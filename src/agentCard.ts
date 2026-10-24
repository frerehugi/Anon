// The public ERC-8004 registration file ("agent card") of Anon. Pure code: no network, no keys.
import { IDENTITY_REGISTRY } from "./constants.js";

export const AGENT_REGISTRY_REF = `eip155:42220:${IDENTITY_REGISTRY}`;

export interface AgentCard {
  type: string;
  name: string;
  description: string;
  services: { name: string; endpoint: string; version?: string }[];
  x402Support: boolean;
  active: boolean;
  supportedTrust: string[];
  registrations?: { agentId: number; agentRegistry: string }[];
}

/** Honest state today: no paid endpoint is live yet, so x402Support is false. It is switched on with setAgentURI once it is. */
export function buildCard(opts: { agentId?: bigint | number; services?: AgentCard["services"]; x402Support?: boolean } = {}): AgentCard {
  const card: AgentCard = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Anon",
    description:
      "Anon builds the Celo x402 Index: measured economic metrics of the Celo x402 economy and a directory of ERC-8004 agents with unpaid x402 probes. " +
      "A small agent team with a human owner; payments run through a policy-limited executor. Built for the Agents on Open Rails hackathon. In development.",
    services: opts.services ?? [],
    x402Support: opts.x402Support ?? false,
    active: true,
    supportedTrust: ["reputation"],
  };
  if (opts.agentId !== undefined) card.registrations = [{ agentId: Number(opts.agentId), agentRegistry: AGENT_REGISTRY_REF }];
  return card;
}

export function toDataUri(card: AgentCard): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(card), "utf8").toString("base64")}`;
}

/** Public origin of the live API (Vercel). Change it together with a setAgentURI when a custom domain replaces it. */
export const API_ORIGIN = "https://anon.sterntalerapp.xyz";

/**
 * The paid routes, as the registry directory should list them. Each URL must answer an unpaid request with a 402,
 * so required query parameters carry an example value (the crawler probes these URLs without paying).
 */
export function paidServices(origin: string = API_ORIGIN): AgentCard["services"] {
  return [
    { name: "x402 Index report", endpoint: `${origin}/v1/index/report` },
    { name: "x402 Index agents", endpoint: `${origin}/v1/index/agents` },
    { name: "x402 agent check", endpoint: `${origin}/v1/check?agentId=9903` },
    { name: "x402 endpoint lint", endpoint: `${origin}/v1/lint?url=https://example.com` },
  ];
}
