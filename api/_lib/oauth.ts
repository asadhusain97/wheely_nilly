import crypto from "node:crypto";
import type { VercelRequest, VercelResponse } from "./vercel.js";

const DISCOVERY_URL = "https://api.snaptrade.com/.well-known/oauth-authorization-server/mcp";
export const MCP_RESOURCE = "https://mcp.snaptrade.com/mcp";
const SESSION_COOKIE = "wheely_session";
const LOGIN_COOKIE = "wheely_oauth_login";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  registration_endpoint: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  sub: unknown;
  clientId: string;
}

export interface LoginState {
  state: string;
  codeVerifier: string;
  clientId: string;
  createdAt: number;
  returnTo: string;
}

let metadataCache: { value: OAuthMetadata; expiresAt: number } | null = null;

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
};

const sealKey = (): Buffer => {
  const value = requiredEnv("SESSION_SEAL_KEY");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32) throw new Error("SESSION_SEAL_KEY must be 32 random bytes encoded as base64url");
  return decoded;
};

const cookieMap = (request: VercelRequest): Map<string, string> => new Map(
  String(request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }),
);

const serializeCookie = (name: string, value: string, maxAge: number): string => [
  `${name}=${encodeURIComponent(value)}`,
  "Path=/",
  "HttpOnly",
  ...(appOrigin().startsWith("https://") ? ["Secure"] : []),
  "SameSite=Lax",
  `Max-Age=${maxAge}`,
].join("; ");

export const appendCookie = (response: VercelResponse, cookie: string): void => {
  const existing = response.getHeader("Set-Cookie");
  const values = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  response.setHeader("Set-Cookie", [...values, cookie]);
};

export const clearCookie = (response: VercelResponse, name: string): void => {
  appendCookie(response, serializeCookie(name, "", 0));
};

export const seal = (value: unknown): string => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
};

export const unseal = <T>(value: string | undefined): T | null => {
  if (!value) return null;
  try {
    const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
    if (!iv || !tag || !encrypted) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", sealKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as T;
  } catch {
    return null;
  }
};

export const readSession = (request: VercelRequest): OAuthTokens | null => {
  const session = unseal<OAuthTokens>(cookieMap(request).get(SESSION_COOKIE));
  return session
    && typeof session.accessToken === "string"
    && typeof session.refreshToken === "string"
    && typeof session.clientId === "string"
    && Number.isFinite(session.expiresAt)
    ? session
    : null;
};

export const readLogin = (request: VercelRequest): LoginState | null => {
  const login = unseal<LoginState>(cookieMap(request).get(LOGIN_COOKIE));
  return login
    && typeof login.state === "string"
    && typeof login.codeVerifier === "string"
    && typeof login.clientId === "string"
    && Number.isFinite(login.createdAt)
    ? login
    : null;
};

export const setSession = (response: VercelResponse, tokens: OAuthTokens): void => {
  const value = seal(tokens);
  if (value.length > 3700) throw new Error("SnapTrade OAuth session is too large for stateless cookie storage");
  appendCookie(response, serializeCookie(SESSION_COOKIE, value, COOKIE_MAX_AGE));
};

export const setLogin = (response: VercelResponse, login: LoginState): void => {
  appendCookie(response, serializeCookie(LOGIN_COOKIE, seal(login), 10 * 60));
};

export const clearAuth = (response: VercelResponse): void => {
  clearCookie(response, LOGIN_COOKIE);
  clearCookie(response, SESSION_COOKIE);
};

export const oauthMetadata = async (): Promise<OAuthMetadata> => {
  if (metadataCache && metadataCache.expiresAt > Date.now()) return metadataCache.value;
  const response = await fetch(DISCOVERY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`SnapTrade OAuth discovery failed with ${response.status}`);
  const value = await response.json() as OAuthMetadata;
  if (!value.authorization_endpoint || !value.token_endpoint || !value.revocation_endpoint || !value.registration_endpoint) throw new Error("SnapTrade MCP OAuth discovery response is incomplete");
  metadataCache = { value, expiresAt: Date.now() + 60 * 60 * 1000 };
  return value;
};

export const appOrigin = (): string => new URL(requiredEnv("APP_ORIGIN")).origin;
export const callbackUri = (): string => `${appOrigin()}/api/auth/callback`;

export const registerOAuthClient = async (): Promise<string> => {
  const metadata = await oauthMetadata();
  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Wheely Nilly",
      client_uri: appOrigin(),
      redirect_uris: [callbackUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`SnapTrade MCP client registration failed with ${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  if (typeof payload.client_id !== "string" || !payload.client_id) throw new Error("SnapTrade MCP client registration response is incomplete");
  if (payload.token_endpoint_auth_method && payload.token_endpoint_auth_method !== "none") throw new Error("SnapTrade MCP did not register a public OAuth client");
  return payload.client_id;
};

const parseTokens = (payload: Record<string, unknown>, clientId: string, previousRefreshToken?: string): OAuthTokens => {
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : previousRefreshToken;
  if (typeof payload.access_token !== "string" || !refreshToken) throw new Error("SnapTrade token response is incomplete");
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    refreshToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 36_000) * 1000,
    scope: typeof payload.scope === "string" ? payload.scope : "read",
    sub: payload.sub ?? null,
    clientId,
  };
};

const tokenRequest = async (body: URLSearchParams, clientId: string, previousRefreshToken?: string): Promise<OAuthTokens> => {
  const metadata = await oauthMetadata();
  body.set("client_id", clientId);
  body.set("resource", MCP_RESOURCE);
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`SnapTrade token request failed with ${response.status}`);
  return parseTokens(await response.json() as Record<string, unknown>, clientId, previousRefreshToken);
};

export const exchangeCode = (code: string, codeVerifier: string, clientId: string): Promise<OAuthTokens> => tokenRequest(new URLSearchParams({
  grant_type: "authorization_code",
  code,
  code_verifier: codeVerifier,
  redirect_uri: callbackUri(),
}), clientId);

export const refreshTokens = (session: OAuthTokens): Promise<OAuthTokens> => tokenRequest(new URLSearchParams({
  grant_type: "refresh_token",
  refresh_token: session.refreshToken,
}), session.clientId, session.refreshToken);

export const revokeTokens = async (session: OAuthTokens): Promise<void> => {
  const metadata = await oauthMetadata();
  await fetch(metadata.revocation_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: session.refreshToken, token_type_hint: "refresh_token", client_id: session.clientId }),
    signal: AbortSignal.timeout(8_000),
  });
};

export const validReturnTo = (value: unknown): string => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/app";

export const requireSameOrigin = (request: VercelRequest): boolean => {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin === appOrigin();
};

export const withAccessToken = async <T>(
  request: VercelRequest,
  response: VercelResponse,
  operation: (accessToken: string) => Promise<T>,
): Promise<T> => {
  let session = readSession(request);
  if (!session) throw Object.assign(new Error("SnapTrade authorization required"), { status: 401, code: "AUTH_REQUIRED" });
  if (session.expiresAt - Date.now() < 5 * 60 * 1000) {
    session = await refreshTokens(session);
    setSession(response, session);
  }
  try {
    return await operation(session.accessToken);
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error;
    const refreshed = await refreshTokens(session);
    setSession(response, refreshed);
    return operation(refreshed.accessToken);
  }
};

export const randomBase64Url = (bytes: number): string => crypto.randomBytes(bytes).toString("base64url");
export const pkceChallenge = (verifier: string): string => crypto.createHash("sha256").update(verifier).digest("base64url");
