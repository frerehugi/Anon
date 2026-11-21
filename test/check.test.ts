import { test } from "node:test";
import assert from "node:assert/strict";
import { probeWithRetry } from "../src/check.js";
import type { LintResult } from "../src/lint.js";

const result = (pass: boolean, status = pass ? 402 : 500): LintResult => ({ status, summary: { pass }, findings: [] } as unknown as LintResult);

test("a probe that passes the first time is not repeated", async () => {
  let calls = 0;
  const r = await probeWithRetry("https://x.example", { lint: async () => { calls++; return result(true); }, pauseMs: 0 });
  assert.equal(calls, 1);
  assert.equal(r.summary.pass, true);
});

test("one miss is retried and a pass on the retry counts as passing", async () => {
  const seq = [result(false), result(true)];
  let i = 0;
  const r = await probeWithRetry("https://x.example", { lint: async () => seq[i++], pauseMs: 0 });
  assert.equal(i, 2);
  assert.equal(r.summary.pass, true);
});

test("two misses in a row count as a failure", async () => {
  let i = 0;
  const r = await probeWithRetry("https://x.example", { lint: async () => { i++; return result(false); }, pauseMs: 0 });
  assert.equal(i, 2);
  assert.equal(r.summary.pass, false);
});
