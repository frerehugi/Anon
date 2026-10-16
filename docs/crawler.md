# Directory crawler

Builds the Celo agent directory (`docs/directory.md`) from the ERC-8004 Identity Registry. Code: `src/directory/`, CLI: `directory`, Worker: second cron.

## Pipeline

1. **Registry scan** (`runRegistryCycle`): `Registered` and `URIUpdated` events from SQD, from block 58,476,306 to the finalized head.
   Same resumable scan core as the settlement indexer (`src/indexer/scan.ts`): cursor in the same transaction, overload retried unchanged, window shrinks only for size errors.
   `data:` URIs are parsed on the spot; `https`/`ipfs` URIs are queued.
2. **Registration files** (`processPending`): queued files are fetched (8 s timeout, 64 KB cap, safe-URL checks). Failures retry after 2 h, 4 h, then the agent is marked `unreadable` (404/410 and unparsable files immediately).
3. **Probes** (`runProbes`): every https endpoint that declares x402 or looks like a paid route gets one unpaid request through the linter. Passing endpoints are re-checked every 6 h, failing ones back off exponentially up to 7 days. Stored: HTTP status, error codes, `payTo`, accepted assets, pass rate. Nothing is ever paid.

An agent's x402 status is one of `live`, `declared_failing`, `declared_unverified`, `declared_no_endpoint`, `none`, `inactive`, `unreadable`.
The registry is open, so every entry carries `ownerAgents` (how many agents the same owner registered) and the stats report a bulk-owner share.

## Local run

```sh
npm run cli -- directory crawl --db anon-index.sqlite          # scan, fetch, probe until caught up
npm run cli -- directory import-events --file events.jsonl     # offline import of raw registry events
npm run cli -- directory stats|list|show 9903 --db anon-index.sqlite
npm run cli -- directory dump --db anon-index.sqlite --out anon-directory-dump.sql
```

## Worker

Second cron `2-59/10 * * * *` (`DIRECTORY_CRON` in `worker/index.ts`, must match `wrangler.toml`), Free-plan budgets: 3 windows, 6 requests, 25 statements, 6 file fetches, 6 probes per run.
Reads (bearer `READ_TOKEN`, fail closed): `GET /v1/agents?x402=1&live=1&tag=&q=&owner=&order=recent|id&limit=&offset=`, `GET /v1/agents/:id`. `/health` includes aggregate directory counts.
The historic backfill (about 20,000 events) is done locally and imported with the dump; the Worker then only follows new events.

## Status

First local run on the real registry (2026-10-16): 9,964 agents; about 89% belong to six owners with 50+ registrations; 63 declare x402; of 272 candidate endpoints, 18 pass the unpaid probe.
Numbers move with every run and are not published as results before they are re-measured.
