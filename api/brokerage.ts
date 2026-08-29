import type { VercelRequest, VercelResponse } from "./_lib/vercel.js";
import { requireSameOrigin, withAccessToken } from "./_lib/oauth.js";
import { SnapTradeMcpClient } from "./_lib/mcp.js";
import {
  normalizeAccount,
  normalizeBalances,
  normalizeConnection,
  normalizeEvent,
  normalizePosition,
  payloadItems,
} from "./_lib/snaptrade.js";

interface Failure {
  accountId: string | null;
  endpoint: string;
  error: { code: string; message: string; retryable: boolean };
}

const safeFailure = (accountId: string | null, endpoint: string, error: unknown): Failure => ({
  accountId,
  endpoint,
  error: {
    code: (error as { status?: number }).status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
    message: `${endpoint} is unavailable`,
    retryable: ![400, 401, 403, 404].includes((error as { status?: number }).status ?? 0),
  },
});

const pathName = (request: VercelRequest): string => String(request.query.path ?? request.url?.split("/api/brokerage/")[1]?.split("?")[0] ?? "snapshot");

async function fetchSnapshot(accessToken: string) {
  const client = new SnapTradeMcpClient(accessToken);
  const errors: Failure[] = [];
  try {
    const rawConnections = payloadItems(await client.callTool("Connections_listBrokerageAuthorizations"));
    const connections = rawConnections.map(normalizeConnection).filter((connection) => connection.id);
    const accountResults = await Promise.allSettled(connections.map((connection) => client.callTool(
      "Connections_listBrokerageAuthorizationAccounts",
      { authorizationId: connection.id },
    )));
    const rawAccounts: unknown[] = [];
    accountResults.forEach((result, index) => {
      if (result.status === "fulfilled") rawAccounts.push(...payloadItems(result.value));
      else errors.push(safeFailure(null, `accounts:${connections[index].id}`, result.reason));
    });
    const accounts = [...new Map(rawAccounts.map(normalizeAccount).filter((account) => account.id).map((account) => [account.id, account])).values()];
    const positions: ReturnType<typeof normalizePosition>[] = [];
    const balances: ReturnType<typeof normalizeBalances> = [];
    const recentOrders: ReturnType<typeof normalizeEvent>[] = [];
    await Promise.all(accounts.map(async (account) => {
      const results = await Promise.allSettled([
        client.callTool("AccountInformation_getAllAccountPositions", { accountId: account.id }),
        client.callTool("AccountInformation_getUserAccountBalance", { accountId: account.id }),
        client.callTool("AccountInformation_getUserAccountRecentOrdersV2", { accountId: account.id }),
      ]);
      const endpoints = ["positions", "balances", "recentOrders"];
      results.forEach((result, index) => {
        if (result.status === "rejected") errors.push(safeFailure(account.id, endpoints[index], result.reason));
      });
      if (results[0].status === "fulfilled") positions.push(...payloadItems(results[0].value).map((value) => normalizePosition(account.id, value)));
      if (results[1].status === "fulfilled") balances.push(...normalizeBalances(account.id, results[1].value));
      if (results[2].status === "fulfilled") recentOrders.push(...payloadItems(results[2].value, "orders").map((value) => normalizeEvent(account.id, value, "order")));
    }));
    return {
      schemaVersion: 1 as const,
      fetchedAt: new Date().toISOString(),
      accounts,
      positions,
      balances,
      recentOrders,
      connections,
      errors,
    };
  } finally {
    await client.close();
  }
}

async function fetchHistoryPage(accessToken: string, accountId: string, offset: number) {
  const client = new SnapTradeMcpClient(accessToken);
  const limit = 1000;
  try {
    const payload = await client.callTool("AccountInformation_getAccountActivities", { accountId, offset, limit }) as any;
    const records = payloadItems(payload, "activities");
    const total = Number(payload?.pagination?.total ?? offset + records.length);
    return {
      events: records.map((value) => normalizeEvent(accountId, value, "activity")),
      nextCursor: records.length && offset + records.length < total ? `${accountId}:${offset + records.length}` : null,
    };
  } finally {
    await client.close();
  }
}

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  response.setHeader("Cache-Control", "private, no-store");
  const route = pathName(request);
  try {
    if ((route === "snapshot" && request.method === "GET") || (route === "refresh" && request.method === "POST")) {
      if (request.method === "POST" && !requireSameOrigin(request)) {
        response.status(403).json({ error: { code: "ORIGIN_REJECTED", message: "Request origin was rejected" } });
        return;
      }
      const snapshot = await withAccessToken(request, response, fetchSnapshot);
      response.status(snapshot.errors.length ? 207 : 200).json(snapshot);
      return;
    }
    if (route === "history" && request.method === "GET") {
      const cursor = typeof request.query.cursor === "string" ? request.query.cursor : "";
      let accountId = typeof request.query.accountId === "string" ? request.query.accountId : "";
      let offset = 0;
      if (cursor) {
        const separator = cursor.lastIndexOf(":");
        accountId = cursor.slice(0, separator);
        offset = Number(cursor.slice(separator + 1));
      }
      if (!accountId || !Number.isInteger(offset) || offset < 0) {
        response.status(400).json({ error: { code: "INVALID_HISTORY_CURSOR", message: "A valid accountId or cursor is required" } });
        return;
      }
      response.status(200).json(await withAccessToken(request, response, (accessToken) => fetchHistoryPage(accessToken, accountId, offset)));
      return;
    }
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  } catch (error) {
    const status = (error as { status?: number }).status === 401 ? 401 : 502;
    response.status(status).json({ error: { code: status === 401 ? "AUTH_REQUIRED" : "BROKERAGE_UNAVAILABLE", message: status === 401 ? "Connect SnapTrade to continue" : "Brokerage data is unavailable" } });
  }
}
