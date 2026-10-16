import { getAddress, isAddress } from "viem";
import { ASSETS, CELO_NETWORK, assetInfo } from "./constants.js";
import { UnsafeUrlError, type Fetcher } from "./net.js";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  fix?: string;
}

export interface NormalizedAccept {
  scheme?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface ParsedChallenge {
  x402Version?: number;
  accepts: NormalizedAccept[];
  extensions?: Record<string, any>;
  source: "header" | "body";
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** Parse the 402 challenge from the PAYMENT-REQUIRED header (v2) or the JSON body (v1/v2). */
export function parseChallenge(headers: Headers, body: string): ParsedChallenge | undefined {
  const raw = headers.get("payment-required");
  let obj: any;
  let source: "header" | "body" = "header";
  if (raw) {
    try {
      obj = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      obj = undefined;
    }
  }
  if (!obj) {
    source = "body";
    try {
      obj = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (!obj || !Array.isArray(obj.accepts)) return undefined;
  const accepts: NormalizedAccept[] = obj.accepts.map((a: any) => ({
    scheme: a.scheme,
    network: a.network,
    amount: a.amount ?? a.maxAmountRequired,
    asset: a.asset,
    payTo: a.payTo,
    maxTimeoutSeconds: a.maxTimeoutSeconds,
    extra: a.extra,
  }));
  return { x402Version: obj.x402Version, accepts, extensions: obj.extensions, source };
}

/** Pure rule set: no network access, so it is fully unit-testable. */
export function lintChallenge(ch: ParsedChallenge | undefined, status: number): Finding[] {
  const f: Finding[] = [];
  if (status >= 300 && status < 400) {
    f.push({
      severity: "warn",
      code: "REDIRECT",
      message: `Unpaid request was redirected (HTTP ${status}). Redirects are not followed; lint the final URL directly.`,
    });
    return f;
  }
  if (status === 405) {
    f.push({ severity: "warn", code: "METHOD", message: "HTTP 405: this route expects a different method; retry with POST." });
    return f;
  }
  if (status !== 402) {
    f.push({
      severity: "error",
      code: "NOT_402",
      message: `Unpaid request returned HTTP ${status}, expected 402 Payment Required.`,
      fix: "Put the x402 payment middleware before the route handler so unpaid requests get a 402 challenge.",
    });
    return f;
  }
  if (!ch) {
    f.push({
      severity: "error",
      code: "NO_CHALLENGE",
      message: "Got 402 but no parseable payment challenge (PAYMENT-REQUIRED header or JSON body with `accepts`).",
      fix: "Return the x402 v2 challenge in the PAYMENT-REQUIRED header (base64 JSON).",
    });
    return f;
  }
  if (ch.x402Version !== 2) {
    f.push({
      severity: "warn",
      code: "NOT_V2",
      message: `x402Version is ${String(ch.x402Version)}; Celo's facilitator issues version 2.`,
      fix: "Use @x402/express (v2 packages).",
    });
  }
  if (ch.accepts.length === 0) {
    f.push({ severity: "error", code: "EMPTY_ACCEPTS", message: "`accepts` is empty: nothing can be paid." });
    return f;
  }
  const celoOffers = ch.accepts.filter((a) => a.network === CELO_NETWORK || a.network === "celo");
  if (celoOffers.length === 0) {
    f.push({
      severity: "error",
      code: "NO_CELO_OFFER",
      message: "No offer on Celo mainnet (eip155:42220).",
      fix: `Add an accept with network "${CELO_NETWORK}".`,
    });
  }
  for (const [i, a] of celoOffers.entries()) {
    const at = `accepts[${i}]`;
    if (a.scheme !== "exact") {
      f.push({ severity: "warn", code: "SCHEME", message: `${at}: scheme is "${a.scheme}", the Celo facilitator supports "exact".` });
    }
    if (!a.payTo || !isAddress(a.payTo)) {
      f.push({ severity: "error", code: "PAYTO_INVALID", message: `${at}: payTo is missing or not a valid address.` });
    } else if (a.payTo.toLowerCase() === ZERO) {
      f.push({ severity: "error", code: "PAYTO_ZERO", message: `${at}: payTo is the zero address; payments would be lost.` });
    }
    if (!a.asset || !isAddress(a.asset)) {
      f.push({ severity: "error", code: "ASSET_INVALID", message: `${at}: asset is missing or not a valid address.` });
    } else {
      const info = assetInfo(a.asset);
      if (!info) {
        f.push({
          severity: "warn",
          code: "ASSET_UNKNOWN",
          message: `${at}: asset ${getAddress(a.asset)} is not among the tokens the Celo facilitator lists.`,
          fix: `Use one of: ${Object.values(ASSETS).map((x) => x.symbol).join(", ")}.`,
        });
      } else {
        if (info.method === "eip3009") {
          const name = a.extra?.name;
          const version = a.extra?.version;
          if (name !== info.name || String(version) !== info.version) {
            f.push({
              severity: "error",
              code: "EIP712_DOMAIN",
              message: `${at}: ${info.symbol} needs extra.name="${info.name}" and extra.version="${info.version}" (got name=${JSON.stringify(name)}, version=${JSON.stringify(version)}). Signature verification fails otherwise.`,
              fix: "Set the EIP-712 domain in `extra` explicitly. USDT has no on-chain version().",
            });
          }
        } else {
          f.push({
            severity: "info",
            code: "PERMIT2_ASSET",
            message: `${at}: ${info.symbol} settles via Permit2, which needs a prior approval from the payer.`,
          });
        }
        if (a.amount !== undefined) {
          if (!/^\d+$/.test(String(a.amount)) || BigInt(a.amount) === 0n) {
            f.push({
              severity: "error",
              code: "AMOUNT_INVALID",
              message: `${at}: amount "${a.amount}" must be a positive integer in token base units (${info.decimals} decimals).`,
              fix: 'Use an explicit price object; the "$0.01" shorthand throws on Celo.',
            });
          } else if (info.decimals === 6 && BigInt(a.amount) > 5_000_000n) {
            f.push({ severity: "info", code: "AMOUNT_HIGH", message: `${at}: price is above 5 ${info.symbol} per call; check the unit.` });
          }
        }
      }
    }
    if (a.maxTimeoutSeconds === undefined) {
      f.push({ severity: "info", code: "NO_TIMEOUT", message: `${at}: maxTimeoutSeconds not set.` });
    }
  }
  const bazaar = ch.extensions?.bazaar;
  if (!bazaar) {
    f.push({
      severity: "warn",
      code: "NO_BAZAAR",
      message: "No bazaar extension: agents and indexes cannot see the input/output shape of this endpoint.",
      fix: "Declare the bazaar extension (method, example input, JSON schema, example output).",
    });
  } else {
    if (!bazaar.info?.input || !bazaar.info?.output) {
      f.push({ severity: "warn", code: "BAZAAR_INCOMPLETE", message: "bazaar.info should describe both input and output." });
    }
    if (!bazaar.schema) f.push({ severity: "info", code: "BAZAAR_NO_SCHEMA", message: "bazaar.schema (JSON Schema) is missing." });
  }
  const desc: unknown = (ch as any).resource?.description;
  if (typeof desc === "string" && desc.length > 500) {
    f.push({ severity: "info", code: "DESC_LONG", message: "Resource description is over 500 characters; indexes prefer short, agent-oriented text." });
  }
  return f;
}

export interface LintResult {
  url: string;
  method: string;
  status?: number;
  challenge?: ParsedChallenge;
  findings: Finding[];
  summary: { errors: number; warnings: number; info: number; pass: boolean };
}

function summarize(findings: Finding[]): LintResult["summary"] {
  const errors = findings.filter((x) => x.severity === "error").length;
  return {
    errors,
    warnings: findings.filter((x) => x.severity === "warn").length,
    info: findings.filter((x) => x.severity === "info").length,
    pass: errors === 0,
  };
}

/** Probe an x402 endpoint WITHOUT paying: one unpaid request, then rule checks. */
export async function lintEndpoint(
  url: string,
  opts: { method?: "GET" | "POST"; body?: string; fetcher: Fetcher },
): Promise<LintResult> {
  const method = opts.method ?? "GET";
  const base: { url: string; method: string } = { url, method };
  try {
    const send = (m: "GET" | "POST") =>
      opts.fetcher(url, {
        method: m,
        body: m === "POST" ? (opts.body ?? "{}") : undefined,
        headers: m === "POST" ? { "content-type": "application/json" } : undefined,
      });
    let res = await send(method);
    let usedMethod = method;
    if (res.status === 405 && method === "GET") {
      res = await send("POST");
      usedMethod = "POST";
    }
    if (usedMethod !== method) base.method = usedMethod;
    const challenge = res.status === 402 ? parseChallenge(res.headers, res.body) : undefined;
    const findings = lintChallenge(challenge, res.status);
    return { ...base, status: res.status, challenge, findings, summary: summarize(findings) };
  } catch (e) {
    const msg = e instanceof UnsafeUrlError ? `URL rejected: ${e.message}` : `Request failed: ${(e as Error).message}`;
    const findings: Finding[] = [{ severity: "error", code: "UNREACHABLE", message: msg }];
    return { ...base, findings, summary: summarize(findings) };
  }
}
