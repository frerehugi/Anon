import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteDb } from "../src/indexer/sqliteDb.js";
import { decodeAbiString, parseRegistryLines, REGISTERED_TOPIC, URI_UPDATED_TOPIC, type AgentEvent } from "../src/directory/events.js";
import { eventStatements } from "../src/directory/store.js";
import { processPending, runProbes, runRegistryCycle, trimWindow } from "../src/directory/crawler.js";
import { directoryStats, getAgent, listAgents } from "../src/directory/queries.js";
import { chainStatements } from "../src/directory/chain.js";
import type { RegistrySource, RegistryWindow } from "../src/directory/registrySource.js";
import type { Fetcher } from "../src/net.js";
import { RetryableSourceError } from "../src/indexer/types.js";

const OWNER = "0x" + "a".repeat(40);
const hex = (n: number | bigint, len = 64) => n.toString(16).padStart(len, "0");
function abiString(s: string) {
  const b = Buffer.from(s, "utf8");
  return "0x" + hex(32) + hex(b.length) + b.toString("hex").padEnd(Math.ceil(b.length / 32) * 64, "0");
}
const dataUri = (o: unknown) => "data:application/json;base64," + Buffer.from(JSON.stringify(o)).toString("base64");
let li = 0;
const ev = (kind: AgentEvent["kind"], agentId: number, uri: string | null, block = 100, actor = OWNER): AgentEvent =>
  ({ kind, agentId, actor, uri, block, ts: 1_780_000_000 + block, txHash: "0x" + hex(block), logIndex: li++ });

const regFile = (extra: object = {}) => ({
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Demo", description: "d", active: true,
  services: [{ name: "api", endpoint: "https://demo.example/paid" }], x402Support: true, ...extra,
});

const paid402 = JSON.stringify({
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "eip155:42220", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", amount: "10000", payTo: "0x" + "9".repeat(40), maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
  resource: { url: "https://demo.example/paid" },
});
const fakeFetcher = (routes: Record<string, { status: number; body: string; headers?: Record<string, string> } | Error>): Fetcher => async (url) => {
  const r = routes[url];
  if (!r) throw new Error("no route " + url);
  if (r instanceof Error) throw r;
  return { status: r.status, body: r.body, headers: new Headers(r.headers ?? {}) };
};

function freshDb() { const db = new SqliteDb(); db.migrate(); return db; }

test("decodeAbiString decodes and rejects malformed data", () => {
  assert.equal(decodeAbiString(abiString("https://x.example/a.json")).value, "https://x.example/a.json");
  assert.equal(decodeAbiString(abiString("")).value, "");
  assert.equal(decodeAbiString(abiString("héllo")).value, "héllo");
  assert.ok(decodeAbiString("0x1234").error);
  assert.equal(decodeAbiString("0x" + hex(32) + hex(999) + "00").error, "truncated");
  assert.equal(decodeAbiString("0x" + hex(99999)  + hex(1)).error, "bad_offset");
});

test("parseRegistryLines reads both event kinds and the last block", () => {
  const lines = [
    { header: { number: 5, timestamp: 50 }, logs: [{ topics: [REGISTERED_TOPIC, "0x" + hex(7), "0x" + "0".repeat(24) + "b".repeat(40)], data: abiString("ipfs://abc"), transactionHash: "0x1", logIndex: 1 }] },
    { header: { number: 6, timestamp: 60 }, logs: [{ topics: [URI_UPDATED_TOPIC, "0x" + hex(7), "0x" + "0".repeat(24) + "c".repeat(40)], data: abiString("https://n"), transactionHash: "0x2", logIndex: 0 }, { topics: ["0xdead", "0x1", "0x2"], data: "0x", transactionHash: "0x3", logIndex: 2 }] },
    { header: { number: 9, timestamp: 90 } },
  ];
  const r = parseRegistryLines(lines);
  assert.equal(r.lastBlock, 9);
  assert.deepEqual(r.events.map((e) => [e.kind, e.agentId, e.uri, e.actor.slice(-2)]), [["registered", 7, "ipfs://abc", "bb"], ["uri_updated", 7, "https://n", "cc"]]);
});

