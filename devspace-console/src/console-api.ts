import { invoke } from "@tauri-apps/api/core";

export type ConsoleHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export async function consoleApi<T>(method: ConsoleHttpMethod, path: string, body?: unknown): Promise<T> {
  return invoke<T>("proxy_gptmcp_api", { method, path, body: body ?? null });
}

export function withQuery(path: string, query: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}
