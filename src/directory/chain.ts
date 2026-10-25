import type { Db, Stmt } from "../indexer/db.js";

export interface AgentChainRow {
  agentId: number;
  checkedAt: number;
  checkedBlock: number | null;
  ownerNow: string | null;
  agentWallet: string | null;
  repClients: number | null;
  repCount: number | null;
  repValue: string | null;
  repDecimals: number | null;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DEC = /^-?\d{1,40}$/;
const nn = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

/** Validate untrusted rows from the ingest route. Anything unexpected is rejected, nothing is coerced. */
export function parseChainRows(input: unknown, now: number): { ok: true; rows: AgentChainRow[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) return { ok: false, error: "rows must be a list of 1..500 entries" };
  const rows: AgentChainRow[] = [];
  for (const [i, r] of input.entries()) {
    if (typeof r !== "object" || r === null) return { ok: false, error: `row ${i}: not an object` };
    const o = r as Record<string, unknown>;
    const agentId = nn(o.agentId, 0, 999_999_999);
    if (agentId === null) return { ok: false, error: `row ${i}: bad agentId` };
    const addr = (v: unknown, name: string) => (v === null || v === undefined ? null : typeof v === "string" && ADDR.test(v) ? v.toLowerCase() : (() => { throw new Error(`row ${i}: bad ${name}`); })());
    try {
      const repValue = o.repValue === null || o.repValue === undefined ? null : typeof o.repValue === "string" && DEC.test(o.repValue) ? o.repValue : (() => { throw new Error(`row ${i}: bad repValue`); })();
      rows.push({
        agentId, checkedAt: now, checkedBlock: nn(o.checkedBlock, 0, 9_999_999_999),
        ownerNow: addr(o.ownerNow, "ownerNow"), agentWallet: addr(o.agentWallet, "agentWallet"),
        repClients: nn(o.repClients, 0, 10_000_000), repCount: nn(o.repCount, 0, Number.MAX_SAFE_INTEGER), repValue, repDecimals: nn(o.repDecimals, 0, 255),
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  return { ok: true, rows };
}

/** Upsert in chunks that respect D1's 100 bound parameters per statement. */
export function chainStatements(rows: AgentChainRow[]): Stmt[] {
  const cols = 9;
  const per = Math.floor(100 / cols);
  const out: Stmt[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    out.push({
      sql: `INSERT INTO agent_chain (agent_id, checked_at, checked_block, owner_now, agent_wallet, rep_clients, rep_count, rep_value, rep_decimals) VALUES ${part.map(() => "(?,?,?,?,?,?,?,?,?)").join(",")}
        ON CONFLICT(agent_id) DO UPDATE SET checked_at=excluded.checked_at, checked_block=excluded.checked_block, owner_now=excluded.owner_now, agent_wallet=excluded.agent_wallet,
          rep_clients=excluded.rep_clients, rep_count=excluded.rep_count, rep_value=excluded.rep_value, rep_decimals=excluded.rep_decimals`,
      params: part.flatMap((r) => [r.agentId, r.checkedAt, r.checkedBlock, r.ownerNow, r.agentWallet, r.repClients, r.repCount, r.repValue, r.repDecimals]),
    });
  }
  return out;
}

/** Agent ids for an enrichment run, ascending. `x402` = agents with an endpoint or an x402 claim; `staleBefore` skips rows checked since then. */
export async function agentIdsToCheck(db: Db, opts: { scope: "x402" | "all"; staleBefore: number; after: number; limit: number }): Promise<number[]> {
  const scope = opts.scope === "x402" ? "AND (a.x402_support = 1 OR EXISTS (SELECT 1 FROM endpoints e WHERE e.agent_id = a.agent_id))" : "";
  const rows = await db.all<{ agent_id: number }>(
    `SELECT a.agent_id FROM agents a LEFT JOIN agent_chain c ON c.agent_id = a.agent_id
     WHERE a.agent_id > ? AND (c.agent_id IS NULL OR c.checked_at < ?) ${scope} ORDER BY a.agent_id LIMIT ?`,
    [opts.after, opts.staleBefore, Math.min(5000, Math.max(1, opts.limit))],
  );
  return rows.map((r) => r.agent_id);
}
