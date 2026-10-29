// Calls one paid route of Anon's own API from another wallet, to test the flow with a payer that is not the Anon wallet.
// Usage: CALLER_PRIVATE_KEY=0x... npm run pay-anon -- check [agentId] | lint <url> | agents | report
// The key comes from the environment only. The script pays the price Anon quotes, never more than the cap below, and asks before it signs.
// The result is written to loop/audits/ and labelled as a test by the same owner: it is not independent demand.
import { createInterface } from "node:readline/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { X402Signer } from "../src/executor/x402Signer.js";
import { toAtomic } from "../src/executor/policy.js";
import { nodeFetcher } from "../src/safeFetch.js";
import { ANON_AGENT_WALLET } from "../src/constants.js";

const ORIGIN = "https://anon.sterntalerapp.xyz";
const REVENUE_WALLET = "0xA137b7886F13B9903564B7B9236d12a7A7732E0f";
const ROUTES: Record<string, { path: (a: string[]) => string; max: string }> = {
  check: { path: (a) => `/v1/check?agentId=${encodeURIComponent(a[0] ?? "9973")}`, max: "0.05" },
  lint: { path: (a) => `/v1/lint?url=${encodeURIComponent(a[0] ?? "")}`, max: "0.03" },
  agents: { path: () => "/v1/index/agents?x402=1&live=1&limit=5", max: "0.02" },
  report: { path: () => "/v1/index/report?days=7", max: "0.10" },
};

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  const route = name ? ROUTES[name] : undefined;
  if (!route) throw new Error("usage: pay-anon check [agentId] | lint <https url> | agents | report");
  if (name === "lint" && !rest[0]?.startsWith("https://")) throw new Error("lint needs an https url");
  const key = process.env.CALLER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("CALLER_PRIVATE_KEY (0x + 64 hex) is required in the environment");
  const account = privateKeyToAccount(key as `0x${string}`);
  if ([ANON_AGENT_WALLET, REVENUE_WALLET].some((w) => w.toLowerCase() === account.address.toLowerCase())) throw new Error("this key belongs to Anon itself; use the other wallet");
  const url = ORIGIN + route.path(rest);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Pay up to ${route.max} USDC to Anon for ${url}\nfrom ${account.address}? (yes/no) `);
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") { console.log("cancelled, nothing signed"); return; }

  const signer = new X402Signer({ account, fetcher: nodeFetcher, timeoutMs: 120_000 });
  const out = await signer.pay({ id: `caller-test-${name}`, wallet: "ops", url, token: "USDC", amount: toAtomic(route.max), experiment: "caller-test", approvalId: "manual" });
  const date = new Date().toISOString();
  const report = {
    date, route: name, url, payer: account.address, status: out.status, txHash: out.txHash, detail: out.detail, maxUsdc: route.max,
    note: "Test by the owner of Anon with a second wallet. It is not independent demand and must not be reported as such.",
    responsePreview: out.body?.slice(0, 1500),
  };
  mkdirSync("loop/audits", { recursive: true });
  const file = `loop/audits/${date.slice(0, 10)}-caller-test-${name}-${date.slice(11, 19).replace(/:/g, "")}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: out.status, txHash: out.txHash, detail: out.detail, file, price: route.max }, null, 2));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