test("data: URI registration is parsed immediately, endpoints are synced on update", async () => {
  const db = freshDb();
  await db.batch(eventStatements(ev("registered", 1, dataUri(regFile())), 1000));
  let a = await getAgent(db, 1);
  assert.equal(a?.registrationStatus, "ok");
  assert.equal(a?.name, "Demo");
  assert.equal(a?.endpoints.length, 1);
  assert.equal(a?.x402Status, "declared_unverified");
  // update drops the old endpoint and adds a new one
  await db.batch(eventStatements(ev("uri_updated", 1, dataUri(regFile({ services: [{ name: "api", endpoint: "https://other.example/x402" }] })), 101), 2000));
  a = await getAgent(db, 1);
  assert.deepEqual(a?.endpoints.map((e) => e.url), ["https://other.example/x402"]);
  assert.equal(a?.owner, OWNER); // updater does not change the owner
  db.close();
});

test("https URI waits for fetch; processPending retries then gives up", async () => {
  const db = freshDb();
  await db.batch(eventStatements(ev("registered", 2, "https://reg.example/2.json"), 1000));
  await db.batch(eventStatements(ev("registered", 3, "https://reg.example/3.json"), 1000));
  await db.batch(eventStatements(ev("registered", 4, "https://reg.example/4.json"), 1000));
  assert.equal((await getAgent(db, 2))?.registrationStatus, "pending");
  let now = 1_000_000;
  const f = fakeFetcher({
    "https://reg.example/2.json": { status: 200, body: JSON.stringify(regFile()) },
    "https://reg.example/3.json": new Error("timeout"),
    "https://reg.example/4.json": { status: 404, body: "" },
  });
  const s1 = await processPending(db, f, { max: 10, now: () => now });
  assert.deepEqual(s1, { attempted: 3, ok: 1, failed: 1, gaveUp: 1 });
  assert.equal((await getAgent(db, 2))?.registrationStatus, "ok");
  assert.equal((await getAgent(db, 4))?.registrationStatus, "unreadable");
  // agent 3 is not due yet, due after backoff
  assert.equal((await processPending(db, f, { max: 10, now: () => now + 10 })).attempted, 0);
  now += 3 * 3600;
  assert.equal((await processPending(db, f, { max: 10, now: () => now })).failed, 1);
  now += 10 * 3600;
  const s3 = await processPending(db, f, { max: 10, now: () => now });
  assert.equal(s3.gaveUp, 1); // third attempt is final
  assert.equal((await getAgent(db, 3))?.registrationStatus, "unreadable");
  db.close();
});

test("runProbes records pass/fail and schedules re-checks", async () => {
  const db = freshDb();
  await db.batch(eventStatements(ev("registered", 1, dataUri(regFile())), 1000));
  await db.batch(eventStatements(ev("registered", 2, dataUri(regFile({ services: [{ name: "api", endpoint: "https://bad.example/x402" }] }))), 1000));
  const now = 2_000_000;
  const f = fakeFetcher({
    "https://demo.example/paid": { status: 402, body: paid402, headers: { "content-type": "application/json" } },
    "https://bad.example/x402": { status: 200, body: "{}" },
  });
  const sum = await runProbes(db, f, { max: 10, now: () => now });
  assert.equal(sum.probed, 2);
  assert.equal(sum.pass, 1);
  const good = await getAgent(db, 1);
  assert.equal(good?.x402Status, "live");
  assert.deepEqual(good?.endpoints[0].payTo, ["0x" + "9".repeat(40)]);
  assert.deepEqual(good?.endpoints[0].assets, ["USDC"]);
  assert.equal((await getAgent(db, 2))?.x402Status, "declared_failing");
  assert.equal((await runProbes(db, f, { max: 10, now: () => now + 60 })).probed, 0);
  assert.equal((await runProbes(db, f, { max: 10, now: () => now + 7 * 3600 })).probed, 1); // only the passing one is due
  db.close();
});

test("trimWindow keeps whole blocks within the budget", () => {
  const events = [1, 1, 2, 3, 3, 4].map((b) => ev("registered", b * 10, null, b));
  const w: RegistryWindow = { events, lastBlock: 50 };
  assert.equal(trimWindow(w, 10), w);
  const t = trimWindow(w, 3);
  assert.equal(t.lastBlock, 2);
  assert.equal(t.events.length, 3);
  assert.ok(t.events.every((e) => e.block <= t.lastBlock));
  const big = trimWindow({ events: [1, 1, 1, 2].map((b) => ev("registered", b, null, b)), lastBlock: 9 }, 2);
  assert.equal(big.lastBlock, 1);
  assert.equal(big.events.length, 3); // one block is never split
});

