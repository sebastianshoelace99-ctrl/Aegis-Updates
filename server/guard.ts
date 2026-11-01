import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createAbuseDetector,
  createChallengeLedger,
  type AbuseDetector,
  type AbusePolicy,
  type ChallengeLedger,
  type Principal,
  type Restriction,
} from "./abuse";
import {
  createMemoryRateLimitStore,
  retryAfterSeconds,
  type RateLimitRule,
  type RateLimitStore,
} from "./rateLimit";
import { createSecurityLog, type SecurityLog } from "./securityLog";

/**
 * The request guard: one place that decides whether a request proceeds, and why.
 *
 * It runs after CORS and the health probe and before any route, so no handler is reachable
 * without passing it. Three properties are worth stating outright:
 *
 *  - **Identity is a claim.** `x-aegis-user` is client-supplied; there is no login yet
 *    (`Supabase/README.md` covers putting real auth in front). A limiter keyed only on that
 *    header would be bypassed by editing one string, so every authenticated bucket consumes
 *    *both* the account bucket and the address bucket. Rotating the claimed id keeps the address
 *    bucket spent - which is the whole point of the composite.
 *  - **Failures are explicit.** If the shared limit store is unreachable, expensive and
 *    authentication paths fail closed (503) and cheap reads fail open, because reading a channel
 *    is not what an outage should break. `AEGIS_RATE_LIMIT_FAIL_MODE` chooses, per deployment.
 *  - **Clients learn nothing.** A rejection carries `Retry-After` and a human sentence. Bucket
 *    names, limits, scores and signal weights stay server-side.
 */

export type BucketName =
  | "read:workspace"
  | "read:messages"
  | "write:messages"
  | "read:uploads"
  | "write:uploads"
  | "create:guilds"
  | "write:guilds"
  | "write:realtime"
  | "connect:events"
  | "auth"
  | "admin"
  | "challenge"
  | "appeal"
  | "default";

export type RuleSpec = {
  rule: RateLimitRule;
  /** When true, an unavailable limit store means "deny", not "allow". */
  expensive: boolean;
};

/**
 * Per-endpoint budgets. `burst` is what a freshly opened window may do; `perMinute` is what it may
 * sustain. Creating a server and uploading a 100 MB file are priced far below reading a channel:
 * they cost the most and are what an abuser actually wants.
 */
export const DEFAULT_RULES: Record<BucketName, RuleSpec> = {
  "read:workspace": { rule: { burst: 20, perMinute: 60 }, expensive: false },
  "read:messages": { rule: { burst: 60, perMinute: 120 }, expensive: false },
  "write:messages": { rule: { burst: 8, perMinute: 30 }, expensive: false },
  "read:uploads": { rule: { burst: 60, perMinute: 240 }, expensive: false },
  "write:uploads": { rule: { burst: 4, perMinute: 10 }, expensive: true },
  "create:guilds": { rule: { burst: 3, perMinute: 5 }, expensive: true },
  "write:guilds": { rule: { burst: 10, perMinute: 30 }, expensive: false },
  "write:realtime": { rule: { burst: 20, perMinute: 120 }, expensive: false },
  // The renderer reconnects its event stream with 0.8-5 s backoff, so this bucket has to allow a
  // reconnect loop to heal: 1/s is far above one client's retries and far below scripted churn.
  "connect:events": { rule: { burst: 10, perMinute: 60 }, expensive: false },
  // Sign-in runs scrypt on the server, so it is priced as expensive work: a burst is fine, an
  // unbounded stream of guesses is not, and an unreachable limit store fails closed.
  auth: { rule: { burst: 10, perMinute: 30 }, expensive: true },
  admin: { rule: { burst: 30, perMinute: 60 }, expensive: true },
  challenge: { rule: { burst: 10, perMinute: 20 }, expensive: false },
  appeal: { rule: { burst: 2, perMinute: 5 }, expensive: false },
  default: { rule: { burst: 30, perMinute: 60 }, expensive: false },
};

/** Unauthenticated callers get one strict rule whatever they ask for. */
const ANONYMOUS_RULE: RateLimitRule = { burst: 5, perMinute: 10 };

/** ...and a cross-endpoint bucket, so switching endpoints does not mint a fresh allowance. */
const ANONYMOUS_GLOBAL: RateLimitRule = { burst: 20, perMinute: 40 };

/** A brand-new account is held to half its normal budget until its clock matters. */
const NEW_ACCOUNT_FACTOR = 0.5;

