import type { Db } from "./db.js";
import { cursorStatement, finishRun, getCursor, settlementStatements, startRun, unclassifiedStatements } from "./store.js";
import { RetryableSourceError, type Source } from "./types.js";

export interface CycleOptions {
  signers: string[];
  source?: string; // cursor key
  windowBlocks?: number;
  minWindowBlocks?: number;
  /** Used only when no cursor exists yet: how far back to start (blocks, about 1 s each on Celo). */
  backfillBlocks?: number;
  /** Cap on successful windows per cycle. */
  maxWindows?: number;
  /** Cap on source requests per cycle including retries (Workers free plan allows 50 subrequests per invocation). */
  maxRequests?: number;
  /** Retries of the same window after a temporary source failure (overload), with exponential backoff. */
  maxRetries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Cap on D1 statements per cycle (Workers free plan allows 50 queries per invocation). */
  maxStatements?: number;
  now?: () => number;
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

const RESERVED = 4; // cursor read, run start, run finish and slack

/**
 * One indexer cycle. Idempotent and resumable: rows are inserted with INSERT OR IGNORE and the cursor moves in
 * the same transaction as the rows it covers. Window size adapts: it halves when the source is overloaded or when a
 * window would exceed the statement budget.
 */
export async function runCycle(db: Db, src: Source, opts: CycleOptions): Promise<CycleSummary> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const sourceKey = opts.source ?? "sqd-celo";
  const maxWindows = opts.maxWindows ?? 8;
  const maxRequests = opts.maxRequests ?? 40;
  const maxRetries = opts.maxRetries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxStatements = opts.maxStatements ?? 40;
  const minWin = opts.minWindowBlocks ?? 250;
  let win = opts.windowBlocks ?? 2500;
  let budget = maxStatements - RESERVED;

  const head = await src.finalizedHead();
  let cursor = await getCursor(db, sourceKey);
  if (cursor === null) cursor = head - (opts.backfillBlocks ?? 86400) - 1;
  const startCursor = cursor;

  const sum: CycleSummary = { fromBlock: null, toBlock: null, head, windows: 0, settlements: 0, unclassified: 0, statements: 0, caughtUp: false, retries: 0 };
  await startRun(db, now());
  let error: string | undefined;

  try {
    let requests = 0;
    let attempts = 0; // consecutive failures of the current window
    while (cursor < head && requests < maxRequests && sum.windows < maxWindows && budget > 0) {
      const from = cursor + 1;
      const to = Math.min(from + win - 1, head);
      requests++;
      let res;
      try {
        res = await src.window(from, to, opts.signers);
      } catch (e) {
        if (e instanceof RetryableSourceError) {
          if (e.shrink && win > minWin) { win = Math.max(minWin, win >> 1); sum.retries++; continue; }
          if (attempts < maxRetries) { await sleep(Math.min(8000, backoffMs * 2 ** attempts)); attempts++; sum.retries++; continue; }
        }
        throw e;
      }
      attempts = 0;
      const stmts = [...settlementStatements(res.settlements), ...unclassifiedStatements(res.unclassified), cursorStatement(sourceKey, res.lastBlock, now())];
      if (stmts.length > budget) {
        if (win > minWin) { win = Math.max(minWin, win >> 1); sum.retries++; continue; }
        break; // even the smallest window does not fit: continue next cycle
      }
      await db.batch(stmts);
      budget -= stmts.length;
      sum.statements += stmts.length;
      sum.windows++;
      sum.settlements += res.settlements.length;
      sum.unclassified += res.unclassified.length;
      cursor = Math.max(cursor, res.lastBlock);
    }
    sum.fromBlock = cursor > startCursor ? startCursor + 1 : null;
    sum.toBlock = cursor > startCursor ? cursor : null;
    sum.caughtUp = cursor >= head;
    return sum;
  } catch (e) {
    error = (e as Error).message;
    throw e;
  } finally {
    await finishRun(db, { now: now(), fromBlock: sum.fromBlock, toBlock: sum.toBlock, windows: sum.windows, settlements: sum.settlements, unclassified: sum.unclassified, status: error ? "error" : "ok", error });
  }
}
