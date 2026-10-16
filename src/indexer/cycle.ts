import type { Db } from "./db.js";
import { runScan, type ScanOpts } from "./scan.js";
import { settlementStatements, unclassifiedStatements } from "./store.js";
import type { Source, WindowResult } from "./types.js";

export interface CycleOptions extends Partial<Omit<ScanOpts, "source" | "startBlock">> {
  signers: string[];
  source?: string; // cursor key
}

export interface CycleSummary {
  fromBlock: number | null;
  toBlock: number | null;
  head: number;
  windows: number;
  settlements: number;
  unclassified: number;
  statements: number;
  caughtUp: boolean;
  retries: number;
}

/**
 * One settlement-indexer cycle: a thin wrapper over the generic resumable scan (see scan.ts for the rules:
 * idempotent rows, cursor in the same transaction, overload retried unchanged, size failures shrink the window).
 */
export async function runCycle(db: Db, src: Source, opts: CycleOptions): Promise<CycleSummary> {
  let settlements = 0;
  let unclassified = 0;
  const s = await runScan<WindowResult>(
    db,
    {
      head: () => src.finalizedHead(),
      window: (from, to) => src.window(from, to, opts.signers),
      lastBlock: (r) => r.lastBlock,
      statements: (r) => {
        settlements += r.settlements.length;
        unclassified += r.unclassified.length;
        return [...settlementStatements(r.settlements), ...unclassifiedStatements(r.unclassified)];
      },
      counts: () => ({ items: settlements, others: unclassified }),
    },
    { ...opts, source: opts.source ?? "sqd-celo" },
  );
  return { ...s, settlements, unclassified };
}
