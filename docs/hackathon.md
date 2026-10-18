# Hackathon: Agents on Open Rails

Event slug `agents-on-open-rails` (Loops House x Celo). Deadline: 2026-11-09 09:00 GMT.
Winners announced 2026-11-13.

## Rules we must meet
- Celo mainnet only. Testnet does not count.
- ERC-8021 attribution tag `celo_2cc7b29e484b` in every Celo mainnet transaction, from the first one.
  x402 settlements: submit the `payTo` address instead (tags not supported there yet).
  Anon revenue `payTo` (public, inbound only): `0xA137b7886F13B9903564B7B9236d12a7A7732E0f`.
- ERC-8004 identity for the agent, registered from the agent wallet.
- Public GitHub repo at enrollment and until judging.
- Code written during the hackathon. Anything reused must be disclosed.
- Relayer-paid gas does not count as our contribution; describe it.
- Required field `agent-wallet`: the public address Anon sends from.
  Anon agent wallet (public, EOA, Celo mainnet): `0x388097B8047cDCAB7e2c7FE67fc42AdfAE1fe1ea`. ERC-8004 agent id **9973** (registered 2026-10-18, both transactions tagged `celo_2cc7b29e484b`).

## Tracks
- **Build with buy**: verified paid calls from the tagged wallet, named user, demand created for consumed services.
- **USA₮ with x402**: real USA₮ settlement via the Celo facilitator, a named independent counterparty, repeat payments, reason USA₮ fits.

## Timeline
| By | Goal |
|---|---|
| 19.10. | Repo scaffold, wallet, ERC-8004 registration |
| 26.10. | Service built and tested, facilitator account |
| 31.10. | Mainnet live, tagged, first independent customers |
| 06.11. | Traction, audit report |
| 09.11. | Submission |

## Open questions
- ~~Are two projects per person allowed?~~ Resolved: the owner confirmed multiple projects are approved (2026-10-15). Keep Anon fully separate from other entries: own Loops account, tag, wallet and ERC-8004 identity.
- ~~Does the facilitator settle USA₮ for payers?~~ Resolved: yes, `GET /supported` on api.x402.celo.org lists USAT (EIP-3009).

## Evidence log

- **2026-10-18, first paid call through buy (Build with buy):** Anon wallet paid 0.01 USDC to the buy gateway `payTo` for one
  Chainstack Celo JSON-RPC call (`eth_blockNumber`). x402 v1 quote, signed by the executor, settled by the Celo facilitator.
  Tx `0x47e009c6ea5947a68514ec3673909979d006d8e9efc51a49ac0d0a3b8c605f7e`, block 80431638, status success.
  Checked on chain: USDC `Transfer` from the Anon wallet to the gateway `payTo`, 0.01; the facilitator signer submitted the tx and paid its gas
  (about 0.017 CELO), so the wallet's own nonce stayed at 2. Attribution for x402 settlements is by `payTo` / wallet, not by a tag in the tx.
- **2026-10-18, first settlement on Anon's own API (self-test, not demand):** the Anon agent wallet called `GET /v1/lint` on the production
  deployment (Vercel) and paid 0.03 USDC. Tx `0x220f93fc4fe29fb8325c3e8e81b8f31dfc209a4e1519803bfd94bc9340450a91`, block 80437591, status success.
  Checked on chain: USDC `Transfer` from the agent wallet `0x3880…e1ea` to the Anon revenue wallet `0xA137…2E0f`, 0.03; submitted by the Celo
  facilitator signer. Proves that settlement completes on serverless. Own traffic: `independent = n`, it does not count as customer demand.
