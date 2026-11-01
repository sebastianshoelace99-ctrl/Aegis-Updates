import { createHash, randomUUID } from "node:crypto";
import type { SecurityEventKind, SecurityLog } from "./securityLog";

/**
 * Risk assessment and graduated enforcement.
 *
 * The design rule that matters most: **this module never decides a request is allowed.** It
 * produces a score and a recommended level, and the guard enforces it through the same
 * permission-checked server functions every other request goes through. An AI moderator that
 * could call arbitrary operations is an authorization bypass with extra steps, so the seam here
 * is an *incident report*, not a command channel.
 *
 * Every signal below is behavioural (rate, repetition, concurrency, age, history) rather than
 * categorical. Address, user agent and VPN use are deliberately absent as standalone inputs: a
 * campus NAT, a corporate proxy and a screen reader all look unusual, and none of them is
 * evidence of automation. The one address-derived signal - many claimed identities from one
 * address - is marked `ipOnly` and is discarded unless another signal corroborates it, so a
 * shared network never punishes anyone on its own.
 */

export type Principal = {
  /** The id the client claimed. Untrusted: it is a claim, not an authenticated identity. */
  accountId: string | null;
  ip: string;
};

export type RiskLevel = "allow" | "throttle" | "challenge" | "restrict" | "suspend";

export type Signal = {
  id: string;
  weight: number;
  /** True when the signal is derived from the client address alone. */
  ipOnly: boolean;
  detail: Record<string, string | number | boolean | null>;
};

export type AbusePolicy = {
  /** Rolling window for every counter. */
  windowMs: number;
  challengeAt: number;
  restrictAt: number;
  suspendAt: number;
  /** An account younger than this is still "new" and gets tighter limits. */
  newAccountMs: number;
  /** Distinct claimed ids from one address that indicates identity rotation. */
  maxIdentitiesPerIp: number;
  /** Repeats of an identical body in one channel before it counts as spam. */
  identicalMessageLimit: number;
  /** In-flight requests from one principal that indicates a script. */
  maxConcurrent: number;
  /** Guild creations inside the window before it counts as churn. */
  maxGuildCreations: number;
  strikeDecayMs: number;
  restrictionMs: number;
  suspendMs: number;
  /** Ceiling, so no combination of signals can exceed the scale. */
  maxScore: number;
};

/**
 * Defaults are internal. They are never serialised to a client: a published threshold is a
 * published recipe for staying just underneath it.
 */
export const DEFAULT_POLICY: AbusePolicy = {
  windowMs: 10 * 60_000,
  challengeAt: 40,
  restrictAt: 65,
  suspendAt: 85,
  newAccountMs: 10 * 60_000,
  maxIdentitiesPerIp: 3,
  identicalMessageLimit: 5,
  maxConcurrent: 12,
  maxGuildCreations: 4,
  strikeDecayMs: 60 * 60_000,
  restrictionMs: 15 * 60_000,
  suspendMs: 60 * 60_000,
  maxScore: 100,
};

export type Restriction = {
  accountId: string;
  /** Bucket names, or `["*"]` for a full suspension. */
  actions: string[];
  /** Epoch ms. Always finite: there is no permanent automated ban. */
  until: number;
  reason: string;
  createdAt: number;
  /** `automated` or the admin who applied it, so an override is attributable. */
  createdBy: string;
};

/**
 * What a restriction covers. Reads are deliberately absent: silencing someone's access to a
 * conversation they can already see is a punishment, not a control, and it makes a false positive
 * far worse than it needs to be. Frozen so a restriction can never be mutated through a reference.
 */
const RESTRICTED_ACTIONS: readonly string[] = Object.freeze([
  "write:messages",
  "write:uploads",
  "create:guilds",
  "write:guilds",
]);

export type Assessment = {
  score: number;
  level: RiskLevel;
  signals: Signal[];
  /** The account's active restriction, if any. */
  restriction: Restriction | null;
};

export type ModerationIncident = {
  caseId: string;
  at: string;
  accountId: string | null;
  /** Keyed, never raw. */
  ipHash: string | null;
  level: RiskLevel;
  score: number;
  bucket: string | null;
  signals: { id: string; weight: number; detail: Record<string, string | number | boolean | null> }[];
};

export type ModerationCase = ModerationIncident & {
  status: "pending" | "upheld" | "rejected" | "cleared";
  reviewedAt: string | null;
  reviewer: string | null;
  decision: string | null;
};

