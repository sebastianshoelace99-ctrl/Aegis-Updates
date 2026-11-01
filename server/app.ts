import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { ZodError } from "zod";
import { voiceSignalSchema, type BackendEvent } from "../shared/events";
import { moderationActionSchema } from "../shared/moderation";
import { presenceSchema, type Member } from "../shared/domain";
import { createServerInputSchema, slugifyServerName } from "../shared/guildFactory";
import {
  MAX_ATTACHMENTS,
  MAX_MESSAGE_BODY,
  type FileAttachment,
} from "../shared/messages";
import { isProviderId, type AuthService, type PublicUser } from "./auth";
import type { EventBus } from "./bus";
import { HttpError } from "./errors";
import {
  claimedAccountId,
  clientIp,
  createRequestGuard,
  idempotencyKeyOf,
  secretMatches,
  type RequestGuard,
} from "./guard";
import type { Principal } from "./abuse";
import type { SecurityEventKind } from "./securityLog";
import type { Store } from "./store";
import { openUpload, parseRange, type UploadHandle, type UploadStore } from "./uploads";

/**
 * The HTTP surface, with no framework.
 *
 * Node's `http` module plus a small router is enough for a handful of endpoints, and it keeps the
 * backend dependency-free. Every handler answers JSON; the two exceptions are `/api/events`, which
 * is a long-lived SSE response, and `/api/uploads/:id`, which streams file bytes.
 */

export type AppOptions = {
  store: Store;
  bus: EventBus;
  /** Empty disables the shared-secret check, which is the local-dev default. */
  apiKey: string;
  uploads: UploadStore;
  iceServers?: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  /**
   * The abuse-prevention guard. Optional so the smoke backend and the tests keep working, but a
   * missing guard is replaced by a default one rather than by no protection at all.
   */
  guard?: RequestGuard;
  /** Empty disables the admin security routes entirely. */
  adminKey?: string;
  /** Only set when a reverse proxy sets `x-forwarded-for`; see `clientIp`. */
  trustProxy?: boolean;
  /**
   * Accounts. Optional: a caller that omits it (the smoke backend, older tests) keeps the legacy
   * `x-aegis-user` behaviour and answers 503 on `/api/auth/*` rather than pretending to sign in.
   */
  auth?: AuthService;
  /**
   * When true, a valid bearer session is required for every API route except health and the auth
   * routes themselves. Off by default so a development machine without an account still works.
   */
  requireAuth?: boolean;
};

const MAX_BODY_BYTES = 1_200_000; // a 400 kB icon data URL plus JSON overhead

/**
 * Types a browser may render inline. Everything else is forced to download.
 *
 * SVG is deliberately excluded even though it is an image: an SVG document can carry script, and
 * `inline` + a top-level navigation would execute it on this origin. The feed renders an SVG as a
 * download card instead of an `<img>`, so no upload is ever opened as a document.
 */
const INLINE_MIME = /^(?:image\/(?!svg\+xml)|audio\/|video\/|application\/pdf$|text\/plain$)/i;


function allowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  if (origin === "app://bundle") return origin;

  try {
    const parsed = new URL(origin);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (loopback && (parsed.protocol === "http:" || parsed.protocol === "https:")) return origin;
  } catch {
    /* an opaque or malformed origin is not allowed */
  }

  return null;
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  const allow = allowedOrigin(req.headers.origin);
  if (allow) res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, x-aegis-user, x-aegis-key, x-aegis-filename, x-aegis-challenge, " +
      "x-aegis-admin, idempotency-key, range",
  );
  // Without this a browser cannot read the size or name back off an attachment response, and a
  // media element cannot tell how much is left to buffer. `retry-after` is here so the client can
  // pace itself off a 429 instead of guessing.
  res.setHeader(
    "Access-Control-Expose-Headers",
    "content-length, content-range, content-disposition, accept-ranges, etag, retry-after, x-aegis-challenge",
  );
  res.setHeader("Access-Control-Max-Age", "600");
}


function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  const payload = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
    // The callback page is the only HTML this server emits; it runs no script of its own.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
    "referrer-policy": "no-referrer",
  });
  res.end(payload);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

/**
 * The page a browser lands on after a provider redirect.
 *
 * It is deliberately a dead end: no script, no token in the URL, no redirect back into the app.
 * The app is polling `pollOAuth`, so all this page has to do is tell the human to go back.
 */
function authPage(title: string, message: string, ok = false): string {
  const accent = ok ? "#e8a020" : "#ff6b5e";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - Aegis Shield</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1c1c20;color:#f3f0e5;font:16px/1.55 "Segoe UI",system-ui,sans-serif}
main{width:min(460px,92vw);padding:32px;border:1px solid ${accent};background:#24242b;clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px)}
.mark{width:38px;height:38px;border:2px solid ${accent};background:rgba(232,160,32,.14);clip-path:polygon(50% 0,100% 20%,100% 62%,50% 100%,0 62%,0 20%)}
h1{margin:18px 0 8px;font-size:26px;letter-spacing:.03em;text-transform:uppercase;font-style:italic;color:${accent}}
p{margin:0;color:#aaa49a}
</style></head>
<body><main><div class="mark"></div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function readRawBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) throw new HttpError(413, "That request body is too large.");
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readRawBody(req);
  if (body.byteLength === 0) return {};

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Expected a JSON request body.");
  }
}

