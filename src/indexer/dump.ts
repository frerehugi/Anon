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

/**
 * Export the directory (agents, endpoints, registry cursor) for a fresh D1 database. Rows use INSERT OR IGNORE, so rows
 * the Worker already wrote are kept; import it before the first directory cron run to skip the historic scan.
 */
export async function dumpDirectorySql(db: Db, opts: { source?: string; rowsPerStatement?: number } = {}): Promise<{ sql: string; agents: number; endpoints: number }> {
  const per = opts.rowsPerStatement ?? 25;
  const source = opts.source ?? "registry-celo";
  const out: string[] = ["-- Anon directory dump (INSERT OR IGNORE)"];
  const emit = (table: string, cols: string[], rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += per) {
      const part = rows.slice(i, i + per).map((r) => `(${cols.map((c) => lit(r[c])).join(",")})`);
      out.push(`INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES\n${part.join(",\n")};`);
    }
  };
  const colsOf = async (table: string) => (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name);
  const agents = await db.all<Record<string, unknown>>("SELECT * FROM agents ORDER BY agent_id");
  const endpoints = await db.all<Record<string, unknown>>("SELECT * FROM endpoints ORDER BY id");
  emit("agents", await colsOf("agents"), agents);
  emit("endpoints", (await colsOf("endpoints")).filter((c) => c !== "id"), endpoints);
  const cur = await db.all<{ last_block: number; updated_at: number }>("SELECT last_block, updated_at FROM cursor WHERE source = ?", [source]);
  if (cur.length) {
    out.push(`INSERT INTO cursor (source, last_block, updated_at) VALUES (${lit(source)}, ${cur[0].last_block}, ${cur[0].updated_at}) ON CONFLICT(source) DO UPDATE SET last_block=excluded.last_block, updated_at=excluded.updated_at WHERE excluded.last_block > cursor.last_block;`);
  }
  return { sql: out.join("\n") + "\n", agents: agents.length, endpoints: endpoints.length };
}
