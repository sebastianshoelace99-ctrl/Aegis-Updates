import { createServer } from "node:http";
import {
  createModerationQueue,
  createWebhookModerationSink,
  createAbuseDetector,
  type ModerationSink,
} from "./abuse";
import { createRequestHandler } from "./app";
import { createAuthStore } from "./auth";
import { EventBus } from "./bus";
import { loadDotEnv, readConfig, type Config } from "./env";
import { createRequestGuard } from "./guard";
import {
  createMemoryRateLimitStore,
  createPostgresRateLimitStore,
  type RateLimitStore,
} from "./rateLimit";
import { runMigrations } from "./migrate";
import { createSecurityLog } from "./securityLog";
import { createMemoryStore } from "./store";
import { createSupabaseStore } from "./supabaseStore";
import { createUploadStore } from "./uploads";

/** `npm run server`: one process, one port, no framework. */
loadDotEnv();

let config: Config;
try {
  config = readConfig();
} catch (error) {
  console.error(`[aegis] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/**
 * The shared bucket store, or the in-process one.
 *
 * Falling back rather than exiting is deliberate: a single instance with local buckets still
 * enforces every limit, it just does so per instance. Refusing to boot over a misconfiguration
 * would trade a weaker limit for no service at all.
 */
function buildLimitStore(): RateLimitStore {
  if (config.abuse.store !== "postgres") return createMemoryRateLimitStore();

  if (config.supabaseUrl.length === 0 || config.supabaseKey.length === 0) {
    console.warn(
      "[aegis] AEGIS_RATE_LIMIT_STORE=postgres needs SUPABASE_URL and a service-role key; " +
        "using the in-process store instead.",
    );
    return createMemoryRateLimitStore();
  }

  return createPostgresRateLimitStore({ url: config.supabaseUrl, key: config.supabaseKey });
}

void (async (): Promise<void> => {
  let store: ReturnType<typeof createMemoryStore> | ReturnType<typeof createSupabaseStore>;

  if (config.store === "supabase") {
    if (config.supabaseDbUrl) {
      await runMigrations(config.supabaseDbUrl);
    } else {
      console.warn(
        "[aegis] SUPABASE_DB_URL is not set; skipping migrations. " +
          "Apply the SQL in Supabase/ before using the hosted store.",
      );
    }
    store = createSupabaseStore({ url: config.supabaseUrl, key: config.supabaseKey });
  } else {
    store = createMemoryStore();
  }

  /**
   * One probe at boot, not one per request.
   *
   * A Supabase project whose origin is not running fails every workspace read, and the first thing a
   * person sees is the retry screen - which does not say why. Probing once here turns that into one
   * honest line in the terminal before anyone clicks anything.
   *
   * It never throws and never exits. The login screen and the account store are local, so the app is
   * still worth starting even when the database is down; refusing to boot would take the working half
   * away with the broken one.
   */
  async function probeSupabase(): Promise<void> {
  /*
   * Probes a real table, not `/rest/v1/`. The root answers with the OpenAPI document, and an edge
   * cache can serve that even while the origin is down - which is how a probe can report "fine" for
   * a project that is failing every actual query. `members` cannot be answered without the origin.
   */
  const url = `${config.supabaseUrl.replace(/\/+$/, "")}/rest/v1/members?select=id&limit=1`;

  try {
    const response = await fetch(url, {
      headers: { apikey: config.supabaseKey, authorization: `Bearer ${config.supabaseKey}` },
    });

    if (response.ok) {
      console.log("[aegis] Supabase probe: reachable, authorised, schema present");
      return;
    }

    if (response.status === 401 || response.status === 403) {
      console.warn(
        "[aegis] Supabase rejected the service-role key. Check SUPABASE_SERVICE_ROLE_KEY " +
          "(the anon key is not enough: the backend writes with the service role).",
      );
      return;
    }

    if (response.status === 404) {
      console.warn(
        "[aegis] Supabase is reachable but `members` does not exist. Run the SQL in Supabase/ " +
          "(01-schema.sql, then 02-rls.sql) against this project.",
      );
      return;
    }

    // 520-526 is Cloudflare failing to reach the origin, which is exactly what a paused project
    // looks like from outside: the gateway validates the key, then cannot reach PostgREST.
    if (response.status >= 500) {
      console.warn(
        `[aegis] Supabase is not serving this project (${response.status}): its origin is down. ` +
          "A paused or over-quota project does exactly this. Restore it in the Supabase dashboard, " +
          "or set AEGIS_STORE=memory to run on the local store.",
      );
      return;
    }

    console.warn(`[aegis] Supabase probe returned ${response.status}. Workspace reads may fail.`);
  } catch {
    console.warn(
      `[aegis] Supabase could not be reached at ${config.supabaseUrl}. Check SUPABASE_URL and your ` +
        "network, or set AEGIS_STORE=memory.",
    );
  }
}

const bus = new EventBus();
const uploads = createUploadStore(config.uploadDir);

/*
 * Accounts live beside the uploads, not in Supabase: identity must still work when the database
 * is unreachable, and a JSON file is one atomic rename away from consistent.
 */
const auth = createAuthStore({
  file: config.auth.file.length > 0 ? config.auth.file : null,
  oauth: config.auth.oauth,
});

/*
 * Moderation is a queue plus, optionally, a webhook. The queue is always the local record; the
 * webhook is how a real Watchdog service would be notified. Neither can execute anything: an
 * incident carries no command, and enforcement stays in `guard.ts`.
 */
const moderationQueue = createModerationQueue();
const webhook = config.abuse.moderationWebhook
  ? createWebhookModerationSink(config.abuse.moderationWebhook)
  : null;
const moderation: ModerationSink = webhook
  ? {
      report: (incident) => {
        moderationQueue.report(incident);
        webhook.report(incident);
      },
    }
  : moderationQueue;

const securityLog = createSecurityLog({ salt: config.abuse.logSalt });
const detector = createAbuseDetector({ log: securityLog, moderation });
const guard = createRequestGuard({
  enabled: config.abuse.enabled,
  store: buildLimitStore(),
  log: securityLog,
  detector,
  failMode: config.abuse.failMode,
});

const server = createServer(
  createRequestHandler({
    store,
    bus,
    apiKey: config.apiKey,
    iceServers: config.iceServers,
    uploads,
    guard,
    adminKey: config.abuse.adminKey,
    trustProxy: config.abuse.trustProxy,
    auth,
    requireAuth: config.auth.requireAuth,
  }),
);

server.on("error", (error) => {
  console.error(`[aegis] could not listen on ${config.host}:${config.port}`, error);
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  console.log(`[aegis] backend listening on http://${config.host}:${config.port}`);
  console.log(`[aegis] store: ${store.kind}`);
  if (store.kind === "supabase") void probeSupabase();
  console.log(`[aegis] uploads: ${uploads.dir} (100 MB per file)`);
  console.log(
    `[aegis] abuse prevention: ${config.abuse.enabled ? "on" : "OFF"} ` +
      `(limits: ${guard.enabled ? "on" : "off"}, fail ${config.abuse.failMode})`,
  );
  console.log(
    `[aegis] admin security routes: ${config.abuse.adminKey.length > 0 ? "on" : "off (set AEGIS_ADMIN_KEY)"}`,
  );

  const configured = auth
    .providers()
    .filter((provider) => provider.configured)
    .map((provider) => provider.label);
  console.log(
    `[aegis] accounts: ${auth.kind === "file" ? config.auth.file : "memory only"} ` +
      `(sessions ${config.auth.requireAuth ? "required" : "optional"})`,
  );
  console.log(
    `[aegis] social sign-in: ${configured.length > 0 ? configured.join(", ") : "none configured"} ` +
      `(redirect ${config.auth.oauth.publicUrl}/api/auth/oauth/callback)`,
  );

  if (store.kind === "memory") {
    console.log(
      "[aegis] memory store selected: servers disappear when this process exits. " +
        "Fill SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env, then restart.",
    );
  }
  if (config.apiKey.length === 0) {
    console.log("[aegis] AEGIS_API_KEY is empty: any local process may call the API.");
  }
});

const shutdown = (signal: string): void => {
  console.log(`[aegis] ${signal} received, closing`);
  server.close(() => process.exit(0));
  // A long-lived SSE connection must not hold the process open forever.
  setTimeout(() => process.exit(0), 2_000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
})();
