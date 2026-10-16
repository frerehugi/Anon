// Cloudflare Worker entry for the Anon indexer: a cron trigger runs one cycle, a small read API serves reports.
// Same pattern as the OSIRIS keeper: platform-neutral core in src/indexer, a thin entry here, config via env.
// Holds no wallet key. The only secret is READ_TOKEN, which protects the report endpoint.
import { D1Db, type D1DatabaseLike } from "../src/indexer/db.js";
import { runCycle } from "../src/indexer/cycle.js";
import { SqdSource } from "../src/indexer/sqd.js";
import { buildReport, status } from "../src/indexer/report.js";
import { parseConfig, type IndexerEnv } from "../src/indexer/config.js";

interface Env extends IndexerEnv {
  DB: D1DatabaseLike;
  READ_TOKEN?: string;
  CELO_USD?: string;
}

interface MinimalExecutionContext { waitUntil(promise: Promise<unknown>): void }

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async scheduled(_event: unknown, env: Env, ctx: MinimalExecutionContext): Promise<void> {
    const cfg = parseConfig(env);
    const db = new D1Db(env.DB);
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
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

    if (url.pathname === "/health") return json(await status(db));

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
