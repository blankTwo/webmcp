# WebMCP MCP 性能优化验收清单

## 正确性

- [x] `tools/list` Fast Path 在 OAuth 校验之后执行
- [x] OAuth resource 校验在缓存命中之前执行
- [x] 缓存只保存 JSON-RPC `result`
- [x] cache hit 使用当前请求的 request id
- [x] 无效 Bearer Token 无法命中缓存
- [x] batch / notification 不进入当前快速缓存路径
- [x] 缓存键包含 token / protocol version / params
- [x] access token 不以明文形式保存到缓存 Map key
- [x] TTL 自动清理
- [x] 并发上限是稳定性保护，不再标记为吞吐优化

## 自动化验证

- [x] TypeScript typecheck
- [x] build
- [x] `server-stateless.test.ts`
- [x] 全量 test（本机 GPG 自动签名配置关闭后）
- [x] 首次 `tools/list` miss
- [x] 第二次 `tools/list` hit
- [x] 第二次 request id 与请求一致
- [x] 无效 access token 返回 401
- [x] optimizer stats 命中 / 未命中 / 写入计数正确

## 基准工具

- [x] `benchmark.sh` 使用真实 OAuth Access Token
- [x] Owner Token 与 OAuth Access Token 明确分离
- [x] benchmark preflight 验证 HTTP 200
- [x] benchmark 强制验证 `X-WebMCP-Cache: hit`
- [x] non-2xx / errors / timeouts / mismatches 非零时失败

## 2026-09-07 有效 OAuth 本机结果

- Cached `tools/list`: p50 9 ms
- Cached `tools/list`: p99 18 ms
- Cached `tools/list`: 1017.1 req/s
- 10171 requests，0 non-2xx，0 errors，0 timeouts

## 尚未验收

- [ ] GC 压力前后 profiler 对照
- [ ] 独立、严格等价的优化前 / 优化后 benchmark
- [ ] 长时间 soak test
- [ ] 不同 CPU / Node 版本复测

因此当前不能继续使用 `25x`、`24x`、`GC -30%` 等未经等价基准证明的结论。
