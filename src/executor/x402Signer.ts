// Pays one x402 endpoint from the Anon wallet. Holds the key, so it lives only in the executor process.
// Rule: nothing is signed unless the server's quote matches exactly what the executor approved
// (Celo mainnet, `exact` scheme, the approved token, amount at most the approved amount).
// Until the paid request is sent the outcome is `failed` (nothing moved); afterwards anything but a clean receipt is `uncertain`.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import type { LocalAccount } from "viem";
import { ASSETS, CELO_NETWORK } from "../constants.js";
import type { Fetcher } from "../net.js";
import type { PayOutcome, Signer } from "./executor.js";
import type { PayRequest } from "./engine.js";

export interface X402SignerOpts {
  account: LocalAccount;
  fetcher: Fetcher;
  timeoutMs?: number;
}

/** Both protocol versions: v2 uses `amount` and "eip155:42220", v1 (the buy gateway) uses `maxAmountRequired` and "celo". */
interface Requirement { scheme: string; network: string; asset: string; payTo: string; amount?: string; maxAmountRequired?: string }
const isCelo = (n: string) => n === CELO_NETWORK || n === "celo";

const tokenAddress = (symbol: string): string | undefined => Object.entries(ASSETS).find(([, i]) => i.symbol === symbol && i.method === "eip3009")?.[0];

export class X402Signer implements Signer {
  /** x402 payments are submitted by the facilitator, so there is no tagged transaction from this wallet. */
  readonly attributed = false;
  private readonly http: x402HTTPClient;
  private current: PayRequest | undefined;

  constructor(private readonly o: X402SignerOpts) {
    const signer = toClientEvmSigner(o.account);
    const client = new x402Client().register(CELO_NETWORK, new ExactEvmScheme(signer)).registerV1("celo", new ExactEvmSchemeV1(signer));
    // Own spend rule for the current request; the library defaults (asset list, USD cap) are replaced by it.
    client.registerPolicy((_v, reqs) => (reqs as unknown as Requirement[]).filter((r) => this.acceptable(r)) as never);
    this.http = new x402HTTPClient(client);
  }

  private acceptable(r: Requirement): boolean {
    const req = this.current;
    if (!req) return false;
    const asset = tokenAddress(req.token);
    const amount = r.amount ?? r.maxAmountRequired ?? "";
    return r.scheme === "exact" && isCelo(r.network) && !!asset && r.asset?.toLowerCase() === asset.toLowerCase() && /^\d+$/.test(amount) && BigInt(amount) > 0n && BigInt(amount) <= req.amount;
  }

  async pay(req: PayRequest): Promise<PayOutcome> {
    if (req.wallet !== "ops") return { status: "failed", detail: "only the ops wallet can pay x402 endpoints" };
    const fail = (detail: string): PayOutcome => ({ status: "failed", detail });
    if (this.current) return fail("another payment is in progress"); // the executor runs payments one at a time; this guards the shared spend rule
    const timeoutMs = this.o.timeoutMs ?? 15_000;
    this.current = req;
    try {
      // 1. unpaid request: get the quote
      const method = req.method ?? "GET";
      const base = { method, body: req.body, timeoutMs, headers: req.body !== undefined ? { "content-type": "application/json" } : undefined };
      let first;
      try { first = await this.o.fetcher(req.url, base); } catch (e) { return fail(`quote request failed: ${(e as Error).message.slice(0, 120)}`); }
      if (first.status !== 402) return fail(`expected a 402 quote, got HTTP ${first.status}; nothing paid`);
      let payload;
      let payTos: string[];
      try {
        let body: unknown;
        try { body = JSON.parse(first.body); } catch { body = undefined; }
        const quote = this.http.getPaymentRequiredResponse((n) => first.headers.get(n), body);
        payTos = (quote.accepts as unknown as Requirement[]).filter((r) => this.acceptable(r)).map((r) => r.payTo.toLowerCase());
        payload = await this.http.createPaymentPayload(quote); // throws when no option passes the policy: nothing signed
      } catch (e) {
        return fail(`no acceptable quote: ${(e as Error).message.slice(0, 120)}`);
      }
      // 2. defense in depth: what was signed must still match the approval (v1 payloads carry no requirement, so check the authorization itself)
      const accepted = (payload as { accepted?: Requirement }).accepted;
      if (accepted && !this.acceptable(accepted)) return fail("signed requirement does not match the approval; payment not sent");
      const auth = (payload.payload as { authorization?: { from?: string; to?: string; value?: string } }).authorization;
      if (!auth || auth.from?.toLowerCase() !== this.o.account.address.toLowerCase() || !payTos.includes((auth.to ?? "").toLowerCase()) || !/^\d+$/.test(auth.value ?? "") || BigInt(auth.value!) > req.amount) {
        return fail("authorization does not match the quote; payment not sent");
      }
      // 3. paid request: from here on, only a clean receipt counts as settled
      const headers = this.http.encodePaymentSignatureHeader(payload);
      let paid;
      try { paid = await this.o.fetcher(req.url, { ...base, headers: { ...base.headers, ...headers }, maxBytes: req.maxResponseBytes }); } catch (e) { return { status: "uncertain", detail: `paid request failed after signing: ${(e as Error).message.slice(0, 120)}` }; }
      let settle;
      try { settle = this.http.getPaymentSettleResponse((n) => paid.headers.get(n)); } catch { settle = undefined; }
      if (paid.status >= 200 && paid.status < 300 && settle?.success === true) {
        return { status: "settled", txHash: settle.transaction || undefined, body: paid.body, detail: `paid ${auth.value} atomic ${req.token}${paid.truncated ? "; response was cut at the size cap" : ""}` };
      }
      return { status: "uncertain", detail: `HTTP ${paid.status} after signing${settle ? `, settle success=${settle.success}` : ", no settlement receipt"}` };
    } finally {
      this.current = undefined;
    }
  }
}
