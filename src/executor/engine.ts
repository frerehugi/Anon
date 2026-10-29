// Pure payment policy check. No I/O, no clock, no keys: everything it needs is passed in, so it is trivial to test.
import type { Approval } from "./approval.js";
import { canonicalUrl, formatAtomic, type Policy } from "./policy.js";

export type EntryStatus = "denied" | "dry_run" | "pending" | "settled" | "failed" | "uncertain";

export interface PayRequest {
  id: string; // idempotency key chosen by the caller
  wallet: "ops" | "treasury";
  url: string;
  token: string; // symbol
  amount: bigint; // atomic units (6 decimals)
  experiment: string;
  approvalId?: string;
  /** x402 endpoints are called with GET (default) or POST with a JSON body, e.g. JSON-RPC. The body is not stored in the ledger. */
  method?: "GET" | "POST";
  body?: string;
  /** Largest response the paid call may return (default 64 KB, at most 8 MB). Large JSON-RPC batches need more. */
  maxResponseBytes?: number;
}

/** Just under what the buy gateway accepts (it answers 413 from about 150 KB); the allowlist, not this cap, decides where a body may go. */
export const MAX_REQUEST_BODY = 125_000;

export interface LedgerEntry {
  requestId: string;
  ts: number; // unix seconds
  status: EntryStatus;
  wallet: PayRequest["wallet"];
  url: string;
  token: string;
  amount: bigint;
  experiment: string;
  approvalId?: string;
  reasons?: string[];
  txHash?: string;
  detail?: string;
}

export interface State {
  entries: LedgerEntry[];
  approvals: Approval[];
  gate2: boolean;
  killed: boolean;
  now: number;
}

export interface Decision { allow: boolean; reasons: string[] }

const moved = (e: LedgerEntry) => e.status !== "denied" && e.status !== "dry_run";

/**
 * Latest entry per request id (a request is appended several times as it moves from pending to its final status).
 * A later denial or dry run of a reused id must never hide money that was already sent or may have been sent.
 */
export function latest(entries: LedgerEntry[]): LedgerEntry[] {
  const m = new Map<string, LedgerEntry>();
  for (const e of entries) {
    const prev = m.get(e.requestId);
    if (prev && moved(prev) && !moved(e)) continue;
    m.set(e.requestId, e);
  }
  return [...m.values()];
}

/** Money that is spent or may have been spent. Uncertain counts: the payment might have settled. */
const counts = (e: LedgerEntry) => e.status === "pending" || e.status === "settled" || e.status === "uncertain";
const day = (ts: number) => Math.floor(ts / 86400);
const sum = (es: LedgerEntry[]) => es.reduce((s, e) => s + e.amount, 0n);

export function spentTotal(entries: LedgerEntry[]): bigint {
  return sum(latest(entries).filter(counts));
}

export function evaluate(req: PayRequest, policy: Policy, state: State): Decision {
  const reasons: string[] = [];
  const deny = (r: string) => reasons.push(r);
  const spent = latest(state.entries).filter(counts);

  if (state.killed) deny("kill switch is on");
  if (!req.id) deny("request id is missing");
  if (state.entries.some((e) => e.requestId === req.id && e.status !== "denied" && e.status !== "dry_run")) deny("request id was already used; a retry needs a new id and a human decision");

  const url = canonicalUrl(req.url);
  if (!url) deny("url is not a plain https URL");
  else if (!policy.endpoints.some((e) => e.url === url)) deny("endpoint is not on the allowlist (or not enabled)");

  if (!policy.tokens.includes(req.token)) deny(`token ${req.token} is not allowed`);
  if (req.amount <= 0n) deny("amount must be positive");
  if (req.amount > policy.perCallMax) deny(`amount ${formatAtomic(req.amount)} is above the per-call limit ${formatAtomic(policy.perCallMax)}`);
  if (!req.experiment) deny("experiment is missing");
  if (req.method !== undefined && req.method !== "GET" && req.method !== "POST") deny("method must be GET or POST");
  if (req.maxResponseBytes !== undefined && !(Number.isInteger(req.maxResponseBytes) && req.maxResponseBytes >= 1 && req.maxResponseBytes <= 8 * 1024 * 1024)) deny("maxResponseBytes must be between 1 and 8 MB");
  if (req.body !== undefined && (req.method !== "POST" || req.body.length > MAX_REQUEST_BODY)) deny(`a body needs method POST and at most ${MAX_REQUEST_BODY} characters`);

  const approval = req.approvalId ? state.approvals.find((a) => a.id === req.approvalId) : undefined;
  if (!approval) deny("no matching CIO approval");
  else {
    if (approval.expires <= state.now) deny("approval has expired");
    if (approval.experiment !== req.experiment) deny("approval belongs to a different experiment");
    const used = sum(spent.filter((e) => e.approvalId === approval.id));
    if (used + req.amount > approval.cap) deny(`approval cap ${formatAtomic(approval.cap)} would be exceeded (used ${formatAtomic(used)})`);
  }

  const expSpent = sum(spent.filter((e) => e.experiment === req.experiment));
  if (expSpent + req.amount > policy.maxPerExperiment) deny(`experiment limit ${formatAtomic(policy.maxPerExperiment)} would be exceeded`);

  const today = day(state.now);
  const dailySpent = sum(spent.filter((e) => e.wallet === req.wallet && day(e.ts) === today));
  const dailyMax = policy.dailyMax[req.wallet];
  if (dailySpent + req.amount > dailyMax) deny(`daily limit for the ${req.wallet} wallet ${formatAtomic(dailyMax)} would be exceeded`);

  // The reserve stays untouchable; growth money is released only after gate 2.
  const cap = policy.experiments + (state.gate2 ? policy.growth : 0n);
  if (sum(spent) + req.amount > cap) deny(`budget ${formatAtomic(cap)} (${state.gate2 ? "gate 2 passed" : "before gate 2"}) would be exceeded`);

  return { allow: reasons.length === 0, reasons };
}
