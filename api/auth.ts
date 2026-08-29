import type { VercelRequest, VercelResponse } from "./_lib/vercel.js";
import {
  appOrigin,
  callbackUri,
  clearAuth,
  clearCookie,
  exchangeCode,
  MCP_RESOURCE,
  oauthMetadata,
  pkceChallenge,
  randomBase64Url,
  readLogin,
  readSession,
  registerOAuthClient,
  requireSameOrigin,
  revokeTokens,
  setLogin,
  setSession,
  validReturnTo,
} from "./_lib/oauth.js";

const sendError = (response: VercelResponse, status: number, code: string, message: string): void => {
  response.status(status).json({ error: { code, message } });
};

const routeName = (request: VercelRequest): string => String(request.query.path ?? request.url?.split("/api/auth/")[1]?.split("?")[0] ?? "session");

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  response.setHeader("Cache-Control", "private, no-store");
  const route = routeName(request);
  try {
    if (route === "start" && request.method === "GET") {
      const metadata = await oauthMetadata();
      const clientId = await registerOAuthClient();
      const state = randomBase64Url(32);
      const codeVerifier = randomBase64Url(64);
      setLogin(response, { state, codeVerifier, clientId, createdAt: Date.now(), returnTo: validReturnTo(request.query.returnTo) });
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: callbackUri(),
        scope: "read",
        state,
        code_challenge: pkceChallenge(codeVerifier),
        code_challenge_method: "S256",
        resource: MCP_RESOURCE,
      }).toString();
      response.redirect(302, url.toString());
      return;
    }

    if (route === "callback" && request.method === "GET") {
      const login = readLogin(request);
      clearCookie(response, "wheely_oauth_login");
      if (!login || Date.now() - login.createdAt > 10 * 60 * 1000 || typeof request.query.state !== "string" || request.query.state !== login.state) {
        response.redirect(302, `${appOrigin()}/?oauth=invalid_state`);
        return;
      }
      if (typeof request.query.error === "string") {
        response.redirect(302, `${appOrigin()}/?oauth=${encodeURIComponent(request.query.error)}`);
        return;
      }
      if (typeof request.query.code !== "string") {
        response.redirect(302, `${appOrigin()}/?oauth=missing_code`);
        return;
      }
      setSession(response, await exchangeCode(request.query.code, login.codeVerifier, login.clientId));
      response.redirect(302, `${appOrigin()}${login.returnTo}${login.returnTo.includes("?") ? "&" : "?"}connected=1`);
      return;
    }

    if (route === "session" && request.method === "GET") {
      const session = readSession(request);
      response.status(200).json({ connected: Boolean(session), scope: session?.scope ?? null, expiresAt: session ? new Date(session.expiresAt).toISOString() : null });
      return;
    }

    if (route === "disconnect" && request.method === "POST") {
      if (!requireSameOrigin(request)) {
        sendError(response, 403, "ORIGIN_REJECTED", "Request origin was rejected");
        return;
      }
      const session = readSession(request);
      if (session) await revokeTokens(session).catch(() => undefined);
      clearAuth(response);
      response.status(204).end();
      return;
    }

    sendError(response, 404, "NOT_FOUND", "Route not found");
  } catch (error) {
    sendError(response, 503, "AUTH_UNAVAILABLE", "SnapTrade authorization is unavailable");
  }
}
