import { ASSETS } from "../constants.js";
import type { SettlementRow, UnclassifiedRow } from "./types.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const TRACKED = new Map(
  Object.entries(ASSETS)
    .filter(([, i]) => i.method === "eip3009")
    .map(([addr, i]) => [addr.toLowerCase(), i] as const),
);

const hexNum = (h: unknown): number | null => {
  if (typeof h === "number") return h;
  if (typeof h !== "string") return null;
  const n = Number.parseInt(h, 16);
  return Number.isFinite(n) ? n : null;
};
const addrOf = (topic: string) => `0x${topic.slice(-40).toLowerCase()}`;

export interface ParsedStream {
  settlements: SettlementRow[];
  unclassified: UnclassifiedRow[];
  lastBlock: number | null;
}

/**
 * Turn SQD stream lines (one JSON object per block with header, transactions, logs) into rows.
 * A signer transaction with a tracked-token Transfer is a settlement; anything else is "unclassified".
 * When one transaction carries several transfers, gas is attached to the first only so it is not double counted.
 */
export function parseStreamLines(lines: any[]): ParsedStream {
  const settlements: SettlementRow[] = [];
  const unclassified: UnclassifiedRow[] = [];
  let lastBlock: number | null = null;

  for (const line of lines) {
    const h = line?.header;
    if (!h || typeof h.number !== "number") continue;
    lastBlock = Math.max(lastBlock ?? 0, h.number);
    const ts: number = h.timestamp;
    const logsByTx = new Map<string, any[]>();
    for (const lg of line.logs ?? []) {
      (logsByTx.get(lg.transactionHash) ?? logsByTx.set(lg.transactionHash, []).get(lg.transactionHash)!).push(lg);
    }
    for (const tx of line.transactions ?? []) {
      const gasUsed = hexNum(tx.gasUsed);
      const gasPriceWei = hexNum(tx.effectiveGasPrice ?? tx.gasPrice);
      const relayer = String(tx.from ?? "").toLowerCase();
      const transfers = (logsByTx.get(tx.hash) ?? []).filter(
        (lg) => lg.topics?.[0] === TRANSFER && lg.topics.length >= 3 && TRACKED.has(String(lg.address).toLowerCase()),
      );
      if (transfers.length === 0 || tx.status === 0) {
        unclassified.push({ txHash: tx.hash, block: h.number, ts, relayer, toAddress: tx.to ? String(tx.to).toLowerCase() : null, gasUsed, gasPriceWei, status: typeof tx.status === "number" ? tx.status : null });
        continue;
      }
      transfers.forEach((lg, i) => {
        const info = TRACKED.get(String(lg.address).toLowerCase())!;
        const atomic = BigInt(lg.data);
        settlements.push({
          txHash: tx.hash, logIndex: lg.logIndex, block: h.number, ts, token: info.symbol,
          payer: addrOf(lg.topics[1]), payTo: addrOf(lg.topics[2]),
          amountAtomic: atomic.toString(), usd: Number(atomic) / 10 ** info.decimals, relayer,
          gasUsed: i === 0 ? gasUsed : null, gasPriceWei: i === 0 ? gasPriceWei : null,
        });
      });
    }
  }
  return { settlements, unclassified, lastBlock };
}
