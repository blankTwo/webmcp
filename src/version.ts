import { createRequire } from "node:module";

interface DevSpacePackageMetadata {
  version: string;
  engines?: {
    node?: string;
  };
}

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as Partial<DevSpacePackageMetadata>;

if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("Unable to read DevSpace package version.");
}

export const DEVSPACE_VERSION = packageJson.version;
export const DEVSPACE_NODE_RANGE = packageJson.engines?.node ?? ">=22.19 <27";
