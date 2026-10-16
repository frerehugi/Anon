/** One x402 settlement as observed on chain (EIP-3009 transfer settled by a facilitator). */
export interface Settlement {
  ts: number; // unix seconds
  token: string; // "USDC" | "USDT" | "USAT" | ...
  payer: string; // lowercase 0x address
  payTo: string; // lowercase 0x address
  usd: number; // face value in USD (stablecoins are treated as 1:1)
  relayer?: string; // tx sender (facilitator signer)
  gasUsed?: number;
  gasPriceWei?: number;
}

export interface MetricsOptions {
  /** CELO price in USD, needed to convert gas into USD. Without it gas is reported in CELO only. */
  celoUsd?: number;
  /** Facilitator fee on top of gas, in basis points (Celo docs: 0.3% = 30). */
  facilitatorFeeBps?: number;
  /** Optional address -> label map (e.g. a gateway's payTo), used for per-shop slices. */
  labels?: Record<string, string>;
  /** How many sellers to list. */
  topSellers?: number;
}

export interface DayRow {
  day: string; // YYYY-MM-DD (UTC)
  settlements: number;
  gmvUsd: number;
  activePayers: number;
  activePayTo: number;
  circuitShareGmv: number;
}

export interface SellerRow {
  payTo: string;
  label?: string;
  settlements: number;
  gmvUsd: number;
  distinctPayers: number;
  repeatPayerShare: number; // payers with >= 2 settlements to this payTo / distinct payers
  circuitShareGmv: number;
  independentGmvUsd: number;
  firstSeenDay: string;
  processingCostUsdEstimate?: number;
}

export interface MetricsReport {
  version: string;
  window: { from: number; to: number; days: number };
  totals: {
    settlements: number;
    gmvUsd: number;
    activePayers: number;
    activePayTo: number;
    avgTicketUsd: number;
    medianTicketUsd: number;
  };
  byToken: Record<string, { settlements: number; gmvUsd: number }>;
  concentration: { top5SettlementShare: number; top5GmvShare: number; hhiGmv: number };
  circuit: {
    components: number;
    addresses: number;
    settlements: number;
    gmvUsd: number;
    settlementShare: number;
    gmvShare: number;
  };
  independent: { settlements: number; gmvUsd: number; activePayers: number; activePayTo: number; repeatPairShare: number };
  facilitators: Record<string, { settlements: number; share: number }>;
  gas?: { totalCelo: number; avgCeloPerSettlement: number; totalUsd?: number; avgUsdPerSettlement?: number; costShareOfGmv?: number };
  labels: Record<string, { settlements: number; gmvUsd: number; avgTicketUsd: number; payers: number }>;
  daily: DayRow[];
  sellers: SellerRow[];
}
