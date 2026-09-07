import assert from "node:assert/strict";
import test from "node:test";
import { McpRequestOptimizer } from "./mcp-request-optimizer.js";

function request(input: {
  token?: string;
  protocolVersion?: string;
  body: unknown;
}) {
  return {
    auth: input.token ? { token: input.token } : undefined,
    body: input.body,
    header: (name: string) => name === "mcp-protocol-version" ? input.protocolVersion : undefined,
  };
}

function response() {
  const headers = new Map<string, string>();
  let statusCode: number | undefined;
  let body: unknown;
  return {
    value: {
      setHeader(name: string, value: string) { headers.set(name, value); },
      status(code: number) { statusCode = code; return this; },
      json(value: unknown) { body = value; },
    },
    result: () => ({ headers, statusCode, body }),
  };
}

test("tools/list cache is partitioned by token, protocol version, and params", () => {
  const optimizer = new McpRequestOptimizer();
  const original = request({
    token: "token-a",
    protocolVersion: "2025-11-25",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { scope: "a" } },
  });
  assert.equal(optimizer.cacheResponse(original as never, {
    jsonrpc: "2.0", id: 1, result: { tools: ["read"] },
  }), true);

  const hitResponse = response();
  assert.equal(optimizer.tryServeCached(request({
    token: "token-a",
    protocolVersion: "2025-11-25",
    body: { jsonrpc: "2.0", id: 99, method: "tools/list", params: { scope: "a" } },
  }) as never, hitResponse.value as never), true);
  assert.equal(hitResponse.result().headers.get("X-DevSpace-Cache"), "hit");
  assert.deepEqual(hitResponse.result().body, {
    jsonrpc: "2.0", id: 99, result: { tools: ["read"] },
  });

  for (const isolated of [
    request({ token: "token-b", protocolVersion: "2025-11-25", body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: { scope: "a" } } }),
    request({ token: "token-a", protocolVersion: "2026-01-01", body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: { scope: "a" } } }),
    request({ token: "token-a", protocolVersion: "2025-11-25", body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: { scope: "b" } } }),
  ]) {
    assert.equal(optimizer.tryServeCached(isolated as never, response().value as never), false);
  }
});

test("only single successful tools/list requests can enter the cache", () => {
  const optimizer = new McpRequestOptimizer();
  const token = "token-a";
  assert.equal(optimizer.isCacheableRequest(request({ token, body: [{ jsonrpc: "2.0", id: 1, method: "tools/list" }] }) as never), false);
  assert.equal(optimizer.isCacheableRequest(request({ token, body: { jsonrpc: "2.0", method: "tools/list" } }) as never), false);
  assert.equal(optimizer.cacheResponse(request({ token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }) as never, {
    jsonrpc: "2.0", id: 1, error: { code: -1 },
  }), false);
  assert.deepEqual(optimizer.getStats(), { size: 0, hits: 0, misses: 0, writes: 0 });
});

test("expired cache entries are not served", async () => {
  const optimizer = new McpRequestOptimizer(1);
  const req = request({ token: "token-a", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.equal(optimizer.cacheResponse(req as never, { jsonrpc: "2.0", id: 1, result: {} }), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(optimizer.tryServeCached(req as never, response().value as never), false);
  assert.deepEqual(optimizer.getStats(), { size: 0, hits: 0, misses: 1, writes: 1 });
});
