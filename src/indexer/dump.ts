import type { Db } from "./db.js";

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
};

const SETTLEMENT_COLS = ["tx_hash", "log_index", "block", "ts", "token", "payer", "pay_to", "amount_atomic", "usd", "relayer", "gas_used", "gas_price_wei"];
const UNCLASSIFIED_COLS = ["tx_hash", "block", "ts", "relayer", "to_address", "gas_used", "gas_price_wei", "status"];

/**
 * Export a local index as an SQL file, so history can be backfilled into D1 without Worker CPU limits:
 *   npx wrangler d1 execute anon-index --remote --file <file>
 * Rows use INSERT OR IGNORE and the cursor only moves forward, so importing twice is harmless.
 */
export async function dumpSql(db: Db, opts: { source?: string; rowsPerStatement?: number } = {}): Promise<{ sql: string; settlements: number; unclassified: number }> {
  const per = opts.rowsPerStatement ?? 50;
  const source = opts.source ?? "sqd-celo";
  const out: string[] = ["-- Anon index dump (INSERT OR IGNORE; safe to import more than once)"];

  const emit = (table: string, cols: string[], rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += per) {
      const part = rows.slice(i, i + per).map((r) => `(${cols.map((c) => lit(r[c])).join(",")})`);
      out.push(`INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES\n${part.join(",\n")};`);
    }
  };

  const settlements = await db.all<Record<string, unknown>>("SELECT * FROM settlements ORDER BY ts, tx_hash, log_index");
  const unclassified = await db.all<Record<string, unknown>>("SELECT * FROM unclassified_txs ORDER BY ts, tx_hash");
  emit("settlements", SETTLEMENT_COLS, settlements);
  emit("unclassified_txs", UNCLASSIFIED_COLS, unclassified);

  const cur = await db.all<{ last_block: number; updated_at: number }>("SELECT last_block, updated_at FROM cursor WHERE source = ?", [source]);
  if (cur.length) {
    out.push(`INSERT INTO cursor (source, last_block, updated_at) VALUES (${lit(source)}, ${cur[0].last_block}, ${cur[0].updated_at}) ON CONFLICT(source) DO UPDATE SET last_block=excluded.last_block, updated_at=excluded.updated_at WHERE excluded.last_block > cursor.last_block;`);
  }
  return { sql: out.join("\n") + "\n", settlements: settlements.length, unclassified: unclassified.length };
}
