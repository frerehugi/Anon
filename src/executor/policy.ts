// Policy for the payment executor, parsed from loop/policy/*.yaml. Fails closed: anything missing or malformed throws.
import { parse } from "yaml";

export class PolicyError extends Error {}

export const TOKEN_DECIMALS = 6;

/** USD amount (number or decimal string) to atomic units of a 6-decimal stablecoin, without float arithmetic. */
export function toAtomic(v: unknown, label = "amount"): bigint {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new PolicyError(`${label}: not a decimal amount with at most ${TOKEN_DECIMALS} digits: ${JSON.stringify(v)}`);
  return BigInt(m[1]) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((m[2] ?? "").padEnd(TOKEN_DECIMALS, "0"));
}

export const formatAtomic = (a: bigint): string => `${a / 10n ** 6n}.${(a % 10n ** 6n).toString().padStart(6, "0")}`;

export interface AllowedEndpoint { url: string; purpose: string }

export interface Policy {
  total: bigint;
  reserve: bigint;
  experiments: bigint; // spendable before gate 2
  growth: bigint; // added once gate 2 is passed
  maxPerExperiment: bigint;
  perCallMax: bigint;
  dailyMax: { ops: bigint; treasury: bigint };
  tokens: string[];
  endpoints: AllowedEndpoint[]; // enabled entries only
  chainId: number;
  requireAttribution: boolean;
  noRetryOn: string[];
}

const obj = (v: unknown, label: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new PolicyError(`${label}: expected a mapping`);
  return v as Record<string, unknown>;
};
const need = (o: Record<string, unknown>, k: string, label: string) => {
  if (o[k] === undefined || o[k] === null) throw new PolicyError(`${label}.${k} is missing`);
  return o[k];
};

/** Canonical form used to compare endpoints: https only, origin + path, no query or fragment, no trailing slash. */
export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

export function parsePolicy(limitsYaml: string, allowlistYaml: string): Policy {
  const l = obj(parse(limitsYaml), "limits");
  const budget = obj(need(l, "budget", "limits"), "limits.budget");
  const perCall = obj(need(l, "per_call", "limits"), "limits.per_call");
  const daily = obj(need(l, "daily", "limits"), "limits.daily");
  const chain = obj(need(l, "chain", "limits"), "limits.chain");
  const retries = obj(need(l, "retries", "limits"), "limits.retries");
  const a = obj(parse(allowlistYaml), "allowlist");

  const tokens = need(a, "tokens", "allowlist");
  if (!Array.isArray(tokens) || tokens.length === 0 || !tokens.every((t) => typeof t === "string")) throw new PolicyError("allowlist.tokens must be a non-empty list of symbols");
  const buy = need(a, "buy", "allowlist");
  if (!Array.isArray(buy)) throw new PolicyError("allowlist.buy must be a list");
  const endpoints: AllowedEndpoint[] = [];
  for (const [i, e] of buy.entries()) {
    const eo = obj(e, `allowlist.buy[${i}]`);
    if (eo.enabled !== true) continue; // anything but an explicit true stays off
    const url = canonicalUrl(String(need(eo, "url", `allowlist.buy[${i}]`)));
    if (!url) throw new PolicyError(`allowlist.buy[${i}].url must be a plain https URL`);
    endpoints.push({ url, purpose: String(eo.purpose ?? "") });
  }

  const p: Policy = {
    total: toAtomic(need(budget, "total", "budget"), "budget.total"),
    reserve: toAtomic(need(budget, "reserve", "budget"), "budget.reserve"),
    experiments: toAtomic(need(budget, "experiments", "budget"), "budget.experiments"),
    growth: toAtomic(need(budget, "growth", "budget"), "budget.growth"),
    maxPerExperiment: toAtomic(need(budget, "max_per_experiment", "budget"), "budget.max_per_experiment"),
    perCallMax: toAtomic(need(perCall, "max_amount", "per_call"), "per_call.max_amount"),
    dailyMax: { ops: toAtomic(need(daily, "ops_wallet_max", "daily"), "daily.ops_wallet_max"), treasury: toAtomic(need(daily, "treasury_max", "daily"), "daily.treasury_max") },
    tokens: tokens as string[],
    endpoints,
    chainId: Number(need(chain, "chain_id", "chain")),
    requireAttribution: need(chain, "require_attribution", "chain") === true,
    noRetryOn: Array.isArray(retries.no_retry_on) ? retries.no_retry_on.map(String) : [],
  };
  if (p.chainId !== 42220) throw new PolicyError("chain_id must be 42220 (Celo mainnet)");
  if (p.reserve + p.experiments + p.growth > p.total) throw new PolicyError("reserve + experiments + growth exceed the total budget");
  if (p.perCallMax > p.maxPerExperiment) throw new PolicyError("per_call.max_amount exceeds budget.max_per_experiment");
  return p;
}
