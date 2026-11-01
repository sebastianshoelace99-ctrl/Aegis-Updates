import { HttpError } from "./errors";

type Json = Record<string, unknown>;

const TIMEOUT_MS = 10_000;

async function requestJson(url: string, init: RequestInit, label: string): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new HttpError(502, `${label} could not be reached. Check this machine's connection.`);
  }
  if (!response.ok) throw new HttpError(502, `${label} refused the sign-in request (${response.status}).`);

  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid JSON object");
    return body as Json;
  } catch {
    throw new HttpError(502, `${label} answered with something that was not JSON.`);
  }
}

function text(value: object, key: string): string {
  const raw = (value as Json)[key];
  return typeof raw === "string" ? raw : "";
}

export type ProviderId = "discord" | "google";
export const PROVIDER_IDS: readonly ProviderId[] = ["discord", "google"];
export const PROVIDER_LABEL: Record<ProviderId, string> = { discord: "Discord", google: "Google" };

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  configured: boolean;
  missing: string[];
};

export type OAuthProfile = {
  provider: ProviderId;
  providerId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
};

export type OAuthConfig = {
  publicUrl: string;
  discord: { clientId: string; clientSecret: string };
  google: { clientId: string; clientSecret: string };
};

export function emptyOAuthConfig(): OAuthConfig {
  return {
    publicUrl: "http://127.0.0.1:8787",
    discord: { clientId: "", clientSecret: "" },
    google: { clientId: "", clientSecret: "" },
  };
}

function missingFor(provider: ProviderId, config: OAuthConfig): string[] {
  const credentials = provider === "discord" ? config.discord : config.google;
  const prefix = provider === "discord" ? "AEGIS_DISCORD" : "AEGIS_GOOGLE";
  return [
    credentials.clientId ? "" : `${prefix}_CLIENT_ID`,
    credentials.clientSecret ? "" : `${prefix}_CLIENT_SECRET`,
  ].filter(Boolean);
}

export function providerInfos(config: OAuthConfig): ProviderInfo[] {
  return PROVIDER_IDS.map((id) => {
    const missing = missingFor(id, config);
    return { id, label: PROVIDER_LABEL[id], configured: missing.length === 0, missing };
  });
}

export function isConfigured(config: OAuthConfig, provider: ProviderId): boolean {
  return missingFor(provider, config).length === 0;
}

export function redirectUri(config: OAuthConfig, _provider: ProviderId): string {
  return `${config.publicUrl.replace(/\/+$/, "")}/api/auth/oauth/callback`;
}

export function authorizeUrl(
  config: OAuthConfig,
  provider: ProviderId,
  state: string,
  challenge: string,
): string {
  const url = new URL(
    provider === "discord"
      ? "https://discord.com/oauth2/authorize"
      : "https://accounts.google.com/o/oauth2/v2/auth",
  );
  const clientId = provider === "discord" ? config.discord.clientId : config.google.clientId;
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(config, provider),
    response_type: "code",
    scope: provider === "discord" ? "identify email" : "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 32) : "Aegis member";
}

export type ExchangeInput = { code: string; verifier: string };

async function exchangeCodeWithProvider(
  url: string,
  fields: Record<string, string>,
  label: string,
): Promise<Json> {
  const response = await requestJson(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    label,
  );
  const errorCode = text(response, "error");
  if (errorCode) throw new HttpError(502, `${label} returned an error: ${errorCode}`);
  return response;
}

async function verifyGoogleIdToken(idToken: string, expectedClientId: string): Promise<Json> {
  const query = new URLSearchParams({ id_token: idToken });
  const claims = await requestJson(
    `https://oauth2.googleapis.com/tokeninfo?${query}`,
    { method: "GET" },
    "Google token verification",
  );
  const issuer = text(claims, "iss");
  if (text(claims, "aud") !== expectedClientId) {
    throw new HttpError(502, "Google identity token has an invalid audience.");
  }
  if (issuer !== "accounts.google.com" && issuer !== "https://accounts.google.com") {
    throw new HttpError(502, "Google identity token came from the wrong issuer.");
  }
  const expiry = Number(claims.exp);
  if (!Number.isFinite(expiry) || expiry * 1000 <= Date.now()) {
    throw new HttpError(502, "Google identity token has expired or is invalid.");
  }
  if (!text(claims, "sub")) throw new HttpError(502, "Google identity token has no subject.");
  return claims;
}

export async function exchangeCode(
  config: OAuthConfig,
  provider: ProviderId,
  input: ExchangeInput,
): Promise<OAuthProfile> {
  if (!isConfigured(config, provider)) {
    throw new HttpError(501, `${PROVIDER_LABEL[provider]} sign-in is not configured on this server.`);
  }
  if (!input.code || !input.verifier) throw new HttpError(400, "The sign-in response is incomplete.");

  if (provider === "discord") {
    const response = await exchangeCodeWithProvider(
      "https://discord.com/api/v10/oauth2/token",
      {
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri(config, provider),
        code: input.code,
        code_verifier: input.verifier,
      },
      "Discord code exchange",
    );
    const accessToken = text(response, "access_token");
    if (!accessToken) throw new HttpError(502, "Discord code exchange returned no access token.");
    const profile = await requestJson(
      "https://discord.com/api/v10/users/@me",
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "Discord profile",
    );
    const providerId = text(profile, "id");
    if (!providerId) throw new HttpError(502, "Discord profile returned no user ID.");
    return {
      provider: "discord",
      providerId,
      email: text(profile, "email"),
      emailVerified: false,
      displayName: text(profile, "username") || "Discord member",
    };
  }

  const response = await exchangeCodeWithProvider(
    "https://oauth2.googleapis.com/token",
    {
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(config, provider),
      code: input.code,
      code_verifier: input.verifier,
    },
    "Google code exchange",
  );
  const idToken = text(response, "id_token");
  if (!idToken) throw new HttpError(502, "Google code exchange returned no identity token.");
  const claims = await verifyGoogleIdToken(idToken, config.google.clientId);
  const email = text(claims, "email");
  return {
    provider: "google",
    providerId: text(claims, "sub"),
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    displayName: text(claims, "name") || displayNameFromEmail(email),
  };
}
