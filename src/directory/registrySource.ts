import { SQD_CELO, sqdFinalizedHead, sqdPost } from "../indexer/sqd.js";
import { RetryableSourceError } from "../indexer/types.js";
import { IDENTITY_REGISTRY } from "../constants.js";
import { parseRegistryLines, REGISTERED_TOPIC, URI_UPDATED_TOPIC, type AgentEvent } from "./events.js";

export interface RegistryWindow { events: AgentEvent[]; lastBlock: number }
export interface RegistrySource {
  finalizedHead(): Promise<number>;
  window(fromBlock: number, toBlock: number): Promise<RegistryWindow>;
}

/** ERC-8004 Identity Registry events (Registered, URIUpdated) from the SQD portal. */
export class SqdRegistrySource implements RegistrySource {
  constructor(private readonly base: string = SQD_CELO, private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init), private readonly pauseMs = 0) {}

  finalizedHead() { return sqdFinalizedHead(this.fetchImpl, this.base); }

  async window(fromBlock: number, toBlock: number): Promise<RegistryWindow> {
    if (this.pauseMs) await new Promise((r) => setTimeout(r, this.pauseMs));
    const lines = await sqdPost(this.fetchImpl, this.base, {
      type: "evm", fromBlock, toBlock,
      fields: { block: { number: true, timestamp: true }, log: { address: true, topics: true, data: true, transactionHash: true, logIndex: true } },
      logs: [{ address: [IDENTITY_REGISTRY.toLowerCase()], topic0: [REGISTERED_TOPIC, URI_UPDATED_TOPIC] }],
    });
    const parsed = parseRegistryLines(lines);
    if (parsed.lastBlock === null) throw new RetryableSourceError("empty response without block headers", true);
    return { events: parsed.events, lastBlock: parsed.lastBlock };
  }
}
