/**
 * The `/v1/:path*` rewrite in vercel.json appends a `path` query parameter to the request. The x402 challenge builds its
 * resource URL from the request URL, so it would advertise `...&path=check`. Our API has no `path` parameter: drop it.
 */
export function stripRoutingParams(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  if (!params.has("path")) return url;
  params.delete("path");
  const rest = params.toString();
  return url.slice(0, q) + (rest ? `?${rest}` : "");
}
