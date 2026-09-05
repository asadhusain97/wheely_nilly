import { MCP_RESOURCE } from "./oauth.js";

const PROTOCOL_VERSION = "2025-11-25";
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface ToolErrorDetails {
  status?: number;
  code?: string;
  message: string;
}

export class McpHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "McpHttpError";
    this.status = status;
  }
}

export class McpToolError extends Error {
  status?: number;
  code?: string;
  retryable: boolean;

  constructor({ status, code, message }: ToolErrorDetails) {
    super(message);
    this.name = "McpToolError";
    this.status = status;
    this.code = code;
    this.retryable = status === undefined || TRANSIENT_STATUSES.has(status);
  }
}

const jsonMessages = async (response: Response): Promise<JsonRpcResponse[]> => {
  if (response.status === 202 || response.status === 204) return [];
  const text = await response.text();
  if (!text.trim()) return [];
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const payload = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    return Array.isArray(payload) ? payload : [payload];
  }
  return text.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return [];
    const payload = JSON.parse(data) as JsonRpcResponse | JsonRpcResponse[];
    return Array.isArray(payload) ? payload : [payload];
  });
};

const parseToolText = (text: string): unknown => {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
};

const toolErrorDetails = (tool: ToolResult): ToolErrorDetails => {
  const contentText = tool.content?.find((item) => item.type === "text" && item.text)?.text;
  const queue: unknown[] = [tool.structuredContent, ...(tool.content ?? []).map((item) => item.text)];
  const records: Record<string, unknown>[] = [];
  const visited = new Set<object>();
  while (queue.length) {
    const value = queue.shift();
    if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
      try { queue.push(JSON.parse(value)); } catch { /* Keep the original text as the message. */ }
      continue;
    }
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    records.push(record);
    queue.push(...Object.values(record));
  }
  const firstValue = (keys: string[]) => records
    .flatMap((record) => keys.map((key) => record[key]))
    .find((value) => value !== undefined && value !== null);
  const rawStatus = Number(firstValue(["status", "statusCode", "status_code", "httpStatus", "http_status"]));
  let status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined;
  const rawCode = firstValue(["code", "errorCode", "error_code"]);
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : undefined;
  const nestedMessage = firstValue(["message", "detail", "error"]);
  const message = contentText
    ?? (typeof nestedMessage === "string" ? nestedMessage : null)
    ?? "SnapTrade MCP tool failed";
  const signature = `${code ?? ""} ${message}`.toLowerCase();
  const authenticationFailure = /(?:auth(?:entication|orization)?[ _-]+required|authentication credentials.{0,30}(?:invalid|missing|not provided)|not authenticated|unauthorized|invalid[ _-]+grant|invalid[ _-]+token|access[ _-]+token.{0,30}(?:expired|invalid)|token.{0,30}expired)/.test(signature);
  if (authenticationFailure && (status === undefined || status === 401 || status === 403)) status = 401;
  else if (status === undefined && /rate.?limit|too many requests/.test(signature)) status = 429;
  else if (status === undefined && /timed? out|timeout/.test(signature)) status = 504;
  else if (status === undefined && /temporar(?:y|ily) unavailable|service unavailable|upstream unavailable/.test(signature)) status = 503;
  return { status, code, message };
};

export const extractToolPayload = (result: unknown): unknown => {
  const tool = result && typeof result === "object" ? result as ToolResult : {};
  if (tool.isError) throw new McpToolError(toolErrorDetails(tool));
  if (tool.structuredContent !== undefined) {
    return typeof tool.structuredContent === "string"
      ? parseToolText(tool.structuredContent)
      : tool.structuredContent;
  }
  const values = (tool.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => parseToolText(item.text!));
  return values.length === 1 ? values[0] : values;
};

export class SnapTradeMcpClient {
  #accessToken: string;
  #sessionId: string | null = null;
  #protocolVersion = PROTOCOL_VERSION;
  #nextId = 1;
  #opened = false;
  #deadlineAt: number;

  constructor(accessToken: string, timeoutMs = 52_000) {
    this.#accessToken = accessToken;
    this.#deadlineAt = Date.now() + timeoutMs;
  }

