// Celo mainnet facts, verified live against https://api.x402.celo.org/supported
// and the Celo docs on 2026-10-15. Re-verify before relying on them.
export const CELO_CHAIN_ID = 42220;
export const CELO_NETWORK = "eip155:42220";
export const FORNO_RPC = "https://forno.celo.org";

export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;

export interface AssetInfo {
  symbol: string;
  decimals: number;
  name: string;
  version: string;
  method: "eip3009" | "permit2";
}

export const ASSETS: Record<string, AssetInfo> = {
  "0xcebA9300f2b948710d2653dD7B07f33A8B32118C": { symbol: "USDC", decimals: 6, name: "USDC", version: "2", method: "eip3009" },
  "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e": { symbol: "USDT", decimals: 6, name: "Tether USD", version: "1", method: "eip3009" },
  "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771": { symbol: "USAT", decimals: 6, name: "Tether America USD", version: "1", method: "eip3009" },
  "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D": { symbol: "wARS", decimals: 18, name: "Peso Argentino", version: "1", method: "permit2" },
  "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0": { symbol: "wBRL", decimals: 18, name: "Real Brasileño", version: "1", method: "permit2" },
  "0x8a1D45e102e886510e891d2Ec656a708991e2D76": { symbol: "wCOP", decimals: 18, name: "Peso Colombiano", version: "1", method: "permit2" },
};

const lower = new Map(Object.entries(ASSETS).map(([a, i]) => [a.toLowerCase(), i] as const));
export function assetInfo(address: string): AssetInfo | undefined {
  return lower.get(address.toLowerCase());
}

export const VISA_API = "https://agent-api.self.xyz";

/** Block of the first mint in the ERC-8004 Identity Registry on Celo (Blockscout, token 1): 2026-02-06. */
export const REGISTRY_FIRST_BLOCK = 58_476_306;
