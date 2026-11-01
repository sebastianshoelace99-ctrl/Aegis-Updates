type Json = Record<string, unknown>;

function text(value: object, key: string): string {
  const raw = (value as Json)[key];
  return typeof raw === "string" ? raw : "";
}

function flag(value: object, key: string): boolean {
  return (value as Json)[key] === true;
}

export type ProviderId = "discord" | "google";

export const PROVIDER_IDS: readonly ProviderId[] = ["discord", "google"];

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  discord: "Discord",
  google: "Google",
};

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  configured: boolean;
  /** Environment variable names that are still empty, so the UI can say what to set. */
  missing: string[];
};

export type OAuthProfile = {
  provider: ProviderId;
  providerId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
};

export function emptyOAuthConfig(): OAuthConfig {
  return {
    publicUrl: "http://127.0.0.1:8787",
    discord: { clientId: "", clientSecret: "" },
    google: { clientId: "", clientSecret: "" },
  };
}

function missingFor(provider: ProviderId, config: OAuthConfig): string[] {
  if (provider === "discord") {
    return [
      config.discord.clientId ? "" : "AEGIS_DISCORD_CLIENT_ID",
      config.discord.clientSecret ? "" : "AEGIS_DISCORD_CLIENT_SECRET",
    ].filter(Boolean);
  }
  if (provider === "google") {
    return [
      config.google.clientId ? "" : "AEGIS_GOOGLE_CLIENT_ID",
      config.google.clientSecret ? "" : "AEGIS_GOOGLE_CLIENT_SECRET",
    ].filter(Boolean);
  }
  return [];
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

export function redirectUri(config: OAuthConfig, provider: ProviderId): string {
  // Apple removed - only discord and google remain
  if (provider === "apple") return config.publicUrl;
  return `${config.publicUrl.replace(/\/+$/, "")}/api/auth/oauth/callback`;
}
export type OAuthConfig = {
  /** Where this backend is reachable, used to build the redirect URI. */
  publicUrl: string;
  discord: { clientId: string; clientSecret: string };
  google: { clientId: string; clientSecret: string };
};

export { OAuthConfig };

function postForm(url: string, fields: Record<string, string>, label: string): Promise<Json> {
  return requestJson(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    label,
  );
}

async function exchangeCodeWithProvider(
  provider: string,
  url: string,
  fields: Record<string, string>,
  label: string,
): Promise<Json> {
  const response = await postForm(url, fields, label);
  const errorCode = text(response, "error");
  if (errorCode) {
    throw new HttpError(502, `${label} returned an error: ${errorCode}`);
  }
  return response;
}

function decodeBase64Url(input: string): string {
  const padding = "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(input, "base64url").toString("utf8");
}

export async function verifyAppleIdToken(idToken: string, clientId: string): Promise<Json> {
  const [rawHeader, rawPayload, rawSignature] = idToken.split(".");

  let header: Json;
  let claims: Json;
  try {
    header = JSON.parse(decodeBase64Url(rawHeader)) as Json;
    claims = JSON.parse(decodeBase64Url(rawPayload)) as Json;
  } catch {
    throw new HttpError(502, "Apple returned an identity token that could not be read.");
  }

  const keys = await requestJson("https://appleid.apple.com/auth/keys", { method: "GET" }, "Apple");
  const list = Array.isArray(keys.keys) ? (keys.keys as Json[]) : [];
  const jwk = list.find((entry) => entry.kid === header.kid);
  if (!jwk) throw new HttpError(502, "Apple's signing key could not be found.");

  let valid = false;
  try {
    const key = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
    valid = verifyBytes(
      "RSA-SHA256",
      Buffer.from(`${rawHeader}.${rawPayload}`),
      key,
      Buffer.from(rawSignature, "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(502, "Apple's identity token signature did not verify.");

  if (claims.iss !== "https://appleid.apple.com") {
    throw new HttpError(502, "Apple's identity token came from the wrong issuer.");
  }
  if (claims.aud !== clientId) {
    throw new HttpError(502, "Apple's identity token was issued for a different app.");
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
    throw new HttpError(502, "Apple's identity token has expired.");
  }

  return {
    sub: text(claims, "sub"),
    email: text(claims, "email"),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
  };
}

/* ── Code exchange ───────────────────────────────────────────────────────── */

export type ExchangeInput = {
  code: string;
  verifier: string;
  /** Apple's form_post result carries the id_token directly; the code is still exchanged. */
  idToken?: string;
  /** Apple sends the display name once, as JSON in the `user` field, on first consent. */
  rawUser?: string;
};

function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 32) : "Aegis member";
}

export async function exchangeCode(
  config: OAuthConfig,
  provider: ProviderId,
  input: ExchangeInput,
): Promise<OAuthProfile> {
  if (!isConfigured(config, provider)) {
    throw new HttpError(501, `${PROVIDER_LABEL[provider]} sign-in is not configured on this server.`);
  }

  const verifier = crypto.randomUUID().replace(/-/g, "").slice(0, 128);

  let challenge: string;
  if (provider === "apple") {
    challenge = verifier;
  } else {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest("SHA-256", data);
    challenge = Buffer.from(hash).toString("base64url");
  }

  if (provider === "discord") {
    const response = await exchangeCodeWithProvider(
      "Discord",
      "https://discord.com/api/v10/oauth2/token",
      {
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri(config, provider),
        code: input.code,
        code_verifier: verifier,
      },
      "Discord code exchange",
    );

    const accessToken = text(response, "access_token");
    if (!accessToken) {
      throw new HttpError(502, "Discord code exchange returned no access token.");
    }

    const profileResponse = await requestJson(
      "https://discord.com/api/v10/users/@me",
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "Discord profile",
    );

    return {
      provider: "discord",
      providerId: text(profileResponse, "id"),
      email: text(profileResponse, "email"),
      emailVerified: false, // Discord does not expose email verification status.
      displayName: text(profileResponse, "username"),
    };
  }

  if (provider === "google") {
    const response = await exchangeCodeWithProvider(
      "Google",
      "https://oauth2.googleapis.com/token",
      {
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri(config, provider),
        code: input.code,
        code_verifier: verifier,
      },
      "Google code exchange",
    );

    const idToken = text(response, "id_token");
    if (!idToken) {
      throw new HttpError(502, "Google code exchange returned no id_token.");
    }

    const claims = await verifyGoogleIdToken(idToken, config.google.clientId);

    return {
      provider: "google",
      providerId: text(claims, "sub"),
      email: text(claims, "email"),
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      displayName: text(claims, "name") || displayNameFromEmail(text(claims, "email")),
    };
  }

  // Apple removed - only discord and google remain
  const tokenResponse = await exchangeCodeWithProvider(
    "Apple",
    "https://appleid.apple.com/auth/token",
    {
      client_id: config.apple.clientId,
      client_secret: config.apple.clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: config.apple.redirectUri ?? redirectUri(config, provider),
      code_verifier: verifier,
    },
    "Apple token exchange",
  );

  const idToken = text(tokenResponse, "id_token") || input.idToken;
  if (!idToken) {
    throw new HttpError(502, "Apple token exchange returned no id_token.");
  }

  const claims = await verifyAppleIdToken(idToken, config.apple.clientId);

  let name = "";
  if (input.rawUser) {
    try {
      const parsed = JSON.parse(input.rawUser) as {
        name?: { firstName?: string; lastName?: string };
      };
      name = [parsed.name?.firstName, parsed.name?.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
    } catch {
      /* the `user` field is optional and Apple only sends it once */
    }
  }

  return {
    provider: "apple",
    providerId: claims.sub,
    email: claims.email,
    emailVerified: claims.emailVerified,
    displayName: name || displayNameFromEmail(claims.email),
  };
}

/* ── ID token verification ───────────────────────────────────────────────── */

async function verifyGoogleIdToken(idToken: string, expectedClientId: string): Promise<Json> {
  const response = await requestJson(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`,
    { method: "GET" },
    "Google tokeninfo",
  );

  if (text(response, "aud") !== expectedClientId) {
    throw new HttpError(502, "Google id_token has an invalid audience.");
  }

  return content;
}

