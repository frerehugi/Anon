import type { Db } from "../indexer/db.js";

export type X402Status = "live" | "declared_failing" | "declared_unverified" | "declared_no_endpoint" | "none" | "inactive" | "unreadable";

export interface EndpointEntry {
  url: string;
  declaredX402: boolean;
  pass: boolean | null;
  httpStatus: number | null;
  errorCodes: string[];
  payTo: string[];
  assets: string[];
  uptime: number | null; // share of probes that passed
  probes: number;
  lastProbeAt: number | null;
}

export interface DirectoryEntry {
  agentId: number;
  owner: string;
  ownerAgents: number; // how many agents this owner address registered (context for bulk registrations)
  name: string | null;
  description: string | null;
  tags: string[];
  x402Support: boolean | null;
  active: boolean | null;
  registrationCoherent: boolean | null;
  registrationStatus: string;
  registrationError: string | null;
  registeredAt: number | null;
  services: { name?: string; endpoint: string; version?: string }[];
  x402Status: X402Status;
  endpoints: EndpointEntry[];
}

interface AgentRow {
  agent_id: number; owner: string; owner_agents: number; reg_ts: number | null; reg_status: string; reg_error: string | null;
  name: string | null; description: string | null; x402_support: number | null; active: number | null; coherent: number | null;
  services_json: string | null; tags_json: string | null;
}
interface EndpointRow {
  agent_id: number; url: string; declared_x402: number; last_pass: number | null; last_status: number | null; last_error_codes: string | null;
  pay_to: string | null; assets: string | null; probes_total: number; probes_pass: number; last_probe_at: number | null;
}

const arr = <T>(s: string | null): T[] => { if (!s) return []; try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

/** What the evidence says about an agent's x402 claim. A fact about probes, never a judgement of intent. */
export function x402StatusOf(a: Pick<AgentRow, "reg_status" | "x402_support" | "active">, eps: Pick<EndpointEntry, "pass" | "probes">[]): X402Status {
  if (a.reg_status === "unreadable") return "unreadable";
  if (a.active === 0) return "inactive";
  if (eps.length === 0) return a.x402_support === 1 ? "declared_no_endpoint" : "none";
  if (eps.some((e) => e.pass === true)) return "live";
  if (eps.every((e) => e.probes === 0)) return "declared_unverified";
  return "declared_failing";
}

function toEntry(a: AgentRow, eps: EndpointRow[]): DirectoryEntry {
  const endpoints: EndpointEntry[] = eps.map((e) => ({
    url: e.url, declaredX402: e.declared_x402 === 1, pass: e.last_pass === null ? null : e.last_pass === 1, httpStatus: e.last_status,
    errorCodes: arr<string>(e.last_error_codes), payTo: arr<string>(e.pay_to), assets: arr<string>(e.assets),
    uptime: e.probes_total ? Math.round((e.probes_pass / e.probes_total) * 100) / 100 : null, probes: e.probes_total, lastProbeAt: e.last_probe_at,
  }));
  return {
    agentId: a.agent_id, owner: a.owner, ownerAgents: a.owner_agents, name: a.name, description: a.description, tags: arr<string>(a.tags_json),
    x402Support: a.x402_support === null ? null : a.x402_support === 1, active: a.active === null ? null : a.active === 1,
    registrationCoherent: a.coherent === null ? null : a.coherent === 1, registrationStatus: a.reg_status, registrationError: a.reg_error,
    registeredAt: a.reg_ts, services: arr(a.services_json), x402Status: x402StatusOf(a, endpoints), endpoints,
  };
}

export interface AgentFilters {
  x402?: boolean; // declares x402 or has a payment-looking endpoint
  live?: boolean; // at least one endpoint passed its last probe
  tag?: string;
  q?: string;
  owner?: string;
  order?: "recent" | "id";
  limit?: number;
  offset?: number;
}

const BASE_SELECT = `SELECT a.agent_id, a.owner, a.reg_ts, a.reg_status, a.reg_error, a.name, a.description, a.x402_support, a.active, a.coherent, a.services_json, a.tags_json,
  (SELECT COUNT(*) FROM agents b WHERE b.owner = a.owner) AS owner_agents FROM agents a`;

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listAgents(db: Db, f: AgentFilters = {}): Promise<{ total: number; items: DirectoryEntry[] }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.x402) where.push("(a.x402_support = 1 OR EXISTS (SELECT 1 FROM endpoints e WHERE e.agent_id = a.agent_id))");
  if (f.live) where.push("EXISTS (SELECT 1 FROM endpoints e WHERE e.agent_id = a.agent_id AND e.last_pass = 1)");
  if (f.tag) { where.push("a.tags_json LIKE ? ESCAPE '\\'"); params.push(like(`"${f.tag}"`)); }
  if (f.q) { where.push("(a.name LIKE ? ESCAPE '\\' OR a.description LIKE ? ESCAPE '\\')"); params.push(like(f.q), like(f.q)); }
  if (f.owner) { where.push("a.owner = ?"); params.push(f.owner.toLowerCase()); }
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = (await db.all<{ c: number }>(`SELECT COUNT(*) AS c FROM agents a${w}`, params))[0]?.c ?? 0;
  const order = f.order === "id" ? "a.agent_id ASC" : "COALESCE(a.reg_ts, 0) DESC, a.agent_id DESC";
  const limit = Math.min(100, Math.max(1, f.limit ?? 20));
  const rows = await db.all<AgentRow>(`${BASE_SELECT}${w} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, Math.max(0, f.offset ?? 0)]);
  if (rows.length === 0) return { total, items: [] };
  const ids = rows.map((r) => r.agent_id);
  const eps = await db.all<EndpointRow>(`SELECT agent_id, url, declared_x402, last_pass, last_status, last_error_codes, pay_to, assets, probes_total, probes_pass, last_probe_at FROM endpoints WHERE agent_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ids);
  const byAgent = new Map<number, EndpointRow[]>();
  for (const e of eps) (byAgent.get(e.agent_id) ?? byAgent.set(e.agent_id, []).get(e.agent_id)!).push(e);
  return { total, items: rows.map((r) => toEntry(r, byAgent.get(r.agent_id) ?? [])) };
}

