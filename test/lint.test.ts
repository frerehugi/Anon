import { test } from "node:test";
import assert from "node:assert/strict";
import { lintChallenge, parseChallenge, type ParsedChallenge } from "../src/lint.js";
import { isPrivateAddress, assertPublicHttps } from "../src/safeFetch.js";
import { registrationCoherent } from "../src/identity.js";

const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const PAYTO = "0x593BA829D84F9bC3AeF2a507C5cf6Cc4dC2c3608";

const good = (over: Record<string, unknown> = {}): ParsedChallenge => ({
  x402Version: 2,
  source: "header",
  accepts: [{ scheme: "exact", network: "eip155:42220", amount: "10000", asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, ...over }],
  extensions: { bazaar: { info: { input: {}, output: {} }, schema: {} } },
});
const codes = (c: ParsedChallenge | undefined, status = 402) => lintChallenge(c, status).map((f) => f.code);

test("valid USDC v2 challenge produces no errors", () => {
  assert.equal(lintChallenge(good(), 402).filter((f) => f.severity === "error").length, 0);
});

test("non-402 status is an error", () => {
  assert.deepEqual(codes(undefined, 200), ["NOT_402"]);
});

test("redirect and 405 are explained, not errors", () => {
  assert.deepEqual(codes(undefined, 308), ["REDIRECT"]);
  assert.deepEqual(codes(undefined, 405), ["METHOD"]);
});

test("USDT without Tether USD / version 1 fails the EIP-712 rule", () => {
  assert.ok(codes(good({ asset: USDT, extra: {} })).includes("EIP712_DOMAIN"));
  assert.ok(!codes(good({ asset: USDT, extra: { name: "Tether USD", version: "1" } })).includes("EIP712_DOMAIN"));
});

test("zero payTo, bad amount and missing Celo offer are caught", () => {
  assert.ok(codes(good({ payTo: "0x0000000000000000000000000000000000000000" })).includes("PAYTO_ZERO"));
  assert.ok(codes(good({ amount: "$0.01" })).includes("AMOUNT_INVALID"));
  assert.ok(codes(good({ network: "eip155:8453" })).includes("NO_CELO_OFFER"));
});

test("missing bazaar extension warns", () => {
  const c = good();
  delete c.extensions;
  assert.ok(codes(c).includes("NO_BAZAAR"));
});

test("parseChallenge reads the base64 PAYMENT-REQUIRED header and normalizes v1 fields", () => {
  const payload = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:42220", amount: "1", asset: USDC, payTo: PAYTO }] };
  const h = new Headers({ "payment-required": Buffer.from(JSON.stringify(payload)).toString("base64") });
  assert.equal(parseChallenge(h, "")?.accepts[0].amount, "1");
  const v1 = { x402Version: 1, accepts: [{ scheme: "exact", network: "celo", maxAmountRequired: "5", asset: USDC, payTo: PAYTO }] };
  assert.equal(parseChallenge(new Headers(), JSON.stringify(v1))?.accepts[0].amount, "5");
  assert.equal(parseChallenge(new Headers(), "not json"), undefined);
});

test("SSRF guard rejects private ranges and non-https", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  assert.ok(!isPrivateAddress("8.8.8.8"));
  await assert.rejects(() => assertPublicHttps("http://example.com"));
  await assert.rejects(() => assertPublicHttps("https://127.0.0.1/"));
  await assert.rejects(() => assertPublicHttps("https://user:pw@example.com/"));
  await assert.rejects(() => assertPublicHttps("https://example.com:8443/"));
});

test("registrationCoherent matches id and Celo registry", () => {
  const reg = { registrations: [{ agentId: 9817, agentRegistry: "eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }] };
  assert.ok(registrationCoherent(reg, 9817n));
  assert.ok(!registrationCoherent(reg, 1n));
  assert.ok(!registrationCoherent(undefined, 9817n));
});
