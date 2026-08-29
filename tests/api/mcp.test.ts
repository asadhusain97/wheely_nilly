import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { extractToolPayload, SnapTradeMcpClient } from "../../api/_lib/mcp";
import { normalizeAccount, normalizeEvent, normalizePosition, payloadItems } from "../../api/_lib/snaptrade";

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

  it("keeps masked account references so same-name accounts are distinguishable", () => {
    assert.deepEqual(normalizeAccount({
      id: "917c8734-8470-4a3e-a18f-57c3f2ee6631",
      display_name: "Robinhood Individual",
      institution_name: "Robinhood",
      number: "****8443",
    }), {
      id: "917c8734-8470-4a3e-a18f-57c3f2ee6631",
      institution: "Robinhood",
      name: "Robinhood Individual",
      numberSuffix: "8443",
      referenceLabel: "Account •••• 8443",
      syncStatus: null,
    });
  });

  it("labels a safe fallback when a brokerage account number is withheld", () => {
    const institutionReference = normalizeAccount({
      id: "917c8734-8470-4a3e-a18f-57c3f2ee6631",
      name: "Robinhood Individual",
      institution_name: "Robinhood",
      number: null,
      institution_account_id: "54953432",
    });
    const snapTradeReference = normalizeAccount({
      id: "917c8734-8470-4a3e-a18f-57c3f2ee6631",
      name: "Robinhood Individual",
      institution_name: "Robinhood",
      number: null,
      institution_account_id: null,
    });

    assert.equal(institutionReference.referenceLabel, "Institution ID •••• 3432");
    assert.equal(snapTradeReference.referenceLabel, "SnapTrade ID …6631");
  });

  it("normalizes unified option positions and matching historical activity", () => {
    const instrument = {
      kind: "option",
      id: "option-1",
      symbol: "RKLB  260918C00070000",
      option_type: "CALL",
      strike_price: "70",
      expiration_date: "2026-09-18",
      multiplier: "100",
      underlying: { kind: "stock", symbol: "RKLB" },
    };
    const position = normalizePosition("account-1", { instrument, units: "-1", price: "1.25", cost_basis: "0.9", currency: "USD" });
    const activity = normalizeEvent("account-1", {
      id: "activity-1",
      option_symbol: { ticker: instrument.symbol, option_type: "CALL", strike_price: 70, expiration_date: "2026-09-18", underlying_symbol: { symbol: "RKLB" } },
      option_type: "SELL_TO_OPEN",
      trade_date: "2026-08-20T15:30:00Z",
      units: 1,
      amount: 90,
      fee: 0.03,
    }, "activity");

    assert.equal(position.quantity, -1);
    assert.equal(position.currency, "USD");
    assert.deepEqual(position.option, {
      symbol: "RKLB260918C00070000",
      underlying: "RKLB",
      expiration: "2026-09-18",
      optionType: "call",
      strike: 70,
      multiplier: 100,
    });
    assert.equal(activity.action, "sell_to_open");
    assert.equal(activity.option?.symbol, position.option?.symbol);
    assert.equal(activity.amountMinor, 9000);
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
