import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { extractToolPayload, McpHttpError, SnapTradeMcpClient } from "../../api/_lib/mcp";
import { normalizeAccount, normalizeEvent, normalizePosition, payloadItems, payloadPagination, payloadRecord } from "../../api/_lib/snaptrade";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SnapTrade MCP client", () => {
  it("fails within the request budget instead of waiting for the platform to kill the function", async () => {
    const client = new SnapTradeMcpClient("private-token", 0);
    await assert.rejects(client.listTools(), (error: unknown) => {
      assert.ok(error instanceof McpHttpError);
      assert.equal(error.status, 504);
      return true;
    });
  });

  it("retries one transient read failure within the request budget", async () => {
    let calls = 0;
    globalThis.fetch = async (_input, init = {}) => {
      calls += 1;
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      if (calls === 1) return new Response(null, { status: 503, headers: { "retry-after": "0" } });
      if (body?.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25" } }, { headers: { "mcp-session-id": "session-1" } });
      }
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "[]" }] } });
    };

    const client = new SnapTradeMcpClient("private-token");
    assert.deepEqual(await client.callTool("Connections_listBrokerageAuthorizations"), []);
    assert.equal(calls, 4);
  });

  it("unwraps the response containers used by MCP and SnapTrade", () => {
    const accounts = [{ id: "account-1" }];
    assert.deepEqual(payloadItems({ result: accounts }), accounts);
    assert.deepEqual(payloadItems({ result: { data: { accounts } } }), accounts);
    assert.deepEqual(payloadItems({ data: { results: accounts } }), accounts);
  });

  it("finds pagination beside deeply nested activity data", () => {
    const pagination = { offset: 0, limit: 1000, total: 1254 };
    const payload = { result: { data: { data: [{ id: "activity-1" }], pagination } } };
    assert.deepEqual(payloadItems(payload, "activities"), [{ id: "activity-1" }]);
    assert.deepEqual(payloadPagination(payload), pagination);
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
      referenceLabel: "Account number •••• 8443",
      syncStatus: null,
      transactionSyncComplete: null,
    });
  });

  it("unwraps account details and accepts connector-style camel case fields", () => {
    const detail = payloadRecord({ structuredContent: { result: { account: {
      id: "account-1",
      displayName: "Robinhood Individual",
      institutionName: "Robinhood",
      accountNumber: "****2087",
    } } } });

    assert.equal(normalizeAccount(detail).referenceLabel, "Account number •••• 2087");
  });

  it("finds account details inside arbitrary MCP wrappers and JSON text", () => {
    const detail = payloadRecord({ output: { content: [{ type: "text", text: JSON.stringify({ account_detail: {
      id: "account-1",
      name: "Robinhood Individual",
      institution_name: "Robinhood",
      number: "****7291",
    } }) }] } });

    assert.equal(normalizeAccount(detail).referenceLabel, "Account number •••• 7291");
  });

  it("skips empty wrapper numbers when a nested account has a usable number", () => {
    const detail = payloadRecord({
      id: "tool-result-1",
      name: "Account result",
      number: null,
      result: { account: {
        id: "account-1",
        name: "Robinhood Individual",
        number: "****6184",
      } },
    });

    assert.equal(normalizeAccount(detail).referenceLabel, "Account number •••• 6184");
  });

  it("prefers a nested account number over an MCP wrapper identifier", () => {
    const detail = payloadRecord({
      id: "tool-result-1",
      structuredContent: [{ result: { account: {
        id: "account-1",
        name: "Robinhood Individual",
        number: "****3914",
      } } }],
    });

    assert.equal(normalizeAccount(detail).id, "account-1");
    assert.equal(normalizeAccount(detail).referenceLabel, "Account number •••• 3914");
  });

  it("labels institution identifiers honestly when the brokerage number is missing", () => {
    const account = normalizeAccount({
      id: "917c8734-8470-4a3e-a18f-57c3f2ee6631",
      name: "Robinhood Individual",
      institution_name: "Robinhood",
      number: null,
      institution_account_id: "54953432",
    });

    assert.equal(account.numberSuffix, null);
    assert.equal(account.referenceLabel, "Institution ID •••• 3432");
  });

  it("keeps accounts distinguishable when SnapTrade omits every institution identifier", () => {
    const account = normalizeAccount({
      id: "917c8734-8470-4a3e-a18f-57c3f2ee6631",
      name: "Robinhood Individual",
      institution_name: "Robinhood",
      number: null,
    });

    assert.equal(account.numberSuffix, null);
    assert.equal(account.referenceLabel, "Connected account •••• 6631");
  });

  it("carries the brokerage transaction-sync state into the selected account", () => {
    const account = normalizeAccount({
      id: "account-1",
      number: "Q6542138443",
      sync_status: { transactions: { initial_sync_completed: false } },
    });

    assert.equal(account.numberSuffix, "8443");
    assert.equal(account.transactionSyncComplete, false);
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
    assert.equal(position.instrumentType, "Option");
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

  it("preserves the underlying instrument class used by goal defaults", () => {
    const position = normalizePosition("account-1", {
      instrument: { id: "fund-1", symbol: "VOO", description: "Vanguard S&P 500 ETF", type: { description: "ETF" } },
      units: "100",
      price: "500",
      cost_basis: "450",
      currency: "USD",
    });

    assert.equal(position.name, "Vanguard S&P 500 ETF");
    assert.equal(position.instrumentType, "ETF");
  });

  it("uses SnapTrade cash-flow and unit direction for uncategorized option activity", () => {
    const optionSymbol = {
      ticker: "RKLB  260918P00075000",
      option_type: "PUT",
      strike_price: 75,
      expiration_date: "2026-09-18",
      underlying_symbol: { symbol: "RKLB" },
    };
    const open = normalizeEvent("account-1", {
      id: "open",
      type: "OPTIONTRADE",
      option_symbol: optionSymbol,
      units: -1,
      amount: 250,
    }, "activity");
    const close = normalizeEvent("account-1", {
      id: "close",
      type: "OPTIONTRADE",
      option_symbol: optionSymbol,
      units: 1,
      amount: -75,
    }, "activity");

    assert.equal(open.action, "sell_to_open");
    assert.equal(close.action, "buy_to_close");
  });

  it("prefers structured tool results", () => {
    assert.deepEqual(extractToolPayload({ structuredContent: { results: [{ id: "account-1" }] } }), { results: [{ id: "account-1" }] });
  });

  it("parses JSON returned as string structured content", () => {
    const payload = extractToolPayload({ structuredContent: "{\"account\":{\"id\":\"account-1\"}}" });
    assert.deepEqual(payload, { account: { id: "account-1" } });
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
