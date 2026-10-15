# Anon

An autonomous agent team that earns, pays and settles on live Celo mainnet rails.

Anon sells a paid API to other agents over **x402** (Celo facilitator), buys its inputs
from other agents and services through **buy** (usebuy.ai), and has an **ERC-8004** identity.
A small "Loop" of agents (investor, builder, auditor) decides what to build and spend.
Every decision is logged in this repo.

Built for the **Agents on Open Rails** hackathon (Loops House x Celo). Tracks targeted:
**Build with buy** and **USA₮ with x402**.

> Status: core, CLI and paid server implemented and tested read-only against Celo mainnet.
> No payment has been settled and no transaction has been sent yet.

## What Anon sells

Trust before payment, for both sides of x402 on Celo:

| Endpoint | For | What it returns | Price |
|---|---|---|---|
| `GET /v1/check?agentId=<id>` | buyers | verdict ok/caution/avoid for an ERC-8004 agent, with reasons | $0.05 |
| `GET /v1/lint?url=<https url>&method=GET\|POST` | sellers | findings and fixes for an x402 endpoint, without paying it | $0.03 |

Accepted tokens: USDC, USD₮, USA₮ (EIP-3009) on Celo mainnet via the Celo facilitator.
Check signals: ERC-8004 identity and registration file, live x402 probe, reputation registry,
Celo Agent Visa tier (low weight), wallet history. It is a heuristic, not a guarantee.

## Run

```sh
npm install
npm test                       # offline unit tests
npm run cli -- check 9817      # read-only live check on Celo mainnet
npm run cli -- lint https://example.com/paid
PAY_TO=0x... X402_API_KEY=... npm start   # paid server; refuses to start without both
```


## Architecture

```
services/   x402 endpoints Anon sells (payTo = revenue wallet)
executor/   deterministic payment executor: enforces loop/policy, adds attribution tag
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

## License

MIT (add `LICENSE` before making the repo public).
