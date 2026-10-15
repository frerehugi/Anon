import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80")) return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/** Reject non-https URLs and hosts that resolve to private/loopback/link-local addresses. */
export async function assertPublicHttps(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a valid URL");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("only https:// URLs are allowed");
  if (url.username || url.password) throw new UnsafeUrlError("credentials in URL are not allowed");
  if (url.port && url.port !== "443") throw new UnsafeUrlError("only the default https port is allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0) throw new UnsafeUrlError("host does not resolve");
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw new UnsafeUrlError("host resolves to a non-public address");
  }
  return url;
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  body: string;
}

const MAX_BODY = 64 * 1024;

/**
 * Fetch without following redirects, with a timeout and a body size cap.
 * Residual risk: DNS rebinding between lookup and connect; run behind an egress filter in production.
 */
export async function safeFetch(
  raw: string,
  init: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<SafeResponse> {
  const url = await assertPublicHttps(raw);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    body: init.body,
    headers: init.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(init.timeoutMs ?? 8000),
  });
  const reader = res.body?.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (received < MAX_BODY) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      received += value.length;
    }
    await reader.cancel().catch(() => {});
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks)).slice(0, MAX_BODY);
  return { status: res.status, headers: res.headers, body };
}
