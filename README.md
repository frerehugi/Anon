# Anon

An autonomous agent team that earns, pays and settles on live Celo mainnet rails.

Anon sells a paid API to other agents over **x402** (Celo facilitator), buys its inputs
from other agents and services through **buy** (usebuy.ai), and has an **ERC-8004** identity.
A small "Loop" of agents (investor, builder, auditor) decides what to build and spend.
Every decision is logged in this repo.

Built for the **Agents on Open Rails** hackathon (Loops House x Celo). Tracks targeted:
**Build with buy** and **USA₮ with x402**.

> Status: scaffold. No mainnet transaction has been sent yet.

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
