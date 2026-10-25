import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionResult, parseAbi } from "viem";
import { AGENTS_PER_BATCH, chunk, parseStageA, parseStageB, stageA, stageB, toRows } from "../src/buyjobs/enrich.js";
import { chainStatements, parseChainRows } from "../src/directory/chain.js";

const identityAbi = parseAbi(["function ownerOf(uint256) view returns (address)", "function getAgentWallet(uint256) view returns (address)"]);
const repAbi = parseAbi(["function getClients(uint256) view returns (address[])", "function getSummary(uint256, address[], string, string) view returns (uint64, int128, uint8)"]);
const O = "0x" + "a".repeat(40), W = "0x" + "b".repeat(40), C1 = "0x" + "c".repeat(40), C2 = "0x" + "d".repeat(40);
const ZERO = "0x" + "0".repeat(40);

test("stage A: three calls per agent plus the block number, ids unique, batch size bounded", () => {
  const { body, calls } = stageA([7, 9]);
  const reqs = JSON.parse(body);
  assert.equal(reqs.length, 7);
  assert.equal(new Set(reqs.map((r: any) => r.id)).size, 7);
  assert.deepEqual(calls.map((c) => c.kind), ["owner", "wallet", "clients", "owner", "wallet", "clients", "block"]);
  assert.equal(reqs[6].method, "eth_blockNumber");
  assert.ok(reqs[0].params[0].data.startsWith("0x6352211e")); // ownerOf(uint256)
  assert.throws(() => stageA(Array.from({ length: AGENTS_PER_BATCH + 1 }, (_, i) => i)), /at most/);
  assert.ok(stageA(Array.from({ length: AGENTS_PER_BATCH }, (_, i) => i)).calls.length <= 2000);
});

test("stage A answers: owners, zero wallet is none, clients, reverts and order independence", () => {
  const { calls } = stageA([7, 9]);
  const answers = [
    { id: 0, result: encodeFunctionResult({ abi: identityAbi, functionName: "ownerOf", result: O as `0x${string}` }) },
    { id: 1, result: encodeFunctionResult({ abi: identityAbi, functionName: "getAgentWallet", result: W as `0x${string}` }) },
    { id: 2, result: encodeFunctionResult({ abi: repAbi, functionName: "getClients", result: [C1, C2] as `0x${string}`[] }) },
    { id: 3, error: { code: 3, message: "execution reverted" } }, // no such token
    { id: 4, result: encodeFunctionResult({ abi: identityAbi, functionName: "getAgentWallet", result: ZERO as `0x${string}` }) },
    { id: 5, result: encodeFunctionResult({ abi: repAbi, functionName: "getClients", result: [] }) },
    { id: 6, result: "0x4d2" },
  ].reverse();
  const r = parseStageA(JSON.stringify(answers), calls);
  assert.deepEqual(r.byAgent.get(7), { ownerNow: O, agentWallet: W, clients: [C1, C2] });
  assert.deepEqual(r.byAgent.get(9), { ownerNow: null, agentWallet: null, clients: [] });
  assert.equal(r.block, 1234);
  assert.equal(r.rpcErrors, 1);
  assert.throws(() => parseStageA("{}", calls), /batch/);
});

test("stage B and the final rows", () => {
  const sa = new Map([[7, { ownerNow: O, agentWallet: W, clients: [C1, C2] }], [9, { ownerNow: O, agentWallet: null, clients: [] }], [11, { ownerNow: null, agentWallet: null, clients: null }]]);
  const { body, calls } = stageB([{ agentId: 7, clients: [C1, C2] }]);
  assert.equal(JSON.parse(body)[0].params[0].to.toLowerCase(), "0x8004baa17c55a88189ae136b182e5fdA19dE9b63".toLowerCase());
  const out = parseStageB(JSON.stringify([{ id: 0, result: encodeFunctionResult({ abi: repAbi, functionName: "getSummary", result: [5n, -120n, 2] }) }]), calls);
  assert.deepEqual(out.byAgent.get(7), { count: 5, value: "-120", decimals: 2 });
  const rows = toRows(sa, out.byAgent, 1234);
  const by = new Map(rows.map((r) => [r.agentId, r]));
  assert.deepEqual(by.get(7), { agentId: 7, checkedBlock: 1234, ownerNow: O, agentWallet: W, repClients: 2, repCount: 5, repValue: "-120", repDecimals: 2 });
  assert.equal(by.get(9)?.repCount, 0); // no clients: no ratings
  assert.equal(by.get(9)?.repValue, "0");
  assert.equal(by.get(11)?.repClients, null); // could not be read
  assert.equal(by.get(11)?.repCount, null);
});

test("chunk", () => assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));

