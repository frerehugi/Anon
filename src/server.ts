import express, { type NextFunction, type Request, type Response } from "express";
import { isAddress } from "viem";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ASSETS, CELO_NETWORK } from "./constants.js";
import { checkAgent } from "./check.js";
import { lintEndpoint } from "./lint.js";
import { nodeFetcher } from "./safeFetch.js";
import { parseAgentsQuery, parseReportQuery, type ParseResult } from "./indexProxy.js";
import { toPublicReport } from "./indexer/publicReport.js";

const PRICES_USD = { check: 0.05, lint: 0.03, indexReport: 0.1, indexAgents: 0.02 } as const;

/** USD price -> base units for a 6-decimal stablecoin. */
export function toBaseUnits(usd: number): string {
  return String(Math.round(usd * 1_000_000));
}

const STABLES = Object.entries(ASSETS).filter(([, i]) => i.method === "eip3009" && i.decimals === 6);

export function accepts(usd: number, payTo: string) {
  return STABLES.map(([asset, info]) => ({
    scheme: "exact" as const,
    network: CELO_NETWORK as `${string}:${string}`,
    payTo,
    maxTimeoutSeconds: 60,
    // Explicit price object: the "$0.01" shorthand throws on Celo. EIP-712 domain goes in `extra`.
    price: { asset, amount: toBaseUnits(usd), extra: { name: info.name, version: info.version } },
  }));
}

function bad(res: Response, msg: string) {
  res.status(400).json({ error: msg });
}

/** Cheap validation BEFORE the payment middleware, so malformed requests get 400 and never a 402 or a charge. */
function validate(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/v1/check") {
    const id = String(req.query.agentId ?? "");
    if (!/^\d{1,18}$/.test(id)) return bad(res, "agentId must be a positive integer");
  } else if (req.path === "/v1/lint") {
    const url = String(req.query.url ?? "");
    if (url.length === 0 || url.length > 2048 || !url.startsWith("https://")) return bad(res, "url must be an https:// URL (max 2048 chars)");
    const m = req.query.method;
    if (m !== undefined && m !== "GET" && m !== "POST") return bad(res, "method must be GET or POST");
  }
  else if (req.path === "/v1/index/report" || req.path === "/v1/index/agents") {
    const parsed = (req.path === "/v1/index/report" ? parseReportQuery : parseAgentsQuery)(req.query as Record<string, unknown>);
    if (!parsed.ok) return bad(res, parsed.error);
  }
  next();
}

/** Calls the indexer Worker (fixed https origin from the environment) with the read token. The token never reaches the client. */
async function fromIndex(base: string, token: string, parsed: ParseResult, fetchImpl: typeof fetch): Promise<{ status: number; json: any }> {
  if (!parsed.ok) return { status: 400, json: { error: parsed.error } };
  const url = `${base}${parsed.value.path}${parsed.value.search ? `?${parsed.value.search}` : ""}`;
  const r = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return { status: 502, json: { error: "index unavailable" } };
  return { status: 200, json: await r.json() };
}

