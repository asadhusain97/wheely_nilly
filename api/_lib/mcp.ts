import { MCP_RESOURCE } from "./oauth.js";

const PROTOCOL_VERSION = "2025-11-25";

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

export class McpHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "McpHttpError";
    this.status = status;
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

export const extractToolPayload = (result: unknown): unknown => {
  const tool = result && typeof result === "object" ? result as ToolResult : {};
  if (tool.isError) {
    const message = tool.content?.find((item) => item.type === "text" && item.text)?.text ?? "SnapTrade MCP tool failed";
    throw new Error(message);
  }
  if (tool.structuredContent !== undefined) return tool.structuredContent;
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

  constructor(accessToken: string) {
    this.#accessToken = accessToken;
  }

  async open(): Promise<void> {
    if (this.#opened) return;
    const result = await this.#request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Wheely Nilly", version: "0.2.0" },
    }, true) as { protocolVersion?: string };
    if (typeof result?.protocolVersion === "string") this.#protocolVersion = result.protocolVersion;
    this.#opened = true;
    await this.#notify("notifications/initialized");
  }

  async listTools(): Promise<unknown> {
    await this.open();
    return this.#request("tools/list", {});
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.open();
    return extractToolPayload(await this.#request("tools/call", { name, arguments: args }));
  }

  async close(): Promise<void> {
    if (!this.#sessionId) return;
    await fetch(MCP_RESOURCE, {
      method: "DELETE",
      headers: this.#headers(false),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    this.#sessionId = null;
    this.#opened = false;
  }

  async #notify(method: string): Promise<void> {
    await this.#post({ jsonrpc: "2.0", method }, null, false);
  }

  async #request(method: string, params: Record<string, unknown>, initializing = false): Promise<unknown> {
    const id = this.#nextId++;
    return this.#post({ jsonrpc: "2.0", id, method, params }, id, initializing);
  }

  async #post(message: Record<string, unknown>, expectedId: number | null, initializing: boolean): Promise<unknown> {
    const response = await fetch(MCP_RESOURCE, {
      method: "POST",
      headers: this.#headers(initializing),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(18_000),
    });
    if (!response.ok) throw new McpHttpError(response.status, `SnapTrade MCP request failed with ${response.status}`);
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.#sessionId = sessionId;
    if (expectedId === null) return null;
    const payload = (await jsonMessages(response)).find((item) => item.id === expectedId);
    if (!payload) throw new Error("SnapTrade MCP response did not include the requested result");
    if (payload.error) throw new Error(`SnapTrade MCP error ${payload.error.code ?? "unknown"}: ${payload.error.message ?? "request failed"}`);
    return payload.result;
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
