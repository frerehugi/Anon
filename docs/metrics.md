# Metrics (version 0.1.0)

Definitions live in `src/metrics/definitions.ts` and are the single source of truth. Every number carries a status:
**measured** (read from chain), **estimated** (model on top of measured data), **unavailable** (not visible on chain).

| Metric | Status | Definition |
|---|---|---|
| Gross volume (GMV) | measured | Sum of face values of EIP-3009 settlements to payTo addresses, stablecoins at 1 USD |
| Settlements | measured | Count of settlements sent by a known facilitator signer |
| Active payers | measured | Distinct payer addresses (pseudonymous; one person can use several) |
| Active sellers (payTo) | measured | Distinct payTo addresses; a gateway counts once however many shops sit behind it |
| Average and median ticket | measured | GMV / settlements; median of single values |
| Concentration | measured | Top-5 payTo share of settlements and GMV; Herfindahl index (0 to 10,000) over GMV per payTo |
| Payment circuit share | measured | Flows whose payer and payTo sit in the same strongly connected group of at least two addresses, plus self-payments |
| Excluding circuit | measured | All metrics recomputed without circuit flows; closest proxy for independent demand |
| Repeat payer rate | measured | Share of (payer, payTo) pairs with at least two settlements in the window |
| Facilitator share | measured | Share of settlements per facilitator signer |
| Settlement gas cost | measured | gasUsed x effective gas price, in CELO; in USD when a CELO price is supplied |
| Processing cost to the seller | estimated | Gas at cost plus the facilitator fee (default 0.3%), per the Celo facilitator's published pricing |
| Revenue per shop behind a shared payTo | estimated | Inferred from price points only; exact only for unique prices |
| Profit / margin | unavailable | Cost of goods is not visible on chain; only revenue minus processing cost is reported |

## Payment circuit: method

Build the directed graph payer -> payTo over the window and find strongly connected components (iterative Tarjan,
`stronglyConnected`). A component of at least two addresses means money can travel from each member back to
itself through the others. Flows inside such a component, and self-payments, are the "circuit". This detects rings
longer than two (direct reciprocal pairs are not required).

It is a **pattern, not a verdict**. Load tests, simulations and legitimate internal flows look the same. The report
therefore always shows both views and never labels intent.

## Views

- **Overall**: everything the facilitator settled.
- **Excluding circuit**: independent-demand proxy.
- **Per shop**: per payTo (exact) and per label such as a gateway payTo (shop split only estimated).
- **Daily series** and **top sellers** with repeat-payer share, circuit share, first-seen day and processing cost.

## Known limits

- Window and coverage: only configured facilitator signers; other facilitators are separate rows when added.
- About 19% of signer transactions contain none of the tracked tokens and are not classified yet.
- SQD can reject large queries; the indexer must use small windows and a fallback source.
- Gas to USD needs a CELO price source and is an estimate at the time of computation.

## Usage

```sh
npm run cli -- metrics rows.json --celo-usd 0.086
```

`rows.json` is a list of `{ ts, token, payer, payTo, usd, relayer?, gasUsed?, gasPriceWei? }`. A reference run on
real data is kept locally and is not published until the findings are discussed with the Celo team.
