#!/usr/bin/env node
import { startConsoleServer } from "./server.js";

const port = parsePort(process.env.CODING_CONSOLE_PORT, 7677);
const host = process.env.CODING_CONSOLE_HOST?.trim() || "127.0.0.1";
const stateDir = process.env.CODING_CONSOLE_STATE_DIR?.trim() || undefined;

const running = await startConsoleServer({ host, port, stateDir });
console.log(`console-server listening on http://${running.host}:${running.port}`);

const shutdown = async () => {
  try { await running.close(); } finally { process.exit(0); }
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}
