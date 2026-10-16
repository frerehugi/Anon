# Deploy the indexer on Cloudflare

The indexer is its own Worker with its own D1 database. Do **not** reuse the OSIRIS keeper Worker or any of its secrets;
the indexer needs no wallet key.

## Steps (you, in a terminal on your machine)

```sh
npx wrangler login
npx wrangler d1 create anon-index
```

1. Copy the printed `database_id` into `wrangler.toml` (`database_id = "..."`).
2. Create the tables:
   ```sh
   npx wrangler d1 migrations apply anon-index --remote
   ```
3. Optional but recommended, backfill history so the Worker only fetches new blocks:
   ```sh
   npm run cli -- index run  --db anon-index.sqlite --backfill-days 4
   npm run cli -- index dump --db anon-index.sqlite --out anon-index-dump.sql
   npx wrangler d1 execute anon-index --remote --file anon-index-dump.sql
   ```
4. Set the read token (pick a long random string) and deploy:
   ```sh
   npx wrangler secret put READ_TOKEN
   npx wrangler deploy
   ```
5. After a few cron runs (every 5 minutes) check:
   ```sh
   curl https://anon-indexer.<your-subdomain>.workers.dev/health
   curl -H "Authorization: Bearer <READ_TOKEN>" "https://anon-indexer.<your-subdomain>.workers.dev/v1/report?days=1&celo_usd=0.086"
   ```

## Plan notes

- Defaults in `wrangler.toml` target the Free plan (10 ms CPU per cron run). If the runs are cut off ("exceeded CPU time"),
  move to Workers Paid and raise `WINDOW_BLOCKS`, `MAX_WINDOWS` and `MAX_STATEMENTS` (see `docs/indexer.md`).
- The cron uses one of the five cron triggers an account has on the Free plan; the OSIRIS keeper already uses one.

## If something is wrong

- `/health` shows `lastRun.status = error`: read `lastRun.error`. `HTTP 529` is the free SQD service being busy; the next cron run continues.
- The cursor does not move: check `SIGNERS` and that the D1 binding is named `DB`.
- Report empty: no settlements in the window yet, or the dump was not imported and the first runs are still catching up.
