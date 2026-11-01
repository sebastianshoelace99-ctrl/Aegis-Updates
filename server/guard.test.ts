import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createRequestHandler } from "./app";
import { EventBus } from "./bus";
import { createRequestGuard, type BucketName, type RuleSpec } from "./guard";
import { createMemoryRateLimitStore, type RateLimitStore } from "./rateLimit";
import { createMemoryStore } from "./store";
import { createUploadStore } from "./uploads";

/**
 * The guard, exercised through the real HTTP handler.
 *
 * These are integration tests on purpose: the unit tests prove the arithmetic and the scoring,
 * and these prove that a request which should be refused never reaches a handler. A stub response
 * is enough because every assertion here is about status, headers and JSON.
 */

type Capture = ServerResponse & {
  status: number;
  body: string;
  json: () => unknown;
  header: (name: string) => string | undefined;
};

function capture(): Capture {
  const headers: Record<string, string | number> = {};
  const chunks: Buffer[] = [];
  const state = {
    status: 0,
    headersSent: false,
    body: "",
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = value;
      return state;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    writeHead(status: number, extra?: Record<string, string | number>) {
      state.status = status;
      state.headersSent = true;
      if (extra) {
        for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value;
      }
      return state;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      state.body = Buffer.concat(chunks).toString("utf8");
      return state;
    },
    header: (name: string) => {
      const value = headers[name.toLowerCase()];
      return value === undefined ? undefined : String(value);
    },
    json: () => JSON.parse(state.body) as unknown,
  };
  return state as unknown as Capture;
}

function request(options: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  ip?: string;
}): IncomingMessage {
  const text = options.body === undefined ? null : JSON.stringify(options.body);
  const stream = Readable.from(text === null ? [] : [Buffer.from(text)]) as unknown as IncomingMessage;

  // A real IncomingMessage carries a Socket; the guard only reads `socket.remoteAddress`, so the
  // cast is narrowed to exactly that instead of faking 100 methods.
  const mutable = stream as unknown as {
    method: string;
    url: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
  };

  mutable.method = options.method ?? "GET";
  mutable.url = options.url;
  mutable.headers = {
    ...(text === null
      ? {}
      : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }),
    ...(options.headers ?? {}),
  };
  mutable.socket = { remoteAddress: options.ip ?? "127.0.0.1" };
  return stream;
}

type Harness = {
  call: (
    options: Parameters<typeof request>[0],
  ) => Promise<{ status: number; json: () => unknown; header: (name: string) => string | undefined }>;
  guard: ReturnType<typeof createRequestGuard>;
  store: ReturnType<typeof createMemoryStore>;
};

function harness(options: {
  rules?: Partial<Record<BucketName, RuleSpec>>;
  limitStore?: RateLimitStore;
  appStore?: ReturnType<typeof createMemoryStore>;
  failMode?: "closed" | "open";
  adminKey?: string;
  policy?: Record<string, number>;
} = {}): Harness {
  const uploads = createUploadStore(join(tmpdir(), `aegis-guard-${randomUUID()}`));
  const guard = createRequestGuard({
    ...(options.rules ? { rules: options.rules } : {}),
    ...(options.limitStore ? { store: options.limitStore } : {}),
    ...(options.failMode ? { failMode: options.failMode } : {}),
    // New accounts normally get half a budget; tests need the configured number to be the number.
    policy: { newAccountMs: 0, ...(options.policy ?? {}) },
  });

  const store = options.appStore ?? createMemoryStore();
  const handler = createRequestHandler({
    store,
    bus: new EventBus(),
    apiKey: "",
    uploads,
    guard,
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
  });

  return {
    guard,
    store,
    async call(input) {
      const res = capture();
      await handler(request(input), res);
      return { status: res.status, json: res.json, header: res.header };
    },
  };
}

const workspaceRule: Partial<Record<BucketName, RuleSpec>> = {
  "read:workspace": { rule: { burst: 2, perMinute: 60 }, expensive: false },
};

const json = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

