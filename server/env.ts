import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { OAuthConfig } from "./oauth";

/**
 * Backend configuration, read once at boot.
 *
 * `.env` is parsed here instead of through a dependency because the server deliberately has no
 * runtime dependencies: `npm run server` works on a clean checkout with Node and nothing else.
 * Existing process environment variables always win, so `PORT=9000 npm run server` still works.
 */

export type StoreKind = "memory" | "supabase";

/**
 * Abuse-prevention settings, read once at boot.
 *
 * The defaults are the safe ones: limits on, in-process store, fail closed on expensive work,
 * `x-forwarded-for` ignored, admin routes off.
 */
export type AbuseConfig = {
  enabled: boolean;
  /** `postgres` shares bucket state across instances; `memory` is honest for one process. */
  store: "memory" | "postgres";
  failMode: "closed" | "open";
  trustProxy: boolean;
  adminKey: string;
  moderationWebhook: string;
  logSalt: string;
};

export type AuthConfig = {
  /**
   * Absolute path for the accounts JSON file. Empty means "memory only", which is what the smoke
   * backend and the tests use: a packaged app directory is read-only.
   */
  file: string;
  /** When true, every API route except `/api/health` and `/api/auth/*` needs a session. */
  requireAuth: boolean;
  oauth: OAuthConfig;
};

export type Config = {
  host: string;
  port: number;
  store: StoreKind;
  supabaseUrl: string;
  supabaseKey: string;
  /**
   * Direct Postgres connection string for running migrations on boot.
   * This is separate from the service-role key: PostgreSQL requires its own database password.
   * Empty means migrations are managed outside this process.
   */
  supabaseDbUrl: string;
  /** When set, every non-health request must present this in `x-aegis-key`. */
  apiKey: string;
  /**
   * Where attachment bytes and their sidecars live. Kept out of the repository and out of the
   * database: a 100 MB file belongs on a disk, not in a `jsonb` column.
   */
  uploadDir: string;
  abuse: AbuseConfig;
  auth: AuthConfig;
};

export function loadDotEnv(path = join(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    if (!key || key in process.env) continue;

    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function text(key: string): string {
  return (process.env[key] ?? "").trim();
}

export function readConfig(): Config {
  const supabaseUrl = text("SUPABASE_URL").replace(/\/+$/, "");
  const supabaseKey = text("SUPABASE_SERVICE_ROLE_KEY") || text("SUPABASE_KEY");

  const supabaseDbUrl = text("SUPABASE_DB_URL");

  const explicit = text("AEGIS_STORE").toLowerCase();
  const store: StoreKind =
    explicit === "memory"
      ? "memory"
      : explicit === "supabase"
        ? "supabase"
        : supabaseUrl.length > 0 && supabaseKey.length > 0
          ? "supabase"
          : "memory";

  if (store === "supabase" && (supabaseUrl.length === 0 || supabaseKey.length === 0)) {
    throw new Error(
      "AEGIS_STORE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env",
    );
  }

  const host = text("HOST") || "127.0.0.1";
  const portRaw = Number.parseInt(text("PORT") || "8787", 10);
  const port = Number.isFinite(portRaw) && portRaw > 0 && portRaw < 65_536 ? portRaw : 8787;

  const failMode = text("AEGIS_RATE_LIMIT_FAIL_MODE").toLowerCase() === "open" ? "open" : "closed";

  /*
   * The redirect URI handed to each provider has to be byte-identical to the one registered in
   * their console, so it is derived once from the address this backend is actually reachable at.
   * `0.0.0.0` is a bind address, not a URL host, hence the substitution.
   */
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const publicUrl = (text("AEGIS_PUBLIC_URL") || `http://${publicHost}:${port}`).replace(/\/+$/, "");

  const authFileRaw = text("AEGIS_AUTH_FILE");
  const authFile =
    authFileRaw.toLowerCase() === "memory"
      ? ""
      : authFileRaw || join(process.cwd(), "data", "auth.json");
  const apiKey = text("AEGIS_API_KEY");
  const uploadDir = text("AEGIS_UPLOAD_DIR") || join(process.cwd(), "data", "uploads");
  const requireAuth = text("AEGIS_REQUIRE_AUTH") === "1";
  const production = text("NODE_ENV").toLowerCase() === "production";

  if (production) {
    const problems: string[] = [];

    if (!requireAuth) problems.push("set AEGIS_REQUIRE_AUTH=1");
    if (apiKey) {
      problems.push("unset AEGIS_API_KEY; desktop clients cannot keep a shared secret");
    }
    if (store !== "supabase") problems.push("configure Supabase; the in-memory store is not durable");
    if (!authFileRaw || !isAbsolute(authFile)) {
      problems.push("set AEGIS_AUTH_FILE to an absolute path on persistent storage");
    }
    if (!text("AEGIS_UPLOAD_DIR") || !isAbsolute(uploadDir)) {
      problems.push("set AEGIS_UPLOAD_DIR to an absolute path on persistent storage");
    }

    try {
      if (new URL(publicUrl).protocol !== "https:") {
        problems.push("set AEGIS_PUBLIC_URL to the public HTTPS backend URL");
      }
    } catch {
      problems.push("set AEGIS_PUBLIC_URL to the public HTTPS backend URL");
    }

    if (problems.length > 0) {
      throw new Error(`Unsafe production configuration: ${problems.join("; ")}.`);
    }
  }

  return {
    host,
    port,
    store,
    supabaseUrl,
    supabaseKey,
    supabaseDbUrl,
    apiKey,
    uploadDir,
    abuse: {
      // Opt-out rather than opt-in: a deployment that forgets to configure this is protected.
      enabled: text("AEGIS_RATE_LIMIT").toLowerCase() !== "off",
      store: text("AEGIS_RATE_LIMIT_STORE").toLowerCase() === "postgres" ? "postgres" : "memory",
      failMode,
      trustProxy: text("AEGIS_TRUST_PROXY") === "1",
      adminKey: text("AEGIS_ADMIN_KEY"),
      moderationWebhook: text("AEGIS_MODERATION_WEBHOOK"),
      logSalt: text("AEGIS_LOG_SALT"),
    },
    auth: {
      file: authFile,
      requireAuth,
      oauth: {
        publicUrl,
        discord: {
          clientId: text("AEGIS_DISCORD_CLIENT_ID"),
          clientSecret: text("AEGIS_DISCORD_CLIENT_SECRET"),
        },
        google: {
          clientId: text("AEGIS_GOOGLE_CLIENT_ID"),
          clientSecret: text("AEGIS_GOOGLE_CLIENT_SECRET"),
        },
      },
    },
  };
}
