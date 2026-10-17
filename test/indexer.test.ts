import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { SqliteDb } from "../src/indexer/sqliteDb.js";
import { D1Db, type D1DatabaseLike, type D1PreparedStatementLike } from "../src/indexer/db.js";
import { parseStreamLines } from "../src/indexer/parse.js";
import { runCycle } from "../src/indexer/cycle.js";
import { buildReport } from "../src/indexer/report.js";
import { cursorStatement, getCursor, settlementStatements } from "../src/indexer/store.js";
import { computeMetrics } from "../src/metrics/compute.js";
import { dumpSql } from "../src/indexer/dump.js";
import { RetryableSourceError, type Source, type WindowResult } from "../src/indexer/types.js";

const SIGNER = "0x" + "d".repeat(40);
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const USAT = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C = "0x" + "c".repeat(40);
const T0 = 1_760_000_000;

interface TxSpec { hash: string; status?: number; transfers?: { token: string; payer: string; to: string; atomic: number; logIndex: number }[] }
function blockLine(num: number, txs: TxSpec[]) {
  const logs: any[] = [];
  const transactions = txs.map((t) => {
    for (const tr of t.transfers ?? []) logs.push({ address: tr.token, topics: [TRANSFER, pad(tr.payer), pad(tr.to)], data: "0x" + tr.atomic.toString(16), transactionHash: t.hash, logIndex: tr.logIndex });
    return { hash: t.hash, from: SIGNER, to: USAT, gasUsed: "0x155e1", effectiveGasPrice: "0x2e90fe98e0", status: t.status ?? 1 };
  });
  return { header: { number: num, timestamp: T0 + num }, transactions, logs };
}

/** Scripted stand-in for SQD: serves blocks from a map, can truncate responses and throw retryable errors. */
class ScriptedSource implements Source {
  requests: [number, number][] = [];
  constructor(private blocks: Map<number, any>, private head: number, private opts: { maxRange?: number; failAbove?: number; fail?: number } = {}) {}
  async finalizedHead() { return this.head; }
  async window(from: number, to: number): Promise<WindowResult> {
    this.requests.push([from, to]);
    if (this.opts.fail && this.opts.fail > 0) { this.opts.fail--; throw new RetryableSourceError("overloaded"); }
    if (this.opts.failAbove !== undefined && to - from + 1 > this.opts.failAbove) throw new RetryableSourceError("too big", true);
    const eff = this.opts.maxRange ? Math.min(to, from + this.opts.maxRange - 1) : to;
    const lines: any[] = [];
    for (let b = from; b <= eff; b++) {
      const l = this.blocks.get(b);
      if (l) lines.push(l); else if (b === from || b === eff) lines.push({ header: { number: b, timestamp: T0 + b } });
    }
    const p = parseStreamLines(lines);
    return { settlements: p.settlements, unclassified: p.unclassified, lastBlock: p.lastBlock! };
  }
}

function makeDb() { const db = new SqliteDb(":memory:"); db.migrate(); return db; }
const count = async (db: SqliteDb, table: string) => (await db.all<{ c: number }>(`SELECT COUNT(*) c FROM ${table}`))[0].c;

test("parse: settlement, unclassified (no transfer, failed) and gas only on the first of several transfers", () => {
  const lines = [
    blockLine(10, [
      { hash: "0x01", transfers: [{ token: USAT, payer: A, to: B, atomic: 1_500_000, logIndex: 3 }] },
      { hash: "0x02" }, // signer tx without tracked transfer
      { hash: "0x03", status: 0, transfers: [{ token: USDC, payer: A, to: B, atomic: 1, logIndex: 0 }] }, // failed
      { hash: "0x04", transfers: [{ token: USDC, payer: A, to: C, atomic: 10_000, logIndex: 5 }, { token: USDC, payer: B, to: C, atomic: 20_000, logIndex: 6 }] },
    ]),
    { header: { number: 12, timestamp: T0 + 12 } },
  ];
  const p = parseStreamLines(lines);
  assert.equal(p.lastBlock, 12);
  assert.equal(p.settlements.length, 3);
  const s1 = p.settlements.find((s) => s.txHash === "0x01")!;
  assert.equal(s1.token, "USAT"); assert.equal(s1.usd, 1.5); assert.equal(s1.payer, A); assert.equal(s1.payTo, B);
  assert.equal(s1.gasUsed, 0x155e1); assert.equal(s1.gasPriceWei, 0x2e90fe98e0);
  const multi = p.settlements.filter((s) => s.txHash === "0x04");
  assert.equal(multi[0].gasUsed, 0x155e1); assert.equal(multi[1].gasUsed, null);
  assert.deepEqual(p.unclassified.map((u) => u.txHash).sort(), ["0x02", "0x03"]);
  assert.equal(p.unclassified.find((u) => u.txHash === "0x03")!.status, 0);
});

