# Indexer

Reads x402 settlements on Celo into a SQL database (Cloudflare D1 in production, a SQLite file locally) and turns them
into the metrics report. Core in `src/indexer`, Worker entry in `worker/index.ts`, schema in `migrations/`.

```
SQD portal ──► window(from,to) ──► parse ──► INSERT OR IGNORE + cursor (one transaction) ──► buildReport ──► computeMetrics
```

## What it stores

| Table | Content |
|---|---|
| `settlements` | one row per EIP-3009 transfer of USDC, USDT or USAT sent by a known facilitator signer (`tx_hash, log_index` is the key) |
| `unclassified_txs` | signer transactions without such a transfer (other assets, approvals, failures), so coverage is measurable |
| `cursor` | last fully processed block per source, moved in the same transaction as the rows it covers |
| `runs` | one row per cycle: window count, rows, status, error |

## Correctness rules

- **Idempotent.** Rows use `INSERT OR IGNORE`; running a range twice changes nothing.
- **Atomic.** A window's rows and the cursor update are one batch; a failure rolls back both.
- **No skipped blocks.** SQD always returns the first and last block header of the requested range. If the last header is
  below the requested end, the response was cut short and the next request starts right after the last covered block.
- **Gas** is attached to the first transfer of a transaction only, so it is not counted twice.
- **Coverage is explicit.** About 19% of signer transactions have no tracked-token transfer; they are counted in
  `meta.unclassifiedTxs` of every report.

## What the live source taught us

- SQD returns `HTTP 529 overloaded` **at random, independent of window size** (a 250-block window failed while a 2,500-block
  window succeeded). The indexer therefore retries the **same window** with exponential backoff. It shrinks the window only for
  timeouts and server errors.
- One day of Celo (86,400 blocks) took about 2.5 minutes with 30 retries; a follow-up run fetched only the new blocks in under 3 seconds.
- SQD is a free, shared service. A second `Source` (for example Chainstack through buy, a paid call) can be plugged in through
  the `Source` interface; it is not implemented yet.

## Limits and defaults

| | Workers Free | Workers Paid |
|---|---|---|
| CPU per cron run | 10 ms | 30 s |
| Subrequests per run | 50 | 10,000 |
| D1 queries per run | 50 | 1,000 |
| Suggested vars | `WINDOW_BLOCKS=500`, `MAX_WINDOWS=2`, `MAX_STATEMENTS=40` | `WINDOW_BLOCKS=2500`, `MAX_WINDOWS=20`, `MAX_STATEMENTS=900` |

D1 allows 100 bound parameters per statement, so inserts are chunked (8 settlement rows per statement).
Whether 10 ms CPU is enough even for small windows has not been tested on Cloudflare; if runs are cut off, use Workers Paid.
Backfill history locally and import it (see `docs/deploy-cloudflare.md`) so the Worker only needs to fetch new blocks.

## Read API (Worker)

- `GET /health`: cursor block, row count, data range, last run. No addresses.
- `GET /v1/report?days=N&celo_usd=X`: the metrics report. Requires `Authorization: Bearer <READ_TOKEN>`; without a configured
  token the endpoint answers 503 (fails closed).

The indexer holds **no wallet key**. Its only secret is `READ_TOKEN`.

## Local commands

```sh
npm run cli -- index run    --db anon-index.sqlite --backfill-days 1   # fill from SQD, resumable
npm run cli -- index report --db anon-index.sqlite --days 1 --celo-usd 0.086
npm run cli -- index status --db anon-index.sqlite
npm run cli -- index dump   --db anon-index.sqlite --out dump.sql       # for D1 import
```

Environment overrides: `SIGNERS`, `LABELS`, `WINDOW_BLOCKS`. Default signers: the Celo facilitator and the third-party x402Go signer.

## Tests

`test/indexer.test.ts` covers parsing, idempotency, atomic rollback, truncated responses, window shrinking, overload backoff,
retry limit with a recorded error run, statement budget across cycles, the report, the D1 adapter and the SQL dump round trip.

## Independent check

`GET /v1/audit/sample?n=` (bearer `READ_TOKEN`) returns random indexed settlements so that another component can verify them. The executor job `executor audit`
(see `executor/README.md`) pays Chainstack through buy to fetch the receipts and compares them with the rows. Public Forno nodes are not consistent with each other
(a receipt can be `null` on one node and present on the next), which is one reason to use a paid, dedicated node for audits.
