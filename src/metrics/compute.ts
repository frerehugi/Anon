import type { DayRow, MetricsOptions, MetricsReport, SellerRow, Settlement } from "./types.js";
import { METRICS_VERSION } from "./definitions.js";

const norm = (a: string) => a.toLowerCase();
const dayOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Strongly connected components of the payer -> payTo graph (iterative Tarjan). */
export function stronglyConnected(adj: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const start of adj.keys()) {
    if (idx.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    idx.set(start, index); low.set(start, index); index++;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame.v;
      const nbrs = adj.get(v) ?? [];
      if (frame.i < nbrs.length) {
        const w = nbrs[frame.i++];
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++;
          stack.push(w); onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      } else {
        if (low.get(v) === idx.get(v)) {
          const comp: string[] = [];
          let w: string;
          do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
          out.push(comp);
        }
        work.pop();
        if (work.length) {
          const p = work[work.length - 1].v;
          low.set(p, Math.min(low.get(p)!, low.get(v)!));
        }
      }
    }
  }
  return out;
}

/** Map address -> component id for components of at least two addresses (cycles). */
export function circuitComponents(rows: Pick<Settlement, "payer" | "payTo">[]): { of: Map<string, number>; components: number } {
  const adjSet = new Map<string, Set<string>>();
  for (const r of rows) {
    const a = norm(r.payer), b = norm(r.payTo);
    if (a === b) continue;
    if (!adjSet.has(a)) adjSet.set(a, new Set());
    adjSet.get(a)!.add(b);
    if (!adjSet.has(b)) adjSet.set(b, new Set());
  }
  const adj = new Map<string, string[]>([...adjSet].map(([k, v]) => [k, [...v]]));
  const of = new Map<string, number>();
  let components = 0;
  for (const comp of stronglyConnected(adj)) {
    if (comp.length < 2) continue;
    comp.forEach((a) => of.set(a, components));
    components++;
  }
  return { of, components };
}