test("cycle indexes a range, moves the cursor to the head, and a re-run changes nothing", async () => {
  const blocks = new Map<number, any>([
    [105, blockLine(105, [{ hash: "0xa1", transfers: [{ token: USAT, payer: A, to: B, atomic: 1_000_000, logIndex: 0 }] }])],
    [150, blockLine(150, [{ hash: "0xa2", transfers: [{ token: USDC, payer: B, to: C, atomic: 50_000, logIndex: 1 }] }, { hash: "0xa3" }])],
  ]);
  const db = makeDb();
  const src = new ScriptedSource(blocks, 200);
  const s = await runCycle(db, src, { signers: [SIGNER], backfillBlocks: 100, windowBlocks: 60, maxWindows: 20, maxStatements: 1000 });
  assert.equal(s.caughtUp, true);
  assert.equal(await count(db, "settlements"), 2);
  assert.equal(await count(db, "unclassified_txs"), 1);
  assert.equal(await getCursor(db, "sqd-celo"), 200);
  const again = await runCycle(db, new ScriptedSource(blocks, 200), { signers: [SIGNER], windowBlocks: 60, maxStatements: 1000 });
  assert.equal(again.windows, 0);
  assert.equal(await count(db, "settlements"), 2);
  assert.equal((await db.all<{ c: number }>("SELECT COUNT(*) c FROM runs"))[0].c, 2);
});

test("inserting the same settlement twice is ignored (primary key tx_hash + log_index)", async () => {
  const db = makeDb();
  const p = parseStreamLines([blockLine(5, [{ hash: "0xdd", transfers: [{ token: USAT, payer: A, to: B, atomic: 1_000_000, logIndex: 0 }] }])]);
  await db.batch(settlementStatements(p.settlements));
  await db.batch(settlementStatements(p.settlements));
  assert.equal(await count(db, "settlements"), 1);
});

test("a truncated response continues from the last covered block, not from the requested end", async () => {
  const blocks = new Map<number, any>([[130, blockLine(130, [{ hash: "0xb1", transfers: [{ token: USAT, payer: A, to: B, atomic: 1_000_000, logIndex: 0 }] }])]]);
  const db = makeDb();
  const src = new ScriptedSource(blocks, 200, { maxRange: 25 });
  await runCycle(db, src, { signers: [SIGNER], backfillBlocks: 100, windowBlocks: 100, maxWindows: 20, maxStatements: 1000 });
  // each response covers 25 blocks, so the next request must start right after it
  for (let i = 1; i < src.requests.length; i++) assert.equal(src.requests[i][0], src.requests[i - 1][0] + 25);
  assert.equal(await count(db, "settlements"), 1);
  assert.equal(await getCursor(db, "sqd-celo"), 200);
});

test("the window halves on size-related failures and the cycle still completes", async () => {
  const blocks = new Map<number, any>([[180, blockLine(180, [{ hash: "0xc1", transfers: [{ token: USAT, payer: A, to: B, atomic: 1_000_000, logIndex: 0 }] }])]]);
  const db = makeDb();
  const src = new ScriptedSource(blocks, 200, { failAbove: 30 });
  const s = await runCycle(db, src, { signers: [SIGNER], backfillBlocks: 100, windowBlocks: 100, minWindowBlocks: 10, maxWindows: 50, maxStatements: 1000 });
  assert.ok(s.retries >= 2);
  assert.equal(s.caughtUp, true);
  assert.equal(await count(db, "settlements"), 1);
});

test("the statement budget shrinks windows and no data is lost across cycles", async () => {
  const blocks = new Map<number, any>();
  for (let b = 101; b <= 300; b++) blocks.set(b, blockLine(b, [{ hash: "0x" + b.toString(16).padStart(4, "0"), transfers: [{ token: USAT, payer: A, to: B, atomic: 1_000_000, logIndex: 0 }] }]));
  const db = makeDb();
  let cycles = 0, caught = false;
  while (!caught && cycles < 100) {
    const s = await runCycle(db, new ScriptedSource(blocks, 300), { signers: [SIGNER], backfillBlocks: 200, windowBlocks: 200, minWindowBlocks: 10, maxWindows: 8, maxStatements: 12 });
    caught = s.caughtUp; cycles++;
    assert.ok(s.statements <= 12);
  }
  assert.ok(caught && cycles > 1);
  assert.equal(await count(db, "settlements"), 200);
});

