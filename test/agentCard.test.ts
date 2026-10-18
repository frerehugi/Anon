import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_REGISTRY_REF, buildCard, toDataUri } from "../src/agentCard.js";
import { parseDataUri, probeCandidates, registrationCoherent } from "../src/registration.js";

test("the card round-trips through our own registry parser", () => {
  const p = parseDataUri(toDataUri(buildCard()));
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.reg.name, "Anon");
  assert.equal(p.reg.x402Support, false); // nothing paid is live yet
  assert.equal(p.reg.active, true);
  assert.deepEqual(probeCandidates(p.reg), []);
});

test("registrations entry makes the card coherent for its own id only", () => {
  const p = parseDataUri(toDataUri(buildCard({ agentId: 12345n })));
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(registrationCoherent(p.reg, 12345n), true);
  assert.equal(registrationCoherent(p.reg, 999n), false);
  assert.equal(AGENT_REGISTRY_REF, "eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
});

test("card stays small and carries no secrets", () => {
  const uri = toDataUri(buildCard({ agentId: 1n }));
  assert.ok(uri.length < 2000);
  assert.doesNotMatch(JSON.stringify(buildCard()), /0x[0-9a-fA-F]{64}/);
});
