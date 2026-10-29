// Directory enrichment: current owner, agent wallet and raw reputation for ERC-8004 agents, read through a paid RPC (Chainstack via buy).
// Pure helpers: they build JSON-RPC batches and read the answers. The paid call itself goes through the executor (see executorCli.ts).
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { IDENTITY_REGISTRY, REPUTATION_REGISTRY } from "../constants.js";
import type { AgentChainRow } from "../directory/chain.js";

const identityAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)", "function getAgentWallet(uint256 agentId) view returns (address)"]);
const reputationAbi = parseAbi([
  "function getClients(uint256 agentId) view returns (address[])",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";
export const MAX_CALLS_PER_BATCH = 2000;
/** Stage A has 3 calls per agent plus one block-number call. */
export const AGENTS_PER_BATCH = 600;
/** Summaries over huge client lists are skipped: the calldata grows with the list and the raw number says little there. */
export const MAX_CLIENTS_FOR_SUMMARY = 500;
export const SUMMARIES_PER_BATCH = 100;
/** A summary call carries its client list as calldata (64 hex characters per address); batches are split to stay under this many characters. */
export const MAX_BATCH_CHARS = 900_000;

type Kind = "owner" | "wallet" | "clients" | "block" | "summary";
export interface CallMeta { id: number; agentId: number; kind: Kind }

const ethCall = (to: string, data: string) => ({ method: "eth_call", params: [{ to, data }, "latest"] });

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function stageA(agentIds: number[]): { body: string; calls: CallMeta[] } {
  if (agentIds.length > AGENTS_PER_BATCH) throw new Error(`at most ${AGENTS_PER_BATCH} agents per batch`);
  const calls: CallMeta[] = [];
  const reqs: object[] = [];
  const add = (agentId: number, kind: Kind, req: { method: string; params: unknown[] }) => {
    const id = calls.length;
    calls.push({ id, agentId, kind });
    reqs.push({ jsonrpc: "2.0", id, ...req });
  };
  for (const a of agentIds) {
    add(a, "owner", ethCall(IDENTITY_REGISTRY, encodeFunctionData({ abi: identityAbi, functionName: "ownerOf", args: [BigInt(a)] })));
    add(a, "wallet", ethCall(IDENTITY_REGISTRY, encodeFunctionData({ abi: identityAbi, functionName: "getAgentWallet", args: [BigInt(a)] })));
    add(a, "clients", ethCall(REPUTATION_REGISTRY, encodeFunctionData({ abi: reputationAbi, functionName: "getClients", args: [BigInt(a)] })));
  }
  add(-1, "block", { method: "eth_blockNumber", params: [] });
  return { body: JSON.stringify(reqs), calls };
}

export interface StageAResult { ownerNow: string | null; agentWallet: string | null; clients: string[] | null }

function items(text: string): Map<number, { result?: string; error?: unknown }> {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error("response is not a JSON-RPC batch");
  const m = new Map<number, { result?: string; error?: unknown }>();
  for (const it of arr) if (typeof it?.id === "number") m.set(it.id, it);
  return m;
}

const decodeOrNull = <T>(fn: () => T): T | null => { try { return fn(); } catch { return null; } };

export function parseStageA(text: string, calls: CallMeta[]): { byAgent: Map<number, StageAResult>; block: number | null; rpcErrors: number } {
  const res = items(text);
  const byAgent = new Map<number, StageAResult>();
  let block: number | null = null;
  let rpcErrors = 0;
  for (const c of calls) {
    const it = res.get(c.id);
    if (c.kind === "block") { block = it?.result ? Number.parseInt(it.result, 16) : null; continue; }
    const r = byAgent.get(c.agentId) ?? byAgent.set(c.agentId, { ownerNow: null, agentWallet: null, clients: null }).get(c.agentId)!;
    if (!it || it.error || typeof it.result !== "string") { if (it?.error) rpcErrors++; continue; } // a revert (for example no such token) is an error entry, not a failure of the batch
    if (c.kind === "owner") r.ownerNow = decodeOrNull(() => decodeFunctionResult({ abi: identityAbi, functionName: "ownerOf", data: it.result as `0x${string}` }) as string)?.toLowerCase() ?? null;
    if (c.kind === "wallet") {
      const w = decodeOrNull(() => decodeFunctionResult({ abi: identityAbi, functionName: "getAgentWallet", data: it.result as `0x${string}` }) as string);
      r.agentWallet = w && w.toLowerCase() !== ZERO ? w.toLowerCase() : null;
    }
    if (c.kind === "clients") r.clients = decodeOrNull(() => (decodeFunctionResult({ abi: reputationAbi, functionName: "getClients", data: it.result as `0x${string}` }) as readonly string[]).map((a) => a.toLowerCase()));
  }
  return { byAgent, block, rpcErrors };
}

/** Splits agents into summary batches of at most SUMMARIES_PER_BATCH calls and MAX_BATCH_CHARS characters of request body. */
export function splitSummaries<T extends { clients: string[] }>(items_: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const it of items_) {
    const size = 400 + 66 * it.clients.length;
    if (cur.length > 0 && (cur.length >= SUMMARIES_PER_BATCH || chars + size > MAX_BATCH_CHARS)) { out.push(cur); cur = []; chars = 0; }
    cur.push(it);
    chars += size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function stageB(items_: { agentId: number; clients: string[] }[]): { body: string; calls: CallMeta[] } {
  if (items_.length > SUMMARIES_PER_BATCH) throw new Error(`at most ${SUMMARIES_PER_BATCH} summaries per batch`);
  const calls: CallMeta[] = [];
  const reqs = items_.map((it, id) => {
    calls.push({ id, agentId: it.agentId, kind: "summary" });
    return { jsonrpc: "2.0", id, ...ethCall(REPUTATION_REGISTRY, encodeFunctionData({ abi: reputationAbi, functionName: "getSummary", args: [BigInt(it.agentId), it.clients as `0x${string}`[], "", ""] })) };
  });
  return { body: JSON.stringify(reqs), calls };
}

export function parseStageB(text: string, calls: CallMeta[]): { byAgent: Map<number, { count: number; value: string; decimals: number }>; rpcErrors: number } {
  const res = items(text);
  const byAgent = new Map<number, { count: number; value: string; decimals: number }>();
  let rpcErrors = 0;
  for (const c of calls) {
    const it = res.get(c.id);
    if (!it || it.error || typeof it.result !== "string") { if (it?.error) rpcErrors++; continue; }
    const d = decodeOrNull(() => decodeFunctionResult({ abi: reputationAbi, functionName: "getSummary", data: it.result as `0x${string}` }) as readonly [bigint, bigint, number]);
    if (d) byAgent.set(c.agentId, { count: Number(d[0]), value: d[1].toString(), decimals: Number(d[2]) });
  }
  return { byAgent, rpcErrors };
}

export function toRows(a: Map<number, StageAResult>, b: Map<number, { count: number; value: string; decimals: number }>, block: number | null): Omit<AgentChainRow, "checkedAt">[] {
  return [...a.entries()].map(([agentId, r]) => {
    const s = b.get(agentId);
    return {
      agentId, checkedBlock: block, ownerNow: r.ownerNow, agentWallet: r.agentWallet, repClients: r.clients ? r.clients.length : null,
      repCount: r.clients ? (r.clients.length === 0 ? 0 : s ? s.count : null) : null, repValue: s ? s.value : r.clients && r.clients.length === 0 ? "0" : null, repDecimals: s ? s.decimals : null,
    };
  });
}
