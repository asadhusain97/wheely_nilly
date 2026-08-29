import type { VercelRequest, VercelResponse } from "./_lib/vercel.js";
import { requireSameOrigin, withAccessToken } from "./_lib/oauth.js";
import { SnapTradeMcpClient } from "./_lib/mcp.js";
import {
  normalizeAccount,
  normalizeBalances,
  normalizeConnection,
  normalizeEvent,
  normalizePosition,
  payloadPagination,
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

const callTool = async (client: SnapTradeMcpClient, name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  try {
    return await client.callTool(name, args);
  } catch (error) {
    Object.assign(error as object, { tool: name });
    throw error;
  }
};

const payloadShape = (payload: unknown): string => Array.isArray(payload)
  ? "array"
  : payload && typeof payload === "object"
    ? `object:${Object.keys(payload as Record<string, unknown>).sort().join(",")}`
    : typeof payload;

async function fetchAccountCatalog(client: SnapTradeMcpClient, errors: Failure[]) {
  const connectionPayload = await callTool(client, "Connections_listBrokerageAuthorizations");
  const rawConnections = payloadItems(connectionPayload);
  if (!rawConnections.length) console.info(JSON.stringify({ event: "snaptrade_mcp_empty_connections", shape: payloadShape(connectionPayload) }));
  const connections = rawConnections.map(normalizeConnection).filter((connection) => connection.id);
  const accountResults = await Promise.allSettled(connections.map((connection) => callTool(client,
    "Connections_listBrokerageAuthorizationAccounts",
    { authorizationId: connection.id },
  )));
  const rawAccounts: unknown[] = [];
  accountResults.forEach((result, index) => {
    if (result.status === "fulfilled") rawAccounts.push(...payloadItems(result.value));
    else errors.push(safeFailure(null, `accounts:${connections[index].id}`, result.reason));
  });
  const firstFailure = accountResults.find((result) => result.status === "rejected");
  if (accountResults.length && accountResults.every((result) => result.status === "rejected") && firstFailure?.status === "rejected") {
    throw firstFailure.reason;
  }
  const accounts = [...new Map(rawAccounts.map(normalizeAccount).filter((account) => account.id).map((account) => [account.id, account])).values()];
  return { accounts, connections };
}

async function fetchAccounts(accessToken: string) {
  const client = new SnapTradeMcpClient(accessToken);
  const errors: Failure[] = [];
  try {
    const catalog = await fetchAccountCatalog(client, errors);
    return { fetchedAt: new Date().toISOString(), ...catalog, errors };
  } finally {
    await client.close();
  }
}

async function fetchSnapshot(accessToken: string, selectedAccountIds: string[]) {
  const client = new SnapTradeMcpClient(accessToken);
  const errors: Failure[] = [];
  try {
    const catalog = await fetchAccountCatalog(client, errors);
    const selected = new Set(selectedAccountIds);
    const accounts = catalog.accounts.filter((account) => selected.has(account.id));
    if (!accounts.length) throw Object.assign(new Error("Selected brokerage account is unavailable"), { status: 409, code: "ACCOUNT_SELECTION_REQUIRED" });
    const positions: ReturnType<typeof normalizePosition>[] = [];
    const balances: ReturnType<typeof normalizeBalances> = [];
    const recentOrders: ReturnType<typeof normalizeEvent>[] = [];
    const positionResults: PromiseSettledResult<unknown>[] = [];
    await Promise.all(accounts.map(async (account) => {
      const results = await Promise.allSettled([
        callTool(client, "AccountInformation_getAllAccountPositions", { accountId: account.id }),
        callTool(client, "AccountInformation_getUserAccountBalance", { accountId: account.id }),
        callTool(client, "AccountInformation_getUserAccountRecentOrdersV2", { accountId: account.id }),
      ]);
      positionResults.push(results[0]);
      const endpoints = ["positions", "balances", "recentOrders"];
      results.forEach((result, index) => {
        if (result.status === "rejected") errors.push(safeFailure(account.id, endpoints[index], result.reason));
      });
      if (results[0].status === "fulfilled") positions.push(...payloadItems(results[0].value).map((value) => normalizePosition(account.id, value)));
      if (results[1].status === "fulfilled") balances.push(...normalizeBalances(account.id, results[1].value));
      if (results[2].status === "fulfilled") recentOrders.push(...payloadItems(results[2].value, "orders").map((value) => normalizeEvent(account.id, value, "order")));
    }));
    const firstPositionFailure = positionResults.find((result) => result.status === "rejected");
    if (positionResults.every((result) => result.status === "rejected") && firstPositionFailure?.status === "rejected") {
      throw firstPositionFailure.reason;
    }
    return {
      schemaVersion: 1 as const,
      fetchedAt: new Date().toISOString(),
      accounts,
      positions,
      balances,
      recentOrders,
      connections: catalog.connections,
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
    const payload = await callTool(client, "AccountInformation_getAccountActivities", { accountId, offset, limit }) as any;
    const records = payloadItems(payload, "activities");
    const pagination = payloadPagination(payload);
    const returnedOffset = Number(pagination?.offset);
    const pageOffset = Number.isInteger(returnedOffset) && returnedOffset >= 0 ? returnedOffset : offset;
    const nextOffset = pageOffset + records.length;
    const total = Number(pagination?.total);
    const hasMore = records.length > 0 && (Number.isFinite(total) ? nextOffset < total : records.length === limit);
    return {
      events: records.map((value) => normalizeEvent(accountId, value, "activity")),
      nextCursor: hasMore ? `${accountId}:${nextOffset}` : null,
    };
  } finally {
    await client.close();
  }
}

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  response.setHeader("Cache-Control", "private, no-store");
  const route = pathName(request);
  try {
    if (route === "accounts" && request.method === "GET") {
      response.status(200).json(await withAccessToken(request, response, fetchAccounts));
      return;
    }
    if (route === "refresh" && request.method === "POST") {
      if (!requireSameOrigin(request)) {
        response.status(403).json({ error: { code: "ORIGIN_REJECTED", message: "Request origin was rejected" } });
        return;
      }
      const body = request.body && typeof request.body === "object" ? request.body as { accountIds?: unknown } : {};
      const accountIds = Array.isArray(body.accountIds)
        ? [...new Set(body.accountIds.filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value)))].slice(0, 20)
        : [];
      if (!accountIds.length) {
        response.status(409).json({ error: { code: "ACCOUNT_SELECTION_REQUIRED", message: "Choose a brokerage account before syncing" } });
        return;
      }
      const snapshot = await withAccessToken(request, response, (accessToken) => fetchSnapshot(accessToken, accountIds));
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
    const upstreamStatus = (error as { status?: number }).status;
    const status = upstreamStatus === 401 ? 401 : upstreamStatus === 409 ? 409 : 502;
    console.error(JSON.stringify({ event: "brokerage_request_failed", route, tool: (error as { tool?: string }).tool ?? null, kind: error instanceof Error ? error.name : typeof error, upstreamStatus: upstreamStatus ?? null }));
    const code = status === 401 ? "AUTH_REQUIRED" : status === 409 ? "ACCOUNT_SELECTION_REQUIRED" : "BROKERAGE_UNAVAILABLE";
    const message = status === 401 ? "Connect SnapTrade to continue" : status === 409 ? "Choose an available brokerage account" : "SnapTrade is connected, but brokerage data could not be aligned";
    response.status(status).json({ error: { code, message } });
  }
}
