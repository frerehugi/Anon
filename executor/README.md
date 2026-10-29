# Executor

A small deterministic component (no LLM). It is the only component that may sign payments.
Code: `src/executor/`, CLI: `npm run cli -- executor ...`.

**Status:** policy engine, approvals, ledger, dry-run flow and the x402 signer (`src/executor/x402Signer.ts`) are built and tested offline.
**First live payment made 2026-10-18** (0.01 USDC to the buy gateway, settled; see `docs/hackathon.md`). Live runs need `--live` and `AGENT_PRIVATE_KEY` in the environment.

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

## Jobs: settlement audit through buy

`executor audit` re-checks a random sample of the indexed settlements against an independent RPC that Anon pays for through buy
(Chainstack Celo, one JSON-RPC batch of up to 2000 receipts for 0.01 USDC). It is the Auditor role in practice: the indexer's rows are
compared with receipts it did not produce. The executor's policy applies as for any payment (allowlist, approval `audit`, limits, ledger).

```sh
INDEX_READ_TOKEN=...   # the indexer's READ_TOKEN, entered without echo
npm run cli -- executor audit --n 100                 # dry run: shows the plan and the policy decision, pays nothing
AGENT_PRIVATE_KEY=0x... npm run cli -- executor audit --n 100 --live
```

- Needs `examples/approval-audit.json` copied to `loop/decisions/` and the Worker route `GET /v1/audit/sample?n=` (bearer `READ_TOKEN`, at most 500 rows).
- Per row it checks: tx status success, block, the `Transfer` log at the recorded index, token contract, payer, payTo and amount. The relayer is a soft check.
- A missing receipt is **inconclusive**, not a mismatch: public RPC nodes disagree with each other (Forno answered `null` for transactions it returned a moment earlier),
  so those hashes are asked for again once (`--rounds`, default 2, at most 3 batches). The match rate is matched / (checked - inconclusive).
- The report goes to `loop/audits/<date>-settlement-audit-<id>.json` with payment tx hashes, counts and mismatch reasons, but no payer or payTo addresses.

## Jobs: directory enrichment through buy

`executor enrich` adds on-chain facts to the directory: the current owner of each agent NFT, the agent wallet, and the **raw** reputation (number of clients,
number of feedback entries, summed value). They are read through the same paid Chainstack node (JSON-RPC batches of up to 2000 calls, 0.01 USDC each) and stored
in the indexer (`agent_chain`, shown as `chain` in `/v1/agents`, filter `rated=1`).

```sh
INDEX_READ_TOKEN, INDEX_WRITE_TOKEN   # entered without echo; the write token is a separate secret of the Worker (WRITE_TOKEN)
npm run cli -- executor enrich --scope x402                 # dry run: plan, estimated cost, policy decision
AGENT_PRIVATE_KEY=0x... npm run cli -- executor enrich --scope x402 --live
npm run cli -- executor enrich --scope all --live            # every agent in the directory (about 10,000: roughly 56 stage A batches plus the summary batches, about 0.6 to 1.2 USDC)
```

- Needs `examples/approval-enrich.json` (cap 1.20) in `loop/decisions/`, migration `0003`, and the Worker routes `GET /v1/agent-ids` (read token) and
  `POST /v1/ingest/agent-chain` (write token, at most 500 rows, strict validation).
- Stage A (3 calls per agent: `ownerOf`, `getAgentWallet`, `getClients`, 180 agents per batch, because the gateway rejects bodies of about 150 KB) and stage B (`getSummary` for agents that have clients, 100 per batch and at most 110 KB).
  Each chunk is self-contained: it is paid, parsed and stored before the next one starts, so a stop loses at most one batch. Agents checked within `--stale-hours` (default 24) are skipped.
- Reputation is shown raw and labelled so: anyone can add feedback, and a single client can contribute many entries (agent 9903 has 179 entries from one client).
  `rawClients` next to `rawCount` makes that visible. It is a signal, not a rating.

## Not done yet

- Running the Anon wallet's key in a hosted executor (today it runs where the key is typed in by a human).
- Verifying the first tagged transaction with `verifyTx`; writing revenue and fees to `loop/ledger/ledger.csv`.
- Token-to-USD conversion: USDC, USDT and USAT are treated as 1 USD.
