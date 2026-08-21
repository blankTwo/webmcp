import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

export interface ToolCardHostContext {
  theme?: "light" | "dark";
  styles?: {
    variables?: Record<string, string | undefined>;
    css?: { fonts?: string };
  };
  safeAreaInsets?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  [key: string]: unknown;
}

export interface ToolInputNotification {
  arguments?: Record<string, unknown>;
}

export interface ToolCancelledNotification {
  reason?: string;
}

interface InitializeResult {
  protocolVersion?: string;
  hostContext?: ToolCardHostContext;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const INITIALIZE_METHOD = "ui/initialize";
const INITIALIZED_METHOD = "ui/notifications/initialized";
const TOOL_INPUT_METHOD = "ui/notifications/tool-input";
const TOOL_INPUT_PARTIAL_METHOD = "ui/notifications/tool-input-partial";
const TOOL_RESULT_METHOD = "ui/notifications/tool-result";
const TOOL_CANCELLED_METHOD = "ui/notifications/tool-cancelled";
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const RESOURCE_TEARDOWN_METHOD = "ui/resource-teardown";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class ToolCardApp {
  ontoolinput?: (input: ToolInputNotification) => void;
  ontoolinputpartial?: (input: ToolInputNotification) => void;
  ontoolresult?: (result: CallToolResult) => void;
  ontoolcancelled?: (cancelled: ToolCancelledNotification) => void;
  onhostcontextchanged?: (context: ToolCardHostContext) => void;
  onteardown?: () => Promise<Record<string, never>> | Record<string, never>;

  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private hostContext?: ToolCardHostContext;
  private connected = false;
  private resizeObserver?: ResizeObserver;
  private resizeFrame = 0;
  private lastWidth = 0;
  private lastHeight = 0;

  constructor(
    private readonly appInfo: { name: string; version: string },
    private readonly parentWindow: Window = window.parent,
    private readonly eventWindow: Window = window,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) throw new Error("ToolCardApp is already connected.");
    this.eventWindow.addEventListener("message", this.handleMessage);

    try {
      const result = await this.request<InitializeResult>(INITIALIZE_METHOD, {
        appCapabilities: {},
        appInfo: this.appInfo,
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      });
      this.hostContext = result.hostContext;
      this.notify(INITIALIZED_METHOD, {});
      this.connected = true;
      this.setupSizeNotifications();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  getHostContext(): ToolCardHostContext | undefined {
    return this.hostContext;
  }

  close(): void {
    this.eventWindow.removeEventListener("message", this.handleMessage);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = 0;
    this.connected = false;

    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("ToolCardApp closed before the request completed."));
    }
    this.pending.clear();
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (event.source !== this.parentWindow) return;
    const message = asJsonRpcMessage(event.data);
    if (!message) return;

    if (typeof message.id === "number" && message.method === undefined) {
      this.resolveRequest(message.id, message);
      return;
    }

    if (typeof message.method !== "string") return;
    const params = asRecord(message.params);

    switch (message.method) {
      case TOOL_INPUT_METHOD:
        this.ontoolinput?.({ arguments: asOptionalRecord(params?.arguments) });
        return;
      case TOOL_INPUT_PARTIAL_METHOD:
        this.ontoolinputpartial?.({ arguments: asOptionalRecord(params?.arguments) });
        return;
      case TOOL_RESULT_METHOD:
        this.ontoolresult?.((params ?? {}) as CallToolResult);
        return;
      case TOOL_CANCELLED_METHOD:
        this.ontoolcancelled?.({ reason: typeof params?.reason === "string" ? params.reason : undefined });
        return;
      case HOST_CONTEXT_CHANGED_METHOD: {
        const next = (params ?? {}) as ToolCardHostContext;
        this.hostContext = { ...this.hostContext, ...next };
        this.onhostcontextchanged?.(next);
        return;
      }
      case "ping":
        this.respond(message.id, {});
        return;
      case RESOURCE_TEARDOWN_METHOD:
        void this.handleTeardown(message.id);
        return;
      default:
        if (message.id !== undefined) this.respondError(message.id, -32601, "Method not found");
    }
  };

  private async handleTeardown(id: unknown): Promise<void> {
    try {
      const result = await this.onteardown?.() ?? {};
      this.respond(id, result);
    } catch (error) {
      this.respondError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.post({ jsonrpc: "2.0", id, method, params });
    });
  }

  private resolveRequest(id: number, message: JsonRpcMessage): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    const error = asRecord(message.error);
    if (error) {
      pending.reject(new Error(typeof error.message === "string" ? error.message : "MCP Apps request failed."));
      return;
    }
    pending.resolve(message.result);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.post({ jsonrpc: "2.0", method, params });
  }

  private respond(id: unknown, result: unknown): void {
    if (id === undefined) return;
    this.post({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: unknown, code: number, message: string): void {
    if (id === undefined) return;
    this.post({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private post(message: Record<string, unknown>): void {
    this.parentWindow.postMessage(message, "*");
  }

  private setupSizeNotifications(): void {
    if (typeof ResizeObserver === "undefined") return;
    const schedule = () => {
      if (this.resizeFrame) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = 0;
        const documentElement = document.documentElement;
        const previousHeight = documentElement.style.height;
        documentElement.style.height = "max-content";
        const height = Math.ceil(documentElement.getBoundingClientRect().height);
        documentElement.style.height = previousHeight;
        const width = Math.ceil(window.innerWidth);
        if (width === this.lastWidth && height === this.lastHeight) return;
        this.lastWidth = width;
        this.lastHeight = height;
        this.notify(SIZE_CHANGED_METHOD, { width, height });
      });
    };

    schedule();
    this.resizeObserver = new ResizeObserver(schedule);
    this.resizeObserver.observe(document.documentElement);
    this.resizeObserver.observe(document.body);
  }
}

export function applyDocumentTheme(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
}

export function applyHostStyleVariables(
  variables: Record<string, string | undefined>,
  target: HTMLElement = document.documentElement,
): void {
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined) target.style.setProperty(key, value);
  }
}

export function applyHostFonts(fonts: string): void {
  const id = "__mcp-host-fonts";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = fonts;
  document.head.appendChild(style);
}

function asJsonRpcMessage(value: unknown): JsonRpcMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as JsonRpcMessage;
  return message.jsonrpc === "2.0" ? message : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined ? undefined : asRecord(value);
}
