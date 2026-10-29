# Anon

An autonomous agent team that earns, pays and settles on live Celo mainnet rails.

Anon sells a paid API to other agents over **x402** (Celo facilitator), buys its inputs
from other agents and services through **buy** (usebuy.ai), and has an **ERC-8004** identity.
A small "Loop" of agents (investor, builder, auditor) decides what to build and spend.
Every decision is logged in this repo.

Built for the **Agents on Open Rails** hackathon (Loops House x Celo). Tracks targeted:
**Build with buy** and **USA₮ with x402**.

> Status: paid API live on Vercel; first settlements verified on Celo mainnet (see docs/hackathon.md).

## What Anon sells

Trust before payment, for both sides of x402 on Celo:

| Endpoint | For | What it returns | Price |
|---|---|---|---|
| `GET /v1/check?agentId=<id>` | buyers | verdict ok/caution/avoid for an ERC-8004 agent, with reasons | $0.05 |
| `GET /v1/lint?url=<https url>&method=GET\|POST` | sellers | findings and fixes for an x402 endpoint, without paying it | $0.03 |
| `GET /v1/index/report?days=` | analysts | measured Celo x402 economy report (aggregates only) | $0.10 |
| `GET /v1/index/agents?...` | agents | ERC-8004 agent directory with x402 probe results | $0.02 |

Accepted tokens: USDC, USD₮, USA₮ (EIP-3009) on Celo mainnet via the Celo facilitator.
Check signals: ERC-8004 identity and registration file, live x402 probe, reputation registry,
Celo Agent Visa tier (low weight), wallet history. It is a heuristic, not a guarantee.

## The Index and Anon Deals

Anon is built around one data core, the **Index**, with two views and one connected sub-project:

- **Metrics** (`docs/metrics.md`, `src/metrics`): versioned definitions of volume, sellers, payers, concentration,
  gas cost and a payment-circuit indicator, each labelled measured, estimated or unavailable.
- **Directory** (`docs/directory.md`, crawler: `docs/crawler.md`): Celo agents and x402 services with probes, reputation and trust evidence.
- **Anon Deals** (`docs/deals.md`, `src/deals`): group buying for agents on catalog products that get cheaper in bundles.

Overview and status: `docs/architecture.md`. Indexer: `docs/indexer.md`, deployment: `docs/deploy-cloudflare.md`.

## Run

```sh
npm install
npm test                       # offline unit tests
npm run cli -- check 9817      # read-only live check on Celo mainnet
npm run cli -- lint https://example.com/paid
npm run cli -- metrics rows.json --celo-usd 0.086   # market metrics from settlement rows
npm run cli -- deals --live                          # rank group-buy candidates from the live catalog
npm run cli -- executor check examples/payment-request.json   # payment policy check (dry run only, no signer yet)
npm run cli -- index run --db anon-index.sqlite      # index settlements from SQD into a local SQLite file
npm run cli -- index report --db anon-index.sqlite --days 1
npm run cli -- directory crawl --db anon-index.sqlite   # ERC-8004 registry scan, registration files, x402 probes
PAY_TO=0x... X402_API_KEY=... npm start   # paid server; refuses to start without both
```


## Architecture

```
services/   x402 endpoints Anon sells (payTo = revenue wallet)
executor/   deterministic payment executor (policy engine and x402 signer built, no live payment yet); code in src/executor
loop/       the agent team: roles, policy, memos, decisions, ledger, audits
agent/      ERC-8004 agent card and registration
docs/       hackathon notes, risks
```

### The Loop

| Role | Job | Money access |
|---|---|---|
| CIO-bot | Decides every investment. Writes a pre-mortem for each approval. | none; writes approvals only |
| CTO-bot | Builds and runs the product. Pitches investments via memos. | small ops budget through the executor |
| Auditor-bot | Independent, read-only. Compares forecasts to results, reports to the human. | none |
| Helpers | Short-lived bots with a task, a token budget and an expiry. | none |

Hard rules live in code (`executor/`, `loop/policy/`), not in prompts. See `loop/roles/`.

### Wallets

- **Revenue**: x402 `payTo`, inbound only.
- **Treasury**: paid out only by the executor.
- **Ops**: small balance for buy purchases.

Private keys are never stored in this repo or given to any agent. See `.env.example`.

## Hackathon identifiers

- Event: `agents-on-open-rails`
- ERC-8021 attribution tag: `celo_2cc7b29e484b` (every Celo mainnet transaction carries it;
  x402 settlements are attributed via the `payTo` address instead)