describe("rate limiting at the edge", () => {
  it("allows the configured burst, then answers 429 with Retry-After", async () => {
    const app = harness({ rules: workspaceRule });
    const user = { "x-aegis-user": "nyx" };

    expect((await app.call({ url: "/api/workspace", headers: user })).status).toBe(200);
    expect((await app.call({ url: "/api/workspace", headers: user })).status).toBe(200);

    const refused = await app.call({ url: "/api/workspace", headers: user });
    expect(refused.status).toBe(429);
    expect(refused.header("retry-after")).toBe("1");

    const body = json(refused.json());
    expect(body.code).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBe(1);
    // Nothing about the bucket, the limit or the score leaks out.
    expect(JSON.stringify(body)).not.toMatch(/read:workspace|burst|perMinute|score|threshold/);
  });

  it("never limits the health probe", async () => {
    const app = harness({ rules: workspaceRule });
    for (let index = 0; index < 40; index += 1) {
      expect((await app.call({ url: "/api/health" })).status).toBe(200);
    }
  });

  it("does not hand out a fresh budget when the claimed identity changes", async () => {
    const app = harness({ rules: workspaceRule });

    // Same address, a new claimed id per request: the address bucket is already spent.
    expect(
      (await app.call({ url: "/api/workspace", headers: { "x-aegis-user": "one" }, ip: "10.0.0.5" }))
        .status,
    ).toBe(200);
    expect(
      (await app.call({ url: "/api/workspace", headers: { "x-aegis-user": "two" }, ip: "10.0.0.5" }))
        .status,
    ).toBe(200);
    expect(
      (await app.call({ url: "/api/workspace", headers: { "x-aegis-user": "three" }, ip: "10.0.0.5" }))
        .status,
    ).toBe(429);
  });

  it("holds unauthenticated callers to the anonymous rule", async () => {
    const app = harness();
    for (let index = 0; index < 5; index += 1) {
      expect((await app.call({ url: "/api/workspace", ip: "10.0.0.9" })).status).toBe(200);
    }
    expect((await app.call({ url: "/api/workspace", ip: "10.0.0.9" })).status).toBe(429);
  });

  it("shares one budget across handlers that share a store", async () => {
    // What two instances behind a load balancer look like when the store is shared.
    const shared = createMemoryRateLimitStore();
    const first = harness({ limitStore: shared, rules: workspaceRule });
    const second = harness({ limitStore: shared, rules: workspaceRule });
    const user = { "x-aegis-user": "nyx" };

    expect((await first.call({ url: "/api/workspace", headers: user })).status).toBe(200);
    expect((await first.call({ url: "/api/workspace", headers: user })).status).toBe(200);
    expect((await second.call({ url: "/api/workspace", headers: user })).status).toBe(429);
  });

  it("prices account creation below reading, so a spammer runs out of servers first", async () => {
    const app = harness();
    const headers = { "x-aegis-user": "spammer" };
    const statuses: number[] = [];

    for (let index = 0; index < 4; index += 1) {
      const response = await app.call({
        method: "POST",
        url: "/api/guilds",
        headers,
        body: { name: `Spam ${index}`, accent: 1, templateId: "custom", ownerId: "spammer" },
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 3)).toEqual([201, 201, 201]);
    expect(statuses[3]).toBe(429);
  });
});


describe("graduated enforcement through HTTP", () => {
  it("blocks a restricted account's writes, explains why, and leaves reads working", async () => {
    const app = harness();
    app.guard.detector.override("flagged", "restrict", 10, "test");

    const headers = { "x-aegis-user": "flagged" };
    const blocked = await app.call({
      method: "POST",
      url: "/api/channels/atelier%2Fgeneral/messages",
      headers,
      body: { body: "hello" },
    });

    expect(blocked.status).toBe(403);
    const body = json(blocked.json());
    expect(body.code).toBe("restricted");
    expect(String(body.error)).toContain("Sending messages is paused");
    // Reversible, and the client is told how to ask for a person.
    expect(String(body.error)).toContain("/api/security/appeals");

    expect((await app.call({ url: "/api/workspace", headers })).status).toBe(200);
  });

  it("asks for a challenge instead of refusing outright when risk is elevated", async () => {
    const app = harness();
    const spammer = { accountId: "chatter", ip: "127.0.0.1" };

    // Eight identical messages in one channel is the repetition signal on its own.
    for (let index = 0; index < 8; index += 1) {
      app.guard.detector.noteMessage(spammer, "atelier/general", "same line");
    }

    const response = await app.call({
      method: "POST",
      url: "/api/channels/atelier%2Fgeneral/messages",
      headers: { "x-aegis-user": "chatter" },
      body: { body: "same line" },
    });

    expect(response.status).toBe(428);
    const body = json(response.json()) as {
      code: string;
      challenge: { id: string; retryAfterSeconds: number };
    };
    expect(body.code).toBe("challenge_required");
    expect(body.challenge.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.challenge.retryAfterSeconds).toBeGreaterThan(0);
    expect(response.header("x-aegis-challenge")).toBe(body.challenge.id);
  });

  it("limits the event stream but never challenges it", async () => {
    // A challenged stream has nowhere to solve the challenge, so escalating it would take live
    // updates down for the whole window. The bucket still applies.
    const guard = createRequestGuard({
      rules: { "connect:events": { rule: { burst: 1, perMinute: 60 }, expensive: false } },
      policy: { newAccountMs: 0, challengeAt: 10 },
    });
    const streamer = { accountId: "streamer", ip: "127.0.0.1" };
    for (let index = 0; index < 3; index += 1) {
      guard.detector.noteAuthFailure(streamer, "bad key");
    }

    const first = await guard.check({
      method: "GET",
      segments: ["api", "events"],
      principal: streamer,
      anonymous: false,
      now: Date.now(),
    });
    expect(first.kind).toBe("allow");

    const second = await guard.check({
      method: "GET",
      segments: ["api", "events"],
      principal: streamer,
      anonymous: false,
      now: Date.now(),
    });
    expect(second.kind).toBe("rate_limited");

    // The same account is challenged on an ordinary write, so the exemption is specific.
    const write = await guard.check({
      method: "POST",
      segments: ["api", "channels", "atelier", "messages"],
      principal: streamer,
      anonymous: false,
      now: Date.now(),
    });
    expect(write.kind).toBe("challenge_required");
  });

  it("suspends the account rather than answering the same request forever", async () => {
    const app = harness();
    const abuser = { accountId: "abuser", ip: "127.0.0.1" };

    for (let index = 0; index < 8; index += 1) {
      app.guard.detector.noteMessage(abuser, "atelier/general", "spam");
      app.guard.detector.noteAuthFailure(abuser, "bad key");
    }
    for (let index = 0; index < 13; index += 1) app.guard.detector.enter(abuser);

    const response = await app.call({
      method: "POST",
      url: "/api/channels/atelier%2Fgeneral/messages",
      headers: { "x-aegis-user": "abuser" },
      body: { body: "spam" },
    });

    expect(response.status).toBe(403);
    expect(String(json(response.json()).error)).toContain("temporarily suspended");
    expect(app.guard.detector.restrictionFor("abuser")?.actions).toEqual(["*"]);
  });
});

describe("operator surface", () => {
  it("answers 404 when no admin key is configured", async () => {
    const app = harness();
    expect((await app.call({ url: "/api/security/summary" })).status).toBe(404);
    expect((await app.call({ url: "/api/security/events" })).status).toBe(404);
  });

  it("answers 404 for a wrong key and 200 for the right one", async () => {
    const app = harness({ adminKey: "s3cret-admin-key" });

    expect((await app.call({ url: "/api/security/summary" })).status).toBe(404);
    expect(
      (await app.call({ url: "/api/security/summary", headers: { "x-aegis-admin": "wrong" } }))
        .status,
    ).toBe(404);

    const ok = await app.call({
      url: "/api/security/summary",
      headers: { "x-aegis-admin": "s3cret-admin-key" },
    });
    expect(ok.status).toBe(200);

    const body = json(ok.json());
    expect(body.summary).toMatchObject({ activeRestrictions: 0, pendingCases: 0 });
    expect(body.restrictions).toEqual([]);
    // No thresholds, no policy, no scores.
    expect(JSON.stringify(body)).not.toMatch(/challengeAt|restrictAt|suspendAt|perMinute|burst/);
  });

  it("records an appeal from a user and shows it to an operator", async () => {
    const app = harness({ adminKey: "s3cret-admin-key" });

    const filed = await app.call({
      method: "POST",
      url: "/api/security/appeals",
      headers: { "x-aegis-user": "nyx" },
      body: { message: "I sent the same link three times by accident." },
    });
    expect(filed.status).toBe(202);
    expect(json(filed.json()).case).toMatchObject({ status: "pending" });

    const cases = await app.call({
      url: "/api/security/cases",
      headers: { "x-aegis-admin": "s3cret-admin-key" },
    });
    expect(cases.status).toBe(200);
    expect(json(cases.json()).cases).toHaveLength(1);
  });

  it("refuses an appeal with no identity", async () => {
    const app = harness();
    const response = await app.call({
      method: "POST",
      url: "/api/security/appeals",
      body: { message: "please review" },
    });
    expect(response.status).toBe(401);
  });
});


describe("retries and duplicates", () => {
  async function channelFixture() {
    const store = createMemoryStore();
    const { guild } = await store.createGuild({
      name: "Atelier",
      accent: 2,
      templateId: "custom",
      ownerId: "nyx",
    });
    const channelId = guild.channels[0]?.id ?? "";
    const app = harness({ appStore: store });
    return {
      store,
      channelId,
      app,
      url: `/api/channels/${encodeURIComponent(channelId)}/messages`,
    };
  }

  it("sends one message when the same request is retried with the same key", async () => {
    const { store, channelId, app, url } = await channelFixture();
    const headers = { "x-aegis-user": "nyx", "idempotency-key": "send-key-0001" };

    const first = await app.call({ method: "POST", url, headers, body: { body: "hello" } });
    const second = await app.call({ method: "POST", url, headers, body: { body: "hello" } });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(json(second.json()).id).toBe(json(first.json()).id);
    expect(await store.listMessages(channelId, null, 10)).toHaveLength(1);
  });

  it("refuses a key reused for different content instead of replaying the old result", async () => {
    const { app, url } = await channelFixture();
    const headers = { "x-aegis-user": "nyx", "idempotency-key": "send-key-0002" };

    await app.call({ method: "POST", url, headers, body: { body: "first" } });
    const reused = await app.call({ method: "POST", url, headers, body: { body: "second" } });

    expect(reused.status).toBe(422);
  });

  it("answers 409 while the first copy is still in flight", async () => {
    const { app, channelId, url } = await channelFixture();
    const key = "send-key-0003";
    const scope = `POST /api/channels/${channelId}/messages`;
    const fingerprint = ["nyx", channelId, "hello", ""].join("\u0000");

    expect(app.guard.idempotency.begin(scope, key, fingerprint)).toEqual({ state: "new" });

    const busy = await app.call({
      method: "POST",
      url,
      headers: { "x-aegis-user": "nyx", "idempotency-key": key },
      body: { body: "hello" },
    });
    expect(busy.status).toBe(409);
  });
});

describe("when the limit store is unavailable", () => {
  const broken: RateLimitStore = {
    kind: "memory",
    async consume() {
      throw new Error("store down");
    },
  };

  it("fails closed for expensive work and fails open for reading", async () => {
    const app = harness({ limitStore: broken });

    const created = await app.call({
      method: "POST",
      url: "/api/guilds",
      headers: { "x-aegis-user": "nyx" },
      body: { name: "Blocked", accent: 0, templateId: "custom", ownerId: "nyx" },
    });
    expect(created.status).toBe(503);
    expect(json(created.json()).code).toBe("unavailable");

    // A read is not what an outage should break.
    expect(
      (await app.call({ url: "/api/workspace", headers: { "x-aegis-user": "nyx" } })).status,
    ).toBe(200);

    // ...and the failure is on the record either way.
    expect(app.guard.log.list({ kind: "degraded" }).length).toBeGreaterThan(0);
  });

  it("can be configured to fail open everywhere", async () => {
    const app = harness({ limitStore: broken, failMode: "open" });
    const created = await app.call({
      method: "POST",
      url: "/api/guilds",
      headers: { "x-aegis-user": "nyx" },
      body: { name: "Allowed", accent: 0, templateId: "custom", ownerId: "nyx" },
    });
    expect(created.status).toBe(201);
  });
});

