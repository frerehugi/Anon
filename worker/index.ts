// Cloudflare Worker entry for the Anon indexer: a cron trigger runs one cycle, a small read API serves reports.
// Same pattern as the OSIRIS keeper: platform-neutral core in src/indexer, a thin entry here, config via env.
// Holds no wallet key. The only secret is READ_TOKEN, which protects the report endpoint.
import { D1Db, type D1DatabaseLike } from "../src/indexer/db.js";
import { runCycle } from "../src/indexer/cycle.js";
import { SqdSource } from "../src/indexer/sqd.js";
import { buildReport, status } from "../src/indexer/report.js";
import { sampleSettlements } from "../src/indexer/store.js";
import { agentIdsToCheck, chainStatements, parseChainRows } from "../src/directory/chain.js";
import { parseConfig, type IndexerEnv } from "../src/indexer/config.js";
import { runDirectoryCycle } from "../src/directory/crawler.js";
import { SqdRegistrySource } from "../src/directory/registrySource.js";
import { directoryStats, getAgent, listAgents } from "../src/directory/queries.js";
import { edgeFetcher } from "../src/net.js";

interface Env extends IndexerEnv {
  DB: D1DatabaseLike;
  READ_TOKEN?: string;
  WRITE_TOKEN?: string; // separate from READ_TOKEN: only the executor's enrichment job writes
  CELO_USD?: string;
}

interface MinimalExecutionContext { waitUntil(promise: Promise<unknown>): void }

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Registry events are sparse, so one request covers far more blocks than a settlement window. */
const REGISTRY_WINDOW_BLOCKS = 150_000;

/** Must match the second cron in wrangler.toml. */
export const DIRECTORY_CRON = "2-59/10 * * * *";

function authorized(req: Request, env: Env): Response | null {
  if (!env.READ_TOKEN) return json({ error: "not configured" }, 503); // fail closed
  const auth = req.headers.get("authorization") ?? "";
  return safeEqual(auth, `Bearer ${env.READ_TOKEN}`) ? null : json({ error: "unauthorized" }, 401);
}

