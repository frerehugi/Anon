import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, circuitComponents, stronglyConnected } from "../src/metrics/compute.js";
import type { Settlement } from "../src/metrics/types.js";

const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C = "0x" + "c".repeat(40);
const S = "0x" + "5".repeat(40), P1 = "0x" + "1".repeat(40), P2 = "0x" + "2".repeat(40), GW = "0x" + "9".repeat(40);
const RELAYER = "0x" + "e".repeat(40);
const DAY = 86400, T0 = 1_760_000_000;

function row(payer: string, payTo: string, usd: number, ts = T0, extra: Partial<Settlement> = {}): Settlement {
  return { ts, token: "USAT", payer, payTo, usd, relayer: RELAYER, ...extra };
}

test("stronglyConnected finds a 3-cycle but not a chain", () => {
  const adj = new Map<string, string[]>([["a", ["b"]], ["b", ["c"]], ["c", ["a"]], ["x", ["a"]], ["a2", []]]);
  const comps = stronglyConnected(adj).filter((c) => c.length > 1);
  assert.equal(comps.length, 1);
  assert.deepEqual(comps[0].sort(), ["a", "b", "c"]);
});

test("circuitComponents ignores self payments and one-way flows", () => {
  const { of, components } = circuitComponents([row(A, B, 1), row(B, C, 1), row(C, A, 1), row(P1, S, 1), row(P1, P1, 1)]);
  assert.equal(components, 1);
  assert.ok(of.has(A) && of.has(B) && of.has(C));
  assert.ok(!of.has(P1) && !of.has(S));
});

test("a ring A->B->C->A is flagged as circuit and excluded from the independent view", () => {
  const rows: Settlement[] = [];
  for (let i = 0; i < 10; i++) { rows.push(row(A, B, 2), row(B, C, 2), row(C, A, 2)); } // 30 ring flows, $60
  rows.push(row(P1, S, 0.05), row(P2, S, 0.05), row(P1, S, 0.05)); // 3 independent flows into one seller
  const m = computeMetrics(rows);
  assert.equal(m.totals.settlements, 33);
  assert.equal(m.circuit.settlements, 30);
  assert.equal(m.circuit.addresses, 3);
  assert.ok(m.circuit.gmvShare > 0.99);
  assert.equal(m.independent.settlements, 3);
  assert.equal(m.independent.activePayers, 2);
  assert.equal(m.independent.activePayTo, 1);
  // P1 paid S twice -> that pair is a repeat pair, P2->S is not
  assert.equal(m.independent.repeatPairShare, 0.5);
});

test("self payments count as circuit", () => {
  const m = computeMetrics([row(A, A, 5), row(P1, S, 1)]);
  assert.equal(m.circuit.settlements, 1);
  assert.equal(m.independent.settlements, 1);
});

test("totals, tokens, median and concentration", () => {
  const rows = [row(P1, S, 1), row(P2, S, 3), row(P1, GW, 0.01, T0, { token: "USDC" })];
  const m = computeMetrics(rows);
  assert.equal(m.totals.gmvUsd, 4.01);
  assert.equal(m.totals.activePayTo, 2);
  assert.equal(m.byToken.USAT.settlements, 2);
  assert.equal(m.byToken.USDC.settlements, 1);
  assert.equal(m.totals.medianTicketUsd, 1);
  assert.ok(m.concentration.top5SettlementShare === 1);
  assert.ok(m.concentration.hhiGmv > 5000);
});

test("labels give a per-shop slice with average ticket", () => {
  const rows = [row(P1, GW, 0.01), row(P2, GW, 0.03), row(P1, S, 5)];
  const m = computeMetrics(rows, { labels: { [GW]: "gateway" } });
  assert.equal(m.labels.gateway.settlements, 2);
  assert.equal(m.labels.gateway.avgTicketUsd, 0.02);
  assert.equal(m.labels.gateway.payers, 2);
});

test("gas is converted to CELO and USD, and attributed as processing cost", () => {
  // 87,500 gas at 200 gwei = 0.0175 CELO
  const g = { gasUsed: 87_500, gasPriceWei: 200_000_000_000 };
  const rows = [row(P1, S, 1, T0, g), row(P2, S, 1, T0, g)];
  const m = computeMetrics(rows, { celoUsd: 0.1 });
  assert.equal(m.gas?.avgCeloPerSettlement, 0.0175);
  assert.equal(m.gas?.avgUsdPerSettlement, 0.00175);
  const seller = m.sellers[0];
  // 2 * 0.00175 gas + 0.3% of $2
  assert.equal(seller.processingCostUsdEstimate, 0.0095);
});

test("daily series and facilitator share", () => {
  const rows = [row(P1, S, 1, T0), row(P2, S, 1, T0 + DAY, { relayer: "0x" + "f".repeat(40) }), row(P1, S, 1, T0 + DAY)];
  const m = computeMetrics(rows);
  assert.equal(m.daily.length, 2);
  assert.equal(m.facilitators[RELAYER].settlements, 2);
  assert.equal(m.facilitators["0x" + "f".repeat(40)].share, 0.3333);
});

test("empty input does not crash", () => {
  const m = computeMetrics([]);
  assert.equal(m.totals.settlements, 0);
  assert.equal(m.window.days, 0);
});
