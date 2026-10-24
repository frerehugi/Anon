import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { auditSample, parseReceipts, receiptBatch, verifyReceipt, type Receipt, type SettlementRef } from "../src/buyjobs/audit.js";
import { fetchCapped } from "../src/net.js";
import { evaluate } from "../src/executor/engine.js";
import { parsePolicy } from "../src/executor/policy.js";
import { readFileSync } from "node:fs";

const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), R = "0x" + "c".repeat(40);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ref = (o: Partial<SettlementRef> = {}): SettlementRef => ({ txHash: "0x" + "1".repeat(64), logIndex: 7, block: 1000, token: "USDC", payer: A, payTo: B, amountAtomic: "10000", relayer: R, ...o });
const receipt = (o: Partial<Receipt> = {}): Receipt => ({
  status: "0x1", blockNumber: "0x3e8", from: R,
  logs: [{ address: USDC, topics: [TRANSFER, pad(A), pad(B)], data: "0x" + (10000).toString(16), logIndex: "0x7" }], ...o,
});

test("a receipt that shows the recorded settlement verifies", () => {
  assert.deepEqual(verifyReceipt(ref(), receipt()), { ok: true });
  assert.deepEqual(verifyReceipt(ref({ payer: A.toUpperCase().replace("0X", "0x") }), receipt()), { ok: true }); // case does not matter
  assert.deepEqual(verifyReceipt(ref(), receipt({ from: "0x" + "d".repeat(40) })), { ok: true, softNote: "relayer differs" });
});

test("every kind of difference is caught", () => {
  const bad = (r: SettlementRef, rc: Receipt | null | undefined, re: RegExp) => { const v = verifyReceipt(r, rc); assert.equal(v.ok, false); if (!v.ok) assert.match(v.reason, re); };
  bad(ref(), null, /no receipt/);
  bad(ref(), receipt({ status: "0x0" }), /status/);
  bad(ref(), receipt({ blockNumber: "0x3e9" }), /block/);
  bad(ref({ logIndex: 8 }), receipt(), /no log/);
  bad(ref({ token: "USDT" }), receipt(), /contract/);
  bad(ref({ payer: B }), receipt(), /payer/);
  bad(ref({ payTo: A }), receipt(), /payTo/);
  bad(ref({ amountAtomic: "10001" }), receipt(), /amount/);
  bad(ref(), receipt({ logs: [{ address: USDC, topics: ["0x" + "e".repeat(64), pad(A), pad(B)], data: "0x2710", logIndex: "0x7" }] }), /not a Transfer/);
});

test("batch dedupes transactions and responses are matched by id, not by order", () => {
  const refs = [ref(), ref({ logIndex: 8 }), ref({ txHash: "0x" + "2".repeat(64) })];
  const { body, hashes } = receiptBatch(refs);
  assert.equal(hashes.length, 2);
  assert.equal(JSON.parse(body).length, 2);
  const out = JSON.stringify([{ jsonrpc: "2.0", id: 1, result: null }, { jsonrpc: "2.0", id: 0, result: receipt() }, { jsonrpc: "2.0", id: 5, result: {} }]);
  const { receipts, errors } = parseReceipts(out, hashes);
  assert.equal(errors, 0);
  assert.equal(receipts.get(hashes[0])?.status, "0x1");
  assert.equal(receipts.get(hashes[1]), null);
  assert.equal(parseReceipts(JSON.stringify([{ id: 0, error: { code: -1 } }]), hashes).errors, 1);
  assert.throws(() => parseReceipts("{}", hashes), /batch/);
});

test("a missing receipt is inconclusive, not a mismatch, and stays out of the match rate", () => {
  const refs = [ref(), ref({ txHash: "0x" + "2".repeat(64) }), ref({ txHash: "0x" + "3".repeat(64), amountAtomic: "9" })];
  const receipts = new Map<string, Receipt | null>([[refs[0].txHash, receipt()], [refs[1].txHash, null], [refs[2].txHash, receipt()]]);
  const a = auditSample(refs, receipts);
  assert.equal(a.checked, 3);
  assert.equal(a.matched, 1);
  assert.deepEqual(a.inconclusive, [refs[1].txHash]);
  assert.equal(a.mismatched.length, 1);
  assert.equal(a.matchRate, 0.5); // 1 of the 2 decided
});

test("audit summary counts matches and lists mismatches", () => {
  const refs = [ref(), ref({ txHash: "0x" + "2".repeat(64), amountAtomic: "5" })];
  const receipts = new Map([[refs[0].txHash.toLowerCase(), receipt()], [refs[1].txHash.toLowerCase(), receipt()]]);
  const a = auditSample(refs, receipts);
  assert.equal(a.checked, 2);
  assert.equal(a.matched, 1);
  assert.equal(a.matchRate, 0.5);
  assert.equal(a.mismatched.length, 1);
  assert.match(a.mismatched[0].reason, /amount/);
});

test("fetchCapped: default cap is 64 KB, maxBytes raises it, truncation is flagged", async () => {
  const big = "x".repeat(200_000);
  const srv = createServer((_q, res) => { res.setHeader("content-type", "text/plain"); res.end(big); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = new URL(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`);
  try {
    const small = await fetchCapped(url);
    assert.equal(small.body.length, 64 * 1024);
    assert.equal(small.truncated, true);
    const more = await fetchCapped(url, { maxBytes: 1_000_000 });
    assert.equal(more.body.length, 200_000);
    assert.equal(more.truncated, undefined);
    const exact = await fetchCapped(url, { maxBytes: 200_000 });
    assert.equal(exact.body.length, 200_000);
    assert.equal(exact.truncated, undefined);
  } finally { srv.close(); }
});

test("the executor limits the response size a paid call may ask for", () => {
  const policy = parsePolicy(readFileSync("loop/policy/limits.yaml", "utf8"), readFileSync("loop/policy/allowlist.yaml", "utf8"));
  const approval = { id: "a", memo: "m", experiment: "e", cap: 1_000_000n, expires: 2_000_000_000, approvedBy: "cio" as const };
  const base = { id: "x", wallet: "ops" as const, url: "https://gateway.usebuy.ai/chainstack/celo", method: "POST" as const, body: "[]", token: "USDC", amount: 10000n, experiment: "e", approvalId: "a" };
  const st = { entries: [], approvals: [approval], gate2: false, killed: false, now: 1_800_000_000 };
  assert.equal(evaluate({ ...base, maxResponseBytes: 4_000_000 }, policy, st).allow, true);
  assert.equal(evaluate({ ...base, maxResponseBytes: 9_000_000 }, policy, st).allow, false);
  assert.equal(evaluate({ ...base, maxResponseBytes: 0 }, policy, st).allow, false);
});
