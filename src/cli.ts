import { checkAgent } from "./check.js";
import { lintEndpoint } from "./lint.js";
import { readFileSync } from "node:fs";
import { computeMetrics } from "./metrics/compute.js";
import { fetchCatalog, simulateDeals } from "./deals/simulate.js";

const [cmd, arg, ...rest] = process.argv.slice(2);
const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

async function main() {
  if (cmd === "check" && arg) {
    console.log(JSON.stringify(await checkAgent(BigInt(arg)), replacer, 2));
  } else if (cmd === "lint" && arg) {
    const method = rest.includes("--post") ? "POST" : "GET";
    console.log(JSON.stringify(await lintEndpoint(arg, { method }), replacer, 2));
  } else if (cmd === "metrics" && arg) {
    // rows.json: [{ts,token,payer,payTo,usd,relayer?,gasUsed?,gasPriceWei?}, ...]
    const celoUsd = rest.includes("--celo-usd") ? Number(rest[rest.indexOf("--celo-usd") + 1]) : undefined;
    console.log(JSON.stringify(computeMetrics(JSON.parse(readFileSync(arg, "utf8")), { celoUsd }), replacer, 2));
  } else if (cmd === "deals") {
    const caps = arg && arg !== "--live" ? JSON.parse(readFileSync(arg, "utf8")).capabilities : await fetchCatalog();
    console.log(JSON.stringify(simulateDeals(caps), replacer, 2));
  } else {
    console.error("usage: cli check <agentId> | lint <https-url> [--post] | metrics <rows.json> [--celo-usd N] | deals [--live|catalog.json]");
    process.exit(2);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
