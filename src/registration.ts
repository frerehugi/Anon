/**
 * ERC-8004 registration files: decoding, normalisation and tagging. Pure code (no network, no node:* imports),
 * so it runs in Node and in Cloudflare Workers. Registration text is untrusted input: everything is size-capped and
 * only plain data comes out.
 */
import { CELO_CHAIN_ID, IDENTITY_REGISTRY } from "./constants.js";

export interface NormalizedRegistration {
  type?: string;
  name?: string;
  description?: string;
  image?: string;
  services: { name?: string; endpoint: string; version?: string }[];
  x402Support?: boolean;
  active?: boolean;
  supportedTrust: string[];
  registrations: { agentId?: string; agentRegistry?: string }[];
}

/** Loose shape of what agents publish; kept for callers that still use the raw type. */
export interface RegistrationFile {
  type?: string;
  name?: string;
  description?: string;
  services?: { name?: string; endpoint?: string; version?: string }[];
  x402Support?: boolean;
  active?: boolean;
  supportedTrust?: string[];
  registrations?: { agentId?: number | string; agentRegistry?: string }[];
}

export type UriKind = "data" | "https" | "ipfs" | "other";
export type ParseResult = { ok: true; reg: NormalizedRegistration } | { ok: false; error: string };

export const MAX_URI_CHARS = 200_000;
const CAP = { name: 120, description: 500, image: 300, endpoint: 300, serviceName: 60, version: 30, services: 20, trust: 10 };

export function classifyUri(uri: string): UriKind {
  if (uri.startsWith("data:")) return "data";
  if (uri.startsWith("https://")) return "https";
  if (uri.startsWith("ipfs://")) return "ipfs";
  return "other";
}

/** JSON text of a `data:` URI (base64 or percent-encoded), or null if it is not decodable. */
export function decodeDataUri(uri: string): string | null {
  if (!uri.startsWith("data:")) return null;
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const meta = uri.slice(5, comma).toLowerCase();
  const payload = uri.slice(comma + 1);
  try {
    if (meta.includes(";base64")) {
      const bin = atob(payload.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") { const s = v.trim().toLowerCase(); if (s === "true") return true; if (s === "false") return false; }
  if (v === 1) return true;
  if (v === 0) return false;
  return undefined;
}

export function normalizeRegistration(raw: unknown): NormalizedRegistration | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const rawServices = Array.isArray(o.services) ? o.services : Array.isArray(o.endpoints) ? o.endpoints : [];
  const services: NormalizedRegistration["services"] = [];
  for (const s of rawServices) {
    if (services.length >= CAP.services) break;
    if (!s || typeof s !== "object") continue;
    const so = s as Record<string, unknown>;
    const endpoint = str(so.endpoint ?? so.url, CAP.endpoint);
    if (!endpoint) continue;
    services.push({ name: str(so.name, CAP.serviceName), endpoint, version: str(so.version, CAP.version) });
  }
  const trust = Array.isArray(o.supportedTrust) ? o.supportedTrust.filter((t): t is string => typeof t === "string").slice(0, CAP.trust).map((t) => t.slice(0, 40)) : [];
  const regs = Array.isArray(o.registrations)
    ? o.registrations.slice(0, 10).filter((r) => r && typeof r === "object").map((r: any) => ({ agentId: r.agentId !== undefined ? String(r.agentId).slice(0, 30) : undefined, agentRegistry: str(r.agentRegistry, 100) }))
    : [];
  return {
    type: str(o.type, 120), name: str(o.name, CAP.name), description: str(o.description, CAP.description), image: str(o.image, CAP.image),
    services, x402Support: bool(o.x402Support), active: bool(o.active), supportedTrust: trust, registrations: regs,
  };
}

export function parseRegistrationText(text: string): ParseResult {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, error: "invalid_json" }; }
  const reg = normalizeRegistration(json);
  return reg ? { ok: true, reg } : { ok: false, error: "not_an_object" };
}

/** Parse a `data:` URI in one step. Other URI kinds need a fetch first. */
export function parseDataUri(uri: string): ParseResult {
  if (uri.length > MAX_URI_CHARS) return { ok: false, error: "uri_too_large" };
  const text = decodeDataUri(uri);
  return text === null ? { ok: false, error: "undecodable_data_uri" } : parseRegistrationText(text);
}

/** Does the file point back at this agent id and the Celo registry? */
export function registrationCoherent(reg: { registrations?: { agentId?: number | string; agentRegistry?: string }[] } | undefined, agentId: bigint | number): boolean {
  const want = `eip155:${CELO_CHAIN_ID}:${IDENTITY_REGISTRY}`.toLowerCase();
  return !!reg?.registrations?.some((r) => String(r.agentId) === agentId.toString() && String(r.agentRegistry ?? "").toLowerCase() === want);
}

const X402_HINT = /x402|premium|paid/i;

/** Endpoints worth probing for x402: https, and either declared (x402Support) or hinted by name/URL. */
export function probeCandidates(reg: NormalizedRegistration): { url: string; declared: boolean }[] {
  const out: { url: string; declared: boolean }[] = [];
  for (const s of reg.services) {
    if (!s.endpoint.startsWith("https://")) continue;
    const hinted = X402_HINT.test(`${s.name ?? ""} ${s.endpoint}`);
    if (reg.x402Support === true || hinted) out.push({ url: s.endpoint, declared: reg.x402Support === true });
  }
  return out;
}

const TAG_RULES: [string, RegExp][] = [
  ["defi", /\b(defi|yield|vault|lend|borrow|liquidity|dex|swap|stake|staking|amm)\b/i],
  ["trading", /\b(trad(e|ing|er)|arbitrage|market ?mak|signal|alpha)\b/i],
  ["payments", /\b(payment|pay-per|micropayment|invoice|checkout|remittance|payroll)\b/i],
  ["data", /\b(data|analytics|oracle|index(er|ing)?|feed|dashboard|scrap(e|er|ing))\b/i],
  ["research", /\b(research|report|summar|news|intelligence|insight)\b/i],
  ["social", /\b(social|twitter|telegram|discord|farcaster|community|content)\b/i],
  ["identity", /\b(identity|reputation|trust|verify|verification|kyc|attest)\b/i],
  ["security", /\b(security|audit|scan|risk|compliance|sanction)\b/i],
  ["health", /\b(health|medical|patient|clinic|wellness)\b/i],
  ["legal", /\b(legal|law|contract|gdb|sozialrecht)\b/i],
  ["gaming", /\b(game|gaming|nft|collectible)\b/i],
  ["developer", /\b(developer|sdk|api|code|deploy|devtool|github)\b/i],
  ["assistant", /\b(assistant|chat|copilot|task|planner|agentic|autonomous)\b/i],
  ["local-currency", /\b(wars|wbrl|wcop|ngn|peso|real|naira|latam|africa)\b/i],
];

export function deriveTags(reg: NormalizedRegistration): string[] {
  const text = `${reg.name ?? ""} ${reg.description ?? ""} ${reg.services.map((s) => s.name ?? "").join(" ")}`;
  const tags: string[] = [];
  for (const [tag, rx] of TAG_RULES) if (rx.test(text)) tags.push(tag);
  for (const s of reg.services) {
    const n = (s.name ?? "").toLowerCase();
    for (const proto of ["mcp", "a2a", "oasf"]) if (n.includes(proto) && !tags.includes(proto)) tags.push(proto);
  }
  if (reg.x402Support === true) tags.push("x402");
  return tags.slice(0, 8);
}