function authorizedWrite(req: Request, env: Env): Response | null {
  if (!env.WRITE_TOKEN) return json({ error: "not configured" }, 503); // fail closed
  const auth = req.headers.get("authorization") ?? "";
  return safeEqual(auth, `Bearer ${env.WRITE_TOKEN}`) ? null : json({ error: "unauthorized" }, 401);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async scheduled(event: { cron?: string }, env: Env, ctx: MinimalExecutionContext): Promise<void> {
    const cfg = parseConfig(env);
    const db = new D1Db(env.DB);
    if (event.cron === DIRECTORY_CRON) {
      // Free plan: 50 queries and 50 subrequests per invocation. Registry scan, registration files and probes share that budget.
      ctx.waitUntil(
        runDirectoryCycle(db, { registry: new SqdRegistrySource(cfg.sqdBase), fetcher: edgeFetcher }, {
          maxWindows: 3, maxRequests: 6, maxRetries: 1, backoffMs: 500, maxStatements: 25, windowBlocks: REGISTRY_WINDOW_BLOCKS, maxFetches: 6, maxProbes: 6, concurrency: 3,
        })
          .then((r) => console.info(`directory: +${r.registry.events} events, files ${r.pending.ok}/${r.pending.attempted}, probes ${r.probes.pass}/${r.probes.probed}, caughtUp=${r.registry.caughtUp}`))
          .catch((e) => console.error("directory error:", e)),
      );
      return;
    }
    ctx.waitUntil(
      runCycle(db, new SqdSource(cfg.sqdBase), {
        signers: cfg.signers, maxStatements: cfg.maxStatements, maxWindows: cfg.maxWindows, maxRequests: 40, maxRetries: 2, backoffMs: 500,
        windowBlocks: cfg.windowBlocks, backfillBlocks: cfg.backfillBlocks,
      })
        .then((s) => console.info(`indexer: ${s.windows} windows, ${s.settlements} settlements, ${s.unclassified} other, caughtUp=${s.caughtUp}`))
        .catch((e) => console.error("indexer error:", e)),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const db = new D1Db(env.DB);
    if (req.method === "POST" && url.pathname === "/v1/ingest/agent-chain") {
      const denied = authorizedWrite(req, env);
      if (denied) return denied;
      const text = await req.text();
      if (text.length > 200_000) return json({ error: "body too large" }, 413);
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { return json({ error: "invalid json" }, 400); }
      const parsed = parseChainRows((payload as { rows?: unknown })?.rows, Math.floor(Date.now() / 1000));
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      await db.batch(chainStatements(parsed.rows));
      return json({ stored: parsed.rows.length });
    }
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

    if (url.pathname === "/health") return json({ ...(await status(db)), directory: await directoryStats(db) });

    if (url.pathname === "/v1/agents" || url.pathname.startsWith("/v1/agents/")) {
      const denied = authorized(req, env);
      if (denied) return denied;
      const idPart = url.pathname.slice("/v1/agents/".length);
      if (url.pathname !== "/v1/agents") {
        if (!/^\d{1,12}$/.test(idPart)) return json({ error: "bad agent id" }, 400);
        const a = await getAgent(db, Number(idPart));
        return a ? json(a) : json({ error: "not found" }, 404);
      }
      const q = url.searchParams;
      const num = (k: string) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
      return json(await listAgents(db, {
        x402: q.get("x402") === "1", live: q.get("live") === "1", rated: q.get("rated") === "1", tag: q.get("tag")?.slice(0, 40) || undefined, q: q.get("q")?.slice(0, 80) || undefined,
        owner: /^0x[0-9a-fA-F]{40}$/.test(q.get("owner") ?? "") ? q.get("owner")! : undefined, order: q.get("order") === "id" ? "id" : "recent", limit: num("limit"), offset: num("offset"),
      }));
    }

    if (url.pathname === "/v1/agent-ids") {
      const denied = authorized(req, env);
      if (denied) return denied;
      const num = (k: string, d: number) => { const v = Number(url.searchParams.get(k) ?? d); return Number.isFinite(v) && v >= 0 ? v : d; };
      const ids = await agentIdsToCheck(db, { scope: url.searchParams.get("scope") === "all" ? "all" : "x402", staleBefore: num("stale_before", 0), after: num("after", 0), limit: num("limit", 1000) });
      return json({ ids });
    }

    if (url.pathname === "/v1/audit/sample") {
      const denied = authorized(req, env);
      if (denied) return denied;
      const n = Number(url.searchParams.get("n") ?? 100);
      const rows = await sampleSettlements(db, Number.isFinite(n) ? n : 100);
      return json({ n: rows.length, rows: rows.map((r) => ({ txHash: r.tx_hash, logIndex: r.log_index, block: r.block, token: r.token, payer: r.payer, payTo: r.pay_to, amountAtomic: r.amount_atomic, relayer: r.relayer })) });
    }

    if (url.pathname === "/v1/report") {
      if (!env.READ_TOKEN) return json({ error: "not configured" }, 503); // fail closed
      const auth = req.headers.get("authorization") ?? "";
      if (!safeEqual(auth, `Bearer ${env.READ_TOKEN}`)) return json({ error: "unauthorized" }, 401);
      const days = Math.min(30, Math.max(0.25, Number(url.searchParams.get("days") ?? 4) || 4));
      const celoUsdRaw = Number(url.searchParams.get("celo_usd") ?? env.CELO_USD);
      const celoUsd = Number.isFinite(celoUsdRaw) && celoUsdRaw > 0 ? celoUsdRaw : undefined;
      const cfg = parseConfig(env);
      return json(await buildReport(db, { days, celoUsd, labels: cfg.labels }));
    }
    return json({ error: "not found" }, 404);
  },
};