/**
 * Apple posts its result back as `application/x-www-form-urlencoded`, and a browser form cannot
 * carry a JSON body, so the callback needs a parser that is not `readJson`.
 */
async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const body = await readRawBody(req, 64 * 1024);
  const form = new URLSearchParams(body.toString("utf8"));
  const values: Record<string, string> = {};
  for (const [key, value] of form) values[key] = value;
  return values;
}

function bearerTokenOf(req: IncomingMessage): string {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "";
  const match = /^Bearer\s+([A-Za-z0-9._-]+)$/i.exec(value.trim());
  return match?.[1] ?? "";
}

/** Set by the handler once a bearer token has been verified; wins over the claim header. */
type AuthenticatedRequest = IncomingMessage & { aegisUserId?: string };

function userIdOf(req: IncomingMessage): string {
  const verified = (req as AuthenticatedRequest).aegisUserId;

  if (verified) return verified;

  const raw = req.headers["x-aegis-user"];
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (!value || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new HttpError(401, "A valid x-aegis-user header is required.");
  }
  return value;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The file name travels percent-encoded in `x-aegis-filename`, because a header cannot carry the
 * arbitrary Unicode a Windows file name can. A name that fails to decode is used verbatim rather
 * than rejected: the upload is still valid, it just has an odd label.
 */
function decodeFileName(raw: string | undefined): string {
  if (!raw) return "file";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Streams one uploaded file.
 *
 * `Range` is honoured because a 100 MB video that cannot be scrubbed is a 100 MB video nobody can
 * watch, and `Content-Disposition` is only `inline` for types a browser renders safely: an
 * uploaded `.html` or `.svg` is a script-execution vector if the renderer opens it in place.
 */
function serveUpload(
  req: IncomingMessage,
  res: ServerResponse,
  handle: UploadHandle,
  download: boolean,
): void {
  const { upload } = handle;
  const size = upload.size;
  const range = parseRange(headerValue(req, "range"), size);
  const inline = !download && INLINE_MIME.test(upload.mime);
  const fallback = upload.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");

  const headers: Record<string, string | number> = {
    "content-type": upload.mime,
    "content-disposition":
      `${inline ? "inline" : "attachment"}; filename="${fallback}"; ` +
      `filename*=UTF-8''${encodeURIComponent(upload.name)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000, immutable",
    etag: `"${upload.uploadId}"`,
    "accept-ranges": "bytes",
  };

  if (range === "invalid") {
    res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
    res.end();
    return;
  }

  if (range) {
    res.writeHead(206, {
      ...headers,
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
      "content-length": range.end - range.start + 1,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    void pipeline(openUpload(handle, range), res).catch(() => res.destroy());
    return;
  }

  res.writeHead(200, { ...headers, "content-length": size });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  void pipeline(openUpload(handle), res).catch(() => res.destroy());
}


function splitPath(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new HttpError(400, "Malformed URL escape.");
      }
    });
}

function publish(bus: EventBus, event: BackendEvent): void {
  bus.publish(event);
}

function memberForSession(user: PublicUser): Member {
  const baseHandle = slugifyServerName(user.handle) || slugifyServerName(user.displayName) || "member";
  const handle = /^[a-z]/.test(baseHandle) ? baseHandle.slice(0, 32) : `member-${baseHandle}`.slice(0, 32);

  return {
    id: user.id,
    name: user.displayName,
    handle,
    role: "artist",
    presence: "offline",
    accent: user.accent,
  };
}

function inviteCodeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function inviteLink(code: string): string {
  return `aegis://invite?code=${encodeURIComponent(code)}`;
}

function openEvents(
  req: IncomingMessage,
  res: ServerResponse,
  bus: EventBus,
  userId: string,
  canSeeEvent: (event: BackendEvent) => Promise<boolean>,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 1500\n\n");
  res.write(`: connected as ${userId}\n\n`);

  let closed = false;
  const off = bus.add((event) => {
    void canSeeEvent(event)
      .then((visible) => {
        if (!visible || closed) return;
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          /* the client is gone; `close` below removes the listener */
        }
      })
      .catch((error: unknown) => {
        console.error("[aegis] could not authorize a live event", error);
      });
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 20_000);

  const close = (): void => {
    closed = true;
    clearInterval(heartbeat);
    off();
  };

  req.on("close", close);
  req.on("error", close);
}

/**
 * Every request lands here. The order is deliberate: CORS first (so a browser sees the headers on
 * an error too), then the unauthenticated health probe, then the shared secret, then routing.
 */
export function createRequestHandler(options: AppOptions) {
  // One guard per handler instance. `server/index.ts` passes a configured one; a caller that does
  // not (the smoke backend, the tests) still gets the default policy rather than an open API.
  const guard = options.guard ?? createRequestGuard();
  const trustProxy = options.trustProxy ?? false;
  const adminKey = options.adminKey ?? "";
  const voiceParticipants = new Map<string, Map<string, number>>();
  const voiceParticipantTtlMs = 60_000;

  const activeVoiceMembers = (channelId: string): Map<string, number> => {
    const participants = voiceParticipants.get(channelId);
    if (!participants) return new Map();
    const now = Date.now();
    for (const [memberId, lastSeenAt] of participants) {
      if (now - lastSeenAt > voiceParticipantTtlMs) participants.delete(memberId);
    }
    if (participants.size === 0) voiceParticipants.delete(channelId);
    return participants;
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    cors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://aegis.local");
    const segments = splitPath(url.pathname);

    const isApi = segments[0] === "api";
    const isAuthRoute = isApi && segments[1] === "auth";
    /*
     * A provider redirect is a plain browser navigation: it cannot carry `x-aegis-key`. The
     * unguessable `state` plus the provider's own code are what authenticate it instead.
     */
    const isOAuthCallback = isAuthRoute && segments[2] === "oauth" && segments[3] === "callback";

    const claim = claimedAccountId(req);
    const ip = clientIp(req, trustProxy);
    // Declared outside `try` because `finally` releases the guard's rate-limit slot.
    let principal: Principal = { accountId: claim, ip };

    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          store: options.store.kind,
          time: new Date().toISOString(),
        });
        return;
      }

      if (options.apiKey.length > 0 && !isOAuthCallback) {
        const supplied = req.headers["x-aegis-key"];
        const value = Array.isArray(supplied) ? supplied[0] : supplied;
        if (!secretMatches(options.apiKey, value)) {
          guard.noteAuthFailure({ accountId: claim, ip }, "rejected x-aegis-key");
          throw new HttpError(401, "Bad or missing x-aegis-key.");
        }
      }

      /*
       * Identity, in order of trust: a verified session, then the `x-aegis-user` claim. A bearer
       * token that does not resolve is refused rather than downgraded - otherwise a stale token
       * would silently act as whatever id the header names.
       */
      const token = bearerTokenOf(req);
      const sessionUser = options.auth && token ? await options.auth.resolve(token) : null;
      if (options.auth && token && !sessionUser) {
        throw new HttpError(401, "Your session has expired. Sign in again.");
      }
      if (sessionUser) (req as AuthenticatedRequest).aegisUserId = sessionUser.id;

      principal = { accountId: sessionUser?.id ?? claim, ip };
      const anonymous = principal.accountId === null;

      if (options.requireAuth && isApi && !isAuthRoute && !sessionUser) {
        throw new HttpError(401, "Sign in to use this workspace.");
      }

      /*
       * Rate limiting, risk assessment and enforcement all happen here - before routing, so no
       * handler is reachable without them, and before any body is read, so a rejected request
       * costs nothing.
       */
      const decision = await guard.check({
        method: req.method ?? "GET",
        segments,
        principal,
        anonymous,
        ...(headerValue(req, "x-aegis-challenge")
          ? { challengeToken: headerValue(req, "x-aegis-challenge") }
          : {}),
        now: Date.now(),
      });
      if (decision.kind !== "allow") {
        guard.apply(res, decision);
        return;
      }

      guard.enter(principal);

      /*
       * ── Accounts ──────────────────────────────────────────────────────────
       *
       * `auth` is optional. A handler built without one (the smoke backend, older tests) answers
       * 503 here instead of pretending the routes exist.
       */
      if (isAuthRoute) {
        const auth = options.auth;
        const requireAccounts = (): AuthService => {
          if (!auth) throw new HttpError(503, "Accounts are not configured on this server.");
          return auth;
        };

        if (segments[2] === "providers" && req.method === "GET") {
          sendJson(res, 200, { providers: requireAccounts().providers() });
          return;
        }

        if (segments[2] === "register" && req.method === "POST") {
          const body = bodyRecord(await readJson(req));
          const session = await requireAccounts().register({
            email: body.email,
            password: body.password,
            displayName: body.displayName,
            handle: body.handle,
          });
          sendJson(res, 201, session);
          return;
        }

        if (segments[2] === "login" && req.method === "POST") {
          const body = bodyRecord(await readJson(req));
          const session = await requireAccounts().login({
            email: body.email,
            password: body.password,
          });
          sendJson(res, 200, session);
          return;
        }

        if (segments[2] === "session" && req.method === "GET") {
          if (!sessionUser) throw new HttpError(401, "Sign in to continue.");
          sendJson(res, 200, { user: sessionUser });
          return;
        }

        if (segments[2] === "logout" && req.method === "POST") {
          if (auth && token) await auth.revoke(token);
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
          return;
        }

        if (segments[2] === "oauth" && segments[3] === "start" && req.method === "POST") {
          const body = bodyRecord(await readJson(req));
          if (!isProviderId(body.provider)) {
            throw new HttpError(400, "Unknown sign-in provider.");
          }
          sendJson(res, 200, requireAccounts().startOAuth(body.provider));
          return;
        }

        if (
          segments[2] === "oauth" &&
          segments[3] === "attempt" &&
          segments.length === 5 &&
          req.method === "GET"
        ) {
          const id = segments[4] ?? "";
          if (!/^[A-Za-z0-9_-]{20,100}$/.test(id)) {
            throw new HttpError(400, "Unknown sign-in attempt.");
          }
          sendJson(res, 200, requireAccounts().pollOAuth(id));
          return;
        }

        /*
         * The redirect target. GET carries Discord/Google's `?code=`, POST carries Apple's
         * form_post body. Both are answered with HTML, because the other side is a browser.
         */
        if (isOAuthCallback && (req.method === "GET" || req.method === "POST")) {
          if (!options.auth) {
            sendHtml(
              res,
              503,
              authPage("Accounts are off", "This backend was started without an account store."),
            );
            return;
          }

          const fields =
            req.method === "GET"
              ? Object.fromEntries(url.searchParams.entries())
              : await readForm(req);

          if (fields.error) {
            sendHtml(
              res,
              400,
              authPage(
                "Sign-in cancelled",
                fields.error_description ?? "The provider did not complete the sign-in.",
              ),
            );
            return;
          }

          try {
            await options.auth.completeOAuth({
              state: fields.state ?? "",
              code: fields.code ?? "",
              ...(fields.id_token ? { idToken: fields.id_token } : {}),
              ...(fields.user ? { rawUser: fields.user } : {}),
            });
            sendHtml(
              res,
              200,
              authPage(
                "You're signed in",
                "Close this tab and return to Aegis Shield. The app finishes signing in on its own.",
                true,
              ),
            );
          } catch (error) {
            const message =
              error instanceof HttpError
                ? error.message
                : "That sign-in could not be completed. Return to the app and try again.";
            sendHtml(res, 400, authPage("Sign-in failed", message));
          }
          return;
        }

        throw new HttpError(404, "Not found.");
      }

      /*
       * The security surface.
       *
       * Admin routes are mounted only when `AEGIS_ADMIN_KEY` is configured, and a missing or wrong
       * key answers **404**, not 401: an endpoint that confirms its own existence is an endpoint
       * worth probing. Every enforcement decision these routes expose is reversible.
       */
      if (isApi && segments[1] === "security") {
        const action = segments[2];

        const requireAdmin = (): void => {
          if (adminKey.length === 0) throw new HttpError(404, "Not found.");
          if (!secretMatches(adminKey, headerValue(req, "x-aegis-admin"))) {
            guard.noteAuthFailure(principal, "rejected x-aegis-admin");
            throw new HttpError(404, "Not found.");
          }
        };

        // User-facing: ask for a human. Requires a claimed identity, like every other write.
        if (action === "appeals" && req.method === "POST") {
          const body = await readJson(req);
          const message =
            body && typeof body === "object" && "message" in body
              ? (body as { message: unknown }).message
              : "";
          if (typeof message !== "string") {
            throw new HttpError(400, "A message is required so a moderator has context.");
          }

          const accountId = userIdOf(req);
          const item = guard.detector.appeal({ accountId, ip: principal.ip }, message);
          sendJson(res, 202, {
            case: { id: item.caseId, status: item.status, createdAt: item.at },
          });
          return;
        }

        if (action === "summary" && req.method === "GET") {
          requireAdmin();
          sendJson(res, 200, {
            summary: {
              ...guard.detector.summary(),
              securityEvents: guard.log.size,
              idempotencyKeys: guard.idempotency.size,
            },
            restrictions: guard.detector.restrictions(),
            recentEvents: guard.log.list({ limit: 20 }),
          });
          return;
        }

        if (action === "events" && req.method === "GET") {
          requireAdmin();
          const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
          const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;
          const kind = url.searchParams.get("kind");
          const accountId = url.searchParams.get("accountId");

          sendJson(res, 200, {
            events: guard.log.list({
              limit,
              ...(kind ? { kind: kind as SecurityEventKind } : {}),
              ...(accountId ? { accountId } : {}),
            }),
          });
          return;
        }

        if (action === "cases" && req.method === "GET") {
          requireAdmin();
          sendJson(res, 200, { cases: guard.detector.cases().slice(0, 100) });
          return;
        }

        if (action === "overrides" && req.method === "POST") {
          requireAdmin();
          const body = await readJson(req);
          const input =
            body && typeof body === "object" ? (body as Record<string, unknown>) : {};
          const accountId = typeof input.accountId === "string" ? input.accountId : "";
          const decision = input.decision;
          const minutes = typeof input.minutes === "number" ? input.minutes : 30;
          const reviewer = typeof input.reviewer === "string" ? input.reviewer : "admin";

          if (!/^[A-Za-z0-9._-]{1,64}$/.test(accountId)) {
            throw new HttpError(400, "A valid accountId is required.");
          }
          if (decision !== "clear" && decision !== "restrict" && decision !== "suspend") {
            throw new HttpError(400, "decision must be clear, restrict or suspend.");
          }

          const restriction = guard.detector.override(accountId, decision, minutes, reviewer);
          sendJson(res, 200, { restriction });
          return;
        }

        throw new HttpError(404, "Not found.");
      }

      /*
       * Uploads are the only endpoints that read a request body this large, so they bypass
       * `readJson` entirely: the bytes are streamed straight to disk with a hard cap, and a
       * client that lies about `content-length` is cut off by the meter transform, not trusted.
       */
      if (isApi && segments[1] === "uploads") {
        if (req.method === "POST" && segments.length === 2) {
          const saved = await options.uploads.save(req, {
            name: decodeFileName(headerValue(req, "x-aegis-filename")),
            mime: headerValue(req, "content-type") ?? "application/octet-stream",
            authorId: userIdOf(req),
          });
          sendJson(res, 201, { attachment: saved.upload });
          return;
        }

        if ((req.method === "GET" || req.method === "HEAD") && segments.length === 3) {
          const handle = await options.uploads.find(segments[2] ?? "");
          if (!handle) throw new HttpError(404, "Unknown upload.");
          serveUpload(req, res, handle, url.searchParams.get("download") === "1");
          return;
        }
      }

      if (
        isApi &&
        segments[1] === "guilds" &&
        segments.length === 4 &&
        segments[3] === "invites"
      ) {
        const guildId = segments[2];
        if (!guildId) throw new HttpError(400, "A server id is required.");
        const memberId = userIdOf(req);

        if (req.method === "GET") {
          sendJson(res, 200, { invites: await options.store.listInvites(guildId, memberId) });
          return;
        }

        if (req.method === "POST") {
          const code = randomBytes(32).toString("base64url");
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          const invite = await options.store.createInvite(
            guildId,
            memberId,
            inviteCodeHash(code),
            expiresAt,
          );
          sendJson(res, 201, { invite, link: inviteLink(code) });
          return;
        }
      }

      if (
        isApi &&
        req.method === "DELETE" &&
        segments[1] === "guilds" &&
        segments.length === 5 &&
        segments[3] === "invites"
      ) {
        const guildId = segments[2];
        const inviteId = segments[4];
        if (!guildId || !inviteId) {
          throw new HttpError(400, "A server and invite id are required.");
        }
        await options.store.revokeInvite(guildId, inviteId, userIdOf(req));
        res.writeHead(204);
        res.end();
        return;
      }

      if (
        isApi &&
        req.method === "POST" &&
        segments[1] === "voice" &&
        segments[2] === "join" &&
        segments.length === 3
      ) {
        const body = bodyRecord(await readJson(req));
        const channelId = typeof body.channelId === "string" ? body.channelId : "";
        if (!channelId) throw new HttpError(400, "A voice channel id is required.");
        const memberId = userIdOf(req);
        const channel = (await options.store.readWorkspace(memberId)).guilds
          .flatMap((guild) => guild.channels)
          .find((entry) => entry.id === channelId);
        if (!channel || channel.kind !== "voice") {
          throw new HttpError(404, "Unknown voice channel.");
        }
        if (!(await options.store.hasPermission(channelId, memberId, "connect_voice"))) {
          throw new HttpError(403, "You do not have permission to join this voice channel.");
        }
        const participants = activeVoiceMembers(channelId);
        if (!participants.has(memberId) && participants.size >= 6) {
          throw new HttpError(409, "This peer-to-peer call is full (maximum 6 participants).");
        }
        const peers = [...participants.keys()].filter((id) => id !== memberId);
        participants.set(memberId, Date.now());
        voiceParticipants.set(channelId, participants);
        publish(options.bus, { type: "voice-peer", channelId, memberId, joined: true });
        sendJson(res, 200, {
          peers,
          iceServers: options.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
          participantLimit: 6,
        });
        return;
      }

      if (
        isApi &&
        req.method === "POST" &&
        segments[1] === "voice" &&
        segments[2] === "heartbeat" &&
        segments.length === 3
      ) {
        const body = bodyRecord(await readJson(req));
        const channelId = typeof body.channelId === "string" ? body.channelId : "";
        const memberId = userIdOf(req);
        const participants = activeVoiceMembers(channelId);
        if (!channelId || !participants.has(memberId)) {
          throw new HttpError(409, "You are not connected to that voice channel.");
        }
        participants.set(memberId, Date.now());
        res.writeHead(204);
        res.end();
        return;
      }

      if (
        isApi &&
        req.method === "DELETE" &&
        segments[1] === "voice" &&
        segments[2] === "join" &&
        segments.length === 3
      ) {
        const body = bodyRecord(await readJson(req));
        const channelId = typeof body.channelId === "string" ? body.channelId : "";
        const memberId = userIdOf(req);
        const participants = activeVoiceMembers(channelId);
        if (participants.delete(memberId)) {
          if (participants.size === 0) voiceParticipants.delete(channelId);
          publish(options.bus, { type: "voice-peer", channelId, memberId, joined: false });
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (
        isApi &&
        req.method === "POST" &&
        segments[1] === "voice" &&
        segments[2] === "signal" &&
        segments.length === 3
      ) {
        const body = bodyRecord(await readJson(req));
        const channelId = typeof body.channelId === "string" ? body.channelId : "";
        const toMemberId = typeof body.toMemberId === "string" ? body.toMemberId : "";
        const signal = voiceSignalSchema.safeParse(body.signal);
        const fromMemberId = userIdOf(req);
        const participants = activeVoiceMembers(channelId);
        if (!channelId || !toMemberId || !signal.success) {
          throw new HttpError(400, "A valid voice signal, channel and recipient are required.");
        }
        if (
          toMemberId === fromMemberId ||
          !participants.has(fromMemberId) ||
          !participants.has(toMemberId)
        ) {
          throw new HttpError(403, "Both peers must be connected to the same voice channel.");
        }
        if (
          !(await options.store.hasPermission(channelId, fromMemberId, "connect_voice")) ||
          !(await options.store.hasPermission(channelId, toMemberId, "connect_voice"))
        ) {
          throw new HttpError(403, "A peer no longer has permission to connect to voice.");
        }
        participants.set(fromMemberId, Date.now());
        publish(options.bus, {
          type: "voice-signal",
          channelId,
          fromMemberId,
          toMemberId,
          signal: signal.data,
        });
        res.writeHead(204);
        res.end();
        return;
      }

      if (
        isApi &&
        req.method === "POST" &&
        segments[1] === "invites" &&
        segments[2] === "redeem" &&
        segments.length === 3
      ) {
        if (!sessionUser) throw new HttpError(401, "Sign in before joining a server.");
        const body = bodyRecord(await readJson(req));
        const code = typeof body.code === "string" ? body.code : "";
        if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
          throw new HttpError(400, "That invite code is not valid.");
        }
        const member = await options.store.ensureMember(memberForSession(sessionUser));
        const guildId = await options.store.redeemInvite(inviteCodeHash(code), member);
        sendJson(res, 200, {
          guildId,
          workspace: await options.store.readWorkspace(sessionUser.id),
        });
        return;
      }

      if (isApi && req.method === "GET" && segments[1] === "workspace" && segments.length === 2) {
        if (sessionUser) await options.store.ensureMember(memberForSession(sessionUser));
        sendJson(res, 200, {
          workspace: await options.store.readWorkspace(sessionUser?.id),
        });
        return;
      }

      if (isApi && req.method === "POST" && segments[1] === "guilds" && segments.length === 2) {
        const input = createServerInputSchema.parse(await readJson(req));
        // A caller may only create a server for themselves; otherwise the owner row and the
        // roster would disagree about who pressed Create.
        if (userIdOf(req) !== input.ownerId) {
          throw new HttpError(403, "The ownerId must match the calling member.");
        }
        const result = await options.store.createGuild(input);
        sendJson(res, 201, {
          ...result,
          workspace: await options.store.readWorkspace(sessionUser?.id),
        });
        return;
      }

      if (
        isApi &&
        segments[1] === "guilds" &&
        segments.length === 4 &&
        segments[3] === "moderation"
      ) {
        const guildId = segments[2];
        if (!guildId) throw new HttpError(400, "A server id is required.");
        const memberId = userIdOf(req);
        if (req.method === "GET") {
          sendJson(res, 200, {
            entries: await options.store.listModerationAudit(guildId, memberId, 100),
            bannedMemberIds: await options.store.listBannedMemberIds(guildId, memberId),
          });
          return;
        }
        if (req.method === "POST") {
          const body = bodyRecord(await readJson(req));
          const action = moderationActionSchema.safeParse(body.action);
          const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
          const reason = typeof body.reason === "string" ? body.reason.trim() : "";
          const durationMinutes =
            typeof body.durationMinutes === "number" ? body.durationMinutes : undefined;
          if (!action.success) throw new HttpError(400, "Choose a valid moderation action.");
          if (!targetId || targetId.length > 64) throw new HttpError(400, "A valid target is required.");
          if (reason.length > 500) throw new HttpError(400, "Reasons are limited to 500 characters.");
          const entry = await options.store.moderateMember(
            guildId,
            memberId,
            targetId,
            action.data,
            reason,
            durationMinutes,
          );
          sendJson(res, 201, {
            entry,
            workspace: await options.store.readWorkspace(memberId),
          });
          return;
        }
      }

      if (
        isApi &&
        req.method === "GET" &&
        segments[1] === "guilds" &&
        segments.length === 4 &&
        segments[3] === "export"
      ) {
        const guildId = segments[2];
        if (!guildId) throw new HttpError(400, "A server id is required.");
        if (!(await options.store.isGuildOwner(guildId, userIdOf(req)))) {
          throw new HttpError(403, "Only the server owner can export its data.");
        }
        sendJson(res, 200, await options.store.exportGuild(guildId));
        return;
      }

      if (isApi && req.method === "DELETE" && segments[1] === "guilds" && segments.length === 3) {
        const guildId = segments[2];
        if (!guildId) throw new HttpError(400, "A server id is required.");
        await options.store.deleteGuild(guildId, userIdOf(req));
        sendJson(res, 200, {
          workspace: await options.store.readWorkspace(sessionUser?.id),
        });
        return;
      }

      if (isApi && req.method === "PATCH" && segments[1] === "guilds" && segments.length === 3) {
        const id = segments[2];
        const body = await readJson(req);
        if (body && typeof body === "object" && "id" in body) {
          if ((body as { id: unknown }).id !== id) {
            throw new HttpError(400, "The guild id in the path and the body must match.");
          }
        }

        const caller = userIdOf(req);
        if (!(await options.store.hasGuildPermission(id, caller, "manage_guild"))) {
          throw new HttpError(403, "You do not have permission to manage this server.");
        }
        const currentGuild = (await options.store.readWorkspace(caller)).guilds.find((guild) => guild.id === id);
        if (!currentGuild) throw new HttpError(404, "Unknown server.");
        const memberIds = (body as { memberIds?: unknown } | null)?.memberIds;
        if (!Array.isArray(memberIds) || !memberIds.includes(caller)) {
          throw new HttpError(403, "Only a member of that guild may edit it.");
        }
        if (
          memberIds.length !== currentGuild.memberIds.length ||
          currentGuild.memberIds.some((memberId) => !memberIds.includes(memberId))
        ) {
          throw new HttpError(403, "Server membership can only be changed with an invite.");
        }

        const result = await options.store.saveGuild(body);
        sendJson(res, 200, {
          ...result,
          workspace: await options.store.readWorkspace(sessionUser?.id),
        });
        return;
      }

      if (isApi && req.method === "GET" && segments[1] === "search" && segments.length === 2) {
        const query = (url.searchParams.get("q") ?? "").trim();
        const guildId = url.searchParams.get("guildId");
        if (query.length < 2 || query.length > 100) {
          throw new HttpError(400, "Search terms must contain 2–100 characters.");
        }
        const workspace = await options.store.readWorkspace(userIdOf(req));
        const guilds = guildId
          ? workspace.guilds.filter((guild) => guild.id === guildId)
          : workspace.guilds;
        if (guildId && guilds.length === 0) throw new HttpError(404, "Unknown server.");
        const channels = guilds.flatMap((guild) => guild.channels);
        const searchable = channels.filter(
          (channel) => channel.kind !== "voice",
        );
        const permittedChannelIds: string[] = [];
        for (const channel of searchable) {
          if (await options.store.hasPermission(channel.id, userIdOf(req), "read_history")) {
            permittedChannelIds.push(channel.id);
          }
        }
        const messages = await options.store.searchMessages(permittedChannelIds, query, 50);
        sendJson(res, 200, { messages });
        return;
      }

      if (
        isApi &&
        segments[1] === "channels" &&
        segments.length === 4 &&
        segments[3] === "messages"
      ) {
        const channelId = segments[2];
        if (!channelId) throw new HttpError(400, "A channel id is required.");

        if (req.method === "GET") {
          const memberId = userIdOf(req);
          if (!(await options.store.hasPermission(channelId, memberId, "view_channel"))) {
            throw new HttpError(403, "You do not have permission to view this channel.");
          }
          if (!(await options.store.hasPermission(channelId, memberId, "read_history"))) {
            throw new HttpError(403, "You do not have permission to read this channel's history.");
          }
          const beforeRaw = url.searchParams.get("before");
          if (beforeRaw && Number.isNaN(Date.parse(beforeRaw))) {
            throw new HttpError(400, "`before` must be an ISO-8601 timestamp.");
          }
          const before = beforeRaw ? new Date(beforeRaw).toISOString() : null;

          const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "40", 10);
          const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 40;

          sendJson(res, 200, await options.store.listMessages(channelId, before, limit));
          return;
        }

        if (req.method === "POST") {
          const memberId = userIdOf(req);
          if (!(await options.store.hasPermission(channelId, memberId, "send_messages"))) {
            throw new HttpError(403, "You do not have permission to send messages in this channel.");
          }
          const body = await readJson(req);
          const text =
            body && typeof body === "object" && "body" in body
              ? (body as { body: unknown }).body
              : "";
          if (typeof text !== "string") throw new HttpError(400, "A message body is required.");

          const trimmed = text.trim();
          if (trimmed.length > MAX_MESSAGE_BODY) {
            throw new HttpError(
              400,
              `Messages are limited to ${MAX_MESSAGE_BODY} characters.`,
            );
          }

          // Attachments arrive as ids only. Names, types and sizes are re-read from the upload
          // store so a sender cannot relabel a file into an inline-rendered type.
          const requested =
            body && typeof body === "object" && "attachments" in body
              ? (body as { attachments: unknown }).attachments
              : undefined;
          const entries = Array.isArray(requested) ? requested : [];
          if (entries.length > MAX_ATTACHMENTS) {
            throw new HttpError(
              400,
              `A message can carry at most ${MAX_ATTACHMENTS} attachments.`,
            );
          }

          const uploadIds: string[] = [];
          for (const entry of entries) {
            const id =
              entry && typeof entry === "object" && "uploadId" in entry
                ? (entry as { uploadId: unknown }).uploadId
                : null;
            if (typeof id !== "string" || id.length === 0) {
              throw new HttpError(400, "Every attachment needs an uploadId.");
            }
            if (!uploadIds.includes(id)) uploadIds.push(id);
          }

          const attachments: FileAttachment[] = [];
          for (const id of uploadIds) {
            const handle = await options.uploads.find(id);
            if (!handle) {
              throw new HttpError(400, "One of those attachments is no longer available.");
            }
            const { upload } = handle;
            attachments.push({
              kind: "file",
              uploadId: upload.uploadId,
              name: upload.name,
              mime: upload.mime,
              size: upload.size,
            });
          }

          if (trimmed.length === 0 && attachments.length === 0) {
            throw new HttpError(400, "Cannot send an empty message.");
          }

          const authorId = userIdOf(req);
          if (sessionUser) await options.store.ensureMember(memberForSession(sessionUser));

          /*
           * `Idempotency-Key` turns a retried send into a no-op instead of a duplicate message.
           * The fingerprint covers the *effective* request, so the same key with different content
           * is a 422 rather than a stale replay of an unrelated message.
           */
          const ledger = guard.idempotency;
          const idemKey = idempotencyKeyOf(req);
          const scope = `POST /api/channels/${channelId}/messages`;
          const fingerprint = [authorId, channelId, trimmed, uploadIds.join(",")].join("\u0000");

          if (idemKey) {
            const state = ledger.begin(scope, idemKey, fingerprint);
            if (state.state === "replay") {
              sendJson(res, 201, state.value);
              return;
            }
            if (state.state === "pending") {
              throw new HttpError(409, "A request with that Idempotency-Key is still in flight.");
            }
            if (state.state === "conflict") {
              throw new HttpError(
                422,
                "That Idempotency-Key was already used for a different message.",
              );
            }
          }

          let message;
          try {
            message = await options.store.createMessage(
              channelId,
              authorId,
              trimmed,
              attachments,
            );
          } catch (error) {
            if (idemKey) ledger.release(scope, idemKey);
            throw error;
          }

          if (idemKey) ledger.complete(scope, idemKey, message);
          guard.noteMessage(principal, channelId, trimmed);
          publish(options.bus, { type: "message", message });
          sendJson(res, 201, message);
          return;
        }
      }

      /*
       * ── Reactions ─────────────────────────────────────────────────────────
       *
       * Also `POST`, and also a toggle: the same request sent twice is add-then-remove, so this is
       * deliberately not idempotent. That is why the reply is the whole message and not a delta -
       * a caller that retried has no way to know which way its toggle landed without it.
       */
      if (
        isApi &&
        req.method === "POST" &&
        segments[1] === "channels" &&
        segments.length === 6 &&
        segments[3] === "messages" &&
        segments[5] === "reactions"
      ) {
        const channelId = segments[2] ?? "";
        const messageId = segments[4] ?? "";
        if (!channelId || !messageId) {
          throw new HttpError(400, "A channel id and a message id are required.");
        }
        if (!(await options.store.hasPermission(channelId, userIdOf(req), "add_reactions"))) {
          throw new HttpError(403, "You do not have permission to add reactions in this channel.");
        }

        const body = bodyRecord(await readJson(req));
        const emoji = typeof body.emoji === "string" ? body.emoji.trim() : "";
        // A glyph, not an id: short enough to be one grapheme cluster, long enough for a ZWJ family.
        if (emoji.length === 0 || emoji.length > 32) {
          throw new HttpError(400, "Send the emoji you want to toggle.");
        }

        const updated = await options.store.toggleReaction(
          channelId,
          messageId,
          userIdOf(req),
          emoji,
          body.burst === true,
        );
        publish(options.bus, { type: "reaction", message: updated });
        sendJson(res, 200, updated);
        return;
      }

      if (isApi && req.method === "POST" && segments[1] === "typing" && segments.length === 2) {
        const body = await readJson(req);
        const channelId =
          body && typeof body === "object" && "channelId" in body
            ? (body as { channelId: unknown }).channelId
            : "";
        if (typeof channelId !== "string" || channelId.length === 0) {
          throw new HttpError(400, "A channelId is required.");
        }
        if (!(await options.store.hasPermission(channelId, userIdOf(req), "send_messages"))) {
          throw new HttpError(404, `Unknown channel: ${channelId}`);
        }

        publish(options.bus, { type: "typing", channelId, memberId: userIdOf(req) });
        res.writeHead(204);
        res.end();
        return;
      }

      if (isApi && req.method === "POST" && segments[1] === "presence" && segments.length === 2) {
        const body = await readJson(req);
        const parsed = presenceSchema.safeParse(
          body && typeof body === "object" && "presence" in body
            ? (body as { presence: unknown }).presence
            : undefined,
        );
        if (!parsed.success) throw new HttpError(400, "Unknown presence state.");

        const memberId = userIdOf(req);
        await options.store.setPresence(memberId, parsed.data);
        publish(options.bus, { type: "presence", memberId, presence: parsed.data });
        res.writeHead(204);
        res.end();
        return;
      }

      if (isApi && req.method === "GET" && segments[1] === "events" && segments.length === 2) {
        const memberId = userIdOf(req);
        openEvents(req, res, options.bus, memberId, async (event) => {
          if (event.type === "message" || event.type === "reaction") {
            return options.store.hasChannel(event.message.channelId, memberId);
          }
          if (event.type === "typing") {
            return options.store.hasChannel(event.channelId, memberId);
          }
          if (event.type === "voice-peer") {
            return options.store.hasPermission(event.channelId, memberId, "connect_voice");
          }
          if (event.type === "voice-signal") {
            return (
              event.toMemberId === memberId &&
              (await options.store.hasPermission(event.channelId, memberId, "connect_voice"))
            );
          }
          const workspace = await options.store.readWorkspace(memberId);
          return workspace.members.some((member) => member.id === event.memberId);
        });
        return;
      }

      throw new HttpError(404, "Not found.");
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }

      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }

      if (error instanceof ZodError) {
        sendJson(res, 400, { error: error.issues[0]?.message ?? "Invalid input." });
        return;
      }

      console.error("[aegis] unhandled request failure", error);
      sendJson(res, 500, { error: "Internal server error." });
    } finally {
      // `enter` only ran after the guard allowed the request; `leave` is a no-op otherwise.
      guard.leave(principal);
    }
  };
}
