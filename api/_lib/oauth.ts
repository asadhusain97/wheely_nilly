import crypto from "node:crypto";
import type { VercelRequest, VercelResponse } from "./vercel.js";

const DISCOVERY_URL = "https://api.snaptrade.com/.well-known/oauth-authorization-server";
const SESSION_COOKIE = "wheely_session";
const LOGIN_COOKIE = "wheely_oauth_login";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  sub: unknown;
}

export interface LoginState {
  state: string;
  codeVerifier: string;
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

export const readSession = (request: VercelRequest): OAuthTokens | null => unseal<OAuthTokens>(cookieMap(request).get(SESSION_COOKIE));
export const readLogin = (request: VercelRequest): LoginState | null => unseal<LoginState>(cookieMap(request).get(LOGIN_COOKIE));

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
  if (!value.authorization_endpoint || !value.token_endpoint || !value.revocation_endpoint) throw new Error("SnapTrade OAuth discovery response is incomplete");
  metadataCache = { value, expiresAt: Date.now() + 60 * 60 * 1000 };
  return value;
};

export const oauthClient = (): { clientId: string; clientSecret: string } => ({
  clientId: requiredEnv("SNAPTRADE_OAUTH_CLIENT_ID"),
  clientSecret: requiredEnv("SNAPTRADE_OAUTH_CLIENT_SECRET"),
});

export const appOrigin = (): string => new URL(requiredEnv("APP_ORIGIN")).origin;
export const callbackUri = (): string => `${appOrigin()}/api/auth/callback`;

const parseTokens = (payload: Record<string, unknown>): OAuthTokens => {
  if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") throw new Error("SnapTrade token response is incomplete");
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 36_000) * 1000,
    scope: typeof payload.scope === "string" ? payload.scope : "read",
    sub: payload.sub ?? null,
  };
};

const tokenRequest = async (body: URLSearchParams): Promise<OAuthTokens> => {
  const metadata = await oauthMetadata();
  const { clientId, clientSecret } = oauthClient();
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`SnapTrade token request failed with ${response.status}`);
  return parseTokens(await response.json() as Record<string, unknown>);
};

export const exchangeCode = (code: string, codeVerifier: string): Promise<OAuthTokens> => tokenRequest(new URLSearchParams({
  grant_type: "authorization_code",
  code,
  code_verifier: codeVerifier,
  redirect_uri: callbackUri(),
}));

export const refreshTokens = (refreshToken: string): Promise<OAuthTokens> => tokenRequest(new URLSearchParams({
  grant_type: "refresh_token",
  refresh_token: refreshToken,
}));

export const revokeTokens = async (refreshToken: string): Promise<void> => {
  const metadata = await oauthMetadata();
  const { clientId, clientSecret } = oauthClient();
  await fetch(metadata.revocation_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" }),
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
    session = await refreshTokens(session.refreshToken);
    setSession(response, session);
  }
  try {
    return await operation(session.accessToken);
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error;
    const refreshed = await refreshTokens(session.refreshToken);
    setSession(response, refreshed);
    return operation(refreshed.accessToken);
  }
};

export const randomBase64Url = (bytes: number): string => crypto.randomBytes(bytes).toString("base64url");
export const pkceChallenge = (verifier: string): string => crypto.createHash("sha256").update(verifier).digest("base64url");
