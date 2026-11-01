/**
 * Rate limiting, as a token bucket with a pluggable store.
 *
 * Three decisions are load-bearing, so they are stated here rather than buried in the code:
 *
 *  1. **Token bucket, not a fixed window.** A fixed window lets a client send a full window's
 *     allowance at 00:59 and again at 01:00 - twice the intended rate across any real interval,
 *     and it makes `Retry-After` lie. A bucket refills continuously, so `burst` and `perMinute`
 *     are independent knobs: `burst` is what a tab may do on first paint, `perMinute` is what it
 *     may sustain.
 *
 *  2. **`consume` is async and takes `now`.** Async because a second server instance must share
 *     the state (an in-process counter behind a load balancer is not a limit, it is a suggestion),
 *     and `now` because a clock read inside the store would make the arithmetic untestable.
 *
 *  3. **The store never forgets a live bucket.** An attacker that mints a new identifier per
 *     request would otherwise evict existing buckets and earn a full burst every time. When the
 *     key space is full, new keys share one overflow bucket: the limit degrades to a global one,
 *     it never resets.
 */

/** `burst`: requests allowed back-to-back from idle. `perMinute`: sustained refill. */
export type RateLimitRule = {
  burst: number;
  perMinute: number;
};

export type ConsumeResult = {
  allowed: boolean;
  /** Whole requests still available. Advisory only - never sent to a client as a limit. */
  remaining: number;
  /** Milliseconds until `cost` tokens exist again. `0` when the request was allowed. */
  retryAfterMs: number;
  /** The bucket's capacity for this call. Internal: it is a detection threshold. */
  limit: number;
};

export type RateLimitStore = {
  readonly kind: "memory" | "postgres";
  consume(key: string, rule: RateLimitRule, cost: number, now: number): Promise<ConsumeResult>;
};

/** One bucket's persisted state. Exported so the Postgres store and the tests agree on it. */
export type Bucket = { tokens: number; updatedAt: number };

/** Tokens per millisecond. A zero rate would divide by zero in `Retry-After`, so it is floored. */
export function refillRate(rule: RateLimitRule): number {
  const perMinute = Number.isFinite(rule.perMinute) ? rule.perMinute : 0;
  return Math.max(perMinute, 0.001) / 60_000;
}

/**
 * The whole algorithm, pure: refill, then spend, or report the wait.
 *
 * `elapsed` is clamped at zero: a clock that jumps backwards must not mint tokens it never earned.
 */
export function takeFrom(
  bucket: Bucket | undefined,
  rule: RateLimitRule,
  cost: number,
  now: number,
): { bucket: Bucket; result: ConsumeResult } {
  const capacity = Math.max(1, Number.isFinite(rule.burst) ? rule.burst : 1);
  const rate = refillRate(rule);
  const elapsed = bucket ? Math.max(0, now - bucket.updatedAt) : 0;
  const tokens = Math.min(capacity, (bucket?.tokens ?? capacity) + elapsed * rate);
  const needed = Math.max(0, Number.isFinite(cost) ? cost : 1);

  if (tokens >= needed) {
    const left = tokens - needed;
    return {
      bucket: { tokens: left, updatedAt: now },
      result: { allowed: true, remaining: Math.floor(left), retryAfterMs: 0, limit: capacity },
    };
  }

  return {
    bucket: { tokens, updatedAt: now },
    result: {
      allowed: false,
      remaining: 0,
      // At least 1 ms: a `Retry-After` of zero invites an immediate retry storm.
      retryAfterMs: Math.max(1, Math.ceil((needed - tokens) / rate)),
      limit: capacity,
    },
  };
}

/** `Retry-After` is whole seconds, and never `0` - see above. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}


export type MemoryRateLimitStore = RateLimitStore & {
  readonly size: number;
  clear(): void;
};

/**
 * The single-process store: a Map, swept only when it fills.
 *
 * Sweeping removes buckets that have been idle longer than any rule's window, which is safe: an
 * idle bucket has refilled to capacity anyway, so dropping it and recreating it gives the same
 * answer. Live buckets are never dropped, because dropping one is a bypass.
 */
export function createMemoryRateLimitStore(
  options: { maxKeys?: number; idleMs?: number } = {},
): MemoryRateLimitStore {
  const maxKeys = Math.max(1, options.maxKeys ?? 20_000);
  const idleMs = Math.max(1_000, options.idleMs ?? 30 * 60_000);
  const buckets = new Map<string, Bucket>();

  /** One shared bucket once the key space is exhausted; `\u0000` cannot collide with a real key. */
  const OVERFLOW = "\u0000overflow";

  const sweep = (now: number): void => {
    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt > idleMs) buckets.delete(key);
    }
  };

  return {
    kind: "memory",

    get size() {
      return buckets.size;
    },

    clear() {
      buckets.clear();
    },

    async consume(key, rule, cost, now) {
      let slot = key;
      if (!buckets.has(key) && buckets.size >= maxKeys) {
        sweep(now);
        if (buckets.size >= maxKeys) slot = OVERFLOW;
      }

      const next = takeFrom(buckets.get(slot), rule, cost, now);
      buckets.set(slot, next.bucket);
      return next.result;
    },
  };
}

/**
 * The shared store: one atomic upsert per check, executed inside Postgres.
 *
 * The refill arithmetic lives in `aegis_rate_limit_consume` (see
 * `Supabase/03-abuse-prevention.sql`) rather than here, because read-modify-write across two
 * instances is a race, and the database already has row locks. This is therefore a thin client:
 * if it cannot reach the database it throws, and the guard decides what "cannot verify" means for
 * that endpoint.
 */
export function createPostgresRateLimitStore(config: {
  url: string;
  key: string;
  timeoutMs?: number;
}): RateLimitStore {
  const base = `${config.url.replace(/\/+$/, "")}/rest/v1`;
  const timeoutMs = Math.max(250, config.timeoutMs ?? 1_500);

  return {
    kind: "postgres",

    async consume(key, rule, cost, now) {
      const capacity = Math.max(1, rule.burst);
      const response = await fetch(`${base}/rpc/aegis_rate_limit_consume`, {
        method: "POST",
        headers: {
          apikey: config.key,
          authorization: `Bearer ${config.key}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          p_key: key,
          p_capacity: capacity,
          p_refill_per_ms: refillRate(rule),
          p_cost: Math.max(0, cost),
          p_now: new Date(now).toISOString(),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`rate limit store rejected the call: ${response.status}`);
      }

      const rows = (await response.json()) as
        | { allowed?: unknown; remaining?: unknown; retry_after_ms?: unknown }[]
        | null;
      const row = rows?.[0];
      if (!row || typeof row.allowed !== "boolean") {
        throw new Error("rate limit store returned no decision");
      }

      return {
        allowed: row.allowed,
        remaining: Math.max(0, Math.floor(Number(row.remaining ?? 0))),
        retryAfterMs: Math.max(0, Math.ceil(Number(row.retry_after_ms ?? 0))),
        limit: capacity,
      };
    },
  };
}
