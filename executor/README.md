# Executor

A small deterministic script (no LLM). It is the only component that can sign payments.

1. Reads an approval from `loop/decisions/` and `loop/policy/*.yaml`.
2. Refuses anything not on the allowlist, above `max_amount`, over a daily or budget limit.
3. Calls `buy curl --max-amount ...` or sends a transaction. On Celo mainnet every transaction
   goes through one wallet client extended with `withAttribution("celo_2cc7b29e484b")`
   (`@celo/attribution-tags` >= 0.5.0). No call site builds its own client.
4. Verifies the first tagged transaction with `verifyTx`, then writes to `loop/ledger/`.
5. Never auto-retries `500 provision_failed` or `500 settle_uncertain`.

Keys come from the environment (see `.env.example`), never from the repo or from an agent's context.

Status: not implemented yet.