test("registry cycle resumes from cursor, retries overload, and is idempotent", async () => {
  const db = freshDb();
  const all = [ev("registered", 1, dataUri(regFile()), 10), ev("registered", 2, null, 20), ev("uri_updated", 1, dataUri(regFile({ name: "Renamed" })), 30)];
  let failures = 1;
  const reqs: [number, number][] = [];
  const src: RegistrySource = {
    finalizedHead: async () => 40,
    window: async (from, to) => {
      reqs.push([from, to]);
      if (failures-- > 0) throw new RetryableSourceError("overloaded");
      const evs = all.filter((e) => e.block >= from && e.block <= to);
      return { events: evs, lastBlock: to };
    },
  };
  const opts = { startBlock: 1, windowBlocks: 15, sleep: async () => {}, maxStatements: 100, maxRetries: 3 };
  const s = await runRegistryCycle(db, src, opts);
  assert.equal(s.caughtUp, true);
  assert.equal(s.retries, 1);
  assert.equal((await getAgent(db, 1))?.name, "Renamed");
  assert.equal((await getAgent(db, 2))?.registrationStatus, "unreadable");
  const before = reqs.length;
  const again = await runRegistryCycle(db, src, opts);
  assert.equal(again.windows, 0);
  assert.equal(reqs.length, before);
  db.close();
});

test("queries: filters, owner context, bulk stats", async () => {
  const db = freshDb();
  const bulk = "0x" + "b".repeat(40);
  for (let i = 1; i <= 5; i++) await db.batch(eventStatements(ev("registered", i, dataUri({ name: `Bulk ${i}`, description: "x", services: [] }), 10 + i, bulk), 1000));
  await db.batch(eventStatements(ev("registered", 6, dataUri(regFile({ name: "Weather Pro" })), 50), 1000));
  await runProbes(db, fakeFetcher({ "https://demo.example/paid": { status: 402, body: paid402 } }), { max: 5, now: () => 5000 });
  assert.equal((await listAgents(db, {})).total, 6);
  const x = await listAgents(db, { x402: true });
  assert.deepEqual(x.items.map((i) => i.agentId), [6]);
  assert.equal((await listAgents(db, { live: true })).total, 1);
  assert.equal((await listAgents(db, { q: "weather" })).items[0].agentId, 6);
  assert.equal((await listAgents(db, { q: "%" })).total, 0); // wildcard is escaped
  const b = await listAgents(db, { owner: bulk, limit: 2, order: "id" });
  assert.equal(b.total, 5);
  assert.deepEqual(b.items.map((i) => i.agentId), [1, 2]);
  assert.equal(b.items[0].ownerAgents, 5);
  const st = await directoryStats(db, 5);
  assert.equal(st.agents, 6);
  assert.equal(st.bulkOwners.agents, 5);
  assert.equal(st.agentsLive, 1);
  assert.equal(st.distinctOwners, 2);
  db.close();
});

test("reputation stats: distinct clients, bulk owners and owner changes", async () => {
  const db = freshDb();
  const bulk = "0x" + "b".repeat(40);
  for (let i = 1; i <= 5; i++) await db.batch(eventStatements(ev("registered", i, dataUri({ name: `Bulk ${i}`, description: "x", services: [] }), 10 + i, bulk), 1000));
  await db.batch(eventStatements(ev("registered", 6, dataUri(regFile({ name: "Solo" })), 50), 1000));
  const row = (agentId: number, repClients: number, repCount: number, ownerNow: string | null) => ({ agentId, checkedAt: 1, checkedBlock: 1, ownerNow, agentWallet: null, repClients, repCount, repValue: "0", repDecimals: 0 });
  await db.batch(chainStatements([
    row(1, 1, 50, bulk), row(2, 3, 3, bulk), row(3, 25, 40, "0x" + "c".repeat(40)), row(4, 0, 0, bulk), row(6, 2, 2, "0x" + "d".repeat(40)),
  ]));
  const r = (await directoryStats(db, 5)).reputation;
  assert.equal(r.withEntries, 4);
  assert.deepEqual(r.byDistinctClients, { one: 1, twoToFour: 2, fiveToNineteen: 0, twentyOrMore: 1 });
  assert.equal(r.singleClientEntries, 50);
  assert.deepEqual(r.bulkOwners, { checked: 4, withEntries: 3, moreThanOneClient: 2, ownerChanged: 1 });
  assert.deepEqual(r.otherOwners, { checked: 1, withEntries: 1, moreThanOneClient: 1, ownerChanged: 1 });
  assert.deepEqual(r.declaredX402, { checked: 1, withEntries: 1, moreThanOneClient: 1 });
  db.close();
});
