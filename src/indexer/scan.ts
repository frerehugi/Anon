import type { Db, Stmt } from "./db.js";
import { getCursor } from "./store.js";
import { RetryableSourceError } from "./types.js";

export interface ScanOpts {
  source: string; // cursor key
  /** Used when no cursor exists: start here (block number), else `head - backfillBlocks`. */
  startBlock?: number;
  backfillBlocks?: number;
  windowBlocks?: number;
  minWindowBlocks?: number;
  maxWindows?: number; // successful windows per cycle
  maxRequests?: number; // source requests per cycle including retries (Workers free: 50 subrequests)
  maxRetries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxStatements?: number; // D1 statements per cycle (Workers free: 50 queries)
  now?: () => number;
}

export interface ScanOps<R> {
  head(): Promise<number>;
  window(from: number, to: number): Promise<R>;
  lastBlock(r: R): number;
  statements(r: R, now: number): Stmt[];
  /** Counters for the run record. */
  counts(): { items: number; others: number };
}

export interface ScanSummary {
  fromBlock: number | null;
  toBlock: number | null;
  head: number;
  windows: number;
  statements: number;
  caughtUp: boolean;
  retries: number;
}

const RESERVED = 4; // cursor read, run start, run finish and slack

export async function startRun(db: Db, now: number, source: string): Promise<number | null> {
  const r = await db.all<{ id: number }>("INSERT INTO runs (started_at, status, source) VALUES (?, 'running', ?) RETURNING id", [now, source]);
  return r[0]?.id ?? null;
}

export async function finishRun(db: Db, id: number | null, r: { now: number; fromBlock: number | null; toBlock: number | null; windows: number; items: number; others: number; status: string; error?: string }): Promise<void> {
  if (id === null) return;
  await db.batch([{
    sql: "UPDATE runs SET finished_at=?, from_block=?, to_block=?, windows=?, settlements=?, unclassified=?, status=?, error=? WHERE id = ?",
    params: [r.now, r.fromBlock, r.toBlock, r.windows, r.items, r.others, r.status, r.error ?? null, id],
  }]);
}

/**
 * Generic resumable scan over block windows. Idempotent persistence is the caller's job (INSERT OR IGNORE); the cursor
 * statement is appended here and runs in the same transaction as the window's rows. Window size shrinks only for
 * size-related failures; overload is retried unchanged with backoff.
 */
export async function runScan<R>(db: Db, ops: ScanOps<R>, opts: ScanOpts): Promise<ScanSummary> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const maxWindows = opts.maxWindows ?? 8;
  const maxRequests = opts.maxRequests ?? 40;
  const maxRetries = opts.maxRetries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minWin = opts.minWindowBlocks ?? 250;
  let win = opts.windowBlocks ?? 2500;
  let budget = (opts.maxStatements ?? 40) - RESERVED;

  // The run row comes first, so a failure while asking for the head or the cursor is visible in /health too.
  const sum: ScanSummary = { fromBlock: null, toBlock: null, head: 0, windows: 0, statements: 0, caughtUp: false, retries: 0 };
  const runId = await startRun(db, now(), opts.source);
  let error: string | undefined;
  let cursor = 0;
  let startCursor = 0;

  try {
    let head: number;
    for (let a = 0; ; a++) {
      try { head = await ops.head(); break; } catch (e) {
        if (!(e instanceof RetryableSourceError) || a >= maxRetries) throw e;
        await sleep(Math.min(8000, backoffMs * 2 ** a)); sum.retries++;
      }
    }
    sum.head = head;
    let c = await getCursor(db, opts.source);
    if (c === null) c = opts.startBlock !== undefined ? opts.startBlock - 1 : head - (opts.backfillBlocks ?? 86400) - 1;
    cursor = c;
    startCursor = c;
    let requests = 0;
    let attempts = 0;
    while (cursor < head && requests < maxRequests && sum.windows < maxWindows && budget > 0) {
      const from = cursor + 1;
      const to = Math.min(from + win - 1, head);
      requests++;
      let res: R;
      try {
        res = await ops.window(from, to);
      } catch (e) {
        if (e instanceof RetryableSourceError) {
          if (e.shrink && win > minWin) { win = Math.max(minWin, win >> 1); sum.retries++; continue; }
          if (attempts < maxRetries) { await sleep(Math.min(8000, backoffMs * 2 ** attempts)); attempts++; sum.retries++; continue; }
        }
        throw e;
      }
      attempts = 0;
      const last = ops.lastBlock(res);
      const stmts = [...ops.statements(res, now()), cursorStmt(opts.source, last, now())];
      if (stmts.length > budget) {
        if (win > minWin) { win = Math.max(minWin, win >> 1); sum.retries++; continue; }
        break; // even the smallest window does not fit: continue next cycle
      }
      await db.batch(stmts);
      budget -= stmts.length;
      sum.statements += stmts.length;
      sum.windows++;
      cursor = Math.max(cursor, last);
    }
    sum.fromBlock = cursor > startCursor ? startCursor + 1 : null;
    sum.toBlock = cursor > startCursor ? cursor : null;
    sum.caughtUp = cursor >= head;
    return sum;
  } catch (e) {
    error = (e as Error).message;
    throw e;
  } finally {
    const c = ops.counts();
    await finishRun(db, runId, { now: now(), fromBlock: sum.fromBlock, toBlock: sum.toBlock, windows: sum.windows, items: c.items, others: c.others, status: error ? "error" : "ok", error });
  }
}

function cursorStmt(source: string, lastBlock: number, now: number): Stmt {
  return {
    sql: "INSERT INTO cursor (source, last_block, updated_at) VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET last_block=excluded.last_block, updated_at=excluded.updated_at WHERE excluded.last_block > cursor.last_block",
    params: [source, lastBlock, now],
  };
}
