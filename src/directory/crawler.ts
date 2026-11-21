import type { Db, Stmt } from "../indexer/db.js";
import { runScan, type ScanOpts, type ScanSummary } from "../indexer/scan.js";
import { lintEndpoint } from "../lint.js";
import { parseRegistrationText } from "../registration.js";
import { assetInfo, REGISTRY_FIRST_BLOCK } from "../constants.js";
import type { Fetcher } from "../net.js";
import { mapLimit } from "../util.js";
import type { RegistryWindow, RegistrySource } from "./registrySource.js";
import { CONFIRM_FAILURES, dueEndpoints, eventStatements, fetchedStatements, pendingFetches } from "./store.js";

export const REGISTRY_SOURCE_KEY = "registry-celo";
const HOUR = 3600;

export interface RegistryCycleOptions extends Partial<Omit<ScanOpts, "source">> {
  source?: string;
  /** Cap on events applied per window (statement budget). Whole blocks only; the window shrinks to fit. */
  maxEventsPerWindow?: number;
}

/**
 * Keep whole blocks only and stop once `max` events are reached, so that one window never exceeds the D1 statement budget.
 * A single block with more events than `max` is kept whole (a block cannot be split).
 */
export function trimWindow(w: RegistryWindow, max: number): RegistryWindow {
  if (w.events.length <= max) return w;
  const cutBlock = w.events[max - 1].block;
  const kept = w.events.filter((e) => e.block <= cutBlock);
  const nextBlockHasMore = w.events.some((e) => e.block > cutBlock);
  return nextBlockHasMore ? { events: kept, lastBlock: cutBlock } : w;
}

/** Scan ERC-8004 registry events from the cursor to the finalized head (resumable, idempotent). */
export async function runRegistryCycle(db: Db, src: RegistrySource, opts: RegistryCycleOptions = {}): Promise<ScanSummary & { events: number }> {
  let events = 0;
  const maxStatements = opts.maxStatements ?? 40;
  const maxEvents = opts.maxEventsPerWindow ?? Math.max(1, Math.floor((maxStatements - 5) / 3));
  const s = await runScan<RegistryWindow>(
    db,
    {
      head: () => src.finalizedHead(),
      window: async (from, to) => trimWindow(await src.window(from, to), maxEvents),
      lastBlock: (r) => r.lastBlock,
      statements: (r, now) => {
        events += r.events.length;
        return r.events.flatMap((e) => eventStatements(e, now));
      },
      counts: () => ({ items: events, others: 0 }),
    },
    { ...opts, source: opts.source ?? REGISTRY_SOURCE_KEY, startBlock: opts.startBlock ?? REGISTRY_FIRST_BLOCK, maxStatements },
  );
  return { ...s, events };
}

export interface PendingSummary { attempted: number; ok: number; failed: number; gaveUp: number }

