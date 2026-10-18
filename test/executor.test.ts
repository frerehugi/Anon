import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicy, toAtomic, PolicyError, canonicalUrl } from "../src/executor/policy.js";
import { parseApproval, loadApprovals } from "../src/executor/approval.js";
import { evaluate, spentTotal, type PayRequest, type State } from "../src/executor/engine.js";
import { Executor, type Signer } from "../src/executor/executor.js";
import { JsonlLedger, MemoryLedger } from "../src/executor/ledger.js";

const URL1 = "https://gateway.usebuy.ai/chainstack/celo";
const limits = readFileSync("loop/policy/limits.yaml", "utf8");
const allow = readFileSync("loop/policy/allowlist.yaml", "utf8").replace("enabled: false", "enabled: true");
const policy = parsePolicy(limits, allow);
const NOW = 1_800_000_000;
const approval = parseApproval(JSON.stringify({ id: "a1", memo: "m1", experiment: "e1", cap: "1.00", expires: new Date((NOW + 3600) * 1000).toISOString(), approvedBy: "cio" }));
const req = (o: Partial<PayRequest> = {}): PayRequest => ({ id: "r1", wallet: "ops", url: URL1, token: "USDC", amount: toAtomic("0.10"), experiment: "e1", approvalId: "a1", ...o });
const state = (o: Partial<State> = {}): State => ({ entries: [], approvals: [approval], gate2: false, killed: false, now: NOW, ...o });
const reasons = (r: PayRequest, s = state()) => evaluate(r, policy, s).reasons.join(" | ");

test("toAtomic is exact and strict", () => {
  assert.equal(toAtomic(0.25), 250000n);
  assert.equal(toAtomic("1.000001"), 1000001n);
  assert.equal(toAtomic(100), 100000000n);
  for (const bad of ["1.0000001", "-1", "1e3", "", "abc", NaN, null]) assert.throws(() => toAtomic(bad), PolicyError);
});

test("shipped policy parses; disabled endpoints stay off; bad config fails closed", () => {
  const shipped = parsePolicy(limits, readFileSync("loop/policy/allowlist.yaml", "utf8"));
  assert.equal(shipped.endpoints.length, 0); // nothing enabled by default
  assert.equal(policy.endpoints.length, 1);
  assert.equal(policy.perCallMax, 250000n);
  assert.throws(() => parsePolicy(limits.replace("chain_id: 42220", "chain_id: 1"), allow), PolicyError);
  assert.throws(() => parsePolicy(limits.replace("reserve: 40", "reserve: 90"), allow), PolicyError);
  assert.throws(() => parsePolicy(limits.replace(/per_call:[\s\S]*?\n\S/, "x:\n_"), allow), PolicyError);
  assert.throws(() => parsePolicy(limits, allow.replace("enabled: true", "enabled: 'yes'")).endpoints.length === 0 && (() => { throw new PolicyError("ok"); })(), PolicyError);
});

test("canonicalUrl", () => {
  assert.equal(canonicalUrl("https://Gateway.usebuy.ai/chainstack/celo/?x=1#f"), URL1);
  assert.equal(canonicalUrl("http://gateway.usebuy.ai/x"), null);
  assert.equal(canonicalUrl("https://u:p@gateway.usebuy.ai/x"), null);
  assert.equal(canonicalUrl("not a url"), null);
});

test("a valid request is allowed", () => assert.equal(reasons(req()), ""));

test("method and body rules", () => {
  assert.equal(reasons(req({ method: "POST", body: "{}" })), "");
  assert.match(reasons(req({ method: "GET", body: "{}" })), /body/);
  assert.match(reasons(req({ body: "{}" })), /body/);
  assert.match(reasons(req({ method: "POST", body: "x".repeat(20_001) })), /body/);
  assert.match(reasons(req({ method: "PUT" as never })), /GET or POST/);
});