export function classify(method: string, segments: string[]): BucketName {
  if (segments[0] !== "api") return "default";

  const resource = segments[1];
  const third = segments[2];
  const fourth = segments[3];

  if (resource === "security") {
    if (third === "challenge") return "challenge";
    if (third === "appeals") return "appeal";
    return "admin";
  }
  if (resource === "auth") return "auth";
  if (resource === "uploads") return method === "POST" ? "write:uploads" : "read:uploads";
  if (resource === "workspace") return "read:workspace";
  if (resource === "guilds") {
    if (method === "POST") return "create:guilds";
    if (method === "PATCH") return "write:guilds";
    return "default";
  }
  if (resource === "channels" && fourth === "messages") {
    return method === "GET" || method === "HEAD" ? "read:messages" : "write:messages";
  }
  if (resource === "typing" || resource === "presence") return "write:realtime";
  if (resource === "events") return "connect:events";
  return "default";
}

/**
 * The client address.
 *
 * `x-forwarded-for` is honoured **only** when the deployment says a proxy sets it. Trusting it by
 * default would let any caller invent a new address per request, which is a rate-limit bypass
 * dressed up as a header.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const raw = req.headers["x-forwarded-for"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const first = value?.split(",")[0]?.trim();
    if (first && /^[0-9a-fA-F:.]{2,45}$/.test(first)) return first;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/** The claimed identity, or null. Never throws: the guard must run for anonymous callers too. */
export function claimedAccountId(req: IncomingMessage): string | null {
  const raw = req.headers["x-aegis-user"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) return null;
  return value;
}

/** Constant-time comparison, so a shared secret cannot be guessed a byte at a time. */
export function secretMatches(expected: string, supplied: string | undefined): boolean {
  if (expected.length === 0) return true;
  if (!supplied) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type GuardDecision =
  | { kind: "allow" }
  | { kind: "rate_limited"; bucket: BucketName; retryAfterMs: number }
  | { kind: "challenge_required"; bucket: BucketName; challengeId: string; expiresAt: string; retryAfterMs: number }
  | { kind: "restricted"; bucket: BucketName; until: string; message: string }
  | { kind: "unavailable"; bucket: BucketName };

export type GuardInput = {
  method: string;
  segments: string[];
  principal: Principal;
  /** True when no valid `x-aegis-user` was supplied. */
  anonymous: boolean;
  challengeToken?: string;
  now: number;
};

export type RequestGuard = {
  readonly enabled: boolean;
  readonly log: SecurityLog;
  readonly detector: AbuseDetector;
  readonly idempotency: IdempotencyLedger;
  check(input: GuardInput): Promise<GuardDecision>;
  enter(principal: Principal): void;
  leave(principal: Principal): void;
  challenge(principal: Principal): { id: string; expiresAt: string; retryAfterMs: number };
  redeem(token: string | undefined): boolean;
  noteAuthFailure(principal: Principal, reason: string): void;
  noteMessage(principal: Principal, channelId: string, body: string): number;
  noteGuildCreated(principal: Principal): void;
  /** Writes the decision to the response. Kept here so every rejection looks the same. */
  apply(res: ServerResponse, decision: GuardDecision): void;
};

/**
 * What a restricted caller is told.
 *
 * Requirement: name the feature and the reason, offer a way back. It deliberately does not say
 * which threshold tripped - that is the recipe for staying underneath it.
 */
function restrictionMessage(bucket: BucketName, suspended: boolean): string {
  const review = " You can ask for a human review with POST /api/security/appeals.";
  if (suspended) {
    return `This account is temporarily suspended while unusual activity is reviewed.${review}`;
  }
  if (bucket === "write:messages") {
    return `Sending messages is paused on this account while unusual activity is reviewed.${review}`;
  }
  if (bucket === "create:guilds" || bucket === "write:guilds") {
    return `Creating or editing servers is paused on this account while unusual activity is reviewed.${review}`;
  }
  return `That action is paused on this account while unusual activity is reviewed.${review}`;
}

function appliesTo(restriction: Restriction, bucket: BucketName): boolean {
  return restriction.actions.includes("*") || restriction.actions.includes(bucket);
}


/** Header format for `Idempotency-Key`: opaque, bounded, and safe to use as a map key. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export function idempotencyKeyOf(req: IncomingMessage): string | null {
  const raw = req.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && IDEMPOTENCY_KEY.test(value) ? value : null;
}

export type IdempotentOutcome =
  | { state: "new" }
  | { state: "pending" }
  | { state: "conflict" }
  | { state: "replay"; value: unknown };

type LedgerEntry = {
  status: "pending" | "done";
  fingerprint: string;
  value: unknown;
  at: number;
};

/**
 * Remembers what a repeated write already did.
 *
 * A retried POST is an ordinary event - a flaky connection, a double-clicked button - and without
 * this a message arrives twice. The fingerprint covers the *effective* request (author, channel,
 * body, attachments), so reusing a key for different content is a `conflict` rather than a silent
 * replay of someone else's result.
 */
export class IdempotencyLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: { maxEntries?: number; ttlMs?: number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 1_000);
    this.ttlMs = Math.max(1_000, options.ttlMs ?? 10 * 60_000);
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) this.entries.delete(id);
    }
    // Still full after expiry means a burst of distinct keys: drop the oldest, which only costs
    // a possible duplicate delivery, never a security decision.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  begin(scope: string, key: string, fingerprint: string): IdempotentOutcome {
    const now = Date.now();
    this.prune(now);

    const id = `${scope}\u0000${key}`;
    const found = this.entries.get(id);
    if (!found) {
      this.entries.set(id, { status: "pending", fingerprint, value: undefined, at: now });
      return { state: "new" };
    }

    if (found.fingerprint !== fingerprint) return { state: "conflict" };
    if (found.status === "pending") return { state: "pending" };
    return { state: "replay", value: found.value };
  }

  complete(scope: string, key: string, value: unknown): void {
    const id = `${scope}\u0000${key}`;
    const found = this.entries.get(id);
    if (!found) return;
    this.entries.set(id, { ...found, status: "done", value, at: Date.now() });
  }

  /** Frees the key after a failure so the client's retry is not answered with `pending` forever. */
  release(scope: string, key: string): void {
    const id = `${scope}\u0000${key}`;
    const found = this.entries.get(id);
    if (found && found.status === "pending") this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }
}


