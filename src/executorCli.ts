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
import { mkdirSync, writeFileSync } from "node:fs";
import { runEnrich } from "./buyjobs/enrichRun.js";
import { auditSample, parseReceipts, receiptBatch, type SettlementRef } from "./buyjobs/audit.js";

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
  if ((sub === "run" || sub === "audit" || sub === "enrich") && args.includes("--live")) {
    const key = process.env.AGENT_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_PRIVATE_KEY (0x + 64 hex) is required in the environment for --live");
    const account = privateKeyToAccount(key as `0x${string}`);
    if (account.address.toLowerCase() !== ANON_AGENT_WALLET.toLowerCase()) throw new Error(`the key belongs to ${account.address}, not to the Anon wallet; refusing`);
    signer = new X402Signer({ account, fetcher: nodeFetcher, timeoutMs: 120_000 });
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
  if (sub === "enrich") {
    // On-chain facts for directory agents (owner, agent wallet, raw reputation), read through Chainstack paid via buy, stored in the indexer.
    const readToken = process.env.INDEX_READ_TOKEN;
    if (!readToken) throw new Error("INDEX_READ_TOKEN is required in the environment");
    return await runEnrich(ex, nodeFetcher, {
      indexUrl: (flag(args, "--index-url") ?? process.env.INDEX_URL ?? "https://anon-indexer.frerehugi.workers.dev").replace(/\/+$/, ""),
      readToken, writeToken: process.env.INDEX_WRITE_TOKEN, scope: flag(args, "--scope") === "all" ? "all" : "x402",
      limit: Math.min(20_000, Math.max(1, Number(flag(args, "--limit") ?? 1000))), staleHours: Number(flag(args, "--stale-hours") ?? 24),
      live: args.includes("--live"), approvalId: flag(args, "--approval") ?? "enrich",
    });
  }
  if (sub === "audit") {
    // Re-check a random sample of indexed settlements against Chainstack, paid through buy (one JSON-RPC batch, 0.01 USDC).
    const indexUrl = (flag(args, "--index-url") ?? process.env.INDEX_URL ?? "https://anon-indexer.frerehugi.workers.dev").replace(/\/+$/, "");
    const token = process.env.INDEX_READ_TOKEN;
    if (!token) throw new Error("INDEX_READ_TOKEN is required in the environment (the indexer's READ_TOKEN)");
    const n = Math.min(500, Math.max(1, Number(flag(args, "--n") ?? 100)));
    const sample = await nodeFetcher(`${indexUrl}/v1/audit/sample?n=${n}`, { headers: { authorization: `Bearer ${token}` }, maxBytes: 2_000_000 });
    if (sample.status !== 200) throw new Error(`index sample request failed: HTTP ${sample.status}`);
    const refs = (JSON.parse(sample.body).rows ?? []) as SettlementRef[];
    if (refs.length === 0) throw new Error("the index returned no settlements");
    const live = args.includes("--live");
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const merged = new Map<string, import("./buyjobs/audit.js").Receipt | null>();
    const payments: { requestId: string; txHash?: string; amountUsdc: string }[] = [];
    let rpcErrors = 0;
    let pending = refs;
    const maxRounds = Math.min(3, Math.max(1, Number(flag(args, "--rounds") ?? 2))); // a lagging node can miss receipts: ask again for those only
    const firstPlan = receiptBatch(refs);
    const plan = { sampled: refs.length, uniqueTransactions: firstPlan.hashes.length, costPerBatchUsdc: "0.01", maxBatches: maxRounds };
    for (let round = 1; round <= maxRounds && pending.length > 0; round++) {
      const { body, hashes } = receiptBatch(pending);
      const req: PayRequest = {
        id: `audit-${stamp}-${round}`, wallet: "ops", url: "https://gateway.usebuy.ai/chainstack/celo", method: "POST", body, token: "USDC", amount: toAtomic("0.01"),
        experiment: "audit", approvalId: flag(args, "--approval") ?? "audit", maxResponseBytes: 4_000_000,
      };
      const res = await ex.execute(req, { dryRun: !live });
      if (res.status !== "settled") return { plan, round, status: res.status, decision: res.decision, detail: res.detail };
      payments.push({ requestId: req.id, txHash: res.txHash, amountUsdc: "0.01" });
      let parsed;
      try { parsed = parseReceipts(res.body ?? "", hashes); } catch (e) { return { plan, round, status: "settled", error: `paid response unreadable: ${(e as Error).message}`, txHash: res.txHash, detail: res.detail }; }
      rpcErrors += parsed.errors;
      for (const [h, r] of parsed.receipts) if (r || !merged.has(h)) merged.set(h, r);
      pending = refs.filter((r) => !merged.get(r.txHash.toLowerCase()));
    }
    const audit = auditSample(refs, merged, rpcErrors);
    const report = { date: now.toISOString(), source: "Chainstack Celo RPC, paid through buy (x402)", payments, sampled: refs.length, uniqueTransactions: firstPlan.hashes.length, ...audit };
    mkdirSync("loop/audits", { recursive: true });
    const file = `loop/audits/${now.toISOString().slice(0, 10)}-settlement-audit-${stamp.slice(-6)}.json`;
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    return { ...report, mismatched: report.mismatched.slice(0, 20), inconclusive: report.inconclusive.length, file };
  }
  if (sub === "status") {
    const all = await ledger.all();
    const reqs = latest(all);
    const byStatus: Record<string, number> = {};
    for (const r of reqs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    return { requests: reqs.length, byStatus, spent: formatAtomic(spentTotal(all)), live: false };
  }
  throw new Error("usage: executor check|dry-run|run <request.json> [--live] | audit [--n 100] [--live] | enrich [--scope x402|all] [--limit N] [--live] | status [--policy dir] [--decisions dir] [--ledger file]");
}
