// Updates Anon's ERC-8004 registration (agent 9973): lists the live paid endpoints and sets x402Support to true.
//   npx tsx scripts/update-agent-card.ts --dry          probes every endpoint (unpaid) and simulates the update; no key needed
//   read -s -p "Key: " AGENT_PRIVATE_KEY; echo; export AGENT_PRIVATE_KEY
//   npx tsx scripts/update-agent-card.ts --send
// The key is read from the environment only and never printed.
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { verifyTx, withAttribution } from "@celo/attribution-tags";
import { writeFileSync } from "node:fs";
import { ANON_AGENT_WALLET, FORNO_RPC, IDENTITY_REGISTRY } from "../src/constants.js";
import { buildCard, paidServices, toDataUri } from "../src/agentCard.js";
import { lintEndpoint } from "../src/lint.js";
import { nodeFetcher } from "../src/safeFetch.js";
import { parseDataUri, probeCandidates, registrationCoherent } from "../src/registration.js";

const AGENT_ID = 9973n;
const TAG = process.env.ATTRIBUTION_TAG ?? "celo_2cc7b29e484b";
const abi = parseAbi([
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);
const send = process.argv.includes("--send");
const transport = http(process.env.CELO_RPC_URL ?? FORNO_RPC, { timeout: 20_000, retryCount: 2 });
const pub = createPublicClient({ chain: celo, transport });

async function main() {
  if ((await pub.getChainId()) !== 42220) throw new Error("not Celo mainnet");
  const owner = await pub.readContract({ address: IDENTITY_REGISTRY, abi, functionName: "ownerOf", args: [AGENT_ID] });
  if (owner.toLowerCase() !== ANON_AGENT_WALLET.toLowerCase()) throw new Error(`agent ${AGENT_ID} is owned by ${owner}, not by the Anon wallet`);

  // 1. every listed endpoint must answer an unpaid request with a valid 402 before we advertise it
  const services = paidServices();
  let bad = 0;
  for (const s of services) {
    const r = await lintEndpoint(s.endpoint, { method: "GET", fetcher: nodeFetcher });
    const payTo = [...new Set((r.challenge?.accepts ?? []).map((a) => a.payTo?.toLowerCase()))];
    const pass = r.status === 402 && r.summary.pass;
    console.log(`${pass ? "PASS" : "FAIL"}  ${s.endpoint}  http ${r.status}  payTo ${payTo.join(",")}`);
    if (!pass) bad++;
  }
  if (bad) throw new Error(`${bad} endpoint(s) do not answer with a valid 402; not updating the card`);

  // 2. the card
  const card = buildCard({ agentId: AGENT_ID, services, x402Support: true });
  const uri = toDataUri(card);
  const parsed = parseDataUri(uri);
  if (!parsed.ok || !registrationCoherent(parsed.reg, AGENT_ID) || probeCandidates(parsed.reg).length !== services.length) throw new Error("new card does not parse as expected");
  console.log(`card ok (${uri.length} chars), ${services.length} endpoints, x402Support true, tag ${TAG}`);

  const gas = await pub.estimateContractGas({ address: IDENTITY_REGISTRY, abi, functionName: "setAgentURI", args: [AGENT_ID, uri], account: ANON_AGENT_WALLET });
  console.log(`simulation ok; gas ~${gas}, cost ~${Number(gas * (await pub.getGasPrice())) / 1e18} CELO`);
  if (!send) { console.log("dry run: nothing sent. Re-run with --send and AGENT_PRIVATE_KEY set."); return; }

  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_PRIVATE_KEY (0x + 64 hex) is required in the environment for --send");
  const account = privateKeyToAccount(key as Hex);
  if (account.address.toLowerCase() !== ANON_AGENT_WALLET.toLowerCase()) throw new Error(`the key belongs to ${account.address}, not to the Anon wallet; refusing`);
  const wallet = createWalletClient({ account, chain: celo, transport }).extend(withAttribution(TAG));
  const tx = await wallet.writeContract({ address: IDENTITY_REGISTRY, abi, functionName: "setAgentURI", args: [AGENT_ID, uri] });
  console.log(`setAgentURI sent: ${tx}`);
  const rc = await pub.waitForTransactionReceipt({ hash: tx });
  if (rc.status !== "success") throw new Error(`reverted: ${tx}`);
  // A node that is a block behind can still serve the old URI right after the receipt: wait until the read shows the new card.
  let current = "";
  for (let i = 0; i < 15; i++) {
    current = await pub.readContract({ address: IDENTITY_REGISTRY, abi, functionName: "tokenURI", args: [AGENT_ID], blockNumber: rc.blockNumber });
    if (current === uri) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const onchain = parseDataUri(current);
  writeFileSync("agent/agent-card.json", JSON.stringify(card, null, 2) + "\n");
  console.log(JSON.stringify({
    agentId: AGENT_ID.toString(), tx, block: rc.blockNumber.toString(),
    onChain: onchain.ok ? { x402Support: onchain.reg.x402Support, endpoints: probeCandidates(onchain.reg).length, coherent: registrationCoherent(onchain.reg, AGENT_ID) } : "unparsable",
    attribution: (await verifyTx({ client: pub, hash: tx }))?.codes ?? null,
  }, null, 2));
}

main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
