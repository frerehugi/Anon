import { checkAgent } from "./check.js";
import { lintEndpoint } from "./lint.js";

const [cmd, arg, ...rest] = process.argv.slice(2);
const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

async function main() {
  if (cmd === "check" && arg) {
    console.log(JSON.stringify(await checkAgent(BigInt(arg)), replacer, 2));
  } else if (cmd === "lint" && arg) {
    const method = rest.includes("--post") ? "POST" : "GET";
    console.log(JSON.stringify(await lintEndpoint(arg, { method }), replacer, 2));
  } else {
    console.error("usage: cli check <agentId> | cli lint <https-url> [--post]");
    process.exit(2);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
