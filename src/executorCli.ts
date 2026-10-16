// Executor commands. Live payments are not wired yet: only `check` and dry runs exist.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadApprovals } from "./executor/approval.js";
import { latest, spentTotal, type PayRequest } from "./executor/engine.js";
import { Executor } from "./executor/executor.js";
import { JsonlLedger } from "./executor/ledger.js";
import { formatAtomic, parsePolicy, toAtomic } from "./executor/policy.js";

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function readRequest(file: string): PayRequest {
  const o = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const s = (k: string) => String(o[k] ?? "");
  if (o.wallet !== "ops" && o.wallet !== "treasury") throw new Error('wallet must be "ops" or "treasury"');
  return { id: s("id"), wallet: o.wallet, url: s("url"), token: s("token"), amount: toAtomic(o.amount, "amount"), experiment: s("experiment"), approvalId: o.approvalId ? s("approvalId") : undefined };
}

export async function executorCommand(sub: string | undefined, args: string[]): Promise<unknown> {
  const policyDir = flag(args, "--policy") ?? "loop/policy";
  const decisionsDir = flag(args, "--decisions") ?? "loop/decisions";
  const ledger = new JsonlLedger(flag(args, "--ledger") ?? "loop/ledger/payments.jsonl");
  const killFile = flag(args, "--kill-file") ?? "loop/policy/KILL";
  const gatesFile = join(decisionsDir, "gates.json");
  const policy = parsePolicy(readFileSync(join(policyDir, "limits.yaml"), "utf8"), readFileSync(join(policyDir, "allowlist.yaml"), "utf8"));
  const ex = new Executor({
    policy, ledger,
    approvals: () => loadApprovals(decisionsDir),
    gate2: () => existsSync(gatesFile) && JSON.parse(readFileSync(gatesFile, "utf8")).gate2 === true,
    killed: () => existsSync(killFile) || process.env.ANON_KILL === "1",
  });
  if (sub === "check" || sub === "dry-run") {
    const file = args.find((a) => !a.startsWith("--") && a !== flag(args, "--policy") && a !== flag(args, "--decisions") && a !== flag(args, "--ledger") && a !== flag(args, "--kill-file"));
    if (!file) throw new Error("request file required");
    const req = readRequest(file);
    return sub === "check" ? await ex.check(req) : await ex.execute(req, { dryRun: true });
  }
  if (sub === "status") {
    const all = await ledger.all();
    const reqs = latest(all);
    const byStatus: Record<string, number> = {};
    for (const r of reqs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    return { requests: reqs.length, byStatus, spent: formatAtomic(spentTotal(all)), live: false };
  }
  if (sub === "run" && args.includes("--live")) throw new Error("live payments are not enabled: no signer is wired yet");
  throw new Error("usage: executor check|dry-run <request.json> | status [--policy dir] [--decisions dir] [--ledger file]");
}
