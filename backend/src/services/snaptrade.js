import { Snaptrade, SnaptradeAuth } from 'snaptrade-typescript-sdk';

import { withRetry } from '../lib/retry.js';
import { sanitizeError } from '../lib/sanitize.js';

export class SnaptradeServiceError extends Error {
  constructor(operation, cause, secrets = []) {
    const safe = sanitizeError(cause, { secrets });
    super(
      `${operation} failed (${safe.status ?? safe.code ?? 'error'}): ${safe.message}`,
    );
    this.name = 'SnaptradeServiceError';
    this.operation = operation;
    this.status = safe.status;
    this.cause = cause;
  }
}

export function createSnaptradeService({ config, client }) {
  const secrets = [
    config.snaptrade.consumerKey,
    config.snaptrade.userSecret,
    config.snaptrade.clientId,
  ];
  const snaptrade =
    client ??
    new Snaptrade({
      auth:
        config.snaptrade.authMode === 'personal'
          ? SnaptradeAuth.personalApiKey({
              clientId: config.snaptrade.clientId,
              consumerKey: config.snaptrade.consumerKey,
            })
          : SnaptradeAuth.commercialApiKey({
              clientId: config.snaptrade.clientId,
              consumerKey: config.snaptrade.consumerKey,
            }),
      baseOptions: { timeout: config.snaptrade.timeoutMs },
    });

  const userCredentials =
    config.snaptrade.authMode === 'commercial'
      ? {
          userId: config.snaptrade.userId,
          userSecret: config.snaptrade.userSecret,
        }
      : {};

  async function call(operation, request) {
    try {
      return await withRetry(request, {
        retries: config.retry.attempts,
        baseMs: config.retry.baseMs,
      });
    } catch (error) {
      throw new SnaptradeServiceError(operation, error, secrets);
    }
  }

  return {
    authMode: config.snaptrade.authMode,

    async checkStatus() {
      const response = await call('apiStatus.check', () =>
        snaptrade.apiStatus.check(),
      );
      return response.data;
    },

    async listAccounts() {
      const response = await call('accountInformation.listUserAccounts', () =>
        snaptrade.accountInformation.listUserAccounts(userCredentials),
      );
      return response.data;
    },

    async listBrokerageAuthorizations() {
      const response = await call('connections.listBrokerageAuthorizations', () =>
        snaptrade.connections.listBrokerageAuthorizations(userCredentials),
      );
      return response.data;
    },

    async createConnectionPortal() {
      const response = await call('authentication.loginSnapTradeUser', () =>
        snaptrade.authentication.loginSnapTradeUser(userCredentials),
      );
      return response.data;
    },

    async getBalances(accountId) {
      const response = await call(
        'accountInformation.getUserAccountBalance',
        () =>
          snaptrade.accountInformation.getUserAccountBalance({
            accountId,
            ...userCredentials,
          }),
      );
      return response.data;
    },

    async getPositions(accountId) {
      const response = await call(
        'accountInformation.getAllAccountPositions',
        () =>
          snaptrade.accountInformation.getAllAccountPositions({
            accountId,
            ...userCredentials,
          }),
      );
      return response.data;
    },

    async getOrders(accountId, days) {
      const response = await call(
        'accountInformation.getUserAccountOrders',
        () =>
          snaptrade.accountInformation.getUserAccountOrders({
            accountId,
            state: 'all',
            days,
            ...userCredentials,
          }),
      );
      return response.data;
    },

    async getActivities(accountId, { startDate, endDate, limit = 1000 }) {
      let offset = 0;
      let combined = [];
      let firstPayload = null;
      do {
        const response = await call(
          'accountInformation.getAccountActivities',
          () => snaptrade.accountInformation.getAccountActivities({
            accountId,
            startDate,
            endDate,
            offset,
            limit,
            ...userCredentials,
          }),
        );
        const payload = response.data;
        firstPayload ??= payload;
        const page = Array.isArray(payload) ? payload : (payload.data ?? []);
        combined = combined.concat(page);
        const total = payload?.pagination?.total ?? combined.length;
        offset += page.length;
        if (page.length === 0 || offset >= total) break;
      } while (true);
      return Array.isArray(firstPayload)
        ? combined
        : { ...firstPayload, data: combined, pagination: { ...firstPayload.pagination, total: combined.length } };
    },
  };
}