test("denials: endpoint, token, amount, approval", () => {
  assert.match(reasons(req({ url: "https://evil.example/pay" })), /allowlist/);
  assert.match(reasons(req({ url: URL1 + "/other" })), /allowlist/);
  assert.match(reasons(req({ url: "http://gateway.usebuy.ai/chainstack/celo" })), /https/);
  assert.match(reasons(req({ token: "wARS" })), /token/);
  assert.match(reasons(req({ amount: toAtomic("0.26") })), /per-call/);
  assert.match(reasons(req({ amount: 0n })), /positive/);
  assert.match(reasons(req({ approvalId: undefined })), /approval/);
  assert.match(reasons(req({ approvalId: "nope" })), /approval/);
  assert.match(reasons(req({ experiment: "e2" })), /different experiment/);
  assert.match(reasons(req(), state({ now: NOW + 7200 })), /expired/);
  assert.match(reasons(req(), state({ killed: true })), /kill switch/);
});

const entry = (o: object) => ({ requestId: "x" + Math.random(), ts: NOW, status: "settled" as const, wallet: "ops" as const, url: URL1, token: "USDC", amount: toAtomic("0.25"), experiment: "e1", approvalId: "a1", ...o });

test("cumulative limits: approval cap, experiment, daily, total; uncertain counts, failed does not", () => {
  const four = [1, 2, 3, 4].map(() => entry({}));
  assert.match(reasons(req({ amount: toAtomic("0.10") }), state({ entries: four })), /approval cap/); // 1.00 used
  const exp = parseApproval(JSON.stringify({ id: "a2", memo: "m", experiment: "e1", cap: "50", expires: new Date((NOW + 99) * 1000).toISOString(), approvedBy: "cio" }));
  const twenty = Array.from({ length: 20 }, () => entry({ approvalId: "a2", wallet: "treasury", ts: NOW - 86400 * 2 }));
  assert.match(reasons(req({ approvalId: "a2" }), state({ approvals: [exp], entries: twenty })), /experiment limit/); // 5.00 used
  assert.match(reasons(req({ amount: toAtomic("0.25") }), state({ approvals: [exp], entries: Array.from({ length: 12 }, () => entry({ approvalId: "a2", experiment: "other", ts: NOW })) })), /daily limit/); // 3.00 ops today
  const failed = [1, 2, 3, 4].map(() => entry({ status: "failed" }));
  assert.equal(reasons(req(), state({ entries: failed })), "");
  const uncertain = [1, 2, 3, 4].map(() => entry({ status: "uncertain" }));
  assert.match(reasons(req(), state({ entries: uncertain })), /approval cap/);
  // total budget before/after gate 2 (30 vs 60)
  const big = parseApproval(JSON.stringify({ id: "a3", memo: "m", experiment: "e9", cap: "100", expires: new Date((NOW + 99) * 1000).toISOString(), approvedBy: "cio" }));
  const spend30 = Array.from({ length: 120 }, (_, i) => entry({ approvalId: "a3", experiment: `x${i}`, wallet: "treasury", ts: NOW - 86400 * (1 + i) }));
  assert.equal(spentTotal(spend30), toAtomic(30));
  assert.match(reasons(req({ approvalId: "a3", experiment: "e9" }), state({ approvals: [big], entries: spend30 })), /before gate 2/);
  assert.equal(reasons(req({ approvalId: "a3", experiment: "e9" }), state({ approvals: [big], entries: spend30, gate2: true })), "");
});

test("a used request id is rejected; a denied or dry-run id may be reused", () => {
  assert.match(reasons(req({ id: "dup" }), state({ entries: [entry({ requestId: "dup", status: "failed" })] })), /already used/);
  assert.equal(reasons(req({ id: "d" }), state({ entries: [entry({ requestId: "d", status: "denied" })] })), "");
  assert.equal(reasons(req({ id: "d" }), state({ entries: [entry({ requestId: "d", status: "dry_run" })] })), "");
});

function make(signer?: Signer, over: { killed?: () => boolean } = {}) {
  const ledger = new MemoryLedger();
  return { ledger, ex: new Executor({ policy, ledger, signer, approvals: () => [approval], gate2: () => false, killed: over.killed ?? (() => false), now: () => NOW }) };
}

