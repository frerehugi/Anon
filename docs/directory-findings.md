# Directory findings: ERC-8004 reputation on Celo

Measured on 2026-10-29 from the Anon index (`/health`, `directory.reputation`). All 10,005 registered agents were read on chain through a paid Chainstack node (buy, x402); the payments are in `loop/audits/`. Aggregates only: no agent or client addresses are published here.

Raw reputation means the entries in the ERC-8004 reputation registry. Anyone can add them. The number of **distinct clients** is therefore the figure to look at, not the number of entries.

| | Agents | Share of all 10,005 |
|---|---:|---:|
| With at least one reputation entry | 7,777 | 77.7 % |
| …from exactly one client | 5,770 | 57.7 % |
| …from 2 to 4 distinct clients | 1,981 | 19.8 % |
| …from 5 to 19 distinct clients | 21 | 0.2 % |
| …from 20 or more distinct clients | 5 | 0.05 % |

So three out of four agents that look rated rest on a single client, and only 26 agents (0.26 %) have feedback from five or more clients. The single-client agents hold 9,261 entries, about 1.6 per agent: this is mostly one entry from one client, not heavy repetition.

## By owner type

Bulk owners are registrants with 50 or more agents (6 owners, 8,862 agents, 88.6 % of the directory).

| | Checked | With entries | More than one client | Owner changed |
|---|---:|---:|---:|---:|
| Bulk owners | 8,862 | 7,062 (79.7 %) | 1,796 | 57 |
| All other owners | 1,143 | 715 (62.6 %) | 211 | 16 |
| Declared x402 (81 agents) | 81 | 19 (23.5 %) | 12 | n/a |

- 73 agents (0.7 %) have a current NFT owner that differs from the registrant.
- Agents that declare x402 support are rated less often than the average (23.5 % against 77.7 %).

## What this does not show

- Distinct clients are distinct addresses, not distinct people. Fresh wallets cost nothing, so more than one client is a necessary sign of independence, not a proof.
- We did not check whether a client is the agent's owner, a bulk registrant or an automated service.
- Entry values (the scores) are stored raw and not interpreted here.

Reproduce: `curl https://anon-indexer.frerehugi.workers.dev/health` (the `directory.reputation` block), or `npm run cli -- directory stats` on a local copy of the database.
