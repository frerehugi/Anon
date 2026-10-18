// Executor commands. `run` is a dry run unless --live is given; live needs AGENT_PRIVATE_KEY in the environment.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadApprovals } from "./executor/approval.js";
import { latest, spentTotal, type PayRequest } from "./executor/engine.js";
import { Executor } from "./executor/executor.js";
import { JsonlLedger } from "./executor/ledger.js";
import { formatAtomic, parsePolicy, toAtomic } from "./executor/policy.js";
import { X402Signer } from "./executor/x402Signer.js";
import { nodeFetcher } from "./safeFetch.js";
import { ANON_AGENT_WALLET } from "./constants.js";
import { privateKeyToAccount } from "viem/accounts";

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function readRequest(file: string): PayRequest {
  const o = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const s = (k: string) => String(o[k] ?? "");
  if (o.wallet !== "ops" && o.wallet !== "treasury") throw new Error('wallet must be "ops" or "treasury"');
  const method = o.method === undefined ? undefined : (String(o.method).toUpperCase() as "GET" | "POST");
  const body = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  return { id: s("id"), wallet: o.wallet, url: s("url"), token: s("token"), amount: toAtomic(o.amount, "amount"), experiment: s("experiment"), approvalId: o.approvalId ? s("approvalId") : undefined, method, body };
}

export async function executorCommand(sub: string | undefined, args: string[]): Promise<unknown> {
  const policyDir = flag(args, "--policy") ?? "loop/policy";
  const decisionsDir = flag(args, "--decisions") ?? "loop/decisions";
  const ledger = new JsonlLedger(flag(args, "--ledger") ?? "loop/ledger/payments.jsonl");
  const killFile = flag(args, "--kill-file") ?? "loop/policy/KILL";
  const gatesFile = join(decisionsDir, "gates.json");
  const policy = parsePolicy(readFileSync(join(policyDir, "limits.yaml"), "utf8"), readFileSync(join(policyDir, "allowlist.yaml"), "utf8"));
  let signer: X402Signer | undefined;
  if (sub === "run" && args.includes("--live")) {
    const key = process.env.AGENT_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_PRIVATE_KEY (0x + 64 hex) is required in the environment for --live");
    const account = privateKeyToAccount(key as `0x${string}`);
    if (account.address.toLowerCase() !== ANON_AGENT_WALLET.toLowerCase()) throw new Error(`the key belongs to ${account.address}, not to the Anon wallet; refusing`);
    signer = new X402Signer({ account, fetcher: nodeFetcher });
  }
  const ex = new Executor({
    policy, ledger, signer,
    approvals: () => loadApprovals(decisionsDir),
    gate2: () => existsSync(gatesFile) && JSON.parse(readFileSync(gatesFile, "utf8")).gate2 === true,
    killed: () => existsSync(killFile) || process.env.ANON_KILL === "1",
  });
  if (sub === "check" || sub === "dry-run" || sub === "run") {
    const file = args.find((a) => !a.startsWith("--") && a !== flag(args, "--policy") && a !== flag(args, "--decisions") && a !== flag(args, "--ledger") && a !== flag(args, "--kill-file"));
    if (!file) throw new Error("request file required");
    const req = readRequest(file);
    if (sub === "check") return await ex.check(req);
    const res = await ex.execute(req, { dryRun: sub === "dry-run" || !args.includes("--live") });
    return { ...res, body: res.body?.slice(0, 2000) };
  }
  if (sub === "status") {
    const all = await ledger.all();
    const reqs = latest(all);
    const byStatus: Record<string, number> = {};
    for (const r of reqs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    return { requests: reqs.length, byStatus, spent: formatAtomic(spentTotal(all)), live: false };
  }
  throw new Error("usage: executor check|dry-run|run <request.json> [--live] | status [--policy dir] [--decisions dir] [--ledger file]");
}
