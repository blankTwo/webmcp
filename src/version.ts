import { createRequire } from "node:module";

interface WebMCPPackageMetadata {
  version: string;
  engines?: {
    node?: string;
  };
}

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as Partial<WebMCPPackageMetadata>;

if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("Unable to read WebMCP package version.");
}

export const WEBMCP_VERSION = packageJson.version;
export const WEBMCP_NODE_RANGE = packageJson.engines?.node ?? ">=22.19 <27";
export const GPTMCP_VERSION = WEBMCP_VERSION;
export const GPTMCP_NODE_RANGE = WEBMCP_NODE_RANGE;
