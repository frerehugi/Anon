/** Decoding of ERC-8004 Identity Registry logs (Registered, URIUpdated). Pure code, no network. */
import { MAX_URI_CHARS } from "../registration.js";

export const REGISTERED_TOPIC = "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a"; // Registered(uint256,string,address)
export const URI_UPDATED_TOPIC = "0x3a2c7fffc2cba7582c690e3b82c453ea02a308326a98a3ad7576c606336409fb"; // URIUpdated(uint256,string,address)

export interface AgentEvent {
  kind: "registered" | "uri_updated";
  agentId: number;
  actor: string; // owner (Registered) or updater (URIUpdated)
  uri: string | null;
  uriError?: string;
  block: number;
  ts: number;
  txHash: string;
  logIndex: number;
}

const addrOf = (topic: string) => `0x${topic.slice(-40).toLowerCase()}`;

/** Decode the single dynamic `string` of an event whose only non-indexed parameter is a string. */
export function decodeAbiString(dataHex: string): { value: string | null; error?: string } {
  const hex = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (hex.length < 128) return { value: null, error: "data_too_short" };
  const offset = Number.parseInt(hex.slice(0, 64), 16);
  if (!Number.isFinite(offset) || offset < 0 || offset > 1024) return { value: null, error: "bad_offset" };
  const lenPos = offset * 2;
  const len = Number.parseInt(hex.slice(lenPos, lenPos + 64), 16);
  if (!Number.isFinite(len) || len < 0) return { value: null, error: "bad_length" };
  if (len > MAX_URI_CHARS) return { value: null, error: "uri_too_large" };
  const body = hex.slice(lenPos + 64, lenPos + 64 + len * 2);
  if (body.length < len * 2) return { value: null, error: "truncated" };
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  try {
    return { value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { value: null, error: "not_utf8" };
  }
}

/** Turn SQD stream lines (blocks with logs) into agent events plus the last covered block. */
export function parseRegistryLines(lines: any[]): { events: AgentEvent[]; lastBlock: number | null } {
  const events: AgentEvent[] = [];
  let lastBlock: number | null = null;
  for (const line of lines) {
    const h = line?.header;
    if (!h || typeof h.number !== "number") continue;
    lastBlock = Math.max(lastBlock ?? 0, h.number);
    for (const lg of line.logs ?? []) {
      const t0 = lg.topics?.[0];
      if ((t0 !== REGISTERED_TOPIC && t0 !== URI_UPDATED_TOPIC) || lg.topics.length < 3) continue;
      const agentId = Number(BigInt(lg.topics[1]));
      if (!Number.isSafeInteger(agentId)) continue;
      const dec = decodeAbiString(lg.data ?? "0x");
      events.push({
        kind: t0 === REGISTERED_TOPIC ? "registered" : "uri_updated",
        agentId, actor: addrOf(lg.topics[2]), uri: dec.value, uriError: dec.error,
        block: h.number, ts: h.timestamp, txHash: lg.transactionHash, logIndex: lg.logIndex,
      });
    }
  }
  return { events, lastBlock };
}
