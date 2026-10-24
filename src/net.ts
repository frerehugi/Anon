/**
 * Fetch layer that runs on both Node and Cloudflare Workers (web APIs only, no node:* imports).
 * The Node-only DNS check lives in safeFetch.ts and is plugged in through the same Fetcher interface.
 */
export interface FetchInit { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number; /** Body cap in bytes (default 64 KB, at most 8 MB). */ maxBytes?: number }
export interface FetchResult { status: number; headers: Headers; body: string; /** The body was longer than the cap and was cut. */ truncated?: boolean }
export type Fetcher = (url: string, init?: FetchInit) => Promise<FetchResult>;

export class UnsafeUrlError extends Error {}

export const MAX_BODY = 64 * 1024;
export const MAX_BODY_CEILING = 8 * 1024 * 1024;

const V4 = /^\d{1,3}(\.\d{1,3}){3}$/;

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

export function ipVersion(host: string): 4 | 6 | 0 {
  if (V4.test(host)) return 4;
  if (host.includes(":")) return 6;
  return 0;
}

export function isPrivateAddress(ip: string): boolean {
  return ipVersion(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/** Syntax-level checks that need no DNS: https only, no credentials, default port, no local names or private IP literals. */
export function assertSafeUrlSyntax(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a valid URL");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("only https:// URLs are allowed");
  if (url.username || url.password) throw new UnsafeUrlError("credentials in URL are not allowed");
  if (url.port && url.port !== "443") throw new UnsafeUrlError("only the default https port is allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("local host names are not allowed");
  }
  if (ipVersion(host) && isPrivateAddress(host)) throw new UnsafeUrlError("host is a non-public address");
  return url;
}

/** GET/POST without following redirects, with a timeout and a body size cap. */
export async function fetchCapped(url: URL, init: FetchInit = {}): Promise<FetchResult> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    body: init.body,
    headers: init.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(init.timeoutMs ?? 8000),
  });
  const cap = Math.min(Math.max(init.maxBytes ?? MAX_BODY, 1), MAX_BODY_CEILING);
  const reader = res.body?.getReader();
  let received = 0;
  let truncated = false;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.length;
      if (received >= cap) { truncated = received > cap || !(await reader.read().then((r) => r.done)); break; }
    }
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(received, cap));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, all.length - off);
    all.set(c.subarray(0, take), off);
    off += take;
    if (off >= all.length) break;
  }
  return { status: res.status, headers: res.headers, body: new TextDecoder().decode(all), ...(truncated ? { truncated: true } : {}) };
}

/**
 * Fetcher for runtimes without DNS access (Cloudflare Workers): syntax guard only.
 * Workers cannot reach private networks, so the remaining DNS-rebinding risk of the Node path does not apply there.
 */
export const edgeFetcher: Fetcher = async (raw, init) => fetchCapped(assertSafeUrlSyntax(raw), init);
