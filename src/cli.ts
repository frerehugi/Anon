import { checkAgent } from "./check.js";
import { lintEndpoint } from "./lint.js";
import { nodeFetcher } from "./safeFetch.js";
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
    console.log(JSON.stringify(await lintEndpoint(arg, { method, fetcher: nodeFetcher }), replacer, 2));
  } else if (cmd === "metrics" && arg) {
    // rows.json: [{ts,token,payer,payTo,usd,relayer?,gasUsed?,gasPriceWei?}, ...]
    const celoUsd = rest.includes("--celo-usd") ? Number(rest[rest.indexOf("--celo-usd") + 1]) : undefined;
    console.log(JSON.stringify(computeMetrics(JSON.parse(readFileSync(arg, "utf8")), { celoUsd }), replacer, 2));
  } else if (cmd === "index") {
    const { indexCommand } = await import("./indexerCli.js");
    console.log(JSON.stringify(await indexCommand(arg, rest), replacer, 2));
  } else if (cmd === "directory") {
    const { directoryCommand } = await import("./directoryCli.js");
    console.log(JSON.stringify(await directoryCommand(arg, rest), replacer, 2));
  } else if (cmd === "executor") {
    const { executorCommand } = await import("./executorCli.js");
    console.log(JSON.stringify(await executorCommand(arg, rest), replacer, 2));
  } else if (cmd === "deals") {
    const caps = arg && arg !== "--live" ? JSON.parse(readFileSync(arg, "utf8")).capabilities : await fetchCatalog();
    console.log(JSON.stringify(simulateDeals(caps), replacer, 2));
  } else {
    console.error("usage: cli check <agentId> | lint <https-url> [--post] | metrics <rows.json> [--celo-usd N] | deals [--live|catalog.json] | index run|report|status|dump --db <file> | directory crawl|import-events|fetch|probe|stats|list|show --db <file> | executor check|dry-run|status");
    process.exit(2);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
