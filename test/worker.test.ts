import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../worker/index.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/indexer/db.js";
import { eventStatements } from "../src/directory/store.js";
import { D1Db } from "../src/indexer/db.js";

class FakeD1 implements D1DatabaseLike {
  raw = new DatabaseSync(":memory:");
  constructor() { for (const f of readdirSync("migrations").filter((n) => n.endsWith(".sql")).sort()) this.raw.exec(readFileSync(`migrations/${f}`, "utf8")); }
  prepare(sql: string): D1PreparedStatementLike {
    const raw = this.raw; let params: unknown[] = [];
    const st: any = { bind(...v: unknown[]) { params = v; return st; }, async all() { return { results: raw.prepare(sql).all(...(params as never[])) }; }, run() { raw.prepare(sql).run(...(params as never[])); } };
    return st;
  }
  async batch(stmts: D1PreparedStatementLike[]) { this.raw.exec("BEGIN"); try { for (const s of stmts as any[]) s.run(); this.raw.exec("COMMIT"); } catch (e) { this.raw.exec("ROLLBACK"); throw e; } return []; }
}

const O = "0x" + "a".repeat(40);
const dataUri = (o: unknown) => "data:application/json;base64," + Buffer.from(JSON.stringify(o)).toString("base64");
async function setup() {
  const d1 = new FakeD1();
  const db = new D1Db(d1);
  for (const id of [1, 2, 3]) await db.batch(eventStatements({ kind: "registered", agentId: id, actor: O, uri: dataUri({ name: `A${id}`, description: "x", services: [] }), block: 10 + id, ts: 1_780_000_000, txHash: "0x" + id, logIndex: id }, 1000));
  const env = { DB: d1, SIGNERS: "", READ_TOKEN: "read-secret", WRITE_TOKEN: "write-secret" } as any;
  const call = (path: string, init: RequestInit = {}, e = env) => worker.fetch(new Request(`https://w.example${path}`, init), e);
  return { d1, env, call };
}
const read = { headers: { authorization: "Bearer read-secret" } };
const write = (body: unknown) => ({ method: "POST", headers: { authorization: "Bearer write-secret", "content-type": "application/json" }, body: JSON.stringify(body) });

test("write route: fail closed, separate token, strict validation, rows show up in the directory", async () => {
  const s = await setup();
  assert.equal((await s.call("/v1/ingest/agent-chain", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await s.call("/v1/ingest/agent-chain", { ...write({ rows: [] }), headers: { authorization: "Bearer read-secret" } })).status, 401); // the read token cannot write
  assert.equal((await s.call("/v1/ingest/agent-chain", write({ rows: [] }), { ...s.env, WRITE_TOKEN: undefined })).status, 503);
  assert.equal((await s.call("/v1/ingest/agent-chain", write({ rows: [{ agentId: 1, ownerNow: "nope" }] }))).status, 400);
  assert.equal((await s.call("/v1/ingest/agent-chain", write({ rows: [{ agentId: 1, checkedBlock: 50, ownerNow: O, agentWallet: null, repClients: 2, repCount: 9, repValue: "80", repDecimals: 0 }, { agentId: 2, ownerNow: "0x" + "b".repeat(40), repClients: 0, repCount: 0, repValue: "0" }] }))).status, 200);
  const one: any = await (await s.call("/v1/agents/1", read)).json();
  assert.equal(one.chain.reputation.rawCount, 9);
  assert.equal(one.chain.ownerChanged, false);
  const two: any = await (await s.call("/v1/agents/2", read)).json();
  assert.equal(two.chain.ownerChanged, true); // current owner differs from the registrant
  const three: any = await (await s.call("/v1/agents/3", read)).json();
  assert.equal(three.chain, null);
  const rated: any = await (await s.call("/v1/agents?rated=1", read)).json();
  assert.deepEqual(rated.items.map((i: any) => i.agentId), [1]);
  const health: any = await (await s.call("/health")).json();
  assert.equal(health.directory.chainChecked, 2);
  assert.equal(health.directory.withReputation, 1);
  assert.equal(health.directory.ownerChanged, 1);
});

test("read routes: agent ids skip fresh rows, honor scope, paging and need the read token", async () => {
  const s = await setup();
  assert.equal((await s.call("/v1/agent-ids")).status, 401);
  assert.equal((await s.call("/v1/agent-ids", { headers: { authorization: "Bearer write-secret" } })).status, 401);
  const all: any = await (await s.call("/v1/agent-ids?scope=all", read)).json();
  assert.deepEqual(all.ids, [1, 2, 3]);
  const x402: any = await (await s.call("/v1/agent-ids?scope=x402", read)).json();
  assert.deepEqual(x402.ids, []); // none of these declares x402
  assert.equal((await s.call("/v1/ingest/agent-chain", write({ rows: [{ agentId: 2, repClients: 0, repCount: 0, repValue: "0" }] }))).status, 200);
  const stale: any = await (await s.call(`/v1/agent-ids?scope=all&stale_before=${Math.floor(Date.now() / 1000) - 3600}`, read)).json();
  assert.deepEqual(stale.ids, [1, 3]); // agent 2 was checked a moment ago
  const page: any = await (await s.call("/v1/agent-ids?scope=all&after=1&limit=1", read)).json();
  assert.deepEqual(page.ids, [3]); // default stale_before is 0: only agents never checked, and agent 2 now has a row
  const sample: any = await (await s.call("/v1/audit/sample?n=5", read)).json();
  assert.equal(sample.n, 0);
});
