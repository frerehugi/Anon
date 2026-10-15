import { REPUTATION_REGISTRY } from "./constants.js";
import { publicClient, reputationAbi } from "./chain.js";
import { readIdentity, registrationCoherent, type IdentityResult } from "./identity.js";
import { readVisa, type VisaStatus } from "./visa.js";
import { lintEndpoint, type LintResult } from "./lint.js";

export type Verdict = "ok" | "caution" | "avoid";

export interface Reputation {
  clients: number;
  count: number;
  average?: number;
  error?: string;
}

export interface CheckResult {
  agentId: string;
  verdict: Verdict;
  score: number;
  reasons: string[];
  caveats: string[];
  identity: IdentityResult;
  reputation: Reputation;
  visa: VisaStatus;
  walletTxCount?: number;
  probes: LintResult[];
}

const MAX_CLIENTS = 200;
const MAX_PROBES = 3;

async function readReputation(agentId: bigint): Promise<Reputation> {
  try {
    const clients = await publicClient.readContract({ address: REPUTATION_REGISTRY, abi: reputationAbi, functionName: "getClients", args: [agentId] });
    if (clients.length === 0) return { clients: 0, count: 0 };
    const used = clients.slice(0, MAX_CLIENTS);
    const [count, value, decimals] = await publicClient.readContract({
      address: REPUTATION_REGISTRY,
      abi: reputationAbi,
      functionName: "getSummary",
      args: [agentId, used, "", ""],
    });
    const avg = Number(count) > 0 ? Number(value) / 10 ** decimals / Number(count) : undefined;
    return { clients: clients.length, count: Number(count), average: avg };
  } catch (e) {
    return { clients: 0, count: 0, error: (e as Error).message.split("\n")[0] };
  }
}

/** Heuristic, explainable counterparty check. A verdict is evidence, not a guarantee. */
export async function checkAgent(agentId: bigint): Promise<CheckResult> {
  const identity = await readIdentity(agentId);
  const caveats = [
    "Heuristic based on public on-chain and HTTP data at the time of the call; not a guarantee or financial advice.",
    "Reputation is read from all reviewers without filtering and can be gamed by fake accounts.",
    "A human-backed (Self) agent is not automatically honest; no Self identity data is revealed or stored.",
  ];
  if (!identity.exists) {
    return {
      agentId: agentId.toString(), verdict: "avoid", score: 0,
      reasons: ["No ERC-8004 agent with this id exists on Celo mainnet."],
      caveats, identity, reputation: { clients: 0, count: 0 }, visa: { available: false }, probes: [],
    };
  }
  const reg = identity.registration;
  // Only probe endpoints that claim to take x402 payments; plain web/API routes would never return 402.
  const endpoints = (reg?.services ?? [])
    .filter((s) => reg?.x402Support === true || /x402|premium|paid/i.test(`${s.name ?? ""} ${s.endpoint ?? ""}`))
    .map((s) => s.endpoint)
    .filter((e): e is string => typeof e === "string" && e.startsWith("https://"))
    .slice(0, MAX_PROBES);

  const [reputation, visa, walletTxCount, probes] = await Promise.all([
    readReputation(agentId),
    readVisa(agentId),
    identity.wallet ? publicClient.getTransactionCount({ address: identity.wallet as `0x${string}` }).catch(() => undefined) : Promise.resolve(undefined),
    Promise.all(endpoints.map((u) => lintEndpoint(u))),
  ]);

  let score = 30; // identity exists
  const reasons: string[] = ["ERC-8004 identity exists (+30)."];
  let hardAvoid = false;

  if (reg?.name && reg.services?.length) { score += 10; reasons.push("Registration file is readable and lists services (+10)."); }
  else reasons.push(identity.registrationError ?? "Registration file is missing a name or services (+0).");

  if (registrationCoherent(reg, agentId)) { score += 5; reasons.push("Registration file points back at this agent id and registry (+5)."); }
  else if (reg) reasons.push("Registration file does not reference this agent id and registry on Celo (+0).");

  if (reg?.active === false) { hardAvoid = true; reasons.push("Agent marks itself inactive (active=false)."); }

  const passing = probes.filter((p) => p.status === 402 && p.summary.pass);
  if (passing.length > 0) { score += 20; reasons.push(`${passing.length} listed endpoint(s) return a valid x402 challenge (+20).`); }
  else if (reg?.x402Support) reasons.push("Declares x402Support but no listed endpoint returned a valid challenge (+0).");

  const wallets = new Set([identity.wallet, identity.owner].filter(Boolean).map((a) => a!.toLowerCase()));
  const payTos = passing.flatMap((p) => p.challenge?.accepts.map((a) => a.payTo?.toLowerCase()) ?? []).filter(Boolean) as string[];
  if (payTos.length > 0) {
    if (payTos.every((p) => wallets.has(p))) { score += 5; reasons.push("Endpoint payTo matches the agent wallet or owner (+5)."); }
    else reasons.push("Endpoint payTo differs from the agent wallet/owner; confirm that is intended (+0).");
  }

  if (reputation.error) reasons.push(`Reputation could not be read: ${reputation.error}`);
  else if (reputation.count > 0 && (reputation.average ?? 0) >= 0) { score += 10; reasons.push(`${reputation.count} feedback entries, non-negative on average (+10).`); }
  else if (reputation.count > 0) reasons.push(`${reputation.count} feedback entries with negative average (+0).`);
  else reasons.push("No reputation feedback yet.");

  if ((visa.tier ?? 0) >= 1) { score += 5; reasons.push(`Celo Agent Visa tier ${visa.tier} (+5).`); }
  else if (!visa.available) reasons.push("Agent Visa status unavailable (unknown, not penalised).");

  const noTrackRecord = (walletTxCount ?? 0) < 10 && reputation.count === 0;
  if ((walletTxCount ?? 0) >= 10) { score += 15; reasons.push(`Agent wallet has ${walletTxCount} outgoing transactions (+15).`); }
  else if ((walletTxCount ?? 0) >= 1) { score += 5; reasons.push(`Agent wallet has only ${walletTxCount} outgoing transactions (+5).`); }

  let verdict: Verdict = score >= 65 ? "ok" : score >= 35 ? "caution" : "avoid";
  if (noTrackRecord && verdict === "ok") { verdict = "caution"; reasons.push("Capped at caution: no reputation and little wallet history."); }
  if (hardAvoid) verdict = "avoid";

  return { agentId: agentId.toString(), verdict, score, reasons, caveats, identity, reputation, visa, walletTxCount, probes };
}
