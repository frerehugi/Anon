import type { Db, Stmt } from "../indexer/db.js";
import { runScan, type ScanOpts, type ScanSummary } from "../indexer/scan.js";
import { lintEndpoint } from "../lint.js";
import { parseRegistrationText } from "../registration.js";
import { assetInfo, REGISTRY_FIRST_BLOCK } from "../constants.js";
import type { Fetcher } from "../net.js";
import { mapLimit } from "../util.js";
import type { RegistryWindow, RegistrySource } from "./registrySource.js";
import { dueEndpoints, eventStatements, fetchedStatements, pendingFetches } from "./store.js";

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

export interface ProbeSummary { probed: number; pass: number; fail: number }

const PASS_INTERVAL = 6 * HOUR;
const MAX_FAIL_INTERVAL = 7 * 24 * HOUR;

/** Probe endpoints that are due: one unpaid request each. Passing ones are re-checked every 6 h, failing ones back off up to 7 days. */
export async function runProbes(db: Db, fetcher: Fetcher, opts: { max: number; concurrency?: number; now?: () => number }): Promise<ProbeSummary> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const due = await dueEndpoints(db, now(), opts.max);
  const sum: ProbeSummary = { probed: due.length, pass: 0, fail: 0 };
  const results = await mapLimit(due, opts.concurrency ?? 4, async (e) => ({ e, r: await lintEndpoint(e.url, { fetcher }) }));
  const stmts: Stmt[] = [];
  for (const { e, r } of results) {
    const pass = r.status === 402 && r.summary.pass;
    const celo = (r.challenge?.accepts ?? []).filter((a) => a.network === "eip155:42220" || a.network === "celo");
    const payTo = [...new Set(celo.map((a) => a.payTo?.toLowerCase()).filter(Boolean))];
    const assets = [...new Set(celo.map((a) => (a.asset ? assetInfo(a.asset)?.symbol ?? a.asset : undefined)).filter(Boolean))];
    const errors = r.findings.filter((f) => f.severity === "error").map((f) => f.code);
    const t = now();
    const next = t + (pass ? PASS_INTERVAL : Math.min(MAX_FAIL_INTERVAL, PASS_INTERVAL * 2 ** (e.consecutive_failures + 1)));
    stmts.push({
      sql: "UPDATE endpoints SET last_probe_at=?, next_probe_at=?, last_status=?, last_pass=?, last_error_codes=?, pay_to=?, assets=?, probes_total=probes_total+1, probes_pass=probes_pass+?, consecutive_failures=? WHERE id=?",
      params: [t, next, r.status ?? null, pass ? 1 : 0, JSON.stringify(errors), JSON.stringify(payTo), JSON.stringify(assets), pass ? 1 : 0, pass ? 0 : e.consecutive_failures + 1, e.id],
    });
    if (pass) sum.pass++; else sum.fail++;
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
