import { describe, expect, it } from "vitest";
import { createSecurityLog, redactDetail } from "./securityLog";

/**
 * The log is the audit trail that makes enforcement reviewable, so what it *refuses* to store
 * matters as much as what it does.
 */

const base = {
  kind: "rate_limited" as const,
  bucket: "write:messages",
  accountId: "nyx",
  count: 9,
  threshold: 8,
  reason: "request rate exceeded",
  action: "throttled",
  detail: {},
};

describe("redaction", () => {
  it("drops secrets, payloads and nested values", () => {
    const clean = redactDetail({
      endpoint: "/api/channels/x/messages",
      token: "abc123",
      password: "hunter2",
      apiKey: "service-role",
      authorization: "Bearer x",
      body: "the whole message",
      messageContent: "secret plans",
      nested: { token: "still secret" },
      list: [1, 2, 3],
      count: 4,
      ok: true,
    });

    expect(clean).toEqual({
      endpoint: "/api/channels/x/messages",
      count: 4,
      ok: true,
    });
  });

  it("keeps a bounded number of bounded strings", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 30; index += 1) wide[`field${index}`] = "x".repeat(500);

    const clean = redactDetail(wide);
    expect(Object.keys(clean).length).toBeLessThanOrEqual(12);
    for (const value of Object.values(clean)) {
      expect(String(value).length).toBeLessThanOrEqual(120);
    }
  });
});

describe("security log", () => {
  it("stores a keyed address, never the raw one", () => {
    const log = createSecurityLog({ salt: "fixed" });
    log.record({ ...base, ip: "203.0.113.7" });

    const [event] = log.list();
    expect(event?.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(event)).not.toContain("203.0.113.7");
  });

  it("keys the same address identically within a process and differently across salts", () => {
    const a = createSecurityLog({ salt: "one" });
    const b = createSecurityLog({ salt: "two" });
    expect(a.fingerprint("203.0.113.7")).toBe(a.fingerprint("203.0.113.7"));
    expect(a.fingerprint("203.0.113.7")).not.toBe(b.fingerprint("203.0.113.7"));
  });

  it("returns newest first and filters", () => {
    const log = createSecurityLog({ salt: "fixed" });
    const now = Date.now();
    const at = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

    log.record({ ...base, at: at(-3_000) });
    log.record({ ...base, kind: "challenge", action: "challenged", at: at(-2_000) });
    log.record({ ...base, accountId: "other", at: at(-1_000) });

    expect(log.list().map((event) => event.at)).toEqual([at(-1_000), at(-2_000), at(-3_000)]);
    expect(log.list({ kind: "challenge" })).toHaveLength(1);
    expect(log.list({ accountId: "other" })).toHaveLength(1);
    expect(log.list({ since: at(-1_500) })).toHaveLength(1);
  });

  it("caps the ring buffer", () => {
    const log = createSecurityLog({ salt: "fixed", maxEntries: 3 });
    for (let index = 0; index < 10; index += 1) {
      log.record({ ...base, count: index });
    }
    expect(log.size).toBe(3);
    // The survivors are the newest three.
    expect(log.list().map((event) => event.count)).toEqual([9, 8, 7]);
  });

  it("drops events past the retention window", () => {
    const log = createSecurityLog({ salt: "fixed", retentionMs: 60_000 });
    log.record({ ...base, at: new Date(Date.now() - 120_000).toISOString() });
    expect(log.size).toBe(0);
  });

  it("clamps the page size and replaces an unparsable timestamp", () => {
    const log = createSecurityLog({ salt: "fixed" });
    log.record({ ...base, at: "not a date" });
    const [event] = log.list({ limit: 10_000 });
    expect(Number.isFinite(Date.parse(event?.at ?? ""))).toBe(true);
    expect(log.list({ limit: 0 }).length).toBeLessThanOrEqual(1);
  });
});
