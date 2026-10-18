import { test } from "node:test";
import assert from "node:assert/strict";
import { stripRoutingParams } from "../src/vercelUrl.js";

test("drops only the injected path parameter, keeps real ones in order", () => {
  assert.equal(stripRoutingParams("/v1/check?agentId=9&path=check"), "/v1/check?agentId=9");
  assert.equal(stripRoutingParams("/v1/index/report?path=index%2Freport"), "/v1/index/report");
  assert.equal(stripRoutingParams("/v1/lint?url=https%3A%2F%2Fexample.com&path=lint&method=POST"), "/v1/lint?url=https%3A%2F%2Fexample.com&method=POST");
  assert.equal(stripRoutingParams("/health"), "/health");
  assert.equal(stripRoutingParams("/v1/check?agentId=9"), "/v1/check?agentId=9");
});