function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function tighten(rule: RateLimitRule): RateLimitRule {
  return {
    burst: Math.max(1, Math.ceil(rule.burst * NEW_ACCOUNT_FACTOR)),
    perMinute: Math.max(1, Math.ceil(rule.perMinute * NEW_ACCOUNT_FACTOR)),
  };
}

export type GuardOptions = {
  enabled?: boolean;
  store?: RateLimitStore;
  log?: SecurityLog;
  detector?: AbuseDetector;
  policy?: Partial<AbusePolicy>;
  /** Per-bucket overrides, merged over `DEFAULT_RULES`. Used by tests and a tuned deployment. */
  rules?: Partial<Record<BucketName, RuleSpec>>;
  /** `closed` denies expensive work when the limit store is unreachable; `open` allows it. */
  failMode?: "closed" | "open";
  now?: () => number;
};

export function createRequestGuard(options: GuardOptions = {}): RequestGuard {
  const enabled = options.enabled ?? true;
  const failMode = options.failMode ?? "closed";
  const clock = options.now ?? Date.now;
  const store = options.store ?? createMemoryRateLimitStore();
  const log = options.log ?? createSecurityLog();
  const detector = options.detector ?? createAbuseDetector({ policy: options.policy, log, now: clock });
  const challenges = createChallengeLedger();
  const idempotency = new IdempotencyLedger();
  const rules: Record<BucketName, RuleSpec> = { ...DEFAULT_RULES, ...options.rules };

  const restrictedDecision = (
    restriction: Restriction,
    bucket: BucketName,
  ): GuardDecision => ({
    kind: "restricted",
    bucket,
    until: new Date(restriction.until).toISOString(),
    message: restrictionMessage(bucket, restriction.actions.includes("*")),
  });

  return {
    enabled,
    log,
    detector,
    idempotency,

    async check(input) {
      if (!enabled) return { kind: "allow" };

      const { principal, anonymous, now } = input;
      const bucket = classify(input.method, input.segments);
      detector.noteRequest(principal);

      // An existing restriction short-circuits everything: no store call, no handler.
      const active = principal.accountId ? detector.restrictionFor(principal.accountId) : null;
      if (active && appliesTo(active, bucket)) return restrictedDecision(active, bucket);

      const spec = rules[bucket];
      const targets: { key: string; rule: RateLimitRule; expensive: boolean }[] = [];

      if (anonymous) {
        targets.push({
          key: `ip:${bucket}:${principal.ip}`,
          rule: ANONYMOUS_RULE,
          expensive: spec.expensive,
        });
        // Cross-endpoint, so switching routes does not mint a fresh allowance.
        targets.push({ key: `ip:*:${principal.ip}`, rule: ANONYMOUS_GLOBAL, expensive: false });
      } else {
        const accountId = principal.accountId ?? "anonymous";
        const rule = detector.isNewAccount(accountId) ? tighten(spec.rule) : spec.rule;
        targets.push({ key: `acct:${bucket}:${accountId}`, rule, expensive: spec.expensive });
        // The address bucket is what makes a rotated `x-aegis-user` worthless as an evasion.
        targets.push({ key: `ip:${bucket}:${principal.ip}`, rule, expensive: spec.expensive });
      }

      let deniedAfterMs = 0;
      let deniedLimit = 0;

      for (const target of targets) {
        let result;
        try {
          result = await store.consume(target.key, target.rule, 1, now);
        } catch {
          const closed = failMode === "closed" && target.expensive;
          log.record({
            kind: "degraded",
            accountId: principal.accountId,
            ip: principal.ip,
            bucket,
            count: null,
            threshold: null,
            reason: "rate limit store unavailable",
            action: closed ? "denied" : "allowed",
            detail: { store: store.kind, failMode },
          });
          if (closed) return { kind: "unavailable", bucket };
          continue;
        }

        if (!result.allowed) {
          deniedAfterMs = Math.max(deniedAfterMs, result.retryAfterMs);
          deniedLimit = result.limit;
        }
      }

      if (deniedAfterMs > 0) detector.noteRateLimited(principal, bucket, deniedLimit);

      const assessment = detector.assess(principal);

      /*
       * Escalation is skipped for the event stream. A long-lived `fetch` that the renderer keeps
       * reconnecting has nowhere to present a challenge, so a 428 there would take live updates
       * down for the whole window - a self-inflicted outage. The token bucket above still applies,
       * which is the control that actually fits a connection.
       */
      const escalates = bucket !== "connect:events";

      // Enforcement goes through `escalate`, which can only write a *restriction*. It never
      // performs an operation: the handler still owns authorization, and a restriction only
      // decides whether the handler is reached.
      const applied = escalates ? detector.escalate(principal, assessment, bucket) : null;
      if (applied) return restrictedDecision(applied, bucket);

      if (escalates && assessment.level === "challenge") {
        const passed = input.challengeToken ? challenges.consume(input.challengeToken) : false;
        if (!passed) {
          const issued = challenges.issue(principal);
          log.record({
            kind: "challenge",
            accountId: principal.accountId,
            ip: principal.ip,
            bucket,
            count: assessment.score,
            threshold: detector.policy.challengeAt,
            reason: "risk score requires a challenge",
            action: "challenged",
            detail: { signals: assessment.signals.map((signal) => signal.id).join(" ") },
          });
          return {
            kind: "challenge_required",
            bucket,
            challengeId: issued.id,
            expiresAt: issued.expiresAt,
            retryAfterMs: issued.retryAfterMs,
          };
        }
      }

      if (deniedAfterMs > 0) return { kind: "rate_limited", bucket, retryAfterMs: deniedAfterMs };
      return { kind: "allow" };
    },

    enter(principal) {
      detector.enter(principal);
    },

    leave(principal) {
      detector.leave(principal);
    },

    challenge(principal) {
      return challenges.issue(principal);
    },

    redeem(token) {
      return challenges.consume(token);
    },

    noteAuthFailure(principal, reason) {
      detector.noteAuthFailure(principal, reason);
    },

    noteMessage(principal, channelId, body) {
      return detector.noteMessage(principal, channelId, body);
    },

    noteGuildCreated(principal) {
      detector.noteGuildCreated(principal);
    },

    apply(res, decision) {
      if (decision.kind === "allow" || res.headersSent) return;

      if (decision.kind === "rate_limited") {
        const seconds = retryAfterSeconds(decision.retryAfterMs);
        res.setHeader("retry-after", String(seconds));
        writeJson(res, 429, {
          error: `Too many requests. Try again in ${seconds} seconds.`,
          code: "rate_limited",
          retryAfterSeconds: seconds,
        });
        return;
      }

      if (decision.kind === "challenge_required") {
        const seconds = retryAfterSeconds(decision.retryAfterMs);
        res.setHeader("retry-after", String(seconds));
        res.setHeader("x-aegis-challenge", decision.challengeId);
        writeJson(res, 428, {
          error: "Please complete the verification step before continuing.",
          code: "challenge_required",
          challenge: {
            id: decision.challengeId,
            expiresAt: decision.expiresAt,
            retryAfterSeconds: seconds,
          },
        });
        return;
      }

      if (decision.kind === "restricted") {
        const seconds = Math.max(1, Math.ceil((Date.parse(decision.until) - clock()) / 1000));
        res.setHeader("retry-after", String(seconds));
        writeJson(res, 403, { error: decision.message, code: "restricted" });
        return;
      }

      res.setHeader("retry-after", "5");
      writeJson(res, 503, {
        error: "This service cannot verify request limits right now. Try again shortly.",
        code: "unavailable",
        retryAfterSeconds: 5,
      });
    },
  };
}


