export interface SettlementRow {
  txHash: string;
  logIndex: number;
  block: number;
  ts: number;
  token: string;
  payer: string;
  payTo: string;
  amountAtomic: string;
  usd: number;
  relayer: string;
  gasUsed: number | null;
  gasPriceWei: number | null;
}

export interface UnclassifiedRow {
  txHash: string;
  block: number;
  ts: number;
  relayer: string;
  toAddress: string | null;
  gasUsed: number | null;
  gasPriceWei: number | null;
  status: number | null;
}

export interface WindowResult {
  settlements: SettlementRow[];
  unclassified: UnclassifiedRow[];
  /** Last block the response actually covered. Below the requested end means the response was cut short. */
  lastBlock: number;
}

export interface Source {
  finalizedHead(): Promise<number>;
  window(fromBlock: number, toBlock: number, signers: string[]): Promise<WindowResult>;
}

/**
 * Temporary source failure. `shrink` says whether a smaller window is likely to help (timeouts, server errors).
 * Overload (HTTP 429/529) is random and independent of window size, so it is retried unchanged after a pause.
 */
export class RetryableSourceError extends Error {
  constructor(message: string, readonly shrink = false) {
    super(message);
  }
}
