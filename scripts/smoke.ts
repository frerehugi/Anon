// Post-deploy smoke test. Sends NO payment. Usage:
//   BASE_URL=https://<deployment> EXPECTED_PAY_TO=0x... npm run smoke
import { parseChallenge, lintChallenge } from "../src/lint.js";

const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const expectedPayTo = process.env.EXPECTED_PAY_TO?.toLowerCase();
if (!base) { console.error("BASE_URL is required"); process.exit(2); }

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failed++;
};
const get = (path: string) => fetch(base + path, { redirect: "manual" });

const health = await get("/health");
ok("GET /health is 200 with no redirect", health.status === 200, String(health.status));

const bad = await get("/v1/check?agentId=abc");
ok("invalid input returns 400, not 402", bad.status === 400, String(bad.status));

for (const path of ["/v1/check?agentId=9817", "/v1/lint?url=https://example.com"]) {
  const res = await get(path);
  ok(`${path} answers 402 directly (no redirect)`, res.status === 402, String(res.status));
  const header = res.headers.get("payment-required");
  ok(`${path} carries a PAYMENT-REQUIRED header`, !!header);
  if (!header) continue;
  const ch = parseChallenge(new Headers({ "payment-required": header }), "");
  const findings = lintChallenge(ch, 402);
  const errors = findings.filter((f) => f.severity === "error");
  ok(`${path} challenge passes our own linter`, errors.length === 0, errors.map((e) => e.code).join(","));
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  ok(`${path} advertises an https resource URL`, String(decoded.resource?.url ?? "").startsWith(base.startsWith("https") ? "https://" : "http://"), decoded.resource?.url);
  const payTos = new Set((ch?.accepts ?? []).map((a) => a.payTo?.toLowerCase()));
  if (expectedPayTo) ok(`${path} pays to the expected revenue wallet`, payTos.size === 1 && payTos.has(expectedPayTo), [...payTos].join(","));
  const symbols = (ch?.accepts ?? []).map((a) => a.asset?.slice(0, 8));
  ok(`${path} offers 3 tokens`, symbols.length === 3, symbols.join(","));
}
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
