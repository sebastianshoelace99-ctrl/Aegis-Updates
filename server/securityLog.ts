import { createHmac, randomBytes } from "node:crypto";

/**
 * The security event log.
 *
 * It is a bounded ring buffer in memory, not a table, and that is a deliberate first step rather
 * than an oversight: it keeps `npm run server` dependency-free and it cannot fail the request it
 * is describing. `Supabase/03-abuse-prevention.sql` documents the durable shape to move to when
 * the deployment grows a second instance.
 *
 * Two rules make the log safe to keep around:
 *
 *  1. **No payloads.** An event names the endpoint, the bucket, the count and the threshold. It
 *     never contains a message body, a token, a password, an API key or a request header. The
 *     `detail` bag is filtered against a deny list *and* restricted to scalar values, so a caller
 *     cannot smuggle a nested object past it.
 *  2. **Addresses are keyed, not stored.** A SHA-256 of an IPv4 address is a lookup table with
 *     4.3 billion rows - trivially reversible. An HMAC with a secret salt is not, so `ipHash` is
 *     an HMAC, and the salt is per-process when none is configured. That makes correlation
 *     within one run possible and correlation across runs impossible by default, which is the
 *     honest trade for a log that exists to answer "did one client do this repeatedly".
 */

export type SecurityEventKind =
  | "rate_limited"
  | "challenge"
  | "restricted"
  | "suspended"
  | "risk_flag"
  | "auth_failure"
  | "appeal"
  | "override"
  | "degraded";

export type SecurityEvent = {
  /** ISO-8601, always UTC `Z`. */
  at: string;
  kind: SecurityEventKind;
  /** Which rate-limit bucket answered, e.g. `write:messages`. Never a user-supplied value. */
  bucket: string | null;
  accountId: string | null;
  /** HMAC of the client address. See the note above. */
  ipHash: string | null;
  /** Requests in the window that produced this event, when there is a count. */
  count: number | null;
  /** The configured threshold that was crossed, when there is one. */
  threshold: number | null;
  /** Short, server-authored explanation. */
  reason: string;
  /** What the server did: `none`, `throttled`, `challenged`, `restricted`, `suspended`. */
  action: string;
  detail: Record<string, string | number | boolean | null>;
};

export type SecurityLogQuery = {
  limit?: number;
  kind?: SecurityEventKind;
  accountId?: string;
  since?: string;
};

export type SecurityLog = {
  record(entry: Omit<SecurityEvent, "at" | "ipHash"> & { at?: string; ip?: string | null }): void;
  /** Newest first, already redacted and bounded. */
  list(query?: SecurityLogQuery): SecurityEvent[];
  readonly size: number;
  /** Stable within one process, unlinkable across restarts unless a salt is configured. */
  fingerprint(ip: string): string;
};

/**
 * Field names that must never reach the log, checked case-insensitively on every `detail` key.
 * `body` and `content` are here because a moderation reason that quotes the offending message
 * turns the security log into a copy of the message table.
 */
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|body|content|message|email/i;

const MAX_DETAIL_KEYS = 12;
const MAX_DETAIL_STRING = 120;

/** Scalars only, deny-listed keys dropped, strings truncated. Returns a new object. */
export function redactDetail(raw: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const clean: Record<string, string | number | boolean | null> = {};
  if (!raw) return clean;

  let kept = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= MAX_DETAIL_KEYS) break;
    if (SENSITIVE_KEY.test(key)) continue;

    if (value === null || typeof value === "boolean") {
      clean[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof value === "string") {
      clean[key] = value.slice(0, MAX_DETAIL_STRING);
    } else {
      // Objects, arrays and functions are dropped rather than stringified: `JSON.stringify` of an
      // arbitrary object is exactly how a token ends up in a log line.
      continue;
    }
    kept += 1;
  }

  return clean;
}

export type SecurityLogOptions = {
  /** Ring size. Older events are dropped first; the log must never grow without a ceiling. */
  maxEntries?: number;
  /** Age after which an event is dropped at the next prune. */
  retentionMs?: number;
  /** HMAC key for `ipHash`. Random per process when empty. */
  salt?: string;
};

export function createSecurityLog(options: SecurityLogOptions = {}): SecurityLog {
  const maxEntries = Math.max(1, options.maxEntries ?? 5_000);
  const retentionMs = Math.max(60_000, options.retentionMs ?? 7 * 24 * 60 * 60_000);
  const salt = options.salt && options.salt.length > 0 ? options.salt : randomBytes(32).toString("hex");

  /** Oldest first: push and shift are both O(1) amortised, which a `splice` is not. */
  const events: SecurityEvent[] = [];

  const fingerprint = (ip: string): string =>
    createHmac("sha256", salt).update(ip).digest("hex").slice(0, 32);

  const prune = (now: number): void => {
    const cutoff = now - retentionMs;
    while (events.length > 0) {
      const oldest = events[0];
      if (!oldest) break;
      if (events.length <= maxEntries && Date.parse(oldest.at) >= cutoff) break;
      events.shift();
    }
  };

  return {
    record(entry) {
      const now = Date.now();
      const at = entry.at ?? new Date(now).toISOString();
      // A timestamp from the future would pin an event forever; a garbage one is worse than a
      // slightly wrong one, so an unparsable value is replaced rather than trusted.
      const stamp = Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : new Date(now).toISOString();

      events.push({
        at: stamp,
        kind: entry.kind,
        bucket: entry.bucket,
        accountId: entry.accountId,
        ipHash: entry.ip ? fingerprint(entry.ip) : null,
        count: entry.count,
        threshold: entry.threshold,
        reason: entry.reason.slice(0, 200),
        action: entry.action.slice(0, 40),
        detail: redactDetail(entry.detail),
      });

      prune(now);
    },

    list(query = {}) {
      const limit = Math.min(200, Math.max(1, query.limit ?? 50));
      const since = query.since ? Date.parse(query.since) : Number.NaN;
      const out: SecurityEvent[] = [];

      for (let index = events.length - 1; index >= 0 && out.length < limit; index -= 1) {
        const event = events[index];
        if (!event) continue;
        if (query.kind && event.kind !== query.kind) continue;
        if (query.accountId && event.accountId !== query.accountId) continue;
        if (Number.isFinite(since) && Date.parse(event.at) < since) continue;
        out.push(event);
      }

      return out;
    },

    get size() {
      return events.length;
    },

    fingerprint,
  };
}

