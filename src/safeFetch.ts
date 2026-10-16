import { lookup } from "node:dns/promises";
import { assertSafeUrlSyntax, fetchCapped, ipVersion, isPrivateAddress, UnsafeUrlError, type FetchInit, type FetchResult, type Fetcher } from "./net.js";

export { UnsafeUrlError, isPrivateAddress };
export type SafeResponse = FetchResult;

/** Node path: syntax guard plus a DNS check that every resolved address is public. */
export async function assertPublicHttps(raw: string): Promise<URL> {
  const url = assertSafeUrlSyntax(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = ipVersion(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0) throw new UnsafeUrlError("host does not resolve");
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw new UnsafeUrlError("host resolves to a non-public address");
  }
  return url;
}

/**
 * Residual risk: DNS rebinding between lookup and connect; run behind an egress filter in production.
 */
export async function safeFetch(raw: string, init: FetchInit = {}): Promise<FetchResult> {
  return fetchCapped(await assertPublicHttps(raw), init);
}

export const nodeFetcher: Fetcher = safeFetch;
