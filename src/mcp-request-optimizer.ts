/**
 * MCP Stateless 请求优化器
 * 
 * 问题分析：
 * - 每次 POST /mcp 都创建新 McpServer + 注册 26 个工具 + 创建 Transport
 * - 工具 handler 闭包捕获外部依赖（workspaces 等），不能简单缓存
 * 
 * 优化策略：
 * 1. 预热：启动时创建一次 McpServer，让 V8 优化热路径
 * 2. Schema 缓存：Zod schema 对象可以复用（不可变）
 * 3. 并发处理：移除 Express 中间件串行瓶颈
 * 4. 快速路径：常见请求（tools/list）走缓存响应
 */

import type { Request, Response } from "express";

export interface CachedResponse {
  body: any;
  expiresAt: number;
}

export class McpRequestOptimizer {
  private responseCache = new Map<string, CachedResponse>();
  private readonly TOOLS_LIST_CACHE_MS = 60_000; // tools/list 缓存 1 分钟

  /**
   * 尝试从缓存返回响应（适用于 tools/list 等静态请求）
   */
  tryServeCached(req: Request, res: Response): boolean {
    if (req.method !== "POST") return false;

    try {
      const body = req.body;
      if (!body || typeof body !== "object") return false;

      // 只缓存 tools/list 和 prompts/list（结果稳定且频繁调用）
      const method = body.method || (Array.isArray(body) && body[0]?.method);
      if (method !== "tools/list" && method !== "prompts/list") return false;

      const cacheKey = `${method}:${req.auth?.token || "anonymous"}`;
      const cached = this.responseCache.get(cacheKey);

      if (cached && Date.now() < cached.expiresAt) {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("X-DevSpace-Cache", "hit");
        res.send(cached.body);
        return true;
      }
    } catch {
      // 解析失败，走正常流程
    }

    return false;
  }

  /**
   * 缓存响应
   */
  cacheResponse(method: string, token: string | undefined, body: any): void {
    if (method !== "tools/list" && method !== "prompts/list") return;

    const cacheKey = `${method}:${token || "anonymous"}`;
    this.responseCache.set(cacheKey, {
      body,
      expiresAt: Date.now() + this.TOOLS_LIST_CACHE_MS,
    });
  }

  /**
   * 获取缓存统计
   */
  getCacheSize(): number {
    return this.responseCache.size;
  }

  /**
   * 清空缓存（配置变更时调用）
   */
  clearCache(): void {
    this.responseCache.clear();
  }

  /**
   * 定期清理过期缓存
   */
  startCacheCleanup(): NodeJS.Timeout {
    return setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of this.responseCache.entries()) {
        if (now >= cached.expiresAt) {
          this.responseCache.delete(key);
        }
      }
    }, 30_000);
  }
}

/**
 * 并发请求处理器：避免 Express 中间件串行执行
 */
export class ConcurrentMcpHandler {
  private activeRequests = 0;
  private readonly MAX_CONCURRENT = 50;

  /**
   * 检查是否可以接受新请求
   */
  canAccept(): boolean {
    return this.activeRequests < this.MAX_CONCURRENT;
  }

  /**
   * 包装异步处理器，自动管理并发计数
   */
  wrap<T>(handler: () => Promise<T>): Promise<T> {
    this.activeRequests++;
    return handler().finally(() => {
      this.activeRequests--;
    });
  }

  getStats() {
    return {
      active: this.activeRequests,
      limit: this.MAX_CONCURRENT,
    };
  }
}
