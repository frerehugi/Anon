-- A failing endpoint is published as failing only after two unpaid probes in a row failed (CONFIRM_FAILURES in src/directory/store.ts).
-- Recompute the published verdict (last_pass) of rows probed under the old rule, where one failed probe already counted as failing:
-- 1 passing, 0 confirmed failing, NULL unverified (never passed and only one failure so far).
UPDATE endpoints SET last_pass = CASE
  WHEN consecutive_failures = 0 THEN 1
  WHEN consecutive_failures >= 2 THEN 0
  WHEN probes_pass > 0 THEN 1
  ELSE NULL
END
WHERE probes_total > 0;
-- Endpoints with one unconfirmed failure are probed again at the next cycle.
UPDATE endpoints SET next_probe_at = 0 WHERE probes_total > 0 AND consecutive_failures = 1;
