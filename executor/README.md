# Executor

A small deterministic component (no LLM). It is the only component that may sign payments.
Code: `src/executor/`, CLI: `npm run cli -- executor ...`.

**Status:** policy engine, approvals, ledger and dry-run flow are built and tested. **No signer is wired:** live payments are refused.
The signer (x402 client via `buy`, plus transfers with the ERC-8021 tag) comes next and needs the Anon wallet.

## Flow

1. A bot (CTO) writes a payment request; the CIO has written an approval in `loop/decisions/<date>-<memo>.json`.
2. `evaluate()` (pure, `engine.ts`) checks against fresh state: kill switch, allowlist (exact https endpoint, `enabled: true` only),
   token, per-call limit, approval (CIO, not expired, same experiment, cumulative cap), experiment limit, daily limit per wallet, total budget
   (before gate 2: `experiments`; after: plus `growth`; the reserve is never released by code).
3. Everything is recorded in the append-only ledger `loop/ledger/payments.jsonl`. Denials too, with reasons.
4. Live path: write-ahead `pending` entry, kill switch re-read, signer call. A signer that throws or is unclear gives `uncertain`;
   uncertain counts as spent and is never retried automatically. A reused request id is denied.
5. Payments run one at a time, so parallel requests cannot pass the same limit twice.

Default is dry run. Config errors (missing key, bad number, chain id other than 42220, budget parts above the total) stop everything: fail closed.

## Files

- `loop/policy/limits.yaml`, `allowlist.yaml`: human-edited. Endpoints are off until `enabled: true` after a `buy quote`.
- `loop/decisions/*.json`: CIO approvals `{id, memo, experiment, cap, expires, approvedBy: "cio"}`; `gates.json`: `{"gate2": true}` set by the human.
- `loop/policy/KILL` (file) or `ANON_KILL=1`: stops all payments.
- Request: `{id, wallet: "ops"|"treasury", url, token, amount, experiment, approvalId}`; amounts are decimal USD strings, converted exactly (6 decimals).

## Commands

```sh
npm run cli -- executor check request.json      # decision only
npm run cli -- executor dry-run request.json    # decision and ledger entry, nothing signed
npm run cli -- executor status
```

## Not done yet

- Signer implementation and the Anon wallet (key only in the executor's environment, never in an agent's context).
- Verifying the first tagged transaction with `verifyTx`; writing revenue and fees to `loop/ledger/ledger.csv`.
- Token-to-USD conversion: USDC, USDT and USAT are treated as 1 USD.
