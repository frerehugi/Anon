import { parseStreamLines } from "./parse.js";
import { RetryableSourceError, type Source, type WindowResult } from "./types.js";

export const SQD_CELO = "https://gateway.usebuy.ai/sqd/datasets/celo-mainnet";

/** SQD portal source (free, per-IP rate limit). Returns what the portal covered; the caller continues from lastBlock + 1. */
export class SqdSource implements Source {
  constructor(
    private readonly base: string = SQD_CELO,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly pauseMs = 0,
  ) {}

  async finalizedHead(): Promise<number> {
    const res = await this.fetchImpl(`${this.base}/finalized-head`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new RetryableSourceError(`finalized-head HTTP ${res.status}`, res.status >= 500 && res.status !== 529);
    const j: any = await res.json();
    if (typeof j?.number !== "number") throw new Error("finalized-head: unexpected response");
    return j.number;
  }

  async window(fromBlock: number, toBlock: number, signers: string[]): Promise<WindowResult> {
    if (this.pauseMs) await new Promise((r) => setTimeout(r, this.pauseMs));
    const body = {
      type: "evm", fromBlock, toBlock,
      fields: {
        block: { number: true, timestamp: true },
        transaction: { from: true, to: true, hash: true, gasUsed: true, effectiveGasPrice: true, status: true },
        log: { address: true, topics: true, data: true, transactionHash: true, logIndex: true },
      },
      transactions: [{ from: signers.map((s) => s.toLowerCase()), logs: true }],
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/finalized-stream`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new RetryableSourceError(`network: ${(e as Error).message}`, true);
    }
    if (res.status === 429 || res.status >= 500) throw new RetryableSourceError(`HTTP ${res.status}`, res.status >= 500 && res.status !== 529);
    if (!res.ok) throw new Error(`SQD HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const parsed = parseStreamLines(lines);
    if (parsed.lastBlock === null) throw new RetryableSourceError("empty response without block headers", true);
    return { settlements: parsed.settlements, unclassified: parsed.unclassified, lastBlock: parsed.lastBlock };
  }
}