export function computeMetrics(rowsIn: Settlement[], opts: MetricsOptions = {}): MetricsReport {
  const rows = rowsIn.map((r) => ({ ...r, payer: norm(r.payer), payTo: norm(r.payTo) }));
  const feeBps = opts.facilitatorFeeBps ?? 30;
  const labels = Object.fromEntries(Object.entries(opts.labels ?? {}).map(([k, v]) => [norm(k), v]));
  const { of: compOf, components } = circuitComponents(rows);
  const isCircuit = (r: { payer: string; payTo: string }) =>
    r.payer === r.payTo || (compOf.has(r.payer) && compOf.get(r.payer) === compOf.get(r.payTo));

  const n = rows.length;
  const gmv = rows.reduce((s, r) => s + r.usd, 0);
  const payers = new Set(rows.map((r) => r.payer));
  const payTos = new Set(rows.map((r) => r.payTo));
  const tss = rows.map((r) => r.ts);
  const from = n ? Math.min(...tss) : 0;
  const to = n ? Math.max(...tss) : 0;

  const byToken: MetricsReport["byToken"] = {};
  for (const r of rows) {
    const t = (byToken[r.token] ??= { settlements: 0, gmvUsd: 0 });
    t.settlements++; t.gmvUsd = round(t.gmvUsd + r.usd);
  }

  const perPayTo = new Map<string, { n: number; gmv: number }>();
  for (const r of rows) {
    const p = perPayTo.get(r.payTo) ?? { n: 0, gmv: 0 };
    p.n++; p.gmv += r.usd; perPayTo.set(r.payTo, p);
  }
  const topN = [...perPayTo.values()].sort((a, b) => b.n - a.n).slice(0, 5).reduce((s, p) => s + p.n, 0);
  const topG = [...perPayTo.values()].sort((a, b) => b.gmv - a.gmv).slice(0, 5).reduce((s, p) => s + p.gmv, 0);
  const hhi = gmv > 0 ? [...perPayTo.values()].reduce((s, p) => s + (p.gmv / gmv) ** 2, 0) * 10000 : 0;

  const circ = rows.filter(isCircuit);
  const indep = rows.filter((r) => !isCircuit(r));
  const circuitAddresses = new Set<string>();
  for (const r of circ) { if (compOf.has(r.payer)) circuitAddresses.add(r.payer); if (compOf.has(r.payTo)) circuitAddresses.add(r.payTo); }
  const circGmv = circ.reduce((s, r) => s + r.usd, 0);
  const indepGmv = indep.reduce((s, r) => s + r.usd, 0);

  const pairCount = new Map<string, number>();
  for (const r of indep) { const k = `${r.payer}>${r.payTo}`; pairCount.set(k, (pairCount.get(k) ?? 0) + 1); }
  const repeatPairs = [...pairCount.values()].filter((c) => c >= 2).length;

  const facilitators: MetricsReport["facilitators"] = {};
  for (const r of rows) {
    const k = r.relayer ? norm(r.relayer) : "unknown";
    (facilitators[k] ??= { settlements: 0, share: 0 }).settlements++;
  }
  for (const f of Object.values(facilitators)) f.share = n ? round(f.settlements / n, 4) : 0;

  let gas: MetricsReport["gas"];
  const withGas = rows.filter((r) => r.gasUsed !== undefined && r.gasPriceWei !== undefined);
  let totalCelo = 0;
  if (withGas.length) {
    totalCelo = withGas.reduce((s, r) => s + Number((BigInt(Math.round(r.gasUsed!)) * BigInt(Math.round(r.gasPriceWei!)))) / 1e18, 0);
    gas = { totalCelo: round(totalCelo, 4), avgCeloPerSettlement: round(totalCelo / withGas.length, 6) };
    if (opts.celoUsd !== undefined) {
      gas.totalUsd = round(totalCelo * opts.celoUsd, 4);
      gas.avgUsdPerSettlement = round((totalCelo * opts.celoUsd) / withGas.length, 6);
      gas.costShareOfGmv = gmv > 0 ? round((totalCelo * opts.celoUsd) / gmv, 6) : 0;
    }
  }
  const gasUsdPer = gas?.avgUsdPerSettlement;

  const labelStats: MetricsReport["labels"] = {};
  for (const [addr, label] of Object.entries(labels)) {
    const rs = rows.filter((r) => r.payTo === addr);
    if (!rs.length) continue;
    const g = rs.reduce((s, r) => s + r.usd, 0);
    labelStats[label] = { settlements: rs.length, gmvUsd: round(g), avgTicketUsd: round(g / rs.length), payers: new Set(rs.map((r) => r.payer)).size };
  }

  const dayMap = new Map<string, Settlement[]>();
  for (const r of rows) { const d = dayOf(r.ts); (dayMap.get(d) ?? dayMap.set(d, []).get(d)!).push(r); }
  const daily: DayRow[] = [...dayMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, rs]) => {
    const g = rs.reduce((s, r) => s + r.usd, 0);
    const cg = rs.filter(isCircuit).reduce((s, r) => s + r.usd, 0);
    return { day, settlements: rs.length, gmvUsd: round(g, 4), activePayers: new Set(rs.map((r) => r.payer)).size, activePayTo: new Set(rs.map((r) => r.payTo)).size, circuitShareGmv: g > 0 ? round(cg / g, 4) : 0 };
  });

  const sellers: SellerRow[] = [...perPayTo.entries()].sort(([, a], [, b]) => b.gmv - a.gmv).slice(0, opts.topSellers ?? 20).map(([payTo, p]) => {
    const rs = rows.filter((r) => r.payTo === payTo);
    const byPayer = new Map<string, number>();
    rs.forEach((r) => byPayer.set(r.payer, (byPayer.get(r.payer) ?? 0) + 1));
    const cg = rs.filter(isCircuit).reduce((s, r) => s + r.usd, 0);
    const row: SellerRow = {
      payTo, label: labels[payTo], settlements: p.n, gmvUsd: round(p.gmv, 4), distinctPayers: byPayer.size,
      repeatPayerShare: byPayer.size ? round([...byPayer.values()].filter((c) => c >= 2).length / byPayer.size, 4) : 0,
      circuitShareGmv: p.gmv > 0 ? round(cg / p.gmv, 4) : 0,
      independentGmvUsd: round(p.gmv - cg, 4),
      firstSeenDay: dayOf(Math.min(...rs.map((r) => r.ts))),
    };
    if (gasUsdPer !== undefined) row.processingCostUsdEstimate = round(gasUsdPer * p.n + (feeBps / 10000) * p.gmv, 6);
    return row;
  });

  return {
    version: METRICS_VERSION,
    window: { from, to, days: n ? round((to - from) / 86400, 2) : 0 },
    totals: { settlements: n, gmvUsd: round(gmv, 4), activePayers: payers.size, activePayTo: payTos.size, avgTicketUsd: n ? round(gmv / n, 6) : 0, medianTicketUsd: round(median(rows.map((r) => r.usd)), 6) },
    byToken,
    concentration: { top5SettlementShare: n ? round(topN / n, 4) : 0, top5GmvShare: gmv > 0 ? round(topG / gmv, 4) : 0, hhiGmv: Math.round(hhi) },
    circuit: { components, addresses: circuitAddresses.size, settlements: circ.length, gmvUsd: round(circGmv, 4), settlementShare: n ? round(circ.length / n, 4) : 0, gmvShare: gmv > 0 ? round(circGmv / gmv, 4) : 0 },
    independent: {
      settlements: indep.length, gmvUsd: round(indepGmv, 4),
      activePayers: new Set(indep.map((r) => r.payer)).size, activePayTo: new Set(indep.map((r) => r.payTo)).size,
      repeatPairShare: pairCount.size ? round(repeatPairs / pairCount.size, 4) : 0,
    },
    facilitators, gas, labels: labelStats, daily, sellers,
  };
}
