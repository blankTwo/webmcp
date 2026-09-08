import express from "express";
import type { Server } from "node:http";
import { GPTMCP_VERSION } from "../version.js";
import {
  MAX_CONSOLE_RETENTION_DAYS,
  MIN_CONSOLE_RETENTION_DAYS,
  TelemetryEventStore,
  type ToolTelemetryInput,
} from "./store.js";

export interface ConsoleServerOptions {
  host?: string;
  port?: number;
  stateDir?: string;
}

export interface RunningConsoleServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

export async function startConsoleServer(options: ConsoleServerOptions = {}): Promise<RunningConsoleServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7677;
  const startedAt = Date.now();
  const store = new TelemetryEventStore(options.stateDir);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      name: "console-server",
      version: GPTMCP_VERSION,
      pid: process.pid,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  app.get("/statusz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      name: "console-server",
      version: GPTMCP_VERSION,
      pid: process.pid,
      host,
      port: actualPort(server, port),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      sqlite: { ok: true, ...store.settings() },
      streamSubscribers: store.subscriberCount(),
      eventCount: store.count(),
    });
  });

  app.post("/telemetry/tool", (req, res) => {
    const input = parseTelemetry(req.body);
    if (!input) {
      res.status(400).json({ ok: false, error: "invalid telemetry payload" });
      return;
    }
    store.ingest(input);
    res.status(202).json({ ok: true });
  });

  app.get("/console/snapshot", (req, res) => {
    const requested = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Number.isFinite(requested) ? requested : 100;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      server: {
        ok: true,
        name: "console-server",
        version: GPTMCP_VERSION,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      },
      settings: store.settings(),
      workspaceEventCounts: store.countsByWorkspaceRoot(),
      runningWorkspaceIds: store.runningWorkspaceIds(),
      workspaces: store.workspaces(),
      events: store.recent(limit),
    });
  });

  app.get("/console/history", (req, res) => {
    const workspaceRoot = typeof req.query.workspaceRoot === "string" ? req.query.workspaceRoot.trim() : "";
    if (!workspaceRoot) {
      res.status(400).json({ ok: false, error: "workspaceRoot is required" });
      return;
    }
    const requested = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const before = typeof req.query.before === "string" && req.query.before ? req.query.before : undefined;
    res.json({ ok: true, ...store.history({ workspaceRoot, before, limit: requested }) });
  });

  app.put("/console/events/:id/favorite", (req, res) => {
    if (typeof req.body?.favorite !== "boolean") {
      res.status(400).json({ ok: false, error: "favorite must be a boolean" });
      return;
    }
    const event = store.setFavorite(req.params.id, req.body.favorite);
    if (!event) {
      res.status(404).json({ ok: false, error: "event not found" });
      return;
    }
    res.json({ ok: true, event });
  });

  app.put("/console/settings", (req, res) => {
    const retentionDays = Number(req.body?.retentionDays);
    if (!Number.isInteger(retentionDays) || retentionDays < MIN_CONSOLE_RETENTION_DAYS || retentionDays > MAX_CONSOLE_RETENTION_DAYS) {
      res.status(400).json({ ok: false, error: `retentionDays must be ${MIN_CONSOLE_RETENTION_DAYS}-${MAX_CONSOLE_RETENTION_DAYS}` });
      return;
    }
    res.json({ ok: true, settings: store.setRetentionDays(retentionDays) });
  });

  app.post("/console/cleanup", (_req, res) => {
    res.json({ ok: true, settings: store.cleanupExpired() });
  });

  app.delete("/console/events", (_req, res) => {
    res.json({ ok: true, settings: store.clearEvents() });
  });

  app.get("/console/processes", (req, res) => {
    const workspaceRoot = typeof req.query.workspaceRoot === "string" ? req.query.workspaceRoot.trim() : "";
    if (!workspaceRoot) {
      res.status(400).json({ ok: false, error: "workspaceRoot is required" });
      return;
    }
    res.json({ ok: true, processes: store.processes(workspaceRoot) });
  });

  app.get("/console/processes/:sessionId/output", (req, res) => {
    const workspaceRoot = typeof req.query.workspaceId === "string" ? req.query.workspaceId.trim() : "";
    const sessionId = Number(req.params.sessionId);
    if (!workspaceRoot || !Number.isInteger(sessionId) || sessionId < 1) {
      res.status(400).json({ ok: false, error: "valid workspaceId and sessionId are required" });
      return;
    }
    const snapshot = store.processOutput(workspaceRoot, sessionId);
    if (!snapshot) {
      res.status(404).json({ ok: false, error: "process not found" });
      return;
    }
    res.json({ ok: true, snapshot });
  });

  app.post("/console/processes/:sessionId/terminate", (_req, res) => {
    res.status(501).json({ ok: false, error: "Console process control is read-only for codex-mcp." });
  });

  app.get("/console/events", (req, res) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(": connected\n\n");
    const unsubscribe = store.subscribe((event) => {
      res.write(`id: ${event.id}\n`);
      res.write("event: tool_call\n");
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  let server: Server;
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, host, (error?: Error) => {
      if (error) reject(error);
      else resolve(listening);
    });
  });

  const address = server.address();
  const boundPort = address && typeof address === "object" ? address.port : port;
  return {
    host,
    port: boundPort,
    close: async () => {
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function actualPort(server: Server | undefined, fallback: number): number {
  const address = server?.address();
  return address && typeof address === "object" ? address.port : fallback;
}

function parseTelemetry(value: unknown): ToolTelemetryInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1
    || input.service !== "codex-mcp"
    || (input.phase !== "started" && input.phase !== "finished")
    || typeof input.invocationId !== "string"
    || !input.invocationId
    || typeof input.tool !== "string"
    || !input.tool
    || typeof input.timestamp !== "string"
  ) return undefined;
  return value as ToolTelemetryInput;
}
