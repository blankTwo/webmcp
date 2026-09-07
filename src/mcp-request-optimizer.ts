import { createHash } from "node:crypto";
import type { Request, Response } from "express";

type JsonRpcId = string | number | null;

interface JsonRpcRequestBody {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: "tools/list";
  params?: unknown;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface CachedToolListResult {
  result: unknown;
  expiresAt: number;
}

export interface McpRequestOptimizerStats {
  size: number;
  hits: number;
  misses: number;
  writes: number;
}

/**
 * Caches only the successful `tools/list` result payload.
 *
 * Authentication and OAuth resource validation must happen before this class is
 * consulted. The JSON-RPC envelope is never cached: every cache hit is wrapped
 * with the current request id so responses cannot leak a previous request id.
 */
export class McpRequestOptimizer {
  private readonly responseCache = new Map<string, CachedToolListResult>();
  private readonly toolsListCacheMs: number;
  private hits = 0;
  private misses = 0;
  private writes = 0;

  constructor(toolsListCacheMs = 60_000) {
    this.toolsListCacheMs = toolsListCacheMs;
  }

  isCacheableRequest(req: Request): boolean {
    return this.requestBody(req) !== undefined && typeof req.auth?.token === "string";
  }

  tryServeCached(req: Request, res: Response): boolean {
    const request = this.requestBody(req);
    const cacheKey = this.cacheKey(req, request);
    if (!request || !cacheKey) return false;

    const cached = this.responseCache.get(cacheKey);
    if (!cached) {
      this.misses += 1;
      return false;
    }

    if (Date.now() >= cached.expiresAt) {
      this.responseCache.delete(cacheKey);
      this.misses += 1;
      return false;
    }

    this.hits += 1;
    res.setHeader("X-DevSpace-Cache", "hit");
    res.status(200).json({
      jsonrpc: "2.0",
      id: request.id,
      result: cached.result,
    } satisfies JsonRpcSuccessResponse);
    return true;
  }

  cacheResponse(req: Request, response: unknown): boolean {
    const request = this.requestBody(req);
    const cacheKey = this.cacheKey(req, request);
    if (!request || !cacheKey || !isSuccessfulResponseFor(response, request.id)) {
      return false;
    }

    this.responseCache.set(cacheKey, {
      result: response.result,
      expiresAt: Date.now() + this.toolsListCacheMs,
    });
    this.writes += 1;
    return true;
  }

  getStats(): McpRequestOptimizerStats {
    return {
      size: this.responseCache.size,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
    };
  }

  clearCache(): void {
    this.responseCache.clear();
  }

  startCacheCleanup(): NodeJS.Timeout {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of this.responseCache.entries()) {
        if (now >= cached.expiresAt) this.responseCache.delete(key);
      }
    }, Math.min(30_000, this.toolsListCacheMs));
    timer.unref();
    return timer;
  }

  private requestBody(req: Request): JsonRpcRequestBody | undefined {
    const body = req.body as unknown;
    if (!body || Array.isArray(body) || typeof body !== "object") return undefined;

    const candidate = body as Record<string, unknown>;
    if (candidate.jsonrpc !== "2.0" || candidate.method !== "tools/list") return undefined;
    if (!("id" in candidate) || !isJsonRpcId(candidate.id)) return undefined;

    return {
      jsonrpc: "2.0",
      id: candidate.id,
      method: "tools/list",
      ...(candidate.params === undefined ? {} : { params: candidate.params }),
    };
  }

  private cacheKey(req: Request, request: JsonRpcRequestBody | undefined): string | undefined {
    const token = req.auth?.token;
    if (!request || typeof token !== "string" || token.length === 0) return undefined;

    const protocolVersion = req.header("mcp-protocol-version") ?? "";
    const params = JSON.stringify(request.params ?? null);
    return createHash("sha256")
      .update("tools/list\0")
      .update(token)
      .update("\0")
      .update(protocolVersion)
      .update("\0")
      .update(params)
      .digest("base64url");
  }
}

/**
 * Backpressure guard for expensive uncached MCP work. It protects the process
 * under load; it is intentionally not described as a throughput optimizer.
 */
export class ConcurrentRequestLimiter {
  private activeRequests = 0;

  constructor(private readonly maxConcurrent = 50) {}

  tryAcquire(): (() => void) | undefined {
    if (this.activeRequests >= this.maxConcurrent) return undefined;
    this.activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRequests -= 1;
    };
  }

  getStats(): { active: number; limit: number } {
    return {
      active: this.activeRequests,
      limit: this.maxConcurrent,
    };
  }
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

function isSuccessfulResponseFor(response: unknown, requestId: JsonRpcId): response is JsonRpcSuccessResponse {
  if (!response || Array.isArray(response) || typeof response !== "object") return false;
  const candidate = response as Record<string, unknown>;
  return candidate.jsonrpc === "2.0"
    && candidate.id === requestId
    && "result" in candidate
    && !("error" in candidate);
}
