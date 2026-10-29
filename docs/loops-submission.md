# Loops project description (draft of 2026-10-29)

Replaces the `description` of the project in the event `agents-on-open-rails`. Every number is measured and reproducible; see `docs/directory-findings.md` and `loop/audits/`.

```text
Anon: the Celo x402 Index. An agent team that measures the Celo x402 economy and sells the result per call. Three products over one data core: (1) measured economics of Celo x402 (volume, payers, sellers, concentration, gas cost, share of flows inside closed payment loops, independent demand); (2) a directory of ERC-8004 agents with unpaid x402 probes and on-chain facts; (3) trust checks and endpoint linting for both sides of a payment. Pay per call in USDC, USDT or USAT via Celo's x402 facilitator at https://anon.sterntalerapp.xyz ($0.10 report, $0.02 directory, $0.05 check, $0.03 lint).

Tracks: USAT with x402; Build with buy.
Identity and addresses: ERC-8004 agent #9973; agent wallet 0x388097B8047cDCAB7e2c7FE67fc42AdfAE1fe1ea (every own transaction carries celo_2cc7b29e484b); x402 revenue payTo 0xA137b7886F13B9903564B7B9236d12a7A7732E0f.

What the index found (measured 2026-10-29, aggregates only): more than 56,000 x402 settlements indexed since 16 Oct; all 10,005 registered ERC-8004 agents read on chain. 7,777 of them show reputation entries, but 5,770 of those rest on a single client, and only 26 agents (0.26 %) have feedback from five or more distinct clients. Raw reputation is not trust. 88.6 % of the agents belong to six bulk registrants, 73 agents changed owner since registration, 81 declare x402 and 14 have an endpoint that passes the unpaid probe. Method and caveats: docs/directory-findings.md in the repo.

Build with buy: Anon's executor (deterministic, allowlist, limits, kill switch, append-only ledger) signs x402 payments to the buy gateway, and the directory is read through it: the owner, agent wallet and reputation of all 10,005 agents come from paid Chainstack Celo RPC calls (JSON-RPC batches, 0.01 USDC each). The reports in loop/audits/ list 112 of these payments with their tx hashes; an earlier job checked a sample of 100 indexed settlements against their on-chain receipts (100 of 100 matched). First paid call: tx 0x47e009c6ea5947a68514ec3673909979d006d8e9efc51a49ac0d0a3b8c605f7e. The executor stops a run when a payment is uncertain and never retries it; two uncertain payments are in the ledger.

Independent users: none yet. Our own test settlement on Anon's API (0.03 USDC, tx 0x220f93fc4fe29fb8325c3e8e81b8f31dfc209a4e1519803bfd94bc9340450a91) is self-traffic and should not be counted.
Gas: x402 settlements are submitted and paid by the facilitator; Anon's own transactions (ERC-8004 registration and updates) are tagged.
Built with: a human owner and an AI coding agent (Claude Code); code written during the hackathon; MIT license, public repo.
```

Apply (needs the owner's approval, `--confirm`):

```sh
loops project update --event agents-on-open-rails --description "<text above>" --confirm
```

Tracks: the project has no bounties selected yet. Ids from `loops bounties --event agents-on-open-rails`:

- Build with buy: `e9a90153-6486-4deb-8027-a931e5eea4d2`
- Open Corridors: USA₮ with x402, 1st place: `603875c0-cce6-44c8-a001-a7342006e340`, 2nd place: `8f651898-2fdc-4f6e-8c12-407cd08a9f7d`
