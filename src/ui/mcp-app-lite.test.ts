import assert from "node:assert/strict";
import test from "node:test";
import { MCP_APPS_PROTOCOL_VERSION, ToolCardApp } from "./mcp-app-lite.js";

test("lightweight MCP Apps bridge uses the reviewed protocol version", () => {
  assert.equal(MCP_APPS_PROTOCOL_VERSION, "2026-01-26");
});

test("lightweight MCP Apps bridge completes handshake and dispatches tool lifecycle events", async () => {
  const parent = new FakeWindow();
  const view = new FakeWindow();
  const app = new ToolCardApp(
    { name: "test-card", version: "1.0.0" },
    parent as unknown as Window,
    view as unknown as Window,
  );

  let toolInput: Record<string, unknown> | undefined;
  let toolResultText: string | undefined;
  let cancelledReason: string | undefined;
  app.ontoolinput = (input) => {
    toolInput = input.arguments;
  };
  app.ontoolresult = (result) => {
    const first = result.content?.[0];
    if (first?.type === "text") toolResultText = first.text;
  };
  app.ontoolcancelled = (cancelled) => {
    cancelledReason = cancelled.reason;
  };
  app.onteardown = () => ({});

  const connecting = app.connect();
  const initialize = parent.messages[0];
  assert.equal(initialize?.method, "ui/initialize");
  assert.equal(initialize?.params?.protocolVersion, MCP_APPS_PROTOCOL_VERSION);
  const initializeId = initialize?.id;
  assert.equal(typeof initializeId, "number");

  view.dispatch(parent, {
    jsonrpc: "2.0",
    id: initializeId,
    result: {
      protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      hostInfo: { name: "host", version: "1" },
      hostCapabilities: {},
      hostContext: { theme: "dark" },
    },
  });
  await connecting;
  assert.equal(app.getHostContext()?.theme, "dark");
  assert.equal(parent.messages.some((message) => message.method === "ui/notifications/initialized"), true);

  view.dispatch(parent, {
    jsonrpc: "2.0",
    method: "ui/notifications/tool-input",
    params: { arguments: { cmd: "npm test" } },
  });
  assert.deepEqual(toolInput, { cmd: "npm test" });

  view.dispatch(parent, {
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { content: [{ type: "text", text: "ok" }] },
  });
  assert.equal(toolResultText, "ok");

  view.dispatch(parent, {
    jsonrpc: "2.0",
    method: "ui/notifications/tool-cancelled",
    params: { reason: "user" },
  });
  assert.equal(cancelledReason, "user");

  view.dispatch(parent, {
    jsonrpc: "2.0",
    id: 99,
    method: "ui/resource-teardown",
    params: {},
  });
  await Promise.resolve();
  assert.equal(parent.messages.some((message) => message.id === 99 && "result" in message), true);

  app.close();
});

class FakeWindow {
  readonly messages: Array<Record<string, any>> = [];
  private listener?: (event: MessageEvent) => void;

  postMessage(message: Record<string, any>): void {
    this.messages.push(message);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "message") return;
    this.listener = typeof listener === "function"
      ? listener as (event: MessageEvent) => void
      : (event) => listener.handleEvent(event);
  }

  removeEventListener(type: string): void {
    if (type === "message") this.listener = undefined;
  }

  dispatch(source: FakeWindow, data: Record<string, unknown>): void {
    this.listener?.({ source, data } as unknown as MessageEvent);
  }
}