test("a failing batch rolls back rows and cursor together", async () => {
  const db = makeDb();
  const p = parseStreamLines([blockLine(5, [{ hash: "0xee", transfers: [{ token: USAT, payer: A, to: B, atomic: 1_000_000, logIndex: 0 }] }])]);
  await assert.rejects(() => db.batch([...settlementStatements(p.settlements), cursorStatement("sqd-celo", 5, 1), { sql: "INSERT INTO no_such_table VALUES (1)" }]));
  assert.equal(await count(db, "settlements"), 0);
  assert.equal(await getCursor(db, "sqd-celo"), null);
});

test("report from the database equals the metrics computed on the same rows, with coverage meta", async () => {
  const blocks = new Map<number, any>();
  // a ring A->B->C->A plus one independent flow, plus one unclassified signer tx
  let n = 0;
  for (const [x, y] of [[A, B], [B, C], [C, A], [A, B], [B, C], [C, A]]) { n++; blocks.set(100 + n, blockLine(100 + n, [{ hash: "0xr" + n, transfers: [{ token: USAT, payer: x, to: y, atomic: 2_000_000, logIndex: 0 }] }])); }
  blocks.set(120, blockLine(120, [{ hash: "0xind", transfers: [{ token: USDC, payer: "0x" + "1".repeat(40), to: "0x" + "5".repeat(40), atomic: 30_000, logIndex: 0 }] }, { hash: "0xother" }]));
  const db = makeDb();
  await runCycle(db, new ScriptedSource(blocks, 130), { signers: [SIGNER], backfillBlocks: 40, windowBlocks: 50, maxStatements: 1000 });
  const rep = await buildReport(db, { days: 1, celoUsd: 0.1 });
  assert.equal(rep.totals.settlements, 7);
  assert.equal(rep.circuit.settlements, 6);
  assert.equal(rep.independent.settlements, 1);
  assert.equal(rep.meta.unclassifiedTxs, 1);
  assert.equal(rep.meta.classified, 7);
  assert.ok(Math.abs(rep.gas!.avgUsdPerSettlement! - 0.00175) < 0.0002); // ~0.0175 CELO at 0.1
  const rows = (await db.all<any>("SELECT * FROM settlements")).map((r) => ({ ts: r.ts, token: r.token, payer: r.payer, payTo: r.pay_to, usd: r.usd, relayer: r.relayer, gasUsed: r.gas_used ?? undefined, gasPriceWei: r.gas_price_wei ?? undefined }));
  assert.equal(computeMetrics(rows, { celoUsd: 0.1 }).totals.gmvUsd, rep.totals.gmvUsd);
});

/** A D1 stand-in backed by node:sqlite, to prove the D1 adapter and the cycle work through the D1 interface. */
class FakeD1 implements D1DatabaseLike {
  raw = new DatabaseSync(":memory:");
  constructor() { for (const f of readdirSync("migrations").filter((n) => n.endsWith(".sql")).sort()) this.raw.exec(readFileSync(`migrations/${f}`, "utf8")); }
  prepare(sql: string): D1PreparedStatementLike {
    const raw = this.raw;
    let params: unknown[] = [];
    const st: any = {
      bind(...v: unknown[]) { params = v; return st; },
      async all() { return { results: raw.prepare(sql).all(...(params as never[])) }; },
      run() { raw.prepare(sql).run(...(params as never[])); },
    };
    return st;
  }
  async batch(stmts: D1PreparedStatementLike[]) {
    this.raw.exec("BEGIN");
    try { for (const s of stmts as any[]) s.run(); this.raw.exec("COMMIT"); } catch (e) { this.raw.exec("ROLLBACK"); throw e; }
    return [];
  }
}

test("the D1 adapter runs a full cycle and a report", async () => {
  const blocks = new Map<number, any>([[110, blockLine(110, [{ hash: "0xf1", transfers: [{ token: USAT, payer: A, to: B, atomic: 1_000_000, logIndex: 0 }] }])]]);
  const db = new D1Db(new FakeD1());
  const s = await runCycle(db, new ScriptedSource(blocks, 140), { signers: [SIGNER], backfillBlocks: 50, windowBlocks: 100, maxStatements: 40 });
  assert.equal(s.caughtUp, true);
  const rep = await buildReport(db, { days: 1 });
  assert.equal(rep.totals.settlements, 1);
  assert.equal(rep.meta.cursorBlock, 140);
});

