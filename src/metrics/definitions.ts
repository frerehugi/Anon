export type MetricStatus = "measured" | "estimated" | "unavailable";

export interface MetricDef {
  id: string;
  name: string;
  definition: string;
  status: MetricStatus;
  caveat?: string;
}

/** Single source of truth for what each number means. Version bumps when a definition changes. */
export const METRICS_VERSION = "0.1.0";

export const METRIC_DEFS: MetricDef[] = [
  { id: "gmv", name: "Gross volume (GMV)", status: "measured",
    definition: "Sum of face values of EIP-3009 settlements to payTo addresses, stablecoins at 1 USD." },
  { id: "settlements", name: "Settlements", status: "measured",
    definition: "Count of settlements (one on-chain transfer each) sent by a known facilitator signer." },
  { id: "active_payers", name: "Active payers", status: "measured",
    definition: "Distinct payer addresses in the window. Pseudonymous: one person can use several." },
  { id: "active_pay_to", name: "Active sellers (payTo)", status: "measured",
    definition: "Distinct payTo addresses that received at least one settlement. A gateway counts once, however many shops sit behind it." },
  { id: "avg_ticket", name: "Average and median ticket", status: "measured",
    definition: "GMV divided by settlements; median of single settlement values." },
  { id: "concentration", name: "Concentration", status: "measured",
    definition: "Share of settlements and GMV that go to the top 5 payTo addresses; Herfindahl index (0-10000) over GMV per payTo." },
  { id: "payment_circuit", name: "Payment circuit share", status: "measured",
    definition: "Flows whose payer and payTo are in the same strongly connected group of at least two addresses (money that cycles among the same addresses), plus self-payments. A pattern, not a verdict about intent.",
    caveat: "Legitimate tests and simulations look identical. Always shown next to the 'excluding circuit' view." },
  { id: "independent_view", name: "Excluding circuit", status: "measured",
    definition: "All metrics recomputed without circuit flows. This is the closest proxy for independent demand." },
  { id: "repeat_payer", name: "Repeat payer rate", status: "measured",
    definition: "Share of (payer, payTo) pairs with at least two settlements in the window." },
  { id: "facilitator_share", name: "Facilitator share", status: "measured",
    definition: "Share of settlements sent by each facilitator signer address." },
  { id: "gas_cost", name: "Settlement gas cost", status: "measured",
    definition: "gasUsed times effective gas price per settlement transaction, in CELO; in USD when a CELO price is supplied." },
  { id: "processing_cost", name: "Processing cost to the seller", status: "estimated",
    definition: "Gas at cost plus the facilitator fee (default 0.3% of the payment), following the Celo facilitator's published pricing.",
    caveat: "Actual billing, free credits and who pays are not visible on chain." },
  { id: "shop_split", name: "Revenue per shop behind a shared payTo", status: "estimated",
    definition: "For gateways with one payTo, inferred from price points only. Exact only for unique prices.",
    caveat: "Prices collide across shops, so this is a range, not a number." },
  { id: "profit", name: "Profit / margin", status: "unavailable",
    definition: "Cost of goods is not visible on chain. Only revenue minus processing cost can be reported." },
];
