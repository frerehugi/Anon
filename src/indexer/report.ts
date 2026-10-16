import type { Db } from "./db.js";
import { computeMetrics } from "../metrics/compute.js";
import type { MetricsOptions, MetricsReport, Settlement } from "../metrics/types.js";
import { countUnclassified, dataRange, getCursor, lastRun, loadSettlements, type SettlementDbRow } from "./store.js";

export interface IndexReport extends MetricsReport {
  meta: {
    windowDays: number;
    classified: number;
    unclassifiedTxs: number;
    unclassifiedShare: number;
    cursorBlock: number | null;
    dataFrom: number | null;
    dataTo: number | null;
  };
}

export function toSettlement(r: SettlementDbRow): Settlement {
  return { ts: r.ts, token: r.token, payer: r.payer, payTo: r.pay_to, usd: r.usd, relayer: r.relayer, gasUsed: r.gas_used ?? undefined, gasPriceWei: r.gas_price_wei ?? undefined };
}

/** Compute the metrics report for the last `days` days of indexed data (ending at the newest settlement). */
export async function buildReport(db: Db, opts: { days: number; source?: string } & MetricsOptions): Promise<IndexReport> {
  const range = await dataRange(db);
  const end = range.maxTs ?? Math.floor(Date.now() / 1000);
  const from = end - Math.round(opts.days * 86400);
  const rows = (await loadSettlements(db, from, end)).map(toSettlement);
  const unclassified = await countUnclassified(db, from, end);
  const report = computeMetrics(rows, opts);
  const total = rows.length + unclassified;
  return {
    ...report,
    meta: {
      windowDays: opts.days, classified: rows.length, unclassifiedTxs: unclassified,
      unclassifiedShare: total ? Math.round((unclassified / total) * 10000) / 10000 : 0,
      cursorBlock: await getCursor(db, opts.source ?? "sqd-celo"), dataFrom: range.minTs, dataTo: range.maxTs,
    },
  };
}

export async function status(db: Db, source = "sqd-celo") {
  const range = await dataRange(db);
  return { cursorBlock: await getCursor(db, source), settlements: range.settlements, dataFrom: range.minTs, dataTo: range.maxTs, lastRun: (await lastRun(db))[0] ?? null };
}
