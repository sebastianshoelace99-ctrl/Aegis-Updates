import { describe, expect, it, vi } from "vitest";
import { createAbuseDetector, createChallengeLedger, type Principal } from "./abuse";
import { createSecurityLog } from "./securityLog";

/**
 * Risk and enforcement.
 *
 * The clock is injected, so "ten minutes later" costs nothing. Every assertion here is about a
 * *decision*, not about an implementation detail: which level comes out, which actions a
 * restriction covers, and - the one that matters most - that an address alone never punishes.
 */

const START = 1_700_000_000_000;

function setup(policy: Record<string, number> = {}) {
  let now = START;
  const log = createSecurityLog({ salt: "test" });
  const detector = createAbuseDetector({
    policy: { ...policy },
    log,
    now: () => now,
  });
  return {
    detector,
    log,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const principal = (accountId: string, ip = "198.51.100.20"): Principal => ({ accountId, ip });

describe("signal scoring", () => {
  it("leaves an ordinary account alone", () => {
    const { detector } = setup();
    const user = principal("artist");
    detector.noteRequest(user);
    expect(detector.assess(user).level).toBe("allow");
  });

  it("raises a challenge for repeated identical messages", () => {
    const { detector } = setup();
    const spammer = principal("spammer");

    detector.noteRequest(spammer);
    for (let index = 0; index < 8; index += 1) {
      detector.noteMessage(spammer, "guild/general", "buy followers now");
    }

    const assessment = detector.assess(spammer);
    const repeats = assessment.signals.find((signal) => signal.id === "repeated_messages");
    expect(repeats?.weight).toBe(45);
    expect(assessment.level).toBe("challenge");
  });

  it("treats a handful of repeats as unremarkable", () => {
    const { detector } = setup();
    const user = principal("chatty");

    detector.noteRequest(user);
    for (let index = 0; index < 4; index += 1) {
      detector.noteMessage(user, "guild/general", "same line");
    }

    expect(detector.assess(user).level).toBe("allow");
  });

  it("ignores a different body in the same channel", () => {
    const { detector } = setup();
    const user = principal("varied");
    detector.noteRequest(user);

    for (let index = 0; index < 10; index += 1) {
      detector.noteMessage(user, "guild/general", `line ${index}`);
    }

    expect(detector.assess(user).signals.some((signal) => signal.id === "repeated_messages")).toBe(
      false,
    );
  });

  it("escalates on sustained rate-limit rejections", () => {
    const { detector } = setup();
    const noisy = principal("noisy");
    detector.noteRequest(noisy);

    for (let index = 0; index < 2; index += 1) detector.noteRateLimited(noisy, "write:messages", 8);
    expect(detector.assess(noisy).level).toBe("allow");

    for (let index = 0; index < 4; index += 1) detector.noteRateLimited(noisy, "write:messages", 8);
    expect(detector.assess(noisy).level).toBe("challenge");
  });

  it("counts failed authentication attempts", () => {
    const { detector } = setup();
    const prober = principal("prober");
    detector.noteRequest(prober);

    for (let index = 0; index < 3; index += 1) {
      detector.noteAuthFailure(prober, "rejected x-aegis-key");
    }

    const assessment = detector.assess(prober);
    expect(assessment.signals.find((signal) => signal.id === "auth_failures")?.weight).toBe(30);
  });

  it("flags server-creation churn", () => {
    const { detector } = setup();
    const churner = principal("churner");
    detector.noteRequest(churner);

    for (let index = 0; index < 5; index += 1) detector.noteGuildCreated(churner);

    expect(detector.assess(churner).signals.some((signal) => signal.id === "guild_churn")).toBe(true);
  });

  it("flags abnormal concurrency once per window, not once per request", () => {
    const { detector } = setup();
    const script = principal("script");
    detector.noteRequest(script);

    for (let index = 0; index < 14; index += 1) detector.enter(script);
    const first = detector.assess(script);
    expect(first.signals.find((signal) => signal.id === "concurrency")?.weight).toBe(12);

    // Another burst in the same window does not compound the weight.
    for (let index = 0; index < 3; index += 1) detector.enter(script);
    expect(detector.assess(script).score).toBe(first.score);
  });

  it("forgets signals once the window closes", () => {
    const { detector, advance } = setup();
    const user = principal("forgetful");
    detector.noteRequest(user);
    for (let index = 0; index < 8; index += 1) {
      detector.noteMessage(user, "guild/general", "same line");
    }
    expect(detector.assess(user).level).toBe("challenge");

    advance(11 * 60_000);
    expect(detector.assess(user).level).toBe("allow");
  });
});

describe("address is never the whole case", () => {
  it("does not punish many accounts behind one address on that basis alone", () => {
    // A lecture hall, a studio, a family: one public address, several people. `challengeAt` is
    // deliberately below the rotation weight so this test fails loudly if the rule is removed.
    const { detector } = setup({ newAccountMs: 0, challengeAt: 20 });
    const shared = "203.0.113.50";

    for (let index = 0; index < 5; index += 1) {
      detector.noteRequest(principal(`student-${index}`, shared));
    }

    const assessment = detector.assess(principal("student-0", shared));
    expect(assessment.signals.map((signal) => signal.id)).toContain("identity_rotation");
    expect(assessment.score).toBeGreaterThanOrEqual(20);
    expect(assessment.level).toBe("allow");
  });

  it("does not react to two people sharing an address", () => {
    const { detector } = setup();
    const shared = "203.0.113.51";
    detector.noteRequest(principal("a", shared));
    detector.noteRequest(principal("b", shared));

    const assessment = detector.assess(principal("a", shared));
    expect(assessment.signals.some((signal) => signal.ipOnly)).toBe(false);
    expect(assessment.level).toBe("allow");
  });

  it("uses rotation once something else corroborates it", () => {
    const { detector } = setup();
    const voter = principal("voter-1", "203.0.113.52");
    for (let index = 1; index <= 4; index += 1) {
      detector.noteRequest(principal(`voter-${index}`, "203.0.113.52"));
    }

    for (let index = 0; index < 3; index += 1) detector.noteRateLimited(voter, "write:messages", 8);

    const assessment = detector.assess(voter);
    expect(assessment.signals.map((signal) => signal.id)).toEqual(
      expect.arrayContaining(["identity_rotation", "rate_limit_hits"]),
    );
    expect(assessment.level).toBe("challenge");
  });
});

describe("graduated enforcement", () => {
  it("suspends a clearly abusive account and covers every action", () => {
    const { detector, now } = setup();
    const abuser = principal("abuser");

    detector.noteRequest(abuser);
    for (let index = 0; index < 8; index += 1) {
      detector.noteMessage(abuser, "guild/general", "spam");
    }
    for (let index = 0; index < 3; index += 1) detector.noteAuthFailure(abuser, "bad key");
    for (let index = 0; index < 13; index += 1) detector.enter(abuser);

    const assessment = detector.assess(abuser);
    expect(assessment.level).toBe("suspend");

    const restriction = detector.escalate(abuser, assessment, "write:messages");
    expect(restriction).toMatchObject({
      accountId: "abuser",
      actions: ["*"],
      createdBy: "automated",
      until: now() + detector.policy.suspendMs,
    });
    expect(detector.restrictionFor("abuser")?.reason).toContain("automated:");
  });

  it("restricts only the abusive actions at the lower level", () => {
    const { detector } = setup();
    const pest = principal("pest");

    detector.noteRequest(pest);
    for (let index = 0; index < 10; index += 1) {
      detector.noteMessage(pest, "guild/general", "same");
    }

    const assessment = detector.assess(pest);
    expect(assessment.level).toBe("restrict");

    const restriction = detector.escalate(pest, assessment, "write:messages");
    expect(restriction?.actions).toEqual([
      "write:messages",
      "write:uploads",
      "create:guilds",
      "write:guilds",
    ]);
    // Reading is untouched.
    expect(restriction?.actions).not.toContain("read:workspace");
  });

  it("is idempotent: a second escalation does not extend or duplicate", () => {
    const { detector } = setup();
    const pest = principal("repeat-pest");
    detector.noteRequest(pest);
    for (let index = 0; index < 10; index += 1) {
      detector.noteMessage(pest, "guild/general", "same");
    }

    const assessment = detector.assess(pest);
    const first = detector.escalate(pest, assessment, "write:messages");
    const second = detector.escalate(pest, assessment, "write:messages");
    expect(second?.until).toBe(first?.until);
    expect(detector.restrictions()).toHaveLength(1);
  });

  it("expires a restriction instead of making it permanent", () => {
    const { detector, advance } = setup();
    const pest = principal("temporary");
    detector.noteRequest(pest);
    for (let index = 0; index < 10; index += 1) {
      detector.noteMessage(pest, "guild/general", "same");
    }
    detector.escalate(pest, detector.assess(pest), "write:messages");
    expect(detector.restrictionFor("temporary")).not.toBeNull();

    advance(detector.policy.restrictionMs + 1);
    expect(detector.restrictionFor("temporary")).toBeNull();
  });

  it("decays a strike so an old incident stops counting", () => {
    const { detector, advance } = setup();
    const pest = principal("former-pest");
    detector.noteRequest(pest);
    for (let index = 0; index < 10; index += 1) {
      detector.noteMessage(pest, "guild/general", "same");
    }
    detector.escalate(pest, detector.assess(pest), "write:messages");
    advance(detector.policy.strikeDecayMs + 1);

    const later = detector.assess(pest);
    expect(later.signals.some((signal) => signal.id === "prior_strikes")).toBe(false);
  });

  it("cannot restrict an anonymous caller, and says so by returning nothing", () => {
    const { detector } = setup();
    const anon: Principal = { accountId: null, ip: "198.51.100.99" };
    detector.noteRequest(anon);
    for (let index = 0; index < 3; index += 1) detector.noteAuthFailure(anon, "no identity");

    const assessment = detector.assess(anon);
    expect(detector.escalate(anon, assessment, "write:messages")).toBeNull();
  });
});

describe("review and reversal", () => {
  it("records an appeal as a pending case with the user's own words", () => {
    const { detector } = setup();

    const item = detector.appeal(principal("appealing"), "I was pasting a link to my own channel.");
    expect(item.status).toBe("pending");
    expect(item.accountId).toBe("appealing");
    expect(item.decision).toContain("pasting a link");

    expect(detector.cases()).toHaveLength(1);
    expect(detector.summary().pendingCases).toBe(1);
  });

  it("never puts the appeal text in the security log", () => {
    const { detector, log } = setup();
    detector.appeal(principal("private"), "my password is hunter2");

    expect(JSON.stringify(log.list({ limit: 50 }))).not.toContain("hunter2");
  });

  it("clears a restriction on operator review, and records who did it", () => {
    const { detector, log } = setup();
    const pest = principal("reviewed");
    detector.noteRequest(pest);
    for (let index = 0; index < 10; index += 1) {
      detector.noteMessage(pest, "guild/general", "same");
    }
    detector.escalate(pest, detector.assess(pest), "write:messages");

    expect(detector.override("reviewed", "clear", 30, "moderator:kai")).toBeNull();
    expect(detector.restrictionFor("reviewed")).toBeNull();

    const override = log.list({ kind: "override" })[0];
    expect(override?.action).toBe("cleared");
    expect(override?.detail.actor).toBe("moderator:kai");
  });

  it("applies a manual restriction that outlives the automated one", () => {
    const { detector } = setup();

    const applied = detector.override("manual-case", "suspend", 120, "moderator:kai");
    expect(applied?.actions).toEqual(["*"]);
    expect(applied?.createdBy).toBe("moderator:kai");
    expect(detector.summary().activeRestrictions).toBe(1);

    detector.override("manual-case", "clear", 0, "moderator:kai");
    expect(detector.summary().activeRestrictions).toBe(0);
  });

  it("reports the shape an operator needs, without thresholds", () => {
    const { detector } = setup();
    detector.noteRequest(principal("counted"));

    const summary = detector.summary();
    expect(summary).toEqual({
      trackedAccounts: 1,
      trackedAddresses: 1,
      activeRestrictions: 0,
      pendingCases: 0,
    });
    expect(JSON.stringify(summary)).not.toContain("challengeAt");
  });
});


describe("challenge ledger", () => {
  it("refuses redemption before the cooldown, then burns the pass after one use", () => {
    vi.useFakeTimers();
    try {
      const ledger = createChallengeLedger({ cooldownMs: 3_000, ttlMs: 60_000 });
      const issued = ledger.issue(principal("challenged"));

      expect(issued.retryAfterMs).toBe(3_000);
      // A script that retries the instant it is challenged gets nothing.
      expect(ledger.verify(issued.id)).toBe(false);

      vi.advanceTimersByTime(3_000);
      expect(ledger.consume(issued.id)).toBe(true);
      // A pass buys one request, not an hour of immunity.
      expect(ledger.consume(issued.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a challenge that is never redeemed", () => {
    vi.useFakeTimers();
    try {
      const ledger = createChallengeLedger({ cooldownMs: 0, ttlMs: 1_000 });
      const issued = ledger.issue(principal("slow"));
      vi.advanceTimersByTime(1_500);
      expect(ledger.verify(issued.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