export async function buildApp(opts: { fetchImpl?: typeof fetch } = {}) {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const indexUrl = (process.env.INDEX_URL ?? "").replace(/\/+$/, "");
  const indexToken = process.env.INDEX_READ_TOKEN ?? "";
  const indexOn = /^https:\/\/[^\s/]+$/.test(indexUrl) && indexToken.length > 0; // both or neither: the Index routes exist only when configured
  const payTo = process.env.PAY_TO ?? "";
  const apiKey = process.env.X402_API_KEY ?? "";
  const devUnpaid = process.env.DEV_UNPAID === "1";
  const facilitatorUrl = process.env.FACILITATOR_URL ?? "https://api.x402.celo.org";

  const app = express();
  app.disable("x-powered-by");
  // On Vercel the TLS proxy sets x-forwarded-proto, so the 402 challenge advertises an https resource URL.
  app.set("trust proxy", process.env.VERCEL ? 1 : false);
  app.get("/health", (_req, res) => res.json({ status: "ok", mode: devUnpaid ? "dev-unpaid" : "paid" }));
  app.use(validate);

  if (devUnpaid) {
    console.warn("DEV_UNPAID=1: paid routes are NOT protected. Local testing only.");
  } else {
    if (!isAddress(payTo)) throw new Error("PAY_TO must be a valid address (the revenue wallet)");
    if (!apiKey) throw new Error("X402_API_KEY is required (facilitator settle key)");
    const facilitator = new HTTPFacilitatorClient({
      url: facilitatorUrl,
      createAuthHeaders: async () => {
        const h = { "X-API-Key": apiKey };
        return { verify: h, settle: h, supported: h };
      },
    });
    const server = new x402ResourceServer(facilitator)
      .register(CELO_NETWORK, new ExactEvmScheme())
      .registerExtension(bazaarResourceServerExtension);

    const indexRoutes: Record<string, any> = indexOn
      ? {
          "GET /v1/index/report": {
            accepts: accepts(PRICES_USD.indexReport, payTo),
            description:
              "Celo x402 Index: measured economic report of the Celo x402 economy (volume, payers, sellers, concentration, gas, payment-circuit share, independent demand). Aggregates only. Optional days=0.25..30.",
            mimeType: "application/json",
            extensions: {
              ...declareDiscoveryExtension({
                input: { days: "2" },
                inputSchema: { properties: { days: { type: "string", pattern: "^\\d{1,2}(\\.\\d{1,2})?$" } } },
                output: { example: { version: "0.1.0", totals: { settlements: 7490, gmvUsd: 26476 }, circuit: { gmvShare: 0.99 } } },
              }),
            },
          },
          "GET /v1/index/agents": {
            accepts: accepts(PRICES_USD.indexAgents, payTo),
            description:
              "Directory of ERC-8004 agents on Celo with unpaid x402 probe results. Filters: x402=1, live=1, tag, q, owner, order, limit, offset; or id=<agentId> for one agent.",
            mimeType: "application/json",
            extensions: {
              ...declareDiscoveryExtension({
                input: { x402: "1", live: "1", limit: "10" },
                inputSchema: { properties: { x402: { type: "string", enum: ["0", "1"] }, live: { type: "string", enum: ["0", "1"] }, limit: { type: "string" }, id: { type: "string" } } },
                output: { example: { total: 1, items: [{ agentId: 9903, name: "Chainstack", x402Status: "live" }] } },
              }),
            },
          },
        }
      : {};

    app.use(
      paymentMiddleware(
        {
          ...indexRoutes,
          "GET /v1/check": {
            accepts: accepts(PRICES_USD.check, payTo),
            description:
              "Counterparty check for an ERC-8004 agent on Celo: identity, registration, live x402 probe, reputation, Agent Visa, wallet history. Returns verdict ok/caution/avoid with reasons.",
            mimeType: "application/json",
            extensions: {
              ...declareDiscoveryExtension({
                input: { agentId: "9817" },
                inputSchema: { properties: { agentId: { type: "string", pattern: "^[0-9]{1,18}$" } }, required: ["agentId"] },
                output: { example: { agentId: "9817", verdict: "caution", score: 45, reasons: ["ERC-8004 identity exists (+30)."] } },
              }),
            },
          },
          "GET /v1/lint": {
            accepts: accepts(PRICES_USD.lint, payTo),
            description:
              "Lint a public https x402 endpoint on Celo without paying it: checks the 402 challenge, EIP-712 domain, assets, payTo and bazaar metadata. Returns findings with fixes.",
            mimeType: "application/json",
            extensions: {
              ...declareDiscoveryExtension({
                input: { url: "https://example.com/paid", method: "GET" },
                inputSchema: { properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "POST"] } }, required: ["url"] },
                output: { example: { status: 402, summary: { errors: 0, warnings: 1, info: 0, pass: true }, findings: [] } },
              }),
            },
          },
        },
        server,
      ),
    );
  }

  app.get("/v1/check", async (req, res) => {
    try {
      res.json(await checkAgent(BigInt(String(req.query.agentId))));
    } catch (e) {
      res.status(502).json({ error: "upstream read failed", detail: (e as Error).message.split("\n")[0] });
    }
  });
  app.get("/v1/lint", async (req, res) => {
    const method = req.query.method === "POST" ? "POST" : "GET";
    res.json(await lintEndpoint(String(req.query.url), { method, fetcher: nodeFetcher }));
  });
  if (indexOn) {
    app.get("/v1/index/report", async (req, res) => {
      try {
        const out = await fromIndex(indexUrl, indexToken, parseReportQuery(req.query as Record<string, unknown>), fetchImpl);
        res.status(out.status).json(out.status === 200 ? toPublicReport(out.json) : out.json);
      } catch {
        res.status(502).json({ error: "index unavailable" });
      }
    });
    app.get("/v1/index/agents", async (req, res) => {
      try {
        const out = await fromIndex(indexUrl, indexToken, parseAgentsQuery(req.query as Record<string, unknown>), fetchImpl);
        res.status(out.status).json(out.json);
      } catch {
        res.status(502).json({ error: "index unavailable" });
      }
    });
  }
  app.get("/v1/pricing", (_req, res) => {
    const { indexReport, indexAgents, ...base } = PRICES_USD;
    res.json({ network: CELO_NETWORK, currency: "USD", tokens: STABLES.map(([, i]) => i.symbol), prices: indexOn ? { ...base, indexReport, indexAgents } : base });
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.DEV_UNPAID === "1" ? "127.0.0.1" : (process.env.HOST ?? "0.0.0.0");
  buildApp()
    .then((app) => app.listen(port, host, () => console.log(`anon listening on ${host}:${port}`)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
