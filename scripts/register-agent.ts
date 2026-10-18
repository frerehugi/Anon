// Registers Anon in the ERC-8004 Identity Registry on Celo mainnet, from the Anon agent wallet.
//   npx tsx scripts/register-agent.ts --dry            simulate only (no key needed)
//   AGENT_PRIVATE_KEY=0x... npx tsx scripts/register-agent.ts --send
// The key is read from the environment only, never from an argument, and never printed.
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { verifyTx, withAttribution } from "@celo/attribution-tags";
import { writeFileSync } from "node:fs";
import { FORNO_RPC, IDENTITY_REGISTRY } from "../src/constants.js";
import { buildCard, toDataUri } from "../src/agentCard.js";
import { parseDataUri, registrationCoherent } from "../src/registration.js";

const EXPECTED_WALLET = "0x388097B8047cDCAB7e2c7FE67fc42AdfAE1fe1ea" as const;
const TAG = process.env.ATTRIBUTION_TAG ?? "celo_2cc7b29e484b";
const abi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const send = process.argv.includes("--send");
const force = process.argv.includes("--force");
const transport = http(process.env.CELO_RPC_URL ?? FORNO_RPC, { timeout: 20_000, retryCount: 2 });
const pub = createPublicClient({ chain: celo, transport });

async function main() {
  const chainId = await pub.getChainId();
  if (chainId !== 42220) throw new Error(`wrong chain ${chainId}, expected Celo mainnet 42220`);

  let account: ReturnType<typeof privateKeyToAccount> | undefined;
  if (send) {
    const key = process.env.AGENT_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_PRIVATE_KEY (0x + 64 hex) is required in the environment for --send");
    account = privateKeyToAccount(key as Hex);
    if (account.address.toLowerCase() !== EXPECTED_WALLET.toLowerCase()) throw new Error(`the key belongs to ${account.address}, not to the Anon wallet ${EXPECTED_WALLET}; refusing`);
  }
  const from = account?.address ?? EXPECTED_WALLET;

  const owned = await pub.readContract({ address: IDENTITY_REGISTRY, abi, functionName: "balanceOf", args: [from] });
  if (owned > 0n && !force) throw new Error(`${from} already owns ${owned} agent identity(ies); refusing to register another (use --force to override)`);

  const uri1 = toDataUri(buildCard());
  const parsed = parseDataUri(uri1);
  if (!parsed.ok) throw new Error(`own card does not parse: ${parsed.error}`);
  console.log(`card ok (${uri1.length} chars), attribution tag ${TAG}`);

  const sim = await pub.simulateContract({ address: IDENTITY_REGISTRY, abi, functionName: "register", args: [uri1], account: from });
  const gas = await pub.estimateContractGas({ address: IDENTITY_REGISTRY, abi, functionName: "register", args: [uri1], account: from });
  const gasPrice = await pub.getGasPrice();
  console.log(`simulation ok; register gas ~${gas}, cost ~${Number(gas * gasPrice) / 1e18} CELO; simulated id ${sim.result}`);
  if (!send || !account) { console.log("dry run: nothing sent. Re-run with --send and AGENT_PRIVATE_KEY set."); return; }

  const wallet = createWalletClient({ account, chain: celo, transport }).extend(withAttribution(TAG));
  const tx1 = await wallet.writeContract({ address: IDENTITY_REGISTRY, abi, functionName: "register", args: [uri1] });
  console.log(`register sent: ${tx1}`);
  const r1 = await pub.waitForTransactionReceipt({ hash: tx1 });
  if (r1.status !== "success") throw new Error(`register reverted in ${tx1}`);
  // The id comes from the Registered event of the receipt; the call's return value can be wrong if someone else registers first.
  const ev = parseEventLogs({ abi, logs: r1.logs, eventName: "Registered" }).find((l) => l.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase() && l.args.owner.toLowerCase() === from.toLowerCase());
  if (!ev) throw new Error(`no Registered event for ${from} in ${tx1}`);
  const agentId = ev.args.agentId;
  console.log(`registered: agentId ${agentId}`);

  const card2 = buildCard({ agentId });
  const uri2 = toDataUri(card2);
  const tx2 = await wallet.writeContract({ address: IDENTITY_REGISTRY, abi, functionName: "setAgentURI", args: [agentId, uri2] });
  console.log(`setAgentURI sent: ${tx2}`);
  const r2 = await pub.waitForTransactionReceipt({ hash: tx2 });
  if (r2.status !== "success") throw new Error(`setAgentURI reverted in ${tx2}`);

  const owner = await pub.readContract({ address: IDENTITY_REGISTRY, abi, functionName: "ownerOf", args: [agentId] });
  const agentWallet = await pub.readContract({ address: IDENTITY_REGISTRY, abi, functionName: "getAgentWallet", args: [agentId] });
  const p2 = parseDataUri(uri2);
  const tagged = [tx1, tx2].map(async (h) => ({ hash: h, codes: (await verifyTx({ client: pub, hash: h }))?.codes ?? null }));
  const verified = await Promise.all(tagged);
  writeFileSync("agent/agent-card.json", JSON.stringify(card2, null, 2) + "\n");
  console.log(JSON.stringify({
    agentId: agentId.toString(), owner, agentWallet, registrationTx: tx1, uriUpdateTx: tx2,
    cardCoherent: p2.ok && registrationCoherent(p2.reg, agentId), attribution: verified,
    next: "put agentId and the wallet into Loops House (agent-wallet) and commit agent/agent-card.json",
  }, null, 2));
}

main().catch((e) => { console.error("error:", (e as Error).message); process.exit(1); });
