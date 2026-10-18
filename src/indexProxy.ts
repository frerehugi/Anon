// Parameters for the paid Index endpoints, validated before the payment middleware so bad input is never charged,
// and passed on to the indexer Worker with a fixed allowlist (no user-controlled URLs or headers).

export type IndexParams = { path: "/v1/report"; search: string } | { path: "/v1/agents" | `/v1/agents/${number}`; search: string };
export type ParseResult = { ok: true; value: IndexParams } | { ok: false; error: string };

const int = (v: unknown, min: number, max: number): number | null => {
  if (typeof v !== "string" || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
};

export function parseReportQuery(q: Record<string, unknown>): ParseResult {
  const params = new URLSearchParams();
  if (q.days !== undefined) {
    const d = typeof q.days === "string" && /^\d{1,2}(\.\d{1,2})?$/.test(q.days) ? Number(q.days) : NaN;
    if (!(d >= 0.25 && d <= 30)) return { ok: false, error: "days must be between 0.25 and 30" };
    params.set("days", String(d));
  }
  return { ok: true, value: { path: "/v1/report", search: params.toString() } };
}

export function parseAgentsQuery(q: Record<string, unknown>): ParseResult {
  if (q.id !== undefined) {
    const id = int(q.id, 0, 999_999_999);
    if (id === null) return { ok: false, error: "id must be a non-negative integer" };
    return { ok: true, value: { path: `/v1/agents/${id}`, search: "" } };
  }
  const p = new URLSearchParams();
  for (const flag of ["x402", "live"] as const) {
    if (q[flag] !== undefined) {
      if (q[flag] !== "1" && q[flag] !== "0") return { ok: false, error: `${flag} must be 0 or 1` };
      if (q[flag] === "1") p.set(flag, "1");
    }
  }
  if (q.tag !== undefined) {
    if (typeof q.tag !== "string" || !/^[a-z0-9_-]{1,40}$/.test(q.tag)) return { ok: false, error: "tag must be 1-40 chars of a-z 0-9 _ -" };
    p.set("tag", q.tag);
  }
  if (q.q !== undefined) {
    if (typeof q.q !== "string" || q.q.length === 0 || q.q.length > 80) return { ok: false, error: "q must be 1-80 characters" };
    p.set("q", q.q);
  }
  if (q.owner !== undefined) {
    if (typeof q.owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(q.owner)) return { ok: false, error: "owner must be an address" };
    p.set("owner", q.owner);
  }
  if (q.order !== undefined) {
    if (q.order !== "recent" && q.order !== "id") return { ok: false, error: "order must be recent or id" };
    p.set("order", q.order);
  }
  if (q.limit !== undefined) {
    const n = int(q.limit, 1, 100);
    if (n === null) return { ok: false, error: "limit must be 1-100" };
    p.set("limit", String(n));
  }
  if (q.offset !== undefined) {
    const n = int(q.offset, 0, 1_000_000);
    if (n === null) return { ok: false, error: "offset must be 0-1000000" };
    p.set("offset", String(n));
  }
  return { ok: true, value: { path: "/v1/agents", search: p.toString() } };
}
