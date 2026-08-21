#!/usr/bin/env node
import { executeLocalAgentWorker } from "./local-agent-service.js";
import { LocalAgentStore } from "./local-agent-store.js";

async function main(args: string[]): Promise<void> {
  const [agentId, stateDirFlag, stateDir, promptFileFlag, promptFile] = args;
  if (
    !agentId
    || stateDirFlag !== "--state-dir"
    || !stateDir
    || promptFileFlag !== "--prompt-file"
    || !promptFile
  ) {
    throw new Error("Usage: local-agent-worker <agent-id> --state-dir <path> --prompt-file <path>");
  }

  const store = new LocalAgentStore(stateDir);
  try {
    await executeLocalAgentWorker(store, agentId, promptFile);
  } finally {
    store.close();
  }
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
