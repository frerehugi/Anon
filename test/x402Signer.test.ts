import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { X402Signer } from "../src/executor/x402Signer.js";
import type { Fetcher } from "../src/net.js";
import type { PayRequest } from "../src/executor/engine.js";

const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const PAY_TO = "0x" + "9".repeat(40);
const URL1 = "https://gateway.usebuy.ai/chainstack/celo";
const account = privateKeyToAccount(generatePrivateKey());

const quote = (o: { asset?: string; amount?: string; network?: string; name?: string } = {}) => ({
  x402Version: 2,
  resource: { url: URL1 },
  accepts: [{ scheme: "exact", network: o.network ?? "eip155:42220", asset: o.asset ?? USDC, amount: o.amount ?? "10000", payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: o.name ?? "USDC", version: "2" } }],
});
const req = (o: Partial<PayRequest> = {}): PayRequest => ({ id: "r1", wallet: "ops", url: URL1, token: "USDC", amount: 20000n, experiment: "e", approvalId: "a", ...o });

/** Fake endpoint: first call has no payment header and gets a 402 quote; a call with a payment header gets `paid`. */
function server(q: object, paid: (sig: any) => { status: number; body?: string; settle?: object } | Error) {
  const calls: { sig: any }[] = [];
  const seen: { method?: string; body?: string }[] = [];
  const fetcher: Fetcher = async (_url, init) => {
    const sig = init?.headers && Object.entries(init.headers).find(([k]) => ["payment-signature", "x-payment"].includes(k.toLowerCase()))?.[1];
    seen.push({ method: init?.method, body: init?.body });
    if (!sig) return (q as any).x402Version === 1
      ? { status: 402, headers: new Headers(), body: JSON.stringify(q) } // v1: quote in the body
      : { status: 402, headers: new Headers({ "payment-required": encodePaymentRequiredHeader(q as any) }), body: "{}" };
    const decoded = decodePaymentSignatureHeader(sig as string);
    calls.push({ sig: decoded });
    const r = paid(decoded);
    if (r instanceof Error) throw r;
    const h = new Headers();
    if (r.settle) h.set((q as any).x402Version === 1 ? "x-payment-response" : "payment-response", encodePaymentResponseHeader(r.settle as any));
    return { status: r.status, headers: h, body: r.body ?? "" };
  };
  return { fetcher, calls, seen };
}
const ok = { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:42220", payer: account.address };

test("pays an approved quote: signs from the Anon wallet to payTo for exactly the quoted amount", async () => {
  const s = server(quote(), () => ({ status: 200, body: '{"result":"0x1"}', settle: ok }));
  const out = await new X402Signer({ account, fetcher: s.fetcher }).pay(req());
  assert.equal(out.status, "settled");
  assert.equal(out.txHash, "0x" + "ab".repeat(32));
  assert.equal(out.body, '{"result":"0x1"}');
  assert.equal(s.calls.length, 1);
  const a = s.calls[0].sig.payload.authorization;
  assert.equal(a.from.toLowerCase(), account.address.toLowerCase());
  assert.equal(a.to.toLowerCase(), PAY_TO);
  assert.equal(a.value, "10000");
});

test("nothing is signed when the quote is above the approved amount, in another token or on another network", async () => {
  for (const q of [quote({ amount: "20001" }), quote({ asset: USDT, name: "Tether USD" }), quote({ network: "eip155:8453" })]) {
    const s = server(q, () => ({ status: 200, settle: ok }));
    const out = await new X402Signer({ account, fetcher: s.fetcher }).pay(req());
    assert.equal(out.status, "failed");
    assert.equal(s.calls.length, 0);
  }
});

test("a free or redirecting endpoint is not paid", async () => {
  for (const status of [200, 301, 500]) {
    const out = await new X402Signer({ account, fetcher: async () => ({ status, headers: new Headers(), body: "" }) }).pay(req());
    assert.equal(out.status, "failed");
  }
});

test("only the ops wallet pays x402", async () => {
  const s = server(quote(), () => ({ status: 200, settle: ok }));
  assert.equal((await new X402Signer({ account, fetcher: s.fetcher }).pay(req({ wallet: "treasury" }))).status, "failed");
});

test("after signing, anything but a clean receipt is uncertain", async () => {
  const cases: [string, (s: any) => any][] = [
    ["network error", () => new Error("socket hang up")],
    ["402 again", () => ({ status: 402, body: "{}" })],
    ["200 without receipt", () => ({ status: 200, body: "data" })],
    ["settle failed", () => ({ status: 200, body: "data", settle: { success: false, errorReason: "x", transaction: "", network: "eip155:42220" } })],
    ["500", () => ({ status: 500 })],
  ];
  for (const [name, paid] of cases) {
    const s = server(quote(), paid);
    const out = await new X402Signer({ account, fetcher: s.fetcher }).pay(req());
    assert.equal(out.status, "uncertain", name);
    assert.equal(out.body, undefined, name);
  }
});

test("the spend rule of one request does not leak into the next", async () => {
  const s = server(quote({ amount: "15000" }), () => ({ status: 200, body: "x", settle: ok }));
  const signer = new X402Signer({ account, fetcher: s.fetcher });
  assert.equal((await signer.pay(req({ amount: 10000n }))).status, "failed");
  assert.equal((await signer.pay(req({ amount: 20000n }))).status, "settled");
});

const quoteV1 = (o: { asset?: string; amount?: string; name?: string } = {}) => ({
  x402Version: 1,
  accepts: [{ scheme: "exact", network: "celo", maxAmountRequired: o.amount ?? "10000", resource: URL1, description: "d", mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 60, asset: o.asset ?? USDC, extra: { name: o.name ?? "USDC", version: "2" } }],
  error: "payment_required",
});
const rpc = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}';

test("v1 endpoint (the buy gateway): POST with a JSON body, network \"celo\", maxAmountRequired", async () => {
  const s = server(quoteV1(), () => ({ status: 200, body: '{"result":"0x4d2"}', settle: ok }));
  const out = await new X402Signer({ account, fetcher: s.fetcher }).pay(req({ method: "POST", body: rpc }));
  assert.equal(out.status, "settled");
  assert.equal(out.body, '{"result":"0x4d2"}');
  assert.deepEqual(s.seen.map((x) => [x.method, x.body]), [["POST", rpc], ["POST", rpc]]); // quote request and paid request carry the same call
  const a = s.calls[0].sig.payload.authorization;
  assert.equal(a.value, "10000");
  assert.equal(a.to.toLowerCase(), PAY_TO);
});

test("v1: nothing is signed for an amount above the approval or another token", async () => {
  for (const q of [quoteV1({ amount: "20001" }), quoteV1({ asset: USDT, name: "Tether USD" })]) {
    const s = server(q, () => ({ status: 200, settle: ok }));
    const out = await new X402Signer({ account, fetcher: s.fetcher }).pay(req({ method: "POST", body: rpc }));
    assert.equal(out.status, "failed");
    assert.equal(s.calls.length, 0);
  }
});