test("executor: dry run by default, denied requests are recorded, nothing is signed", async () => {
  let signed = 0;
  const { ex, ledger } = make({ attributed: true, pay: async () => { signed++; return { status: "settled" }; } });
  assert.equal((await ex.execute(req())).status, "dry_run");
  assert.equal((await ex.execute(req({ id: "r2", url: "https://evil.example" }), { dryRun: false })).status, "denied");
  assert.equal(signed, 0);
  assert.deepEqual(ledger.entries.map((e) => e.status), ["dry_run", "denied"]);
  assert.equal(spentTotal(ledger.entries), 0n);
});

test("executor: live path writes ahead, records outcome, thrown signer means uncertain and is never retried", async () => {
  const seen: string[] = [];
  const { ex, ledger } = make({ attributed: true, pay: async (r) => { seen.push(r.id); if (r.id === "boom") throw new Error("socket hang up"); return { status: "settled", txHash: "0xabc" }; } });
  const ok = await ex.execute(req({ id: "ok" }), { dryRun: false });
  assert.equal(ok.status, "settled");
  assert.deepEqual(ledger.entries.filter((e) => e.requestId === "ok").map((e) => e.status), ["pending", "settled"]);
  const boom = await ex.execute(req({ id: "boom" }), { dryRun: false });
  assert.equal(boom.status, "uncertain");
  const again = await ex.execute(req({ id: "boom" }), { dryRun: false });
  assert.equal(again.status, "denied");
  assert.deepEqual(seen, ["ok", "boom"]);
  assert.equal(spentTotal(ledger.entries), toAtomic("0.20")); // uncertain still counts
});

test("executor: kill switch is re-read right before signing", async () => {
  let calls = 0; let signed = 0;
  const { ex, ledger } = make({ attributed: true, pay: async () => { signed++; return { status: "settled" }; } }, { killed: () => ++calls > 1 }); // off for the policy check, on at signing time
  const r = await ex.execute(req({ id: "k1" }), { dryRun: false });
  assert.equal(r.status, "failed");
  assert.equal(signed, 0);
  assert.equal(spentTotal(ledger.entries), 0n);
});

test("executor: parallel requests cannot exceed the approval cap", async () => {
  let signed = 0;
  const { ex, ledger } = make({ attributed: true, pay: async () => { signed++; await new Promise((r) => setTimeout(r, 5)); return { status: "settled" }; } });
  const res = await Promise.all([1, 2, 3, 4, 5].map((i) => ex.execute(req({ id: `p${i}`, amount: toAtomic("0.25") }), { dryRun: false })));
  assert.equal(res.filter((r) => r.status === "settled").length, 4); // cap 1.00
  assert.equal(res.filter((r) => r.status === "denied").length, 1);
  assert.equal(signed, 4);
  assert.equal(spentTotal(ledger.entries), toAtomic("1.00"));
});

test("approvals: strict parsing, duplicate ids and broken files are errors", () => {
  assert.throws(() => parseApproval(JSON.stringify({ id: "a", memo: "m", experiment: "e", cap: "1", expires: "2030-01-01", approvedBy: "cto" })));
  assert.throws(() => parseApproval(JSON.stringify({ id: "a", memo: "m", experiment: "e", cap: "1", expires: "soon", approvedBy: "cio" })));
  const dir = mkdtempSync(join(tmpdir(), "appr-"));
  const ok = JSON.stringify({ id: "a", memo: "m", experiment: "e", cap: "1", expires: "2030-01-01", approvedBy: "cio" });
  writeFileSync(join(dir, "1.json"), ok);
  assert.equal(loadApprovals(dir).length, 1);
  writeFileSync(join(dir, "2.json"), ok);
  assert.throws(() => loadApprovals(dir), /duplicate/);
  writeFileSync(join(dir, "2.json"), "{broken");
  assert.throws(() => loadApprovals(dir), /2\.json/);
});

test("jsonl ledger round-trips bigint and rejects corrupt lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "led-"));
  const l = new JsonlLedger(join(dir, "p.jsonl"));
  assert.deepEqual(await l.all(), []);
  await l.append(entry({ requestId: "z", amount: 123456789012345678901n }));
  assert.equal((await l.all())[0].amount, 123456789012345678901n);
  writeFileSync(join(dir, "p.jsonl"), "{nope\n");
  await assert.rejects(l.all(), /corrupt/);
});
