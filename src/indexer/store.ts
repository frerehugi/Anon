import type { Db, Stmt } from "./db.js";
import type { SettlementRow, UnclassifiedRow } from "./types.js";

/** D1 allows at most 100 bound parameters per statement, so rows are inserted in small chunks. */
const MAX_PARAMS = 100;

const S_COLS = ["tx_hash", "log_index", "block", "ts", "token", "payer", "pay_to", "amount_atomic", "usd", "relayer", "gas_used", "gas_price_wei"];
const U_COLS = ["tx_hash", "block", "ts", "relayer", "to_address", "gas_used", "gas_price_wei", "status"];

function chunkInsert(table: string, cols: string[], rows: unknown[][]): Stmt[] {
  if (rows.length === 0) return [];
  const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  const out: Stmt[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    const ph = `(${cols.map(() => "?").join(",")})`;
    out.push({
      sql: `INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES ${part.map(() => ph).join(",")}`,
      params: part.flat(),
    });
  }
  return out;
}

export const settlementStatements = (rows: SettlementRow[]): Stmt[] =>
  chunkInsert("settlements", S_COLS, rows.map((r) => [r.txHash, r.logIndex, r.block, r.ts, r.token, r.payer, r.payTo, r.amountAtomic, r.usd, r.relayer, r.gasUsed, r.gasPriceWei]));

export const unclassifiedStatements = (rows: UnclassifiedRow[]): Stmt[] =>
  chunkInsert("unclassified_txs", U_COLS, rows.map((r) => [r.txHash, r.block, r.ts, r.relayer, r.toAddress, r.gasUsed, r.gasPriceWei, r.status]));

export const cursorStatement = (source: string, lastBlock: number, now: number): Stmt => ({
  sql: "INSERT INTO cursor (source, last_block, updated_at) VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET last_block=excluded.last_block, updated_at=excluded.updated_at WHERE excluded.last_block > cursor.last_block",
  params: [source, lastBlock, now],
});

export async function getCursor(db: Db, source: string): Promise<number | null> {
  const r = await db.all<{ last_block: number }>("SELECT last_block FROM cursor WHERE source = ?", [source]);
  return r.length ? r[0].last_block : null;
}

export interface SettlementDbRow {
  tx_hash: string; log_index: number; block: number; ts: number; token: string; payer: string; pay_to: string;
  amount_atomic: string; usd: number; relayer: string; gas_used: number | null; gas_price_wei: number | null;
}

export const loadSettlements = (db: Db, fromTs: number, toTs: number) =>
  db.all<SettlementDbRow>("SELECT * FROM settlements WHERE ts >= ? AND ts <= ? ORDER BY ts, tx_hash, log_index", [fromTs, toTs]);

export async function countUnclassified(db: Db, fromTs: number, toTs: number): Promise<number> {
  const r = await db.all<{ c: number }>("SELECT COUNT(*) AS c FROM unclassified_txs WHERE ts >= ? AND ts <= ?", [fromTs, toTs]);
  return r[0]?.c ?? 0;
}

export async function dataRange(db: Db): Promise<{ minTs: number | null; maxTs: number | null; settlements: number }> {
  const r = await db.all<{ mn: number | null; mx: number | null; c: number }>("SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS c FROM settlements");
  return { minTs: r[0]?.mn ?? null, maxTs: r[0]?.mx ?? null, settlements: r[0]?.c ?? 0 };
}

export const lastRun = (db: Db) =>
  db.all<Record<string, unknown>>("SELECT id, started_at, finished_at, from_block, to_block, windows, settlements, unclassified, status, error FROM runs ORDER BY id DESC LIMIT 1");

/** Random settlements for an independent re-check. `n` is clamped to 1..500. */
export const sampleSettlements = (db: Db, n: number) =>
  db.all<SettlementDbRow>("SELECT * FROM settlements ORDER BY RANDOM() LIMIT ?", [Math.min(500, Math.max(1, Math.floor(n)))]);
