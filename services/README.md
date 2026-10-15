# Services (x402 endpoints Anon sells)

Candidate product 1: **Celo / agent intelligence API** (wallet risk score, ERC-8004 agent check,
protocol snapshots), built on data bought through buy (Chainstack RPC, SQD).

## Seller setup (from the Celo docs)

- Packages: `@x402/express` (or `@x402/hono`), `@x402/core`, `@x402/evm`; scheme `exact`.
- Facilitator: `https://api.x402.celo.org` (mainnet), `https://api.x402.sepolia.celo.org` (test).
  `/verify` and `/supported` are open; `/settle` needs the API key (`X402_API_KEY`, server only).
- Do not use `price: "$0.01"` on Celo (throws). Use an explicit price object (`amount`, `asset`, `extra`).
- USDT needs `extra: { name: "Tether USD", version: "1" }`.
- Mainnet (`eip155:42220`) USDC `0xcebA9300f2b948710d2653dD7B07f33A8B32118C`,
  USDT `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` (6 decimals).
- Fee: gas at cost + 0.3% of the payment per settlement.
- Check `GET /supported` before promising USA₮ as a payment token.

Status: not implemented yet.
