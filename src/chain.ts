import { createPublicClient, http, parseAbi } from "viem";
import { celo } from "viem/chains";
import { FORNO_RPC } from "./constants.js";

export const publicClient = createPublicClient({
  chain: celo,
  transport: http(process.env.CELO_RPC_URL ?? FORNO_RPC, { timeout: 10_000, retryCount: 1 }),
});

export const identityAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

export const reputationAbi = parseAbi([
  "function getClients(uint256 agentId) view returns (address[])",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);