/** Fetch registration files that live behind https or ipfs URIs. Failures are retried with backoff, then marked unreadable. */
export async function processPending(db: Db, fetcher: Fetcher, opts: { max: number; concurrency?: number; now?: () => number }): Promise<PendingSummary> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const rows = await pendingFetches(db, now(), opts.max);
  const sum: PendingSummary = { attempted: rows.length, ok: 0, failed: 0, gaveUp: 0 };
  const results = await mapLimit(rows, opts.concurrency ?? 4, async (r) => {
    const url = r.pending_uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${r.pending_uri.slice(7)}` : r.pending_uri;
    const attempts = r.fetch_attempts + 1;
    const fail = (error: string, permanent: boolean) => ({ error, permanent: permanent || attempts >= 3, attempts, retryAt: now() + HOUR * 2 ** attempts });
    try {
      const res = await fetcher(url, { timeoutMs: 8000 });
      if (res.status !== 200) return { agentId: r.agent_id, out: fail(`http_${res.status}`, res.status === 404 || res.status === 410) };
      const p = parseRegistrationText(res.body);
      return p.ok ? { agentId: r.agent_id, out: { reg: p.reg } } : { agentId: r.agent_id, out: fail(p.error, true) };
    } catch (e) {
      return { agentId: r.agent_id, out: fail(`fetch_failed: ${(e as Error).message.slice(0, 80)}`, false) };
    }
  });
  const stmts: Stmt[] = [];
  for (const r of results) {
    stmts.push(...fetchedStatements(r.agentId, r.out, now()));
    if ("reg" in r.out) sum.ok++; else if (r.out.permanent) sum.gaveUp++; else sum.failed++;
  }
  await db.batch(stmts);
  return sum;
}

export interface ProbeSummary { probed: number; pass: number; fail: number; unconfirmed: number }

const PASS_INTERVAL = 6 * HOUR;
const RETRY_INTERVAL = 15 * 60;
const MAX_FAIL_INTERVAL = 7 * 24 * HOUR;

/**
 * Probe endpoints that are due: one unpaid request each. Passing ones are re-checked every 6 h.
 * One failed probe is not published as a failure: the published verdict (`last_pass`) keeps its previous value
 * (a passing endpoint stays passing, an endpoint that never passed stays unverified) and the endpoint is probed again after
 * 15 minutes. Only CONFIRM_FAILURES failures in a row flip the verdict to failing; after that re-checks back off up to 7 days.
 */
export async function runProbes(db: Db, fetcher: Fetcher, opts: { max: number; concurrency?: number; now?: () => number }): Promise<ProbeSummary> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const due = await dueEndpoints(db, now(), opts.max);
  const sum: ProbeSummary = { probed: due.length, pass: 0, fail: 0, unconfirmed: 0 };
  const results = await mapLimit(due, opts.concurrency ?? 4, async (e) => ({ e, r: await lintEndpoint(e.url, { fetcher }) }));
  const stmts: Stmt[] = [];
  for (const { e, r } of results) {
    const pass = r.status === 402 && r.summary.pass;
    const celo = (r.challenge?.accepts ?? []).filter((a) => a.network === "eip155:42220" || a.network === "celo");
    const payTo = [...new Set(celo.map((a) => a.payTo?.toLowerCase()).filter(Boolean))];
    const assets = [...new Set(celo.map((a) => (a.asset ? assetInfo(a.asset)?.symbol ?? a.asset : undefined)).filter(Boolean))];
    const errors = r.findings.filter((f) => f.severity === "error").map((f) => f.code);
    const t = now();
    const failures = pass ? 0 : e.consecutive_failures + 1;
    const confirmed = failures >= CONFIRM_FAILURES;
    // Published verdict: 1 pass, 0 confirmed failure, null unverified (never passed and not yet confirmed failing).
    const verdict = pass ? 1 : confirmed ? 0 : e.probes_pass > 0 ? 1 : null;
    const next = t + (pass ? PASS_INTERVAL : confirmed ? Math.min(MAX_FAIL_INTERVAL, PASS_INTERVAL * 2 ** (failures - 1)) : RETRY_INTERVAL);
    stmts.push({
      sql: "UPDATE endpoints SET last_probe_at=?, next_probe_at=?, last_status=?, last_pass=?, last_error_codes=?, pay_to=?, assets=?, probes_total=probes_total+1, probes_pass=probes_pass+?, consecutive_failures=? WHERE id=?",
      params: [t, next, r.status ?? null, verdict, JSON.stringify(errors), JSON.stringify(payTo), JSON.stringify(assets), pass ? 1 : 0, failures, e.id],
    });
    if (pass) sum.pass++; else { sum.fail++; if (!confirmed) sum.unconfirmed++; }
  }
  await db.batch(stmts);
  return sum;
}

export interface DirectoryCycleOptions extends RegistryCycleOptions { maxFetches?: number; maxProbes?: number; concurrency?: number }

/** One directory cycle: scan new registry events, fetch waiting registration files, probe due endpoints. */
export async function runDirectoryCycle(db: Db, deps: { registry: RegistrySource; fetcher: Fetcher }, opts: DirectoryCycleOptions = {}) {
  const registry = await runRegistryCycle(db, deps.registry, opts);
  const pending = await processPending(db, deps.fetcher, { max: opts.maxFetches ?? 8, concurrency: opts.concurrency, now: opts.now });
  const probes = await runProbes(db, deps.fetcher, { max: opts.maxProbes ?? 8, concurrency: opts.concurrency, now: opts.now });
  return { registry, pending, probes };
}
