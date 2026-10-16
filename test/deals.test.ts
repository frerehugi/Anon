import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateDeals, evaluateMode, DEFAULT_PARAMS, type Capability } from "../src/deals/simulate.js";

const schemaWithArray = { type: "object", properties: { body: { type: "object", properties: { usernames: { type: "array" } } }, maxResults: { type: "integer" } } };
const bundle = (id: string, title: string, tiers: [number, number][], schema: unknown = schemaWithArray, description = ""): Capability => ({
  id, title, description, platform: id.split(".")[1], pricingModel: "fixed_result_bundle", inputSchema: schema,
  priceOptions: tiers.map(([maxResults, usd]) => ({ maxResults, usd: String(usd) })),
});

const caps: Capability[] = [
  bundle("monid.tiktok.apify.micro-scraper", "Tiktok Micro Scraper", [[1, 0.0036], [5, 0.006], [10, 0.009]]),
  bundle("monid.reddit.apify.comment-scraper", "Reddit Comment Scraper", [[1, 0.105], [5, 0.113], [10, 0.123]], schemaWithArray, "Scrape Reddit comments"),
  bundle("monid.linkedin.apify.profile-search", "Linkedin Profile Search", [[1, 0.333], [5, 0.453], [10, 0.603]]),
  { id: "chainstack.celo", title: "Celo RPC", platform: "chainstack", available: true },
  { id: "browser.sessions.create", title: "Browser", platform: "browser", priceOptions: [{ durationMinutes: 1, usd: "0.003606" }, { durationMinutes: 10, usd: "0.00906" }] },
  { ...bundle("monid.x.apify.gone", "Gone", [[1, 1], [10, 2]]), available: false },
];

test("gas floor: a micro product is not viable per single payment but viable as a pack", () => {
  const d = simulateDeals(caps).find((c) => c.id.includes("micro-scraper"))!;
  assert.equal(d.single.status, "not_viable");
  assert.equal(d.pack.status, "viable");
  assert.ok(d.structuralSavingPct >= 70);
});

test("a mid-ticket product is viable per single payment with a positive margin", () => {
  const d = simulateDeals(caps).find((c) => c.id.includes("comment-scraper"))!;
  assert.equal(d.single.status, "viable");
  assert.ok(d.single.marginPerSlotUsd > 0);
  assert.ok(d.single.buyerSavingPct >= 20);
  assert.ok(d.single.breakEvenSlots !== null && d.single.breakEvenSlots <= 10);
  assert.ok(d.flags.includes("results_are_content_items"));
});

test("personal-data products are flagged and never recommended", () => {
  const d = simulateDeals(caps).find((c) => c.id.includes("profile-search"))!;
  assert.ok(d.flags.includes("personal_data"));
  assert.equal(d.recommended, false);
});

test("batch and duration products carry their risk flags and are not recommended", () => {
  const all = simulateDeals(caps);
  const rpc = all.find((c) => c.kind === "batch")!;
  assert.ok(rpc.flags.includes("free_alternative_exists"));
  assert.ok(rpc.structuralSavingPct > 99);
  assert.equal(rpc.recommended, false);
  const br = all.find((c) => c.kind === "duration")!;
  assert.ok(br.flags.includes("shared_session_isolation_risk"));
  assert.equal(br.recommended, false);
});

test("unavailable capabilities are skipped and recommended ones sort first", () => {
  const all = simulateDeals(caps);
  assert.ok(!all.some((c) => c.id.includes("gone")));
  assert.equal(all[0].recommended, true);
});

test("evaluateMode never prices above the solo price when it claims viability", () => {
  const r = evaluateMode(0.0123, 0.105, 0.0015, DEFAULT_PARAMS, 0.123);
  assert.equal(r.status, "viable");
  assert.ok(r.slotPriceUsd < 0.105);
});
