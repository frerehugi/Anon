# Architecture: the Index, its two views, and Anon Deals

Anon is built around one data core, the **Index**, with two views and one connected sub-project.

```
 sources                    Index core                          views / products
 ───────                    ──────────                          ────────────────
 settlements (SQD, RPC)  →  ingest → store → compute   →  Metrics report   (src/metrics)
 ERC-8004 registry       →  (small windows, retries)   →  Directory        (docs/directory.md)
 live endpoint probes    →                              →  Check / Lint     (src/check.ts, src/lint.ts)
 buy catalog (prices)    →                              →  Anon Deals       (docs/deals.md, src/deals)
```

## Why one core

Everything x402 on Celo settles on chain, and 99.8% of EIP-3009 settlements in a 24h sample went through one
facilitator signer. Reading those settlements plus the agent registry and probing the declared endpoints
gives a near-complete picture without asking anyone for data.

## Ingest

| Source | Used for | Reliability |
|---|---|---|
| SQD portal via `gateway.usebuy.ai/sqd` (free, rate limited) | settlement history, transfers, gas | rejects large queries with HTTP 529; use windows of about 2,500 blocks with retry and backoff |
| Celo RPC (forno, or paid Chainstack through buy) | registry reads, receipts, fallback when SQD is overloaded | forno is free but rate limited |
| Facilitator `/supported` | signer addresses, assets | open |
| Live probes (`src/lint.ts`) | endpoint health, payTo, price | SSRF-guarded, unpaid, one request per origin |
| buy `/v1/catalog` | capability prices and input schemas | free, public |

A settlement is: an ERC-20 `Transfer` of USDC, USDT or USAT inside a transaction sent by a known facilitator
signer. About 19% of signer transactions contain none of the three tokens (probably other assets such as wFIAT via
Permit2). They are counted as "unclassified" until analysed, not silently dropped.

## Store and compute

- Daily aggregates and per-seller rows are enough for the views; raw settlements can be rebuilt from chain data.
- Target storage: Cloudflare D1 or KV written by a cron Worker (same pattern as the OSIRIS keeper), read by the
  Vercel endpoints with a read-only token. Not implemented yet.
- All numbers come from pure functions (`src/metrics/compute.ts`) so they are unit-tested and reproducible.

## Views

1. **Metrics report** (`docs/metrics.md`): fixed, versioned definitions; always shows a "gross" and an
   "excluding payment circuit" view; each metric labelled measured, estimated or unavailable.
2. **Directory** (`docs/directory.md`): registry entries enriched with probes, reputation, visa tier and a trust
   verdict; searchable by capability.

## Anon Deals (connected sub-project)

Pools demand for catalog products that get cheaper per unit in bigger bundles. It reads the live buy catalog, uses
the Directory and Metrics to see who buys what, and writes its results back into the same ledger. See `docs/deals.md`.

## Autonomy loop (one cycle)

1. Scout: new registry entries, new settlements, catalog changes.
2. Evaluate: probes, supplier quotes, deal simulation.
3. Buy: batched RPC or bundle purchases through the executor, within `loop/policy`.
4. Process: compute metrics, update the directory, split deal results.
5. Offer: x402 endpoints for queries and deal slots.
6. Measure: ledger, fill rates, margins; the auditor compares forecast with result.

The executor is the only component that signs. Bots read and write data and memos, never keys.

## Status

| Part | State |
|---|---|
| Check, Lint, paid server, Vercel entry | built and tested read-only |
| Metrics engine (`src/metrics`) | built, unit-tested, reproduces a 4-day real dataset |
| Deal simulator (`src/deals`) | built, unit-tested, runs on the live catalog |
| Indexer with storage, cron Worker | not built |
| Directory crawler and query endpoint | not built |
| Executor, deal engine, dashboard | not built |

## Publication rule

Findings about third-party addresses (for example closed payment circuits) are reported only as aggregate
indicators, never with addresses, and are discussed with the Celo team before any public release.