/**
 * The Watchdog seam.
 *
 * This project has no moderation system yet, so the contract is deliberately one-directional and
 * small: an incident goes out, nothing comes back to execute. When a real Watchdog (or a human
 * queue) exists, it implements `report` and the detector does not change - and because the
 * payload carries no message content, forwarding it cannot leak conversation data.
 */
export type ModerationSink = {
  report(incident: ModerationIncident): void | Promise<void>;
};

export type ModerationQueue = ModerationSink & {
  list(): ModerationCase[];
  review(caseId: string, status: "upheld" | "rejected" | "cleared", reviewer: string): boolean;
  readonly size: number;
};

/**
 * The default sink: a bounded, in-process review queue the admin endpoints read.
 *
 * It drops the oldest case when full rather than growing forever. A dropped case is a moderation
 * miss, not a security decision, so failing soft here is correct.
 */
export function createModerationQueue(options: { maxCases?: number } = {}): ModerationQueue {
  const maxCases = Math.max(1, options.maxCases ?? 500);
  const cases = new Map<string, ModerationCase>();

  const list = (): ModerationCase[] =>
    [...cases.values()].sort((a, b) => b.at.localeCompare(a.at));

  return {
    report(incident) {
      cases.set(incident.caseId, {
        ...incident,
        status: "pending",
        reviewedAt: null,
        reviewer: null,
        decision: null,
      });

      while (cases.size > maxCases) {
        const oldest = list().pop();
        if (!oldest) break;
        cases.delete(oldest.caseId);
      }
    },

    list,

    review(caseId, status, reviewer) {
      const found = cases.get(caseId);
      if (!found) return false;
      cases.set(caseId, {
        ...found,
        status,
        reviewer: reviewer.slice(0, 64),
        reviewedAt: new Date().toISOString(),
        decision: status,
      });
      return true;
    },

    get size() {
      return cases.size;
    },
  };
}

/**
 * Forwards incidents to an external moderation service.
 *
 * Fire-and-forget with a short timeout, and a failure is swallowed on purpose: a moderation
 * webhook that is down must not break a user's request, and it must not cause the detector to
 * retry into a loop. The local queue is still the record of what happened.
 */
export function createWebhookModerationSink(url: string, timeoutMs = 2_000): ModerationSink {
  return {
    report(incident) {
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "aegis.abuse.incident", incident }),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch(() => undefined);
    },
  };
}

export type ChallengeLedger = {
  issue(principal: Principal): { id: string; expiresAt: string; retryAfterMs: number };
  verify(token: string | undefined): boolean;
  readonly size: number;
};

/**
 * The "supported challenge": a cooldown the client has to actually wait out.
 *
 * This is **not** a CAPTCHA and is not claimed to be one. It is the cheapest challenge that raises
 * the cost of a naive script without hurting a person: the server hands out a one-time token, the
 * client waits, then exchanges it for a short pass. Anything that can implement a real provider
 * (hCaptcha, Turnstile) replaces `verify` and nothing else moves; `docs/05-abuse-prevention.md`
 * states exactly where that goes.
 */
export function createChallengeLedger(
  options: { cooldownMs?: number; ttlMs?: number; maxOpen?: number } = {},
): ChallengeLedger & { consume(token: string | undefined): boolean } {
  const cooldownMs = Math.max(0, options.cooldownMs ?? 3_000);
  const ttlMs = Math.max(1_000, options.ttlMs ?? 60_000);
  const maxOpen = Math.max(1, options.maxOpen ?? 5_000);

  /** token -> when it can be redeemed, and when it dies. A pass lives here too. */
  const open = new Map<string, { readyAt: number; expiry: number }>();

  const prune = (now: number): void => {
    for (const [token, entry] of open) {
      if (entry.expiry <= now) open.delete(token);
    }
  };

  const verify = (token: string | undefined): boolean => {
    if (!token) return false;
    const entry = open.get(token);
    if (!entry) return false;

    const now = Date.now();
    if (entry.expiry <= now) {
      open.delete(token);
      return false;
    }
    // Redeeming before the cooldown is the script's move, not the person's.
    return now >= entry.readyAt;
  };

  return {
    issue() {
      const now = Date.now();
      prune(now);
      if (open.size >= maxOpen) {
        const oldest = open.keys().next();
        if (!oldest.done) open.delete(oldest.value);
      }

      const id = randomUUID();
      const readyAt = now + cooldownMs;
      open.set(id, { readyAt, expiry: readyAt + ttlMs });
      return {
        id,
        expiresAt: new Date(readyAt + ttlMs).toISOString(),
        retryAfterMs: cooldownMs,
      };
    },

    verify,

    /** A pass is single-use: one solved challenge buys one request, not an hour of immunity. */
    consume(token) {
      if (!verify(token)) return false;
      if (token) open.delete(token);
      return true;
    },

    get size() {
      return open.size;
    },
  };
}