export async function getAgent(db: Db, agentId: number): Promise<DirectoryEntry | null> {
  const rows = await db.all<AgentRow>(`${BASE_SELECT} WHERE a.agent_id = ?`, [agentId]);
  if (!rows.length) return null;
  const eps = await db.all<EndpointRow>("SELECT agent_id, url, declared_x402, last_pass, last_status, last_error_codes, pay_to, assets, probes_total, probes_pass, last_probe_at FROM endpoints WHERE agent_id = ? ORDER BY id", [agentId]);
  return toEntry(rows[0], eps);
}

export interface DirectoryStats {
  agents: number;
  byRegistrationStatus: Record<string, number>;
  distinctOwners: number;
  bulkOwners: { threshold: number; owners: number; agents: number; agentShare: number };
  declaredX402: number;
  withEndpoints: number;
  endpointsTotal: number;
  endpointsProbed: number;
  endpointsPassing: number;
  agentsLive: number;
  active: { yes: number; no: number; undeclared: number };
  coherent: number;
  pendingFetches: number;
}

export async function directoryStats(db: Db, bulkThreshold = 50): Promise<DirectoryStats> {
  const one = async (sql: string, p: unknown[] = []) => (await db.all<{ c: number }>(sql, p))[0]?.c ?? 0;
  const byStatus: Record<string, number> = {};
  for (const r of await db.all<{ reg_status: string; c: number }>("SELECT reg_status, COUNT(*) AS c FROM agents GROUP BY reg_status")) byStatus[r.reg_status] = r.c;
  const agents = Object.values(byStatus).reduce((s, n) => s + n, 0);
  const bulk = (await db.all<{ owners: number; agents: number }>("SELECT COUNT(*) AS owners, COALESCE(SUM(n), 0) AS agents FROM (SELECT owner, COUNT(*) AS n FROM agents GROUP BY owner HAVING n >= ?)", [bulkThreshold]))[0] ?? { owners: 0, agents: 0 };
  return {
    agents, byRegistrationStatus: byStatus,
    distinctOwners: await one("SELECT COUNT(DISTINCT owner) AS c FROM agents"),
    bulkOwners: { threshold: bulkThreshold, owners: bulk.owners, agents: bulk.agents, agentShare: agents ? Math.round((bulk.agents / agents) * 1000) / 1000 : 0 },
    declaredX402: await one("SELECT COUNT(*) AS c FROM agents WHERE x402_support = 1"),
    withEndpoints: await one("SELECT COUNT(DISTINCT agent_id) AS c FROM endpoints"),
    endpointsTotal: await one("SELECT COUNT(*) AS c FROM endpoints"),
    endpointsProbed: await one("SELECT COUNT(*) AS c FROM endpoints WHERE probes_total > 0"),
    endpointsPassing: await one("SELECT COUNT(*) AS c FROM endpoints WHERE last_pass = 1"),
    agentsLive: await one("SELECT COUNT(DISTINCT agent_id) AS c FROM endpoints WHERE last_pass = 1"),
    active: { yes: await one("SELECT COUNT(*) AS c FROM agents WHERE active = 1"), no: await one("SELECT COUNT(*) AS c FROM agents WHERE active = 0"), undeclared: await one("SELECT COUNT(*) AS c FROM agents WHERE active IS NULL") },
    coherent: await one("SELECT COUNT(*) AS c FROM agents WHERE coherent = 1"),
    pendingFetches: await one("SELECT COUNT(*) AS c FROM agents WHERE reg_status = 'pending'"),
  };
}
