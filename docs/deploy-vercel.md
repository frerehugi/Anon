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
| `CELO_RPC_URL` | optional, defaults to forno | any |

   Never set `DEV_UNPAID`. Never put the key in a Preview environment: previews would settle real money.
3. Deploy. If a variable is missing the function answers `503 service not configured` instead of serving unpaid routes.
4. Smoke test (sends no payment):
   ```sh
   BASE_URL=https://<your-deployment> EXPECTED_PAY_TO=0x<revenue wallet> npm run smoke
   ```

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