export type AbuseDetector = {
  policy: AbusePolicy;
  /** Records the principal and starts its clock; cheap enough to call on every request. */
  noteRequest(principal: Principal): void;
  noteAuthFailure(principal: Principal, reason: string): void;
  noteRateLimited(principal: Principal, bucket: string, threshold: number): void;
  noteMessage(principal: Principal, channelId: string, body: string): number;
  noteGuildCreated(principal: Principal): void;
  enter(principal: Principal): void;
  leave(principal: Principal): void;
  assess(principal: Principal): Assessment;
  /** Applies the level's consequence once and returns it, so the caller can enforce it. */
  escalate(principal: Principal, assessment: Assessment, bucket: string): Restriction | null;
  restrictionFor(accountId: string): Restriction | null;
  isNewAccount(accountId: string): boolean;
  appeal(principal: Principal, message: string): ModerationCase;
  override(
    accountId: string,
    decision: "clear" | "restrict" | "suspend",
    minutes: number,
    actor: string,
  ): Restriction | null;
  restrictions(): Restriction[];
  cases(): ModerationCase[];
  summary(): {
    trackedAccounts: number;
    trackedAddresses: number;
    activeRestrictions: number;
    pendingCases: number;
  };
};

type Counter = { count: number; startedAt: number };

/** Per-principal duplicate-body detector. Holds a digest, never the text. */
type DuplicateWatch = { digest: string; count: number; startedAt: number };

const digestOf = (body: string): string =>
  createHash("sha256").update(body.trim().toLowerCase()).digest("hex").slice(0, 16);

/**
 * Drop the oldest entries when a map exceeds `max`.
 *
 * These maps feed *detection*, not enforcement, so losing an entry can only make the detector
 * more forgiving. It can never hand out a fresh allowance: the limiter's buckets are a separate
 * structure that is never evicted while live.
 */
function capMap<K, V>(map: Map<K, V>, max: number): void {
  if (map.size <= max) return;
  const excess = map.size - max;
  let removed = 0;
  for (const key of map.keys()) {
    if (removed >= excess) break;
    map.delete(key);
    removed += 1;
  }
}

