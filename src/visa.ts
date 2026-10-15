import { CELO_CHAIN_ID, VISA_API } from "./constants.js";

export interface VisaStatus {
  available: boolean;
  tier?: number;
  tierName?: string;
  transactionCount?: number;
  volumeUsd?: number;
  error?: string;
}

/** Read-only call to Self's public Celo Agent Visa endpoint. Failure means "unknown", never "bad". */
export async function readVisa(agentId: bigint): Promise<VisaStatus> {
  try {
    const res = await fetch(`${VISA_API}/api/visa/${CELO_CHAIN_ID}/${agentId}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const j: any = await res.json();
    return {
      available: true,
      tier: typeof j.tier === "number" ? j.tier : undefined,
      tierName: j.tierName,
      transactionCount: j.metrics?.transactionCount,
      volumeUsd: j.metrics?.volumeUsd,
    };
  } catch (e) {
    return { available: false, error: (e as Error).message };
  }
}
