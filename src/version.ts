import { createRequire } from "node:module";

interface GPTMCPPackageMetadata {
  version: string;
  engines?: {
    node?: string;
  };
}

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as Partial<GPTMCPPackageMetadata>;

if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("Unable to read GPTMCP package version.");
}

export const GPTMCP_VERSION = packageJson.version;
export const GPTMCP_NODE_RANGE = packageJson.engines?.node ?? ">=22.19 <27";
