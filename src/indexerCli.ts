// Local commands for the indexer, on a SQLite file. Production runs the same core on D1 (worker/index.ts).
import { SqliteDb } from "./indexer/sqliteDb.js";
import { runCycle } from "./indexer/cycle.js";
import { SqdSource } from "./indexer/sqd.js";
import { buildReport, status } from "./indexer/report.js";
import { parseConfig, type IndexerEnv } from "./indexer/config.js";
import { dumpSql } from "./indexer/dump.js";
import { writeFileSync } from "node:fs";

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

export async function indexCommand(sub: string | undefined, args: string[]): Promise<unknown> {
  const dbPath = flag(args, "--db") ?? "anon-index.sqlite";
  const db = new SqliteDb(dbPath);
  db.migrate();
  const cfg = parseConfig(process.env as IndexerEnv);
  try {
    if (sub === "run") {
      const backfillDays = Number(flag(args, "--backfill-days") ?? 1);
      const pauseMs = Number(flag(args, "--pause-ms") ?? 700);
      const maxCycles = Number(flag(args, "--max-cycles") ?? 500);
      const src = new SqdSource(undefined, fetch, pauseMs);
      const totals = { cycles: 0, windows: 0, settlements: 0, unclassified: 0, retries: 0 };
      for (let i = 0; i < maxCycles; i++) {
        const s = await runCycle(db, src, {
          signers: cfg.signers, backfillBlocks: backfillDays * 86400, maxWindows: 50, maxRequests: 400, maxRetries: 8, backoffMs: 1000, maxStatements: 100_000, windowBlocks: cfg.windowBlocks,
        });
        totals.cycles++; totals.windows += s.windows; totals.settlements += s.settlements; totals.unclassified += s.unclassified; totals.retries += s.retries;
        console.error(`cycle ${totals.cycles}: +${s.settlements} settlements, to block ${s.toBlock ?? "-"} of ${s.head}${s.caughtUp ? " (caught up)" : ""}`);
        if (s.caughtUp) break;
      }
      return { ...totals, status: await status(db) };
    }
    if (sub === "report") {
      const celoUsd = flag(args, "--celo-usd");
      return await buildReport(db, { days: Number(flag(args, "--days") ?? 4), celoUsd: celoUsd ? Number(celoUsd) : undefined, labels: cfg.labels });
    }
    if (sub === "status") return await status(db);
    if (sub === "dump") {
      const out = flag(args, "--out") ?? "anon-index-dump.sql";
      const d = await dumpSql(db);
      writeFileSync(out, d.sql);
      return { file: out, bytes: d.sql.length, settlements: d.settlements, unclassified: d.unclassified };
    }
    throw new Error("usage: index run|report|status|dump --db <file.sqlite> [--backfill-days N] [--days N] [--celo-usd X]");
  } finally {
    db.close();
  }
}
