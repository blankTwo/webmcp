#!/usr/bin/env bash
# GPTMCP MCP benchmark. Requires a real OAuth access token for /mcp.

set -euo pipefail

BASE_URL="${GPTMCP_BASE_URL:-http://localhost:7676}"
ACCESS_TOKEN="${GPTMCP_ACCESS_TOKEN:-}"
OWNER_TOKEN="${GPTMCP_OWNER_TOKEN:-}"
PROTOCOL_VERSION="${GPTMCP_MCP_PROTOCOL_VERSION:-2025-11-25}"

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "Error: GPTMCP_ACCESS_TOKEN is required." >&2
  echo "Use a real OAuth access token issued for $BASE_URL/mcp; the GPTMCP owner token is not a Bearer access token." >&2
  exit 2
fi

if [[ -z "$OWNER_TOKEN" && -f "$HOME/.gptmcp/auth.json" ]]; then
  OWNER_TOKEN="$(node -e 'const fs=require("node:fs"); const p=process.argv[1]; const v=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(v.ownerToken ?? "")' "$HOME/.gptmcp/auth.json")"
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "Error: npx not found." >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl not found." >&2
  exit 2
fi

echo "=== GPTMCP MCP Performance Benchmark ==="
echo "Endpoint: $BASE_URL/mcp"
echo "Protocol: $PROTOCOL_VERSION"
echo

TOOLS_LIST_BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
INITIALIZE_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"gptmcp-benchmark","version":"1.0.0"}}}'

mcp_curl() {
  curl -sS \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Accept: application/json, text/event-stream" \
    -H "Content-Type: application/json" \
    -H "MCP-Protocol-Version: $PROTOCOL_VERSION" \
    "$@"
}

preflight_status="$(mcp_curl -o /dev/null -w '%{http_code}' -X POST -d "$TOOLS_LIST_BODY" "$BASE_URL/mcp")"
if [[ "$preflight_status" != "200" ]]; then
  echo "Error: tools/list preflight returned HTTP $preflight_status." >&2
  echo "The OAuth access token or MCP server configuration is not valid for this benchmark." >&2
  exit 3
fi

cache_headers="$(mcp_curl -D - -o /dev/null -X POST -d "$TOOLS_LIST_BODY" "$BASE_URL/mcp")"
if ! printf '%s\n' "$cache_headers" | grep -qi '^X-GPTMCP-Cache: hit'; then
  echo "Error: second tools/list request did not report X-GPTMCP-Cache: hit." >&2
  echo "Refusing to report cached performance numbers." >&2
  exit 4
fi

summarize_autocannon() {
  node --input-type=module -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const lines = input.trim().split(/\r?\n/).filter(Boolean);
      const result = JSON.parse(lines.at(-1));
      const failures = Number(result.non2xx ?? 0) + Number(result.errors ?? 0) + Number(result.timeouts ?? 0) + Number(result.mismatches ?? 0);
      console.log(JSON.stringify({
        p50Ms: result.latency?.p50,
        p95Ms: result.latency?.p95,
        p99Ms: result.latency?.p99,
        avgMs: result.latency?.average,
        reqPerSec: result.requests?.average,
        requests: result.requests?.total,
        non2xx: result.non2xx ?? 0,
        errors: result.errors ?? 0,
        timeouts: result.timeouts ?? 0,
        mismatches: result.mismatches ?? 0
      }, null, 2));
      if (failures !== 0) process.exit(10);
    });
  '
}

run_benchmark() {
  local title="$1"
  local connections="$2"
  local duration="$3"
  local body="$4"

  echo "=== $title ==="
  local result
  result="$(npx --yes autocannon -j -n \
    -c "$connections" -d "$duration" -m POST \
    -H "Authorization=Bearer $ACCESS_TOKEN" \
    -H "Accept=application/json, text/event-stream" \
    -H "Content-Type=application/json" \
    -H "MCP-Protocol-Version=$PROTOCOL_VERSION" \
    -b "$body" \
    "$BASE_URL/mcp")"

  if ! printf '%s\n' "$result" | summarize_autocannon; then
    echo "Error: benchmark contained non-2xx responses, transport errors, timeouts, or body mismatches." >&2
    exit 5
  fi
  echo
}

run_benchmark "Cached tools/list (10 connections)" 10 10 "$TOOLS_LIST_BODY"
run_benchmark "Uncached initialize path (20 connections)" 20 10 "$INITIALIZE_BODY"

if [[ -n "$OWNER_TOKEN" ]]; then
  echo "=== Optimizer Statistics ==="
  curl -sS -H "x-gptmcp-owner-token: $OWNER_TOKEN" "$BASE_URL/statusz/optimizer"
  echo
else
  echo "Optimizer statistics skipped: GPTMCP_OWNER_TOKEN is not set and ~/.gptmcp/auth.json has no ownerToken."
fi

echo "=== Benchmark Complete ==="
