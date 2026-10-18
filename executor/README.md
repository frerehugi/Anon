# Executor

A small deterministic component (no LLM). It is the only component that may sign payments.
Code: `src/executor/`, CLI: `npm run cli -- executor ...`.

**Status:** policy engine, approvals, ledger, dry-run flow and the x402 signer (`src/executor/x402Signer.ts`) are built and tested offline.
**No live payment has been made yet.** Live runs need `--live` and `AGENT_PRIVATE_KEY` in the environment.

## Signer rules

- Holds the key, used only for the ops wallet; refuses a key that is not the Anon wallet (`0x3880…e1ea`).
- Asks the endpoint for its quote first (same method and body as the paid call), then signs only if the quote is Celo mainnet, scheme `exact`,
  the approved token and an amount at most the approved amount. Otherwise it fails before signing.
- Supports x402 v2 (`eip155:42220`, `amount`) and v1 (the buy gateway: `celo`, `maxAmountRequired`), GET and POST with a JSON body (JSON-RPC).
- After signing, the authorization (`from`, `to`, `value`) is checked against the quote again before it is sent.
- `settled` only for a 2xx response with a successful settlement receipt. Everything else after signing is `uncertain` and counts as spent.
- Never follows redirects and never retries. The response body is returned to the caller but not stored in the ledger; it is untrusted data.
- x402 settlements are sent by the facilitator, so there is no tagged transaction from this wallet. Attribution for these is the `payTo` address.

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
npm run cli -- executor run request.json            # same as dry-run unless --live is given
AGENT_PRIVATE_KEY=0x... npm run cli -- executor run request.json --live   # the only way money moves
npm run cli -- executor status
```

## First live test (about 0.01 USDC)

1. Enable the endpoint: set `enabled: true` for `https://gateway.usebuy.ai/chainstack/celo` in `loop/policy/allowlist.yaml` after checking a fresh quote
   (`npm run cli -- lint https://gateway.usebuy.ai/chainstack/celo`).
2. Copy `examples/approval-first-test.json` to `loop/decisions/2026-10-18-first-test.json` (cap 0.05).
3. `npm run cli -- executor dry-run examples/payment-request.json`: must say `dry_run`, allowed.
4. Live: `AGENT_PRIVATE_KEY=0x... npm run cli -- executor run examples/payment-request.json --live`, then unset the key.
5. Check `loop/ledger/payments.jsonl` (`pending` then `settled` with the tx hash) and the wallet balance.

## Not done yet

- Running the Anon wallet's key in a hosted executor (today it runs where the key is typed in by a human).
- Verifying the first tagged transaction with `verifyTx`; writing revenue and fees to `loop/ledger/ledger.csv`.
- Token-to-USD conversion: USDC, USDT and USAT are treated as 1 USD.
