// The only component that may sign payments. Deterministic, no LLM. Policy is checked against fresh state at signing time.
import type { Approval } from "./approval.js";
import { evaluate, type Decision, type LedgerEntry, type PayRequest, type State } from "./engine.js";
import type { LedgerStore } from "./ledger.js";
import type { Policy } from "./policy.js";

export interface PayOutcome { status: "settled" | "failed" | "uncertain"; txHash?: string; detail?: string; body?: string }

/** Holds the key (outside this repo's agents). `failed` only when nothing was sent; anything unclear must be `uncertain`. */
export interface Signer {
  readonly attributed: boolean; // every tx carries the ERC-8021 tag
  pay(req: PayRequest): Promise<PayOutcome>;
}

export interface ExecutorDeps {
  policy: Policy;
  ledger: LedgerStore;
  signer?: Signer; // absent means dry run only
  approvals: () => Approval[];
  gate2: () => boolean;
  killed: () => boolean; // read before every payment
  now?: () => number;
}

/** `body` is what the paid endpoint returned. It is untrusted data and is not written to the ledger. */
export interface ExecResult { decision: Decision; status: LedgerEntry["status"]; txHash?: string; detail?: string; body?: string }

export class Executor {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly d: ExecutorDeps) {}

  private async state(): Promise<State> {
    return { entries: await this.d.ledger.all(), approvals: this.d.approvals(), gate2: this.d.gate2(), killed: this.d.killed(), now: (this.d.now ?? (() => Math.floor(Date.now() / 1000)))() };
  }

  /** Check only: no ledger write, no signing. */
  async check(req: PayRequest): Promise<Decision> {
    return evaluate(req, this.d.policy, await this.state());
  }

  /** Payments run strictly one after another, so two requests can never both pass the same limit. */
  execute(req: PayRequest, opts: { dryRun?: boolean } = {}): Promise<ExecResult> {
    const run = this.queue.then(() => this.run(req, opts.dryRun ?? true));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(req: PayRequest, dryRun: boolean): Promise<ExecResult> {
    const st = await this.state();
    const base = { requestId: req.id, ts: st.now, wallet: req.wallet, url: req.url, token: req.token, amount: req.amount, experiment: req.experiment, approvalId: req.approvalId };
    const decision = evaluate(req, this.d.policy, st);
    if (!decision.allow) {
      await this.d.ledger.append({ ...base, status: "denied", reasons: decision.reasons });
      return { decision, status: "denied" };
    }
    if (dryRun || !this.d.signer) {
      await this.d.ledger.append({ ...base, status: "dry_run" });
      return { decision, status: "dry_run", detail: dryRun ? "dry run" : "no signer configured" };
    }
    // Write ahead: the spend is on the books before any money can move.
    await this.d.ledger.append({ ...base, status: "pending" });
    if (this.d.killed()) { // re-check at signing time
      await this.d.ledger.append({ ...base, status: "failed", detail: "kill switch turned on before signing" });
      return { decision: { allow: false, reasons: ["kill switch is on"] }, status: "failed" };
    }
    let out: PayOutcome;
    try {
      out = await this.d.signer.pay(req);
    } catch (e) {
      out = { status: "uncertain", detail: `signer threw: ${(e as Error).message.slice(0, 200)}` }; // never retried automatically
    }
    await this.d.ledger.append({ ...base, status: out.status, txHash: out.txHash, detail: out.detail });
    return { decision, status: out.status, txHash: out.txHash, detail: out.detail, body: out.status === "settled" ? out.body : undefined };
  }
}