export function createAbuseDetector(
  options: {
    policy?: Partial<AbusePolicy>;
    log?: SecurityLog;
    moderation?: ModerationSink;
    /** Injectable clock, so decay and expiry are testable without sleeping. */
    now?: () => number;
  } = {},
): AbuseDetector {
  const policy: AbusePolicy = { ...DEFAULT_POLICY, ...options.policy };
  const log = options.log;
  const moderation = options.moderation;
  const clock = options.now ?? Date.now;
  const maxAccounts = 10_000;
  const maxAddresses = 10_000;

  /** accountId -> first time this process saw it. */
  const firstSeen = new Map<string, number>();
  /** ip -> accountId -> last seen. Bounded on both axes. */
  const identities = new Map<string, Map<string, number>>();
  const rateLimitHits = new Map<string, Counter>();
  const authFailures = new Map<string, Counter>();
  const guildCreations = new Map<string, Counter>();
  const duplicates = new Map<string, DuplicateWatch>();
  const inFlight = new Map<string, number>();
  const concurrencyHits = new Map<string, Counter>();
  /** accountId -> {count, at}. Decays, so an old incident stops counting. */
  const strikes = new Map<string, Counter>();
  const activeRestrictions = new Map<string, Restriction>();
  const caseLog: ModerationCase[] = [];

  const accountKey = (principal: Principal): string =>
    principal.accountId ? `acct:${principal.accountId}` : `ip:${principal.ip}`;

  const bump = (map: Map<string, Counter>, key: string, now: number, max: number): number => {
    const current = map.get(key);
    if (!current || now - current.startedAt > policy.windowMs) {
      map.set(key, { count: 1, startedAt: now });
      capMap(map, max);
      return 1;
    }
    current.count += 1;
    return current.count;
  };

  const countOf = (map: Map<string, Counter>, key: string, now: number): number => {
    const current = map.get(key);
    if (!current) return 0;
    if (now - current.startedAt > policy.windowMs) return 0;
    return current.count;
  };

  const strikeCount = (accountId: string | null, now: number): number => {
    if (!accountId) return 0;
    const record = strikes.get(accountId);
    if (!record) return 0;
    if (now - record.startedAt > policy.strikeDecayMs) return 0;
    return record.count;
  };


  /** accountKey -> highest repeat count seen this window, for O(1) assessment. */
  const repeatPeak = new Map<string, DuplicateWatch>();

  const record = (
    kind: SecurityEventKind,
    principal: Principal,
    reason: string,
    action: string,
    extra: {
      bucket?: string | null;
      count?: number | null;
      threshold?: number | null;
      detail?: Record<string, string | number | boolean | null>;
    } = {},
  ): void => {
    log?.record({
      kind,
      accountId: principal.accountId,
      ip: principal.ip,
      bucket: extra.bucket ?? null,
      count: extra.count ?? null,
      threshold: extra.threshold ?? null,
      reason,
      action,
      detail: extra.detail ?? {},
    });
  };

  const levelFor = (score: number): RiskLevel => {
    if (score >= policy.suspendAt) return "suspend";
    if (score >= policy.restrictAt) return "restrict";
    if (score >= policy.challengeAt) return "challenge";
    return "allow";
  };

  const restrictionFor = (accountId: string): Restriction | null => {
    const found = activeRestrictions.get(accountId);
    if (!found) return null;
    if (found.until <= clock()) {
      activeRestrictions.delete(accountId);
      return null;
    }
    return { ...found, actions: [...found.actions] };
  };

  return {
    policy,

    noteRequest(principal) {
      const now = clock();
      if (!principal.accountId) return;

      if (!firstSeen.has(principal.accountId)) {
        firstSeen.set(principal.accountId, now);
        capMap(firstSeen, maxAccounts);
      }

      let perAddress = identities.get(principal.ip);
      if (!perAddress) {
        perAddress = new Map();
        identities.set(principal.ip, perAddress);
        capMap(identities, maxAddresses);
      }
      perAddress.set(principal.accountId, now);
      capMap(perAddress, 32);
    },

    noteAuthFailure(principal, reason) {
      const now = clock();
      const key = accountKey(principal);
      const count = bump(authFailures, key, now, maxAccounts);
      record("auth_failure", principal, reason, "none", { count });
    },

    noteRateLimited(principal, bucket, threshold) {
      const now = clock();
      const count = bump(rateLimitHits, accountKey(principal), now, maxAccounts);
      record("rate_limited", principal, "request rate exceeded", "throttled", {
        bucket,
        count,
        threshold,
      });
    },

    noteMessage(principal, channelId, body) {
      const now = clock();
      const key = `${accountKey(principal)}|${channelId}`;
      const digest = digestOf(body);
      const current = duplicates.get(key);

      let count: number;
      if (!current || current.digest !== digest || now - current.startedAt > policy.windowMs) {
        count = 1;
        duplicates.set(key, { digest, count, startedAt: now });
        capMap(duplicates, maxAccounts);
      } else {
        current.count += 1;
        count = current.count;
      }

      const peak = repeatPeak.get(accountKey(principal));
      if (!peak || now - peak.startedAt > policy.windowMs) {
        repeatPeak.set(accountKey(principal), { digest: "", count, startedAt: now });
        capMap(repeatPeak, maxAccounts);
      } else if (count > peak.count) {
        peak.count = count;
      }

      return count;
    },

    noteGuildCreated(principal) {
      const now = clock();
      bump(guildCreations, accountKey(principal), now, maxAccounts);
    },

    enter(principal) {
      const key = accountKey(principal);
      const next = (inFlight.get(key) ?? 0) + 1;
      inFlight.set(key, next);
      capMap(inFlight, maxAccounts);

      if (next > policy.maxConcurrent) {
        // Recorded once per breach of the window, not once per request: a slow endpoint that
        // legitimately holds a connection should not climb the score on its own.
        const already = countOf(concurrencyHits, key, clock());
        if (already === 0) bump(concurrencyHits, key, clock(), maxAccounts);
      }
    },

    leave(principal) {
      const key = accountKey(principal);
      const next = (inFlight.get(key) ?? 0) - 1;
      if (next <= 0) inFlight.delete(key);
      else inFlight.set(key, next);
    },


    assess(principal) {
      const now = clock();
      const key = accountKey(principal);
      const signals: Signal[] = [];

      const hits = countOf(rateLimitHits, key, now);
      if (hits >= 3) {
        signals.push({
          id: "rate_limit_hits",
          weight: Math.min(36, hits * 6),
          ipOnly: false,
          detail: { hits },
        });
      }

      const peak = repeatPeak.get(key);
      const repeats = peak && now - peak.startedAt <= policy.windowMs ? peak.count : 0;
      if (repeats >= policy.identicalMessageLimit) {
        // Capped below `restrictAt + new-account weight` on purpose: repetition alone can reach a
        // restriction but never a suspension. Suspension needs corroboration, so that one noisy
        // bot script cannot get a person locked out on a single signal.
        signals.push({
          id: "repeated_messages",
          weight: Math.min(65, 15 + (repeats - policy.identicalMessageLimit) * 10),
          ipOnly: false,
          detail: { repeats },
        });
      }

      const failures = countOf(authFailures, key, now);
      if (failures >= 3) {
        signals.push({
          id: "auth_failures",
          weight: Math.min(30, failures * 10),
          ipOnly: false,
          detail: { failures },
        });
      }

      const created = countOf(guildCreations, key, now);
      if (created > policy.maxGuildCreations) {
        signals.push({
          id: "guild_churn",
          weight: 14,
          ipOnly: false,
          detail: { created },
        });
      }

      const concurrency = countOf(concurrencyHits, key, now);
      if (concurrency > 0) {
        signals.push({
          id: "concurrency",
          weight: 12,
          ipOnly: false,
          detail: { peak: policy.maxConcurrent },
        });
      }

      if (principal.accountId) {
        const seen = firstSeen.get(principal.accountId);
        if (seen !== undefined && now - seen < policy.newAccountMs) {
          signals.push({
            id: "new_account",
            weight: 8,
            ipOnly: false,
            detail: { ageMs: now - seen },
          });
        }
      }

      const accounts = identities.get(principal.ip);
      if (accounts && accounts.size > policy.maxIdentitiesPerIp) {
        signals.push({
          id: "identity_rotation",
          // Address-derived by construction, and therefore never sufficient on its own.
          weight: 25,
          ipOnly: true,
          detail: { accounts: accounts.size },
        });
      }

      const prior = strikeCount(principal.accountId, now);
      if (prior > 0) {
        signals.push({
          id: "prior_strikes",
          weight: Math.min(30, prior * 15),
          ipOnly: false,
          detail: { strikes: prior },
        });
      }

      const corroborated = signals.some((signal) => !signal.ipOnly);
      const total = signals.reduce((sum, signal) => sum + signal.weight, 0);
      const score = Math.min(policy.maxScore, total);

      // The rule that keeps a shared campus NAT out of trouble: address-only evidence is
      // reported (so it is auditable) but cannot raise the level by itself.
      const level: RiskLevel = corroborated ? levelFor(score) : "allow";

      return {
        score,
        level,
        signals,
        restriction: principal.accountId ? restrictionFor(principal.accountId) : null,
      };
    },

    escalate(principal, assessment, bucket) {
      const { level } = assessment;
      if (level !== "restrict" && level !== "suspend") return null;

      // An anonymous caller has no account to restrict. The rate limiter still applies, and the
      // incident is still logged - enforcement without an identity would mean blocking an
      // address, which is exactly what this design refuses to do.
      const accountId = principal.accountId;
      if (!accountId) return null;

      const now = clock();
      const suspended = level === "suspend";
      const until = now + (suspended ? policy.suspendMs : policy.restrictionMs);
      const existing = activeRestrictions.get(accountId);
      if (existing && existing.until >= until) return { ...existing, actions: [...existing.actions] };

      const reason = assessment.signals
        .filter((signal) => !signal.ipOnly)
        .map((signal) => signal.id)
        .join(",");

      const restriction: Restriction = {
        accountId,
        actions: suspended ? ["*"] : [...RESTRICTED_ACTIONS],
        until,
        reason: reason.length > 0 ? `automated:${reason}` : "automated:risk",
        createdAt: now,
        createdBy: "automated",
      };
      activeRestrictions.set(accountId, restriction);
      capMap(activeRestrictions, maxAccounts);

      const strike = strikes.get(accountId);
      if (!strike || now - strike.startedAt > policy.strikeDecayMs) {
        strikes.set(accountId, { count: 1, startedAt: now });
      } else {
        strike.count += 1;
      }

      record(suspended ? "suspended" : "restricted", principal, restriction.reason, suspended ? "suspended" : "restricted", {
        bucket,
        count: assessment.score,
        threshold: suspended ? policy.suspendAt : policy.restrictAt,
        detail: { until: new Date(until).toISOString(), actions: restriction.actions.join(" ") },
      });

      const incident: ModerationIncident = {
        caseId: randomUUID(),
        at: new Date(now).toISOString(),
        accountId,
        ipHash: log?.fingerprint(principal.ip) ?? null,
        level,
        score: assessment.score,
        bucket,
        signals: assessment.signals.map((signal) => ({
          id: signal.id,
          weight: signal.weight,
          detail: signal.detail,
        })),
      };

      if (moderation) {
        void Promise.resolve()
          .then(() => moderation.report(incident))
          .catch(() => undefined);
      }

      caseLog.unshift({ ...incident, status: "pending", reviewedAt: null, reviewer: null, decision: null });
      while (caseLog.length > 500) caseLog.pop();

      return restriction;
    },

    restrictionFor(accountId) {
      return restrictionFor(accountId);
    },

    isNewAccount(accountId) {
      const seen = firstSeen.get(accountId);
      return seen !== undefined && clock() - seen < policy.newAccountMs;
    },

    appeal(principal, message) {
      const now = clock();
      const assessment = this.assess(principal);
      const item: ModerationCase = {
        caseId: randomUUID(),
        at: new Date(now).toISOString(),
        accountId: principal.accountId,
        ipHash: log?.fingerprint(principal.ip) ?? null,
        level: assessment.level,
        score: assessment.score,
        bucket: null,
        signals: assessment.signals.map((signal) => ({
          id: signal.id,
          weight: signal.weight,
          detail: signal.detail,
        })),
        status: "pending",
        reviewedAt: null,
        reviewer: null,
        // The user's own words, truncated. This is the one place client text is stored, and it is
        // kept out of the security log (which is why `record` above takes no message argument).
        decision: message.slice(0, 500),
      };

      caseLog.unshift(item);
      while (caseLog.length > 500) caseLog.pop();

      record("appeal", principal, "user requested human review", "none", {
        detail: { case: item.caseId, restricted: assessment.restriction ? true : false },
      });

      if (moderation) {
        void Promise.resolve()
          .then(() =>
            moderation.report({
              caseId: item.caseId,
              at: item.at,
              accountId: item.accountId,
              ipHash: item.ipHash,
              level: item.level,
              score: item.score,
              bucket: null,
              signals: item.signals,
            }),
          )
          .catch(() => undefined);
      }

      return item;
    },

    override(accountId, decision, minutes, actor) {
      const now = clock();
      if (decision === "clear") {
        activeRestrictions.delete(accountId);
        record(
          "override",
          { accountId, ip: "admin" },
          "restriction cleared by an operator",
          "cleared",
          { detail: { actor } },
        );
        return null;
      }

      const until = now + Math.max(1, minutes) * 60_000;
      const restriction: Restriction = {
        accountId,
        actions: decision === "suspend" ? ["*"] : [...RESTRICTED_ACTIONS],
        until,
        reason: `manual:${decision}`,
        createdAt: now,
        createdBy: actor,
      };
      activeRestrictions.set(accountId, restriction);
      record("override", { accountId, ip: "admin" }, restriction.reason, decision, {
        detail: { actor, until: new Date(until).toISOString() },
      });
      return restriction;
    },

    restrictions() {
      const now = clock();
      const out: Restriction[] = [];
      for (const [accountId, restriction] of activeRestrictions) {
        if (restriction.until <= now) {
          activeRestrictions.delete(accountId);
          continue;
        }
        out.push({ ...restriction, actions: [...restriction.actions] });
      }
      return out.sort((a, b) => a.until - b.until);
    },

    cases() {
      return caseLog.map((item) => ({ ...item, signals: item.signals.map((s) => ({ ...s })) }));
    },

    summary() {
      const now = clock();
      let active = 0;
      for (const restriction of activeRestrictions.values()) {
        if (restriction.until > now) active += 1;
      }

      return {
        trackedAccounts: firstSeen.size,
        trackedAddresses: identities.size,
        activeRestrictions: active,
        pendingCases: caseLog.filter((item) => item.status === "pending").length,
      };
    },
  };
}

