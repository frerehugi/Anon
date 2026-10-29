// The enrichment job: plans batches, pays for them through the executor, ingests the rows into the indexer.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Fetcher } from "../net.js";
import type { PayRequest } from "../executor/engine.js";
import type { Executor } from "../executor/executor.js";
import { toAtomic } from "../executor/policy.js";
import { AGENTS_PER_BATCH, MAX_CLIENTS_FOR_SUMMARY, chunk, parseStageA, parseStageB, splitSummaries, stageA, stageB, toRows } from "./enrich.js";

const URL_RPC = "https://gateway.usebuy.ai/chainstack/celo";

export interface EnrichOpts {
  indexUrl: string;
  readToken: string;
  writeToken?: string; // only needed for a live run
  scope: "x402" | "all";
  limit: number;
  staleHours: number;
  live: boolean;
  approvalId: string;
  now?: () => Date;
  reportDir?: string; // where the run report is written (default loop/audits)
}

const hdr = (t: string) => ({ authorization: `Bearer ${t}` });

async function getIds(f: Fetcher, o: EnrichOpts, nowSec: number): Promise<number[]> {
  const ids: number[] = [];
  let after = 0;
  while (ids.length < o.limit) {
    const want = Math.min(5000, o.limit - ids.length);
    const r = await f(`${o.indexUrl}/v1/agent-ids?scope=${o.scope}&limit=${want}&after=${after}&stale_before=${nowSec - Math.round(o.staleHours * 3600)}`, { headers: hdr(o.readToken), maxBytes: 1_000_000 });
    if (r.status !== 200) throw new Error(`index agent-ids failed: HTTP ${r.status}`);
    const page: number[] = JSON.parse(r.body).ids ?? [];
    if (page.length === 0) break;
    ids.push(...page);
    after = page[page.length - 1];
    if (page.length < want) break;
  }
  return ids;
}

export async function runEnrich(ex: Executor, f: Fetcher, o: EnrichOpts): Promise<unknown> {
  const now = o.now ?? (() => new Date());
  const start = now();
  const stamp = start.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const ids = await getIds(f, o, Math.floor(start.getTime() / 1000));
  if (ids.length === 0) return { status: "nothing to do", scope: o.scope };
  const chunks = chunk(ids, AGENTS_PER_BATCH);
  const plan = {
    scope: o.scope, agents: ids.length, stageABatches: chunks.length,
    estimatedBatches: `${chunks.length} to ${chunks.length * 2 + 2}`, estimatedCostUsdc: `${(chunks.length * 0.01).toFixed(2)} to ${((chunks.length * 2 + 2) * 0.01).toFixed(2)}`,
  };
  const mk = (id: string, body: string): PayRequest => ({
    id, wallet: "ops", url: URL_RPC, method: "POST", body, token: "USDC", amount: toAtomic("0.01"), experiment: "enrich", approvalId: o.approvalId, maxResponseBytes: 4_000_000,
  });
  if (!o.live) {
    const first = mk(`enrich-${stamp}-a1`, stageA(chunks[0]).body);
    return { plan, status: "dry_run", decision: await ex.check(first), note: "nothing paid" };
  }
  if (!o.writeToken) throw new Error("INDEX_WRITE_TOKEN is required in the environment for --live");

  const payments: { requestId: string; txHash?: string }[] = [];
  let stored = 0, rpcErrors = 0, withReputation = 0, ownerChanged = 0, unreadable = 0;
  for (const [k, ids_] of chunks.entries()) {
    const a = stageA(ids_);
    const resA = await ex.execute(mk(`enrich-${stamp}-a${k + 1}`, a.body), { dryRun: false });
    if (resA.status !== "settled") return { plan, stoppedAt: `a${k + 1}`, status: resA.status, decision: resA.decision, detail: resA.detail, stored, payments };
    payments.push({ requestId: `enrich-${stamp}-a${k + 1}`, txHash: resA.txHash });
    const pa = parseStageA(resA.body ?? "", a.calls);
    rpcErrors += pa.rpcErrors;
    const need = [...pa.byAgent].filter(([, r]) => r.clients && r.clients.length > 0 && r.clients.length <= MAX_CLIENTS_FOR_SUMMARY).map(([agentId, r]) => ({ agentId, clients: r.clients! }));
    const summaries = new Map<number, { count: number; value: string; decimals: number }>();
    for (const [j, part] of splitSummaries(need).entries()) {
      const b = stageB(part);
      const rid = `enrich-${stamp}-b${k + 1}-${j + 1}`;
      const resB = await ex.execute(mk(rid, b.body), { dryRun: false });
      if (resB.status !== "settled") return { plan, stoppedAt: `b${k + 1}-${j + 1}`, status: resB.status, decision: resB.decision, detail: resB.detail, stored, payments };
      payments.push({ requestId: rid, txHash: resB.txHash });
      const pb = parseStageB(resB.body ?? "", b.calls);
      rpcErrors += pb.rpcErrors;
      for (const [id, v] of pb.byAgent) summaries.set(id, v);
    }
    const rows = toRows(pa.byAgent, summaries, pa.block);
    unreadable += rows.filter((r) => r.ownerNow === null && r.repClients === null).length;
    withReputation += rows.filter((r) => (r.repCount ?? 0) > 0).length;
    for (const part of chunk(rows, 500)) {
      const r = await f(`${o.indexUrl}/v1/ingest/agent-chain`, { method: "POST", headers: { ...hdr(o.writeToken), "content-type": "application/json" }, body: JSON.stringify({ rows: part }), timeoutMs: 20_000 });
      if (r.status !== 200) return { plan, stoppedAt: `ingest ${k + 1}`, status: "ingest_failed", httpStatus: r.status, detail: r.body.slice(0, 200), stored, payments };
      stored += part.length;
    }
  }
  const report = { date: start.toISOString(), source: "Chainstack Celo RPC, paid through buy (x402)", scope: o.scope, agentsChecked: ids.length, stored, withReputation, unreadable, rpcErrors, payments };
  const dir = o.reportDir ?? "loop/audits";
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${start.toISOString().slice(0, 10)}-directory-enrichment-${stamp.slice(-6)}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  return { ...report, paymentsCount: payments.length, payments: undefined, file, ownerChanged };
}