  async open(): Promise<void> {
    if (this.#opened) return;
    const result = await this.#request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Wheely Nilly", version: "0.2.0" },
    }, true, true) as { protocolVersion?: string };
    if (typeof result?.protocolVersion === "string") this.#protocolVersion = result.protocolVersion;
    this.#opened = true;
    await this.#notify("notifications/initialized");
  }

  async listTools(): Promise<unknown> {
    await this.open();
    return this.#request("tools/list", {}, false, true);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.open();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return extractToolPayload(await this.#request("tools/call", { name, arguments: args }, false, name !== "request_connection_link"));
      } catch (error) {
        const retryableToolError = error instanceof McpToolError && error.retryable && name !== "request_connection_link";
        if (attempt === 0 && retryableToolError && await this.#pauseBeforeRetry(1_000)) continue;
        throw error;
      }
    }
    throw new McpHttpError(504, "SnapTrade MCP request timed out");
  }

  async close(): Promise<void> {
    if (!this.#sessionId) return;
    await fetch(MCP_RESOURCE, {
      method: "DELETE",
      headers: this.#headers(false),
      signal: AbortSignal.timeout(3_000),
    }).catch(() => undefined);
    this.#sessionId = null;
    this.#opened = false;
  }

  async #notify(method: string): Promise<void> {
    await this.#post({ jsonrpc: "2.0", method }, null, false, true);
  }

  async #request(method: string, params: Record<string, unknown>, initializing = false, retryable = false): Promise<unknown> {
    const id = this.#nextId++;
    return this.#post({ jsonrpc: "2.0", id, method, params }, id, initializing, retryable);
  }

  async #post(message: Record<string, unknown>, expectedId: number | null, initializing: boolean, retryable: boolean): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingMs = this.#deadlineAt - Date.now();
      if (remainingMs <= 0) throw new McpHttpError(504, "SnapTrade MCP request timed out");
      let response: Response;
      try {
        response = await fetch(MCP_RESOURCE, {
          method: "POST",
          headers: this.#headers(initializing),
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(Math.min(18_000, remainingMs)),
        });
      } catch (error) {
        const requestError = (error as { name?: string }).name === "TimeoutError" || (error as { name?: string }).name === "AbortError"
          ? new McpHttpError(504, "SnapTrade MCP request timed out")
          : error;
        if (retryable && attempt === 0 && await this.#pauseBeforeRetry(250)) continue;
        throw requestError;
      }
      if (!response.ok) {
        const requestError = new McpHttpError(response.status, `SnapTrade MCP request failed with ${response.status}`);
        if (retryable && attempt === 0 && TRANSIENT_STATUSES.has(response.status) && await this.#pauseBeforeRetry(this.#retryDelay(response))) continue;
        throw requestError;
      }
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.#sessionId = sessionId;
      if (expectedId === null) return null;
      const payload = (await jsonMessages(response)).find((item) => item.id === expectedId);
      if (!payload) throw new Error("SnapTrade MCP response did not include the requested result");
      if (payload.error) throw new Error(`SnapTrade MCP error ${payload.error.code ?? "unknown"}: ${payload.error.message ?? "request failed"}`);
      return payload.result;
    }
    throw new McpHttpError(504, "SnapTrade MCP request timed out");
  }

  #retryDelay(response: Response): number {
    const header = response.headers.get("retry-after");
    if (!header) return 250;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(2_000, Math.max(0, seconds * 1000));
    const at = Date.parse(header);
    return Number.isFinite(at) ? Math.min(2_000, Math.max(0, at - Date.now())) : 250;
  }

  async #pauseBeforeRetry(delayMs: number): Promise<boolean> {
    if (this.#deadlineAt - Date.now() <= delayMs) return false;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return true;
  }

  #headers(initializing: boolean): Record<string, string> {
    return {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.#accessToken}`,
      "content-type": "application/json",
      ...(!initializing ? { "MCP-Protocol-Version": this.#protocolVersion } : {}),
      ...(this.#sessionId ? { "Mcp-Session-Id": this.#sessionId } : {}),
    };
  }
}
