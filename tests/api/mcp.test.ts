import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { extractToolPayload, SnapTradeMcpClient } from "../../api/_lib/mcp";
import { payloadItems } from "../../api/_lib/snaptrade";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SnapTrade MCP client", () => {
  it("unwraps the response containers used by MCP and SnapTrade", () => {
    const accounts = [{ id: "account-1" }];
    assert.deepEqual(payloadItems({ result: accounts }), accounts);
    assert.deepEqual(payloadItems({ result: { data: { accounts } } }), accounts);
    assert.deepEqual(payloadItems({ data: { results: accounts } }), accounts);
  });

  it("prefers structured tool results", () => {
    assert.deepEqual(extractToolPayload({ structuredContent: { results: [{ id: "account-1" }] } }), { results: [{ id: "account-1" }] });
  });

  it("parses JSON from text tool results", () => {
    assert.deepEqual(extractToolPayload({ content: [{ type: "text", text: "```json\n[{\"id\":\"account-1\"}]\n```" }] }), [{ id: "account-1" }]);
  });

  it("initializes a session and reads an SSE tool response", async () => {
    const calls: Array<{ method: string; headers: Headers; body: unknown }> = [];
    globalThis.fetch = async (_input, init = {}) => {
      const headers = new Headers(init.headers);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method: init.method ?? "GET", headers, body });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "SnapTrade", version: "1" } } }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
        });
      }
      if (calls.length === 2) return new Response(null, { status: 202 });
      if (calls.length === 3) {
        const result = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "[{\"id\":\"account-1\"}]" }] } };
        return new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(null, { status: 200 });
    };

    const client = new SnapTradeMcpClient("private-token");
    assert.deepEqual(await client.callTool("Connections_listBrokerageAuthorizations"), [{ id: "account-1" }]);
    await client.close();

    assert.equal(calls.length, 4);
    assert.equal(calls[0].headers.get("authorization"), "Bearer private-token");
    assert.equal(calls[0].headers.get("mcp-protocol-version"), null);
    assert.equal(calls[1].headers.get("mcp-session-id"), "session-1");
    assert.equal(calls[2].headers.get("mcp-protocol-version"), "2025-11-25");
    assert.deepEqual(calls[2].body, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "Connections_listBrokerageAuthorizations", arguments: {} } });
    assert.equal(calls[3].method, "DELETE");
  });
});
