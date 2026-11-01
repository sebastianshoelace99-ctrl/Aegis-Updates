import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryRateLimitStore,
  createPostgresRateLimitStore,
  retryAfterSeconds,
  takeFrom,
} from "./rateLimit";

/**
 * The limiter, tested where it is easiest to be wrong: the arithmetic, the shared state, and the
 * two ways a limiter silently stops limiting (an evicted bucket, and a new identifier).
 */

const RULE = { burst: 3, perMinute: 60 };
const T0 = 1_700_000_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token bucket arithmetic", () => {
  it("allows a burst, then refuses and reports the wait", () => {
    const at = T0;
    let bucket = takeFrom(undefined, RULE, 1, at).bucket;

    // Three from empty at the same instant: the burst, exactly.
    for (let index = 0; index < 2; index += 1) {
      const next = takeFrom(bucket, RULE, 1, at);
      expect(next.result.allowed).toBe(true);
      bucket = next.bucket;
    }
    expect(bucket.tokens).toBe(0);

    const denied = takeFrom(bucket, RULE, 1, at);
    expect(denied.result.allowed).toBe(false);
    // burst 3 over 60 s is one token per second, so a deficit of one token is one second.
    expect(denied.result.retryAfterMs).toBe(1_000);
    expect(retryAfterSeconds(denied.result.retryAfterMs)).toBe(1);
  });

  it("refills continuously rather than in windows", () => {
    const spent = takeFrom(undefined, RULE, 3, T0);
    expect(spent.result.allowed).toBe(true);

    // Half a token after 500 ms: still refused, but with half the wait.
    const midway = takeFrom(spent.bucket, RULE, 1, T0 + 500);
    expect(midway.result.allowed).toBe(false);
    expect(midway.result.retryAfterMs).toBe(500);

    const later = takeFrom(midway.bucket, RULE, 1, T0 + 1_000);
    expect(later.result.allowed).toBe(true);
  });

  it("never exceeds capacity after a long idle period", () => {
    const spent = takeFrom(undefined, RULE, 3, T0).bucket;
    const later = takeFrom(spent, RULE, 1, T0 + 24 * 60 * 60_000);
    expect(later.result.allowed).toBe(true);
    // One spent from a full bucket, not from a bucket that accrued a day of tokens.
    expect(later.bucket.tokens).toBe(2);
  });

  it("does not mint tokens when the clock goes backwards", () => {
    const spent = takeFrom(undefined, RULE, 3, T0).bucket;
    const rewound = takeFrom(spent, RULE, 1, T0 - 60_000);
    expect(rewound.result.allowed).toBe(false);
  });
});

describe("in-process store", () => {
  it("separates buckets and shares state between consumers of one store", async () => {
    const store = createMemoryRateLimitStore();

    for (let index = 0; index < 3; index += 1) {
      expect((await store.consume("a", RULE, 1, T0)).allowed).toBe(true);
    }

    // Same store, same key, a different call: the budget is spent. A second server instance
    // sharing this store would observe exactly this.
    expect((await store.consume("a", RULE, 1, T0)).allowed).toBe(false);
    expect((await store.consume("b", RULE, 1, T0)).allowed).toBe(true);
  });

  it("refills over time for the same key", async () => {
    const store = createMemoryRateLimitStore();
    await store.consume("a", RULE, 3, T0);
    expect((await store.consume("a", RULE, 1, T0)).allowed).toBe(false);
    expect((await store.consume("a", RULE, 1, T0 + 1_000)).allowed).toBe(true);
  });

  it("degrades to one shared bucket instead of evicting a live one", async () => {
    // The bypass this prevents: mint a key per request, evict someone else's bucket, take a fresh
    // burst. With two slots, the third key has to share.
    const store = createMemoryRateLimitStore({ maxKeys: 2, idleMs: 60_000 });
    const rule = { burst: 2, perMinute: 60 };

    expect((await store.consume("a", rule, 1, T0)).allowed).toBe(true);
    expect((await store.consume("b", rule, 1, T0)).allowed).toBe(true);

    // A new identifier gets the overflow bucket, not a brand-new full one.
    expect((await store.consume("c", rule, 1, T0)).allowed).toBe(true);
    expect((await store.consume("d", rule, 1, T0)).allowed).toBe(true);
    expect((await store.consume("e", rule, 1, T0)).allowed).toBe(false);

    // And the live buckets kept their own remaining budget.
    expect((await store.consume("a", rule, 1, T0)).allowed).toBe(true);
  });

  it("sweeps idle buckets so the map cannot grow without a ceiling", async () => {
    const store = createMemoryRateLimitStore({ maxKeys: 2, idleMs: 1_000 });
    await store.consume("a", RULE, 1, T0);
    await store.consume("b", RULE, 1, T0);
    // Two minutes later both are idle, so a third key gets its own bucket, not the overflow one.
    expect((await store.consume("c", RULE, 1, T0 + 120_000)).allowed).toBe(true);
    expect(store.size).toBeLessThanOrEqual(3);
  });
});

describe("shared Postgres store", () => {
  it("calls the atomic RPC and maps its row", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ allowed: true, remaining: 4, retry_after_ms: 0 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const store = createPostgresRateLimitStore({
      url: "https://project.supabase.co/",
      key: "service-role",
    });

    const result = await store.consume("acct:x", { burst: 5, perMinute: 60 }, 1, T0);
    expect(result).toEqual({ allowed: true, remaining: 4, retryAfterMs: 0, limit: 5 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://project.supabase.co/rest/v1/rpc/aegis_rate_limit_consume");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ p_key: "acct:x", p_capacity: 5, p_cost: 1 });
    expect(body.p_refill_per_ms).toBeCloseTo(60 / 60_000, 9);
  });

  it("throws rather than inventing an allowance when the database rejects the call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const store = createPostgresRateLimitStore({ url: "https://project.supabase.co", key: "k" });
    await expect(store.consume("k", RULE, 1, T0)).rejects.toThrow(/rejected/);
  });

  it("throws when the network is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const store = createPostgresRateLimitStore({ url: "https://project.supabase.co", key: "k" });
    await expect(store.consume("k", RULE, 1, T0)).rejects.toThrow(/ECONNREFUSED/);
  });
});

