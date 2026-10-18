import type { IndexReport } from "./report.js";

/**
 * What the paid API may show. Aggregates only: the per-seller table (it names payTo addresses and which of them sit in the
 * payment circuit) is removed. Facilitator signers and labelled shops (the buy gateway) are public infrastructure and stay.
 */
export function toPublicReport(r: IndexReport): Omit<IndexReport, "sellers"> & { note: string } {
  const { sellers: _sellers, ...rest } = r;
  return { ...rest, note: "Aggregate measurements of the indexed window. Addresses of individual sellers are not published." };
}
