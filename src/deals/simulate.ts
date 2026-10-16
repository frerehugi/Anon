/**
 * Deal simulator: which products in the buy catalog get cheaper per unit when several buyers pool,
 * and does the pooled slot price still cover settlement costs? Pure functions plus a catalog fetch.
 * It sends no payment. Every result is an estimate until a small test purchase confirms the unit semantics.
 */

export interface PriceOption { maxResults?: number; durationMinutes?: number; usd?: string | number }
export interface Capability {
  id: string;
  title?: string;
  description?: string;
  platform?: string;
  available?: boolean;
  pricingModel?: string;
  inputSchema?: unknown;
  priceOptions?: PriceOption[];
}

export interface DealParams {
  gasUsdPerSettlement: number; // measured: ~0.0015 USD on Celo at ~0.086 USD/CELO
  feeBps: number; // facilitator fee, 30 = 0.3%
  markup: number; // margin on top of cost, e.g. 0.3
  minDiscount: number; // a deal must be at least this much cheaper than buying solo
  packSize: number; // slots sold per payment in "pack" mode
}

export const DEFAULT_PARAMS: DealParams = { gasUsdPerSettlement: 0.0015, feeBps: 30, markup: 0.3, minDiscount: 0.2, packSize: 10 };

export type Viability = "viable" | "not_viable";

export interface ModeResult {
  slotPriceUsd: number;
  buyerSavingPct: number;
  marginPerSlotUsd: number;
  breakEvenSlots: number | null;
  status: Viability;
}

export interface DealCandidate {
  id: string;
  title: string;
  platform: string;
  kind: "bundle" | "batch" | "duration";
  unit: string;
  soloUsd: number;
  pooledCostPerUnitUsd: number;
  structuralSavingPct: number;
  arrayInputs: string[];
  flags: string[];
  single: ModeResult;
  pack: ModeResult;
  recommended: boolean;
}

const PERSONAL = /(profile|people|person|employee|email|follower|following|contact|user|account)/i;
const CONTENT_ITEMS = /(posts|tweets|comments|videos|jobs|listings|reviews|threads)/i;

function num(x: unknown): number { const n = Number(x); return Number.isFinite(n) ? n : NaN; }

function arrayInputFields(schema: unknown): string[] {
  const out: string[] = [];
  const walk = (node: any, path: string, depth: number) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    if (node.type === "array") out.push(path);
    for (const [k, v] of Object.entries<any>(node.properties ?? {})) walk(v, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(schema, "", 0);
  return out;
}

export function evaluateMode(costPerUnit: number, soloUsd: number, gasPerSale: number, p: DealParams, bundlePrice: number): ModeResult {
  const fee = p.feeBps / 10000;
  const slot = ((costPerUnit + gasPerSale) * (1 + p.markup)) / (1 - fee);
  const margin = slot * (1 - fee) - gasPerSale - costPerUnit;
  const saving = soloUsd > 0 ? 1 - slot / soloUsd : 0;
  const unitNet = slot * (1 - fee) - gasPerSale;
  const be = unitNet > 0 ? Math.ceil(bundlePrice / unitNet) : null;
  return {
    slotPriceUsd: round(slot), buyerSavingPct: round(saving * 100, 1), marginPerSlotUsd: round(margin), breakEvenSlots: be,
    status: saving >= p.minDiscount && margin > 0 ? "viable" : "not_viable",
  };
}
const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

export function simulateDeals(caps: Capability[], params: Partial<DealParams> = {}): DealCandidate[] {
  const p = { ...DEFAULT_PARAMS, ...params };
  const out: DealCandidate[] = [];
  for (const c of caps) {
    if (c.available === false) continue;
    const text = `${c.id} ${c.title ?? ""}`;
    const desc = c.description ?? "";
    const opts = (c.priceOptions ?? []).map((o) => ({ n: o.maxResults ?? o.durationMinutes ?? NaN, usd: num(o.usd) })).filter((o) => Number.isFinite(o.n) && Number.isFinite(o.usd));
    const arrays = arrayInputFields(c.inputSchema);
    const flags: string[] = [];
    if (PERSONAL.test(text)) flags.push("personal_data");

    if (c.pricingModel === "fixed_result_bundle" && opts.length >= 2) {
      opts.sort((a, b) => a.n - b.n);
      const small = opts[0], big = opts[opts.length - 1];
      const solo = small.usd / small.n;
      const cost = big.usd / big.n;
      flags.push("unit_semantics_unverified");
      if (CONTENT_ITEMS.test(`${text} ${desc}`)) flags.push("results_are_content_items");
      if (arrays.length === 0) flags.push("no_list_input");
      const single = evaluateMode(cost, solo, p.gasUsdPerSettlement, p, big.usd);
      const pack = evaluateMode(cost, solo, p.gasUsdPerSettlement / p.packSize, p, big.usd);
      out.push(candidate(c, "bundle", `result (tiers ${opts.map((o) => o.n).join("/")})`, solo, cost, arrays, flags, single, pack));
    } else if (c.platform === "chainstack" && c.id.includes("celo")) {
      const price = 0.01, maxCalls = 2000;
      flags.push("free_alternative_exists", "batch_window_adds_latency");
      const single = evaluateMode(price / maxCalls, price, p.gasUsdPerSettlement, p, price);
      const pack = evaluateMode(price / maxCalls, price, p.gasUsdPerSettlement / p.packSize, p, price);
      out.push(candidate(c, "batch", "JSON-RPC call in a 2000-call batch", price, price / maxCalls, arrays, flags, single, pack));
    } else if (c.platform === "browser" && opts.length >= 2) {
      opts.sort((a, b) => a.n - b.n);
      const solo = opts[0].usd / opts[0].n, big = opts[opts.length - 1];
      const cost = big.usd / big.n;
      flags.push("shared_session_isolation_risk");
      const single = evaluateMode(cost, solo, p.gasUsdPerSettlement, p, big.usd);
      const pack = evaluateMode(cost, solo, p.gasUsdPerSettlement / p.packSize, p, big.usd);
      out.push(candidate(c, "duration", "browser minute", solo, cost, arrays, flags, single, pack));
    }
  }
  return out.sort((a, b) => Number(b.recommended) - Number(a.recommended) || b.pack.buyerSavingPct - a.pack.buyerSavingPct);
}

function candidate(c: Capability, kind: DealCandidate["kind"], unit: string, solo: number, cost: number, arrays: string[], flags: string[], single: ModeResult, pack: ModeResult): DealCandidate {
  const blocked = flags.includes("personal_data") || flags.includes("free_alternative_exists") || flags.includes("shared_session_isolation_risk");
  return {
    id: c.id, title: c.title ?? c.id, platform: c.platform ?? "?", kind, unit,
    soloUsd: round(solo), pooledCostPerUnitUsd: round(cost), structuralSavingPct: round((1 - cost / solo) * 100, 1),
    arrayInputs: arrays, flags, single, pack,
    recommended: !blocked && (single.status === "viable" || pack.status === "viable"),
  };
}

export async function fetchCatalog(url = "https://gateway.usebuy.ai/v1/catalog"): Promise<Capability[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
  const j: any = await res.json();
  return Array.isArray(j.capabilities) ? j.capabilities : [];
}
