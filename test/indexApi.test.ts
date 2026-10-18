import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { parseAgentsQuery, parseReportQuery } from "../src/indexProxy.js";
import { toPublicReport } from "../src/indexer/publicReport.js";
import { buildApp } from "../src/server.js";

const ADDR = "0x" + "a".repeat(40);

test("report query: days in range, nothing else passes", () => {
  assert.deepEqual(parseReportQuery({}), { ok: true, value: { path: "/v1/report", search: "" } });
  assert.deepEqual(parseReportQuery({ days: "2" }), { ok: true, value: { path: "/v1/report", search: "days=2" } });
  for (const days of ["0", "31", "abc", "1e2", "-1", "2; drop"]) assert.equal(parseReportQuery({ days }).ok, false, days);
  assert.deepEqual(parseReportQuery({ days: "2", evil: "x" }), { ok: true, value: { path: "/v1/report", search: "days=2" } });
});

test("agents query: allowlisted filters only, id wins, bad values rejected", () => {
  assert.deepEqual(parseAgentsQuery({ id: "9973" }), { ok: true, value: { path: "/v1/agents/9973", search: "" } });
  const r = parseAgentsQuery({ x402: "1", live: "1", tag: "x402", q: "chain", owner: ADDR, order: "id", limit: "5", offset: "10", evil: "1" });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.search, `x402=1&live=1&tag=x402&q=chain&owner=${ADDR}&order=id&limit=5&offset=10`);
  for (const bad of [{ id: "-1" }, { id: "1.5" }, { x402: "yes" }, { tag: "A B" }, { q: "" }, { q: "x".repeat(81) }, { owner: "0x12" }, { order: "random" }, { limit: "0" }, { limit: "101" }, { offset: "-1" }]) {
    assert.equal(parseAgentsQuery(bad as never).ok, false, JSON.stringify(bad));
  }
});

test("public report drops the per-seller table and keeps aggregates", () => {
  const full: any = { version: "0.1.0", window: { from: 1, to: 2, days: 2 }, totals: { settlements: 3 }, byToken: {}, concentration: {}, circuit: { components: 2, addresses: 7, settlements: 3, gmvUsd: 1, settlementShare: 1, gmvShare: 1 },
    independent: {}, facilitators: {}, labels: {}, daily: [], sellers: [{ payTo: ADDR, settlements: 3 }], meta: { windowDays: 2 } };
  const pub: any = toPublicReport(full);
  assert.equal("sellers" in pub, false);
  assert.equal(pub.circuit.addresses, 7); // a count, not addresses
  assert.equal(pub.totals.settlements, 3);
  assert.doesNotMatch(JSON.stringify(pub), new RegExp(ADDR));
});

async function withServer(env: Record<string, string>, fetchImpl: typeof fetch, run: (base: string) => Promise<void>) {
  const old = { ...process.env };
  Object.assign(process.env, env);
  const app = await buildApp({ fetchImpl });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  try { await run(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`); } finally {
    srv.close();
    for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

test("Index routes exist only when configured; bad input is 400 before any payment; token never leaves the server", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fakeIndex: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ version: "0.1.0", totals: {}, circuit: {}, sellers: [{ payTo: ADDR }], meta: {} }), { status: 200 });
  };
  // not configured: no Index routes, pricing lists only the two base endpoints
  await withServer({ DEV_UNPAID: "1" }, fakeIndex, async (b) => {
    assert.equal((await fetch(`${b}/v1/index/report`)).status, 404);
    assert.deepEqual(Object.keys((await (await fetch(`${b}/v1/pricing`)).json()).prices), ["check", "lint"]);
  });
  // configured (unpaid dev mode just to exercise the handlers)
  await withServer({ DEV_UNPAID: "1", INDEX_URL: "https://idx.example", INDEX_READ_TOKEN: "secret-token" }, fakeIndex, async (b) => {
    assert.equal((await fetch(`${b}/v1/index/report?days=99`)).status, 400);
    assert.equal(calls.length, 0);
    const ok = await fetch(`${b}/v1/index/report?days=2`);
    assert.equal(ok.status, 200);
    const body = await ok.text();
    assert.doesNotMatch(body, /secret-token/);
    assert.doesNotMatch(body, new RegExp(ADDR)); // sellers removed
    assert.deepEqual(calls[0], { url: "https://idx.example/v1/report?days=2", auth: "Bearer secret-token" });
    assert.equal((await fetch(`${b}/v1/index/agents?id=9973`)).status, 200);
    assert.equal(calls[1].url, "https://idx.example/v1/agents/9973");
    assert.equal((await fetch(`${b}/v1/index/agents?limit=500`)).status, 400);
  });
  // only https origins without a path are accepted
  await withServer({ DEV_UNPAID: "1", INDEX_URL: "http://idx.example", INDEX_READ_TOKEN: "t" }, fakeIndex, async (b) => {
    assert.equal((await fetch(`${b}/v1/index/report`)).status, 404);
  });
});
