# Agent identity (ERC-8004)

Anon's identity is registered from the **Anon agent wallet** `0x388097B8047cDCAB7e2c7FE67fc42AdfAE1fe1ea` (not any other project's wallet).
Registry on Celo mainnet: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.
Guide: https://docs.celo.org/build-on-celo/build-with-ai/8004

Only the Anon-facing identity is registered; the internal loop bots are not.

## How

The card (`src/agentCard.ts`) is stored on-chain as a `data:` URI, so no hosting is needed. Two transactions, both carrying the
hackathon attribution tag `celo_2cc7b29e484b` (ERC-8021, via `withAttribution`):

1. `register(agentURI)`: mints the identity; the registry sets the agent wallet to the sender.
2. `setAgentURI(agentId, uri)`: the id is read from the `Registered` event of the receipt (not from the call's return value) and written
   into the card's `registrations` entry, so card and registry agree.

```sh
npx tsx scripts/register-agent.ts --dry                      # simulation only, no key needed (cost ~0.13 CELO)
AGENT_PRIVATE_KEY=0x... npx tsx scripts/register-agent.ts --send   # on your own machine, key only in the environment
```

The script refuses a key that does not belong to the Anon wallet, refuses a second registration for the same wallet (`--force` overrides),
checks chain id 42220, verifies both transactions with `verifyTx`, and writes `agent/agent-card.json`.

## Card state

Registered with `x402Support: false` and no services, because nothing paid was live. Once the API was live and tested, the card is updated with
another `setAgentURI` (`scripts/update-agent-card.ts`): it first probes every listed endpoint without paying and refuses to advertise one that
does not answer with a valid 402, then lists the four paid routes (`src/agentCard.ts`, `paidServices`) and sets `x402Support: true`.
The directory crawler then probes these URLs like any other agent's. If the API origin changes (custom domain), update `API_ORIGIN` and run the script again.

```sh
npx tsx scripts/update-agent-card.ts --dry     # probes the endpoints, simulates; no key
read -s -p "Key: " AGENT_PRIVATE_KEY; echo; export AGENT_PRIVATE_KEY
npx tsx scripts/update-agent-card.ts --send
unset AGENT_PRIVATE_KEY
```

Status: **registered on 2026-10-18** as agent **9973** (owner and agent wallet `0x388097B8047cDCAB7e2c7FE67fc42AdfAE1fe1ea`).
- register: `0x3c0782579d2be0a01f742969a9686dee155d286b487c4aee51961fb927e1b456` (block 80426275)
- setAgentURI: `0x77f3852b627042c05dfd52c0ea760c0a336c22d98c95ee0c2c6156075ba9723d` (block 80426276)
Both carry `celo_2cc7b29e484b`; checked with `verifyTx`. Card on-chain parses and is coherent with the id.
