# Hackathon: Agents on Open Rails

Event slug `agents-on-open-rails` (Loops House x Celo). Deadline: 2026-11-09 09:00 GMT.
Winners announced 2026-11-13.

## Rules we must meet
- Celo mainnet only. Testnet does not count.
- ERC-8021 attribution tag `celo_2cc7b29e484b` in every Celo mainnet transaction, from the first one.
  x402 settlements: submit the `payTo` address instead (tags not supported there yet).
- ERC-8004 identity for the agent, registered from the agent wallet.
- Public GitHub repo at enrollment and until judging.
- Code written during the hackathon. Anything reused must be disclosed.
- Relayer-paid gas does not count as our contribution; describe it.
- Required field `agent-wallet`: the public address Anon sends from.

## Tracks
- **Build with buy**: verified paid calls from the tagged wallet, named user, demand created for consumed services.
- **USA₮ with x402**: real USA₮ settlement via the Celo facilitator, a named independent counterparty, repeat payments, reason USA₮ fits.

## Timeline
| By | Goal |
|---|---|
| 19.10. | Repo scaffold, wallet, ERC-8004 registration |
| 26.10. | Service built and tested, facilitator account |
| 31.10. | Mainnet live, tagged, first independent customers |
| 06.11. | Traction, audit report |
| 09.11. | Submission |

## Open questions
- Are two projects per person allowed? Ask the organizers before moving money.
- Does the facilitator settle USA₮ for payers (`GET /supported`)?
