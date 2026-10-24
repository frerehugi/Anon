// Local commands for the directory crawler, on a SQLite file. Production runs the same core on D1 (worker/index.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { dumpDirectorySql } from "./indexer/dump.js";
import { SqliteDb } from "./indexer/sqliteDb.js";
import { cursorStatement, getCursor } from "./indexer/store.js";
import { nodeFetcher } from "./safeFetch.js";
import { SqdRegistrySource } from "./directory/registrySource.js";
import { parseRegistryLines } from "./directory/events.js";
import { eventStatements } from "./directory/store.js";
import { processPending, runDirectoryCycle, runProbes, REGISTRY_SOURCE_KEY } from "./directory/crawler.js";
import { directoryStats, getAgent, listAgents } from "./directory/queries.js";

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

export async function directoryCommand(sub: string | undefined, args: string[]): Promise<unknown> {
  const db = new SqliteDb(flag(args, "--db") ?? "anon-index.sqlite");
  db.migrate();
  try {
    if (sub === "crawl") {
      const maxCycles = Number(flag(args, "--max-cycles") ?? 200);
      const pauseMs = Number(flag(args, "--pause-ms") ?? 700);
      const registry = new SqdRegistrySource(undefined, fetch, pauseMs);
      let last: unknown;
      for (let i = 0; i < maxCycles; i++) {
        const r = await runDirectoryCycle(db, { registry, fetcher: nodeFetcher }, {
          maxWindows: 50, maxRequests: 400, maxRetries: 8, backoffMs: 1000, maxStatements: 20_000,
          windowBlocks: Number(flag(args, "--window-blocks") ?? 150_000), // registry events are sparse; a window that is too big shrinks by itself

          maxFetches: Number(flag(args, "--fetches") ?? 50), maxProbes: Number(flag(args, "--probes") ?? 50), concurrency: 4,
        });
        last = r;
        console.error(`cycle ${i + 1}: +${r.registry.events} events to block ${r.registry.toBlock ?? "-"} of ${r.registry.head}; files ok ${r.pending.ok}/${r.pending.attempted}; probes ${r.probes.pass}/${r.probes.probed}`);
        if (r.registry.caughtUp && r.pending.attempted === 0 && r.probes.probed === 0) break;
      }
      return { last, stats: await directoryStats(db) };
    }
    if (sub === "import-events") {
      const file = flag(args, "--file");
      if (!file) throw new Error("--file <events.jsonl> required");
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const { events, lastBlock } = parseRegistryLines(lines.map((l) => ({
        header: { number: l.block, timestamp: l.ts },
        logs: [{ topics: l.topics, data: l.data, transactionHash: l.tx, logIndex: l.li }],
      })));
      events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < events.length; i += 500) {
        await db.batch(events.slice(i, i + 500).flatMap((e) => eventStatements(e, now)));
      }
      const prev = await getCursor(db, REGISTRY_SOURCE_KEY);
      if (lastBlock !== null && (prev === null || lastBlock > prev)) await db.batch([cursorStatement(REGISTRY_SOURCE_KEY, lastBlock, now)]);
      return { imported: events.length, cursor: lastBlock, stats: await directoryStats(db) };
    }
    if (sub === "fetch") return { pending: await processPending(db, nodeFetcher, { max: Number(flag(args, "--max") ?? 50), concurrency: 4 }) };
    if (sub === "probe") return { probes: await runProbes(db, nodeFetcher, { max: Number(flag(args, "--max") ?? 50), concurrency: 4 }) };
    if (sub === "dump") {
      const out = flag(args, "--out") ?? "anon-directory-dump.sql";
      const d = await dumpDirectorySql(db);
      writeFileSync(out, d.sql);
      return { file: out, bytes: d.sql.length, agents: d.agents, endpoints: d.endpoints };
    }
    if (sub === "stats") return await directoryStats(db);
    if (sub === "list") {
      return await listAgents(db, {
        x402: args.includes("--x402"), live: args.includes("--live"), tag: flag(args, "--tag"), q: flag(args, "--q"),
        owner: flag(args, "--owner"), limit: Number(flag(args, "--limit") ?? 20), offset: Number(flag(args, "--offset") ?? 0),
      });
    }
    if (sub === "show") {
      const id = Number(flag(args, "--id") ?? args.find((a) => /^\d+$/.test(a)));
      return await getAgent(db, id);
    }
    throw new Error("usage: directory crawl|import-events|fetch|probe|dump|stats|list|show --db <file.sqlite>");
  } finally {
    db.close();
  }
}
