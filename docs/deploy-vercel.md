# Deploy on Vercel

The Express app (`src/server.ts`) runs as one Vercel Node function (`api/index.js`).
`npm run build` compiles `src/` to `dist/`. `vercel.json` routes `/health` and `/v1/*` to the
function and serves `public/index.html` at `/`. Trailing-slash redirects are off, so paid routes
answer `402` directly (a `308` would hide the challenge from agents and indexes).

## Steps (you)
1. Vercel: **Add New Project**, import `frerehugi/Anon`, production branch as you choose. No framework preset.
2. Add environment variables, **Production only** for the real key:

| Variable | Value | Scope |
|---|---|---|
| `PAY_TO` | Anon **revenue** wallet address (public) | Production |
| `X402_API_KEY` | key from x402.celo.org (shown once) | Production |
| `INDEX_URL` | `https://anon-indexer.frerehugi.workers.dev` (origin only, https) | Production |
| `INDEX_READ_TOKEN` | the Worker's `READ_TOKEN` (same value; mark Sensitive) | Production |
| `CELO_RPC_URL` | optional, defaults to forno | any |

   `INDEX_URL` and `INDEX_READ_TOKEN` are a pair: without both, the two Index routes do not exist (404) and `/v1/pricing` lists only check and lint.
   `PAY_TO` for Anon: `0xA137b7886F13B9903564B7B9236d12a7A7732E0f` (a separate inbound-only revenue wallet, not the agent wallet).

   Never set `DEV_UNPAID`. Never put the key in a Preview environment: previews would settle real money.
3. Deploy. If a variable is missing the function answers `503 service not configured` instead of serving unpaid routes.
4. Smoke test (sends no payment):
   ```sh
   BASE_URL=https://<your-deployment> EXPECTED_PAY_TO=0x<revenue wallet> npm run smoke
   ```

## Endpoints and prices (USD, USDC/USDT/USAT)

| Route | Price | Returns |
|---|---|---|
| `GET /v1/check?agentId=` | 0.05 | counterparty verdict for an ERC-8004 agent |
| `GET /v1/lint?url=&method=` | 0.03 | findings for an x402 endpoint |
| `GET /v1/index/report?days=` | 0.10 | measured Celo x402 economy report, aggregates only (the per-seller table is removed) |
| `GET /v1/index/agents?...` or `?id=` | 0.02 | agent directory with probe results |

Invalid input is rejected with 400 before the payment middleware, so it is never charged.

## Before real traffic
- **Plan:** Vercel's Hobby plan is meant for non-commercial use; this service takes payments.
  Check Vercel's current terms and use a plan that allows it.
- **Duration:** `maxDuration` is 30 s (fits Hobby and Pro). Probe and RPC timeouts are well below that.
- **First payment:** serverless can freeze after the response, and x402 settles after the handler.
  Do one tiny real call (`/v1/lint`, $0.03) from the Anon wallet, then confirm the settlement
  transaction on celoscan and that the revenue wallet received it. Only then announce the endpoint.
- **Egress:** Vercel has no egress filter. `src/safeFetch.ts` blocks private and non-https targets;
  DNS rebinding between lookup and connect remains a small residual risk.
- **Mainnet and the tag:** x402 settlements are attributed by the `payTo` address (submit it in the
  hackathon form). Every other Celo mainnet transaction must carry `celo_2cc7b29e484b`.

## After deploy
1. Re-run `npm run smoke` against the production URL.
2. Run `npm run cli -- lint https://<deployment>/v1/check` (Anon lints itself).
3. Register the origin: buy catalog "List your service" form, `agent402.tools`, ERC-8004 registration file
   (`services[].endpoint`, `x402Support: true`).
