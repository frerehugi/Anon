import type { Db, Stmt } from "../indexer/db.js";
import { classifyUri, deriveTags, parseDataUri, probeCandidates, registrationCoherent, type NormalizedRegistration } from "../registration.js";
import type { AgentEvent } from "./events.js";

const bit = (b: boolean | undefined) => (b === undefined ? null : b ? 1 : 0);

/** Small non-cryptographic fingerprint (FNV-1a, 32 bit): detects URI changes without storing the URI. */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0") + s.length.toString(16);
}

const CONTENT_COLS = "uri_kind, uri_hash, pending_uri, fetch_attempts, next_fetch_at, reg_status, reg_error, name, description, image, x402_support, active, coherent, services_json, trust_json, tags_json";

interface ContentParams { uriKind: string | null; uriHash: string | null; pendingUri: string | null; status: "ok" | "pending" | "unreadable"; error: string | null; reg?: NormalizedRegistration; coherent?: boolean }

function contentValues(c: ContentParams): unknown[] {
  const r = c.reg;
  return [
    c.uriKind, c.uriHash, c.pendingUri, 0, null, c.status, c.error,
    r?.name ?? null, r?.description ?? null, r?.image ?? null, bit(r?.x402Support), bit(r?.active), c.coherent === undefined ? null : c.coherent ? 1 : 0,
    r ? JSON.stringify(r.services) : null, r ? JSON.stringify(r.supportedTrust) : null, r ? JSON.stringify(deriveTags(r)) : null,
  ];
}

/** Content fields derived from an event URI. data: URIs are parsed on the spot; https/ipfs wait for a fetch. */
function contentFromUri(agentId: number, uri: string | null, uriError?: string): ContentParams {
  if (uri === null) return { uriKind: null, uriHash: null, pendingUri: null, status: "unreadable", error: uriError ?? "no_uri" };
  const kind = classifyUri(uri);
  const hash = fingerprint(uri);
  if (kind === "data") {
    const p = parseDataUri(uri);
    return p.ok ? { uriKind: kind, uriHash: hash, pendingUri: null, status: "ok", error: null, reg: p.reg, coherent: registrationCoherent(p.reg, agentId) } : { uriKind: kind, uriHash: hash, pendingUri: null, status: "unreadable", error: p.error };
  }
  if (kind === "https" || kind === "ipfs") return { uriKind: kind, uriHash: hash, pendingUri: uri.slice(0, 2000), status: "pending", error: null };
  return { uriKind: kind, uriHash: hash, pendingUri: null, status: "unreadable", error: "unsupported_uri_scheme" };
}

const SET_CONTENT = `uri_kind=excluded.uri_kind, uri_hash=excluded.uri_hash, pending_uri=excluded.pending_uri, fetch_attempts=0, next_fetch_at=NULL, reg_status=excluded.reg_status, reg_error=excluded.reg_error, name=excluded.name, description=excluded.description, image=excluded.image, x402_support=excluded.x402_support, active=excluded.active, coherent=excluded.coherent, services_json=excluded.services_json, trust_json=excluded.trust_json, tags_json=excluded.tags_json, updated_at=excluded.updated_at`;

function endpointStatements(agentId: number, reg: NormalizedRegistration): Stmt[] {
  const cands = probeCandidates(reg);
  const out: Stmt[] = [];
  if (cands.length === 0) {
    out.push({ sql: "DELETE FROM endpoints WHERE agent_id = ?", params: [agentId] });
    return out;
  }
  out.push({ sql: `DELETE FROM endpoints WHERE agent_id = ? AND url NOT IN (${cands.map(() => "?").join(",")})`, params: [agentId, ...cands.map((c) => c.url)] });
  out.push({
    sql: `INSERT INTO endpoints (agent_id, url, declared_x402) VALUES ${cands.map(() => "(?,?,?)").join(",")} ON CONFLICT(agent_id, url) DO UPDATE SET declared_x402=excluded.declared_x402`,
    params: cands.flatMap((c) => [agentId, c.url, c.declared ? 1 : 0]),
  });
  return out;
}

