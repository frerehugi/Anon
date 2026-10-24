// Settlement audit: re-check a random sample of indexed settlements against an independent RPC (paid through buy, Chainstack).
// Pure helpers here; the paid call goes through the executor (see auditCli.ts).
import { ASSETS } from "../constants.js";

export interface SettlementRef {
  txHash: string;
  logIndex: number;
  block: number;
  token: string; // symbol as stored by the indexer
  payer: string;
  payTo: string;
  amountAtomic: string;
  relayer: string;
}

export interface Receipt {
  status?: string;
  blockNumber?: string;
  from?: string;
  logs?: { address: string; topics: string[]; data: string; logIndex: string }[];
}

/** `inconclusive`: the RPC had no receipt (a lagging or pruned node). That says nothing about the indexed row, so it is counted apart from real mismatches. */
export type Verdict = { ok: true; softNote?: string } | { ok: false; reason: string; inconclusive?: boolean };

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const lc = (s: string) => s.toLowerCase();
const topicAddr = (t: string | undefined) => (t && t.length === 66 ? `0x${t.slice(26)}` : "");

const tokenAddress = (symbol: string) => Object.entries(ASSETS).find(([, i]) => i.symbol === symbol)?.[0];

/** Does the receipt show exactly the settlement the indexer recorded? */
export function verifyReceipt(ref: SettlementRef, r: Receipt | null | undefined): Verdict {
  if (!r) return { ok: false, reason: "no receipt returned", inconclusive: true };
  if (r.status !== "0x1") return { ok: false, reason: `tx status ${r.status ?? "missing"}` };
  if (r.blockNumber === undefined || Number.parseInt(r.blockNumber, 16) !== ref.block) return { ok: false, reason: `block ${r.blockNumber ?? "missing"} differs from indexed ${ref.block}` };
  const log = (r.logs ?? []).find((l) => Number.parseInt(l.logIndex, 16) === ref.logIndex);
  if (!log) return { ok: false, reason: `no log at index ${ref.logIndex}` };
  const asset = tokenAddress(ref.token);
  if (!asset || lc(log.address) !== lc(asset)) return { ok: false, reason: `log emitted by ${log.address}, expected the ${ref.token} contract` };
  if (lc(log.topics?.[0] ?? "") !== TRANSFER) return { ok: false, reason: "log is not a Transfer" };
  if (lc(topicAddr(log.topics[1])) !== lc(ref.payer)) return { ok: false, reason: "payer differs" };
  if (lc(topicAddr(log.topics[2])) !== lc(ref.payTo)) return { ok: false, reason: "payTo differs" };
  let value: bigint;
  try { value = BigInt(log.data); } catch { return { ok: false, reason: "amount not readable" }; }
  if (value !== BigInt(ref.amountAtomic)) return { ok: false, reason: `amount ${value} differs from indexed ${ref.amountAtomic}` };
  if (r.from && lc(r.from) !== lc(ref.relayer)) return { ok: true, softNote: "relayer differs" };
  return { ok: true };
}

/** One JSON-RPC batch for the unique transaction hashes of the sample. */
export function receiptBatch(refs: SettlementRef[]): { body: string; hashes: string[] } {
  const hashes = [...new Set(refs.map((r) => lc(r.txHash)))];
  const body = JSON.stringify(hashes.map((h, i) => ({ jsonrpc: "2.0", id: i, method: "eth_getTransactionReceipt", params: [h] })));
  return { body, hashes };
}

/** Map batch results back to hashes. Order is not guaranteed by JSON-RPC, so match on id. */
export function parseReceipts(text: string, hashes: string[]): { receipts: Map<string, Receipt | null>; errors: number } {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error("response is not a JSON-RPC batch");
  const receipts = new Map<string, Receipt | null>();
  let errors = 0;
  for (const item of arr) {
    const h = hashes[item?.id];
    if (h === undefined) continue;
    if (item.error) { errors++; continue; }
    receipts.set(h, item.result ?? null);
  }
  return { receipts, errors };
}

export interface AuditResult {
  checked: number;
  matched: number;
  mismatched: { txHash: string; logIndex: number; reason: string }[];
  inconclusive: string[]; // tx hashes without a usable receipt
  notes: number;
  rpcErrors: number;
  /** matched / (checked - inconclusive) */
  matchRate: number;
}

export function auditSample(refs: SettlementRef[], receipts: Map<string, Receipt | null>, rpcErrors = 0): AuditResult {
  const mismatched: AuditResult["mismatched"] = [];
  const inconclusive: string[] = [];
  let matched = 0;
  let notes = 0;
  for (const ref of refs) {
    const v = verifyReceipt(ref, receipts.get(lc(ref.txHash)));
    if (v.ok) { matched++; if (v.softNote) notes++; }
    else if (v.inconclusive) inconclusive.push(ref.txHash);
    else mismatched.push({ txHash: ref.txHash, logIndex: ref.logIndex, reason: v.reason });
  }
  const decided = refs.length - inconclusive.length;
  return { checked: refs.length, matched, mismatched, inconclusive, notes, rpcErrors, matchRate: decided ? Math.round((matched / decided) * 10000) / 10000 : 0 };
}
