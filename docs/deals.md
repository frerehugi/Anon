# Anon Deals (sub-project of the Index)

"Group buying for agents": several buyers pool requests for the same catalog product so that each pays less than
buying alone. Anon is the market maker, pays the supplier once, splits the results.

## Where the discount comes from (measured on the live buy catalog)

Several suppliers price in bundles with a large fixed part per call. In the catalog, 22 products have tiers of
1/5/10 results; roughly half of the smallest price is fixed. Examples (USD per result, smallest tier vs 10-result tier):

| Product | Solo | In a 10-pack | Cheaper |
|---|---:|---:|---:|
| Reddit scraper (lite) | 0.0898 | 0.0151 | 83% |
| TikTok scraper | 0.0036 | 0.0009 | 75% |
| X tweet scraper | 0.0038 | 0.0011 | 71% |
| LinkedIn job search | 0.0070 | 0.0025 | 64% |

These products accept list inputs (`usernames`, `searchTerms`, `startUrls`, ...), so requests from several buyers
can in principle be merged into one call.

## What stops it (and what the simulator checks)

- **Settlement cost floor.** A settlement costs about 0.0015 USD in gas (measured: 0.0174 CELO at ~0.086 USD/CELO) plus
  0.3% facilitator fee. Slots below roughly 0.02 USD do not carry that cost as single payments. They work as **packs**
  (several slots per payment). The simulator evaluates both modes.
- **Unit semantics.** `maxResults` counts results, not inputs. For content scrapers (posts, comments, tweets) results are
  items, so pooling different inputs may not give each buyer a fair share. Unverified until a small test purchase.
- **Personal data.** Profile, people, email, follower products are excluded from recommendations.
- **Supplier revenue.** A pooled purchase pays the supplier less than N solo calls. Weigh against the hackathon criterion
  "demand created for the services consumed".
- **Fill risk.** Anon pays the full bundle; unfilled slots are Anon's loss, bounded by the bundle price (cents).

## Simulator

```sh
npm run cli -- deals --live        # fetch the live catalog
npm run cli -- deals catalog.json  # or a saved catalog
```

Per product it reports solo price, pooled cost per unit, structural saving, slot price, buyer saving, margin per slot,
break-even slots, and flags (`personal_data`, `unit_semantics_unverified`, `results_are_content_items`, `no_list_input`,
`free_alternative_exists`, `shared_session_isolation_risk`). Parameters: gas per settlement, fee bps, markup, minimum discount, pack size.

First live result (23 candidates): 7 recommended; only one (Reddit scraper) is viable as a single payment; the others need packs.

## Deal lifecycle (planned)

`open -> filling -> closed -> purchased -> delivered | refunded`

1. Open: deal board entry with product, input template, window, slot price, slots filled.
2. Join: buyer pays the announced slot price via x402 and submits its input. The price never exceeds the solo price.
3. Close: window ends or bundle is full. The executor buys the largest tier justified by filled slots, within policy.
4. Deliver: code splits and validates results per buyer. A buyer only sees its own data.
5. Refund: if the purchase fails or a slot cannot be served, the slot price is returned.

Later option: all-or-nothing deals using signed EIP-3009 authorizations that are only submitted once the threshold is reached.

## Connection to the Index

- The Directory shows who the buyers and suppliers are; Metrics measure fill rate, tickets and repeat buyers of deals.
- Anon's own recurring purchases (index refreshes) can anchor a bundle; the remaining slots are offered to others.
- All deal purchases are paid by the tagged agent wallet and logged in the ledger.

## Test plan and kill criteria

1. Run the simulator weekly; keep only products with a positive margin after the gas floor.
2. One small real test purchase (a few cents) per candidate to verify what a bundle returns for several inputs.
3. Ask real agent builders whether they would join (Telegram, office hours) before building the deal board.
4. Stop a deal type after 14 days without independent buyers or with a negative margin.

## Not built yet

Deal engine, board and endpoints. The simulator and its tests exist.
