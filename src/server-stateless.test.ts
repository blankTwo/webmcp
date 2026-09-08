import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createServer } from "./server.js";

const OWNER_TOKEN = "test-owner-token-that-is-long-enough";
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

test("MCP HTTP serving is stateless per request and returns JSON without session ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-stateless-http-test-"));
  const stateDir = join(root, ".state");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: OWNER_TOKEN,
    HOST: "127.0.0.1",
    PORT: "7676",
  });
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const accessToken = await issueAccessToken(config.oauth, mcpUrl, stateDir);
  const runtime = createServer(config);
  const httpServer = runtime.app.listen(0, "127.0.0.1");

  try {
    await once(httpServer, "listening");
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;

    const initialized = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "gptmcp-stateless-test", version: "1.0.0" },
      },
    });
    assert.equal(initialized.status, 200);
    assert.match(initialized.headers.get("content-type") ?? "", /application\/json/i);
    assert.equal(initialized.headers.get("mcp-session-id"), null);
    const initializePayload = await initialized.json() as { result?: { serverInfo?: { name?: unknown } } };
    assert.equal(initializePayload.result?.serverInfo?.name, "gptmcp");

    const tools = await postMcp(
      endpoint,
      accessToken,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "mcp-session-id": "legacy-session-that-must-not-be-required" },
    );
    assert.equal(tools.status, 200);
    assert.match(tools.headers.get("content-type") ?? "", /application\/json/i);
    assert.equal(tools.headers.get("mcp-session-id"), null);
    assert.equal(tools.headers.get("x-gptmcp-cache"), null);
    const toolsPayload = await tools.json() as { id?: unknown; result?: { tools?: Array<{ name?: unknown }> } };
    assert.equal(toolsPayload.id, 2);
    assert.equal(toolsPayload.result?.tools?.some((tool) => tool.name === "open_workspace"), true);

    const cachedTools = await postMcp(endpoint, accessToken, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/list",
      params: {},
    });
    assert.equal(cachedTools.status, 200);
    assert.equal(cachedTools.headers.get("x-gptmcp-cache"), "hit");
    const cachedPayload = await cachedTools.json() as {
      id?: unknown;
      result?: { tools?: Array<{ name?: unknown }> };
    };
    assert.equal(cachedPayload.id, 99);
    assert.equal(cachedPayload.result?.tools?.some((tool) => tool.name === "open_workspace"), true);

    const denied = await postMcp(endpoint, "invalid-access-token", {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/list",
      params: {},
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("x-gptmcp-cache"), null);

    const optimizer = await fetch(endpoint.replace(/\/mcp$/, "/statusz/optimizer"), {
      headers: { "x-gptmcp-owner-token": OWNER_TOKEN },
    });
    assert.equal(optimizer.status, 200);
    const optimizerPayload = await optimizer.json() as {
      cache?: { size?: unknown; hits?: unknown; misses?: unknown; writes?: unknown };
    };
    assert.equal(optimizerPayload.cache?.size, 1);
    assert.equal(optimizerPayload.cache?.hits, 1);
    assert.equal(optimizerPayload.cache?.misses, 1);
    assert.equal(optimizerPayload.cache?.writes, 1);

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(endpoint, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "POST");
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function issueAccessToken(
  oauthConfig: ReturnType<typeof loadConfig>["oauth"],
  mcpUrl: URL,
  stateDir: string,
): Promise<string> {
  const provider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [REDIRECT_URI],
      client_name: "ChatGPT stateless test",
    });
    assert.ok(client);
    const code = "stateless-http-test-code";
    provider["codes"].set(code, {
      clientId: client.client_id,
      params: {
        redirectUri: REDIRECT_URI,
        codeChallenge: "challenge",
        scopes: ["gptmcp"],
        resource: mcpUrl,
      },
      expiresAtMs: Date.now() + 60_000,
    });
    const issued = await provider.exchangeAuthorizationCode(
      client,
      code,
      undefined,
      REDIRECT_URI,
      mcpUrl,
    );
    return issued.access_token;
  } finally {
    provider.close();
  }
}

async function postMcp(
  endpoint: string,
  accessToken: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}