/** Statements that apply one registry event. Events must be applied in block order; the latest event wins. */
export function eventStatements(ev: AgentEvent, now: number): Stmt[] {
  const c = contentFromUri(ev.agentId, ev.uri, ev.uriError);
  const cols = `agent_id, owner, reg_block, reg_ts, ${CONTENT_COLS}, first_seen_at, updated_at, uri_updates`;
  const vals = [ev.agentId, ev.actor, ev.block, ev.ts, ...contentValues(c), now, now, ev.kind === "uri_updated" ? 1 : 0];
  const ph = vals.map(() => "?").join(",");
  const ownerClause = ev.kind === "registered"
    ? "owner=excluded.owner, reg_block=excluded.reg_block, reg_ts=excluded.reg_ts"
    : "uri_updates=agents.uri_updates+1";
  const stmts: Stmt[] = [{ sql: `INSERT INTO agents (${cols}) VALUES (${ph}) ON CONFLICT(agent_id) DO UPDATE SET ${ownerClause}, ${SET_CONTENT}`, params: vals }];
  if (c.status === "ok" && c.reg) stmts.push(...endpointStatements(ev.agentId, c.reg));
  else if (c.status !== "pending") stmts.push({ sql: "DELETE FROM endpoints WHERE agent_id = ?", params: [ev.agentId] });
  return stmts;
}

/** Apply a fetched registration text (or a fetch error) to an agent that was waiting in the queue. */
export function fetchedStatements(agentId: number, outcome: { reg: NormalizedRegistration } | { error: string; permanent: boolean; attempts: number; retryAt: number }, now: number): Stmt[] {
  if ("reg" in outcome) {
    const base = [
      "ok", null, outcome.reg.name ?? null, outcome.reg.description ?? null, outcome.reg.image ?? null, bit(outcome.reg.x402Support), bit(outcome.reg.active),
      registrationCoherent(outcome.reg, agentId) ? 1 : 0, JSON.stringify(outcome.reg.services), JSON.stringify(outcome.reg.supportedTrust), JSON.stringify(deriveTags(outcome.reg)), now, agentId,
    ];
    return [
      { sql: "UPDATE agents SET pending_uri=NULL, fetch_attempts=0, next_fetch_at=NULL, reg_status=?, reg_error=?, name=?, description=?, image=?, x402_support=?, active=?, coherent=?, services_json=?, trust_json=?, tags_json=?, updated_at=? WHERE agent_id=?", params: base },
      ...endpointStatements(agentId, outcome.reg),
    ];
  }
  return [{
    sql: "UPDATE agents SET reg_status=?, reg_error=?, fetch_attempts=?, next_fetch_at=?, updated_at=? WHERE agent_id=?",
    params: [outcome.permanent ? "unreadable" : "pending", outcome.error, outcome.attempts, outcome.permanent ? null : outcome.retryAt, now, agentId],
  }];
}

export const pendingFetches = (db: Db, now: number, limit: number) =>
  db.all<{ agent_id: number; pending_uri: string; fetch_attempts: number }>(
    "SELECT agent_id, pending_uri, fetch_attempts FROM agents WHERE reg_status='pending' AND pending_uri IS NOT NULL AND (next_fetch_at IS NULL OR next_fetch_at <= ?) ORDER BY agent_id LIMIT ?",
    [now, limit],
  );

export interface DueEndpoint { id: number; agent_id: number; url: string; consecutive_failures: number }
export const dueEndpoints = (db: Db, now: number, limit: number) =>
  db.all<DueEndpoint>(
    "SELECT id, agent_id, url, consecutive_failures FROM endpoints WHERE next_probe_at IS NULL OR next_probe_at <= ? ORDER BY COALESCE(next_probe_at, 0), id LIMIT ?",
    [now, limit],
  );