test("overload (529) is retried on the same window with backoff and does not shrink it", async () => {
  const blocks = new Map<number, any>([[150, blockLine(150, [{ hash: "0x91", transfers: [{ token: USAT, payer: A, to: B, atomic: 1_000_000, logIndex: 0 }] }])]]);
  const db = makeDb();
  const src = new ScriptedSource(blocks, 200, { fail: 2 });
  const delays: number[] = [];
  const s = await runCycle(db, src, { signers: [SIGNER], backfillBlocks: 100, windowBlocks: 100, maxStatements: 1000, maxRetries: 3, backoffMs: 100, sleep: async (ms) => { delays.push(ms); } });
  assert.deepEqual(delays, [100, 200]);
  assert.equal(s.retries, 2);
  assert.deepEqual(src.requests[0], src.requests[1]); // same window, not smaller
  assert.deepEqual(src.requests[1], src.requests[2]);
  assert.equal(await count(db, "settlements"), 1);
});

test("a source that keeps failing ends the cycle with an error after the retry limit, and the run is recorded", async () => {
  const db = makeDb();
  const src = new ScriptedSource(new Map(), 200, { fail: 99 });
  await assert.rejects(() => runCycle(db, src, { signers: [SIGNER], backfillBlocks: 100, windowBlocks: 100, maxRetries: 2, backoffMs: 1, sleep: async () => {} }));
  const run = (await db.all<any>("SELECT status, error FROM runs ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(run.status, "error");
  assert.match(run.error, /overloaded/);
  assert.equal(await getCursor(db, "sqd-celo"), null);
});

test("dump round trip: the exported SQL rebuilds the same rows and cursor, and importing twice is harmless", async () => {
  const blocks = new Map<number, any>([
    [110, blockLine(110, [{ hash: "0xd1", transfers: [{ token: USAT, payer: A, to: B, atomic: 1_234_567, logIndex: 0 }] }, { hash: "0xd2" }])],
    [120, blockLine(120, [{ hash: "0xd3", transfers: [{ token: USDC, payer: B, to: C, atomic: 10_000, logIndex: 2 }] }])],
  ]);
  const src = makeDb();
  await runCycle(src, new ScriptedSource(blocks, 150), { signers: [SIGNER], backfillBlocks: 60, windowBlocks: 100, maxStatements: 1000 });
  const d = await dumpSql(src, { rowsPerStatement: 1 });
  assert.equal(d.settlements, 2);
  assert.equal(d.unclassified, 1);
  const dst = makeDb();
  dst.raw.exec(d.sql);
  dst.raw.exec(d.sql); // second import
  assert.equal(await count(dst, "settlements"), 2);
  assert.equal(await count(dst, "unclassified_txs"), 1);
  assert.equal(await getCursor(dst, "sqd-celo"), 150);
  const a = await src.all<any>("SELECT * FROM settlements ORDER BY tx_hash");
  const b = await dst.all<any>("SELECT * FROM settlements ORDER BY tx_hash");
  assert.deepEqual(b, a);
});

test("SqliteDb.migrate is idempotent: running it twice does not fail on the ALTER TABLE migration", () => {
  const db = new SqliteDb(":memory:");
  db.migrate();
  db.migrate();
  const cols = (db.raw.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("source"));
});

test("a failing head request is retried and, if it keeps failing, recorded as an error run", async () => {
  const db = new SqliteDb(); db.migrate();
  let calls = 0;
  const failing = { finalizedHead: async () => { calls++; throw new RetryableSourceError("finalized-head HTTP 529"); }, window: async () => { throw new Error("unreachable"); } } as unknown as Source;
  await assert.rejects(runCycle(db, failing, { signers: [SIGNER], maxRetries: 2, backoffMs: 1, sleep: async () => {} }), /529/);
  assert.equal(calls, 3);
  const runs = await db.all<{ status: string; error: string }>("SELECT status, error FROM runs");
  assert.deepEqual(runs.map((r) => r.status), ["error"]);
  assert.match(runs[0].error, /529/);
  db.close();
});

test("default fetch is never called as a method (Workers: Illegal invocation)", async () => {
  const real = globalThis.fetch;
  const strict = function (this: unknown, _input: unknown): Promise<Response> {
    if (this !== undefined && this !== globalThis) return Promise.reject(new TypeError("Illegal invocation: function called with incorrect `this` reference"));
    return Promise.resolve(new Response(JSON.stringify({ number: 123 })));
  };
  globalThis.fetch = strict as unknown as typeof fetch;
  try {
    const { SqdSource } = await import("../src/indexer/sqd.js");
    const { SqdRegistrySource } = await import("../src/directory/registrySource.js");
    assert.equal(await new SqdSource().finalizedHead(), 123);
    assert.equal(await new SqdRegistrySource().finalizedHead(), 123);
  } finally {
    globalThis.fetch = real;
  }
});