## On-chain evidence (Celo mainnet)

Anon deploys no smart contract of its own; it uses the standard ERC-8004 registries, the stablecoin contracts and Celo's x402 facilitator.

| What | Address |
|---|---|
| ERC-8004 Identity Registry | [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) |
| ERC-8004 Reputation Registry | [`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`](https://celoscan.io/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63) |
| Anon agent wallet (ERC-8004 agent #9973, tag `celo_2cc7b29e484b`) | [`0x388097B8047cDCAB7e2c7FE67fc42AdfAE1fe1ea`](https://celoscan.io/address/0x388097B8047cDCAB7e2c7FE67fc42AdfAE1fe1ea) · [8004scan](https://www.8004scan.io/agents/celo/9973) |
| Anon revenue wallet (x402 `payTo`) | [`0xA137b7886F13B9903564B7B9236d12a7A7732E0f`](https://celoscan.io/address/0xA137b7886F13B9903564B7B9236d12a7A7732E0f) |
| USDC / USD₮ / USA₮ | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` / `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` / `0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771` |

Sample transactions (all mainnet, all checked on chain; details in [`docs/hackathon.md`](docs/hackathon.md)):

| What | Transaction |
|---|---|
| ERC-8004 registration (tagged) | [`0x3c0782…1b456`](https://celoscan.io/tx/0x3c0782579d2be0a01f742969a9686dee155d286b487c4aee51961fb927e1b456) |
| Card update 1 (tagged) | [`0x77f385…9723d`](https://celoscan.io/tx/0x77f3852b627042c05dfd52c0ea760c0a336c22d98c95ee0c2c6156075ba9723d) |
| Card update: paid routes listed, `x402Support` true (tagged) | [`0xc21bee…c15a8f`](https://celoscan.io/tx/0xc21bee39fbe735d37dac81f8a58b740abf9186af1b5f9c3732cebb69d3c15a8f) |
| Card update: own domain (tagged) | [`0xaa3a5a…c3fa`](https://celoscan.io/tx/0xaa3a5a9b5ebabb27697c9759e8b8fabd89cabfeadd59805bfb9612242f98c3fa) |
| First paid call through buy: 0.01 USDC for a Celo JSON-RPC call | [`0x47e009…5f7e`](https://celoscan.io/tx/0x47e009c6ea5947a68514ec3673909979d006d8e9efc51a49ac0d0a3b8c605f7e) |
| Settlement audit through buy: 0.01 USDC, 100 of 100 sampled settlements matched | [`0x215743…809f`](https://celoscan.io/tx/0x2157437da0879bbb00a55055d3f0598340c13f937d94dc7283f45a4a855c809f) |
| Self-test on Anon's own API: 0.03 USDC (own traffic, not customer demand) | [`0x220f93…0a91`](https://celoscan.io/tx/0x220f93fc4fe29fb8325c3e8e81b8f31dfc209a4e1519803bfd94bc9340450a91) |

x402 settlements are submitted and paid by the Celo facilitator (the transaction sender is its signer), so for them the attribution is the `payTo` address.

## How to reproduce

```sh
npm install && npm test                       # offline tests, no keys needed
npm run cli -- check 9903                     # read-only agent check on Celo mainnet
npm run cli -- lint https://anon.sterntalerapp.xyz/v1/check?agentId=9903
curl -i https://anon.sterntalerapp.xyz/v1/index/agents    # 402 with the price and accepted tokens
curl https://anon.sterntalerapp.xyz/stats                 # live counts from the indexer
```
Everything that signs a payment needs the wallet key and runs only in the executor (`executor/README.md`); the tests use throwaway keys.

## Hackathon disclosure

- All code in this repository was written during the hackathon (from 2026-10-15), by a human owner working with an AI coding agent
  (Claude Code); the Loop's bots are agents as well. Commits made by the agent say so in their trailer.
- Reused ideas, not code: the cron-worker layout follows the owner's other project OSIRIS (own design, rewritten here); the executor's
  "check at signing time, default deny, limits, kill switch" pattern is inspired by AgentVault. No code was copied from either.
- Third-party libraries are used as published: x402 (`@x402/*`), viem, `@celo/attribution-tags`, express, yaml.
- Gas of x402 settlements is paid by the Celo facilitator and is not counted as Anon's contribution; Anon's own transactions
  (ERC-8004 registration and updates) carry the tag.
- Data is read from public sources only (Celo RPC, the free SQD portal, public ERC-8004 registration files, unpaid probes).
  No secrets are stored in this repository.

## License

MIT, see `LICENSE`.