test("ingest rows are validated strictly and written as bounded upserts", () => {
  const ok = parseChainRows([{ agentId: 7, checkedBlock: 100, ownerNow: O.toUpperCase().replace("0X", "0x"), agentWallet: null, repClients: 2, repCount: 5, repValue: "-120", repDecimals: 2 }], 1000);
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.rows[0].ownerNow, O); assert.equal(ok.rows[0].checkedAt, 1000); }
  for (const bad of [[], "x", [{ agentId: -1 }], [{ agentId: 1.5 }], [{ agentId: 1, ownerNow: "0x12" }], [{ agentId: 1, repValue: "1e5" }], [{ agentId: 1, repValue: "1); drop" }], Array.from({ length: 501 }, (_, i) => ({ agentId: i }))]) {
    assert.equal(parseChainRows(bad, 1).ok, false, JSON.stringify(bad).slice(0, 40));
  }
  const rows = Array.from({ length: 25 }, (_, i) => ({ agentId: i, checkedAt: 1, checkedBlock: 1, ownerNow: null, agentWallet: null, repClients: 0, repCount: 0, repValue: "0", repDecimals: null }));
  const stmts = chainStatements(rows);
  assert.ok(stmts.every((s) => (s.params?.length ?? 0) <= 100));
  assert.equal(stmts.length, 3); // 11 rows of 9 params per statement
});

import { runEnrich } from "../src/buyjobs/enrichRun.js";
import type { Executor } from "../src/executor/executor.js";
import type { Fetcher } from "../src/net.js";

function fakeSetup(opts: { deny?: boolean } = {}) {
  const requests: { id: string; body: string }[] = [];
  const ingested: any[] = [];
  const ex = {
    check: async () => ({ allow: !opts.deny, reasons: opts.deny ? ["nope"] : [] }),
    execute: async (req: any) => {
      requests.push({ id: req.id, body: req.body });
      if (opts.deny) return { decision: { allow: false, reasons: ["nope"] }, status: "denied" };
      const arr = JSON.parse(req.body);
      let results: object[];
      if (arr[0].params[0].data.startsWith("0x6352211e")) { // stage A: ownerOf first
        const agents = (arr.length - 1) / 3;
        results = [];
        for (let i = 0; i < agents; i++) {
          const rated = i === 0;
          results.push({ id: i * 3, result: encodeFunctionResult({ abi: identityAbi, functionName: "ownerOf", result: O as `0x${string}` }) });
          results.push({ id: i * 3 + 1, result: encodeFunctionResult({ abi: identityAbi, functionName: "getAgentWallet", result: ZERO as `0x${string}` }) });
          results.push({ id: i * 3 + 2, result: encodeFunctionResult({ abi: repAbi, functionName: "getClients", result: (rated ? [C1] : []) as `0x${string}`[] }) });
        }
        results.push({ id: agents * 3, result: "0x10" });
      } else {
        results = arr.map((r: any) => ({ id: r.id, result: encodeFunctionResult({ abi: repAbi, functionName: "getSummary", result: [3n, 90n, 0] }) }));
      }
      return { decision: { allow: true, reasons: [] }, status: "settled", txHash: "0x" + "ab".repeat(32), body: JSON.stringify(results) };
    },
  } as unknown as Executor;
  const f: Fetcher = async (url, init) => {
    if (url.includes("/v1/agent-ids")) return { status: 200, headers: new Headers(), body: JSON.stringify({ ids: [11, 12] }) };
    if (url.includes("/v1/ingest/agent-chain")) { ingested.push({ auth: (init?.headers as any)?.authorization, body: JSON.parse(init!.body!) }); return { status: 200, headers: new Headers(), body: "{}" }; }
    throw new Error("unexpected " + url);
  };
  return { ex, f, requests, ingested };
}
const base = { indexUrl: "https://idx.example", readToken: "r", scope: "x402" as const, limit: 100, staleHours: 24, approvalId: "enrich", now: () => new Date("2026-10-26T10:00:00Z") };

test("enrich dry run: plans and checks policy, pays and stores nothing", async () => {
  const s = fakeSetup();
  const out: any = await runEnrich(s.ex, s.f, { ...base, live: false });
  assert.equal(out.status, "dry_run");
  assert.equal(out.plan.agents, 2);
  assert.equal(out.decision.allow, true);
  assert.equal(s.requests.length, 0);
  assert.equal(s.ingested.length, 0);
});

test("enrich live: stage A and B are paid one after another, rows are ingested with the write token", async () => {
  const s = fakeSetup();
  const out: any = await runEnrich(s.ex, s.f, { ...base, live: true, writeToken: "w" });
  assert.deepEqual(s.requests.map((r) => r.id), ["enrich-20261026100000-a1", "enrich-20261026100000-b1-1"]);
  assert.equal(s.ingested.length, 1);
  assert.equal(s.ingested[0].auth, "Bearer w");
  const rows = s.ingested[0].body.rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { agentId: 11, checkedBlock: 16, ownerNow: O, agentWallet: null, repClients: 1, repCount: 3, repValue: "90", repDecimals: 0 });
  assert.equal(rows[1].repCount, 0);
  assert.equal(out.stored, 2);
  assert.equal(out.withReputation, 1);
});

test("enrich: a refused payment stops the job, and a missing write token is an error", async () => {
  const s = fakeSetup({ deny: true });
  const out: any = await runEnrich(s.ex, s.f, { ...base, live: true, writeToken: "w" });
  assert.equal(out.status, "denied");
  assert.equal(out.stored, 0);
  assert.equal(s.ingested.length, 0);
  await assert.rejects(runEnrich(fakeSetup().ex, fakeSetup().f, { ...base, live: true }), /INDEX_WRITE_TOKEN/);
});
