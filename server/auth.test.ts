import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createRequestHandler } from "./app";
import {
  createAuthStore,
  hashPassword,
  slugifyHandle,
  verifyPassword,
} from "./auth";
import { EventBus } from "./bus";
import { createRequestGuard } from "./guard";
import { emptyOAuthConfig, providerInfos, type OAuthConfig } from "./oauth";
import { createMemoryStore } from "./store";
import { createUploadStore } from "./uploads";

/**
 * Accounts, sessions and the OAuth handoff, exercised through the real HTTP handler.
 *
 * These are integration tests on purpose: a pure unit test of `register` would not catch the
 * things that actually break sign-in - a route that reads the wrong body field, a bearer header
 * the handler ignores, or a callback the shared-secret check rejects before it can run.
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
  form?: Record<string, string>;
}): IncomingMessage {
  const text =
    options.form !== undefined
      ? new URLSearchParams(options.form).toString()
      : options.body === undefined
        ? null
        : JSON.stringify(options.body);

  const stream = Readable.from(text === null ? [] : [Buffer.from(text)]) as unknown as IncomingMessage;

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
      : {
          "content-type":
            options.form !== undefined
              ? "application/x-www-form-urlencoded"
              : "application/json",
          "content-length": String(Buffer.byteLength(text)),
        }),
    ...(options.headers ?? {}),
  };
  mutable.socket = { remoteAddress: "127.0.0.1" };
  return stream;
}

type CallInput = Parameters<typeof request>[0];

function harness(options: { oauth?: OAuthConfig; apiKey?: string; requireAuth?: boolean } = {}) {
  const uploads = createUploadStore(join(tmpdir(), `aegis-auth-${randomUUID()}`));
  const auth = createAuthStore({
    file: null,
    oauth: options.oauth ?? emptyOAuthConfig(),
  });
  const store = createMemoryStore();

  const handler = createRequestHandler({
    store,
    bus: new EventBus(),
    apiKey: options.apiKey ?? "",
    uploads,
    // The limiter has its own suite; here it would only turn a long test into a 429.
    guard: createRequestGuard({ enabled: false }),
    auth,
    requireAuth: options.requireAuth ?? false,
  });

  return {
    auth,
    store,
    async call(input: CallInput) {
      const res = capture();
      await handler(request(input), res);
      return {
        status: res.status,
        body: res.body,
        json: () => res.json() as Record<string, unknown>,
        header: res.header,
      };
    },
  };
}

const CREDENTIALS = {
  email: "Nyx@Example.com",
  password: "correct horse battery",
  displayName: "Nyx",
  handle: "nyx",
};

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("password hashing", () => {
  it("round-trips a password and rejects everything else", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("Correct horse battery", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("fails closed on a malformed or missing hash", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", "scrypt$not-a-number$x$y$z$w")).toBe(false);
    expect(await verifyPassword("anything", "sha256$deadbeef")).toBe(false);
  });

  it("accepts only the handle grammar", () => {
    expect(slugifyHandle("Nyx the Artist")).toBe("nyx-the-artist");
    expect(slugifyHandle("Ünïcode!")).toBe("unicode");
  });
});

describe("registration and sessions", () => {
  it("creates an account, normalises the email, and issues a session", async () => {
    const app = harness();
    const reply = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: CREDENTIALS,
    });

    expect(reply.status).toBe(201);
    const body = reply.json();
    const user = body.user as Record<string, unknown>;

    expect(typeof body.token).toBe("string");
    expect(String(body.token).length).toBeGreaterThan(30);
    expect(user.email).toBe("nyx@example.com");
    expect(user.handle).toBe("nyx");
    expect(user.displayName).toBe("Nyx");
    expect(user.provider).toBe("email");
    expect(Number(user.accent)).toBeGreaterThanOrEqual(0);
    expect(Number(user.accent)).toBeLessThan(8);
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("refuses a duplicate email with 409 and suffixes a taken handle", async () => {
    const app = harness();
    await app.call({ method: "POST", url: "/api/auth/register", body: CREDENTIALS });

    const duplicate = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: { ...CREDENTIALS, handle: "someone-else" },
    });
    expect(duplicate.status).toBe(409);

    const second = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: {
        email: "second@example.com",
        password: "another good password",
        displayName: "Second",
        handle: "nyx",
      },
    });
    expect(second.status).toBe(201);
    expect((second.json().user as Record<string, unknown>).handle).toBe("nyx-2");
  });

  it("validates email, password length and the handle", async () => {
    const app = harness();

    const badEmail = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: { ...CREDENTIALS, email: "not-an-email" },
    });
    expect(badEmail.status).toBe(400);

    const short = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: { ...CREDENTIALS, password: "short" },
    });
    expect(short.status).toBe(400);

    const badHandle = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: { ...CREDENTIALS, handle: "!" },
    });
    expect(badHandle.status).toBe(400);
  });

  it("logs in, and answers one generic 401 for both failure modes", async () => {
    const app = harness();
    await app.call({ method: "POST", url: "/api/auth/register", body: CREDENTIALS });

    const ok = await app.call({
      method: "POST",
      url: "/api/auth/login",
      body: { email: "nyx@example.com", password: CREDENTIALS.password },
    });
    expect(ok.status).toBe(200);

    const wrong = await app.call({
      method: "POST",
      url: "/api/auth/login",
      body: { email: "nyx@example.com", password: "wrong password" },
    });
    const unknown = await app.call({
      method: "POST",
      url: "/api/auth/login",
      body: { email: "nobody@example.com", password: "wrong password" },
    });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json().error).toBe(unknown.json().error);
  });
});


describe("sessions as identity", () => {
  it("resolves a bearer token, refuses a stale one, and revokes on logout", async () => {
    const app = harness();
    const created = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: CREDENTIALS,
    });
    const token = String(created.json().token);

    const session = await app.call({ url: "/api/auth/session", headers: bearer(token) });
    expect(session.status).toBe(200);
    expect((session.json().user as Record<string, unknown>).handle).toBe("nyx");

    const stale = await app.call({ url: "/api/auth/session", headers: bearer("x".repeat(43)) });
    expect(stale.status).toBe(401);

    const out = await app.call({
      method: "POST",
      url: "/api/auth/logout",
      headers: bearer(token),
    });
    expect(out.status).toBe(204);

    const after = await app.call({ url: "/api/auth/session", headers: bearer(token) });
    expect(after.status).toBe(401);
  });

  it("treats a verified session as the identity, not the spoofable header", async () => {
    const app = harness();
    const created = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: CREDENTIALS,
    });
    const body = created.json();
    const token = String(body.token);
    const id = String((body.user as Record<string, unknown>).id);

    // Claiming someone else in `x-aegis-user` must not let the caller create a server for them.
    const spoofed = await app.call({
      method: "POST",
      url: "/api/guilds",
      headers: { ...bearer(token), "x-aegis-user": "someone-else" },
      body: { name: "Spoofed", accent: 1, templateId: "friends", ownerId: "someone-else" },
    });
    expect(spoofed.status).toBe(403);

    const own = await app.call({
      method: "POST",
      url: "/api/guilds",
      headers: { ...bearer(token), "x-aegis-user": "someone-else" },
      body: { name: "Mine", accent: 1, templateId: "friends", ownerId: id },
    });
    expect(own.status).toBe(201);
  });

  it("can require a session for the rest of the API", async () => {
    const app = harness({ requireAuth: true });

    const anonymous = await app.call({ url: "/api/workspace" });
    expect(anonymous.status).toBe(401);

    const created = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: CREDENTIALS,
    });
    const token = String(created.json().token);

    const allowed = await app.call({ url: "/api/workspace", headers: bearer(token) });
    expect(allowed.status).toBe(200);
  });

  it("uses invite links to join servers and keeps nonmembers out", async () => {
    const app = harness({ requireAuth: true });
    const ownerLogin = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: CREDENTIALS,
    });
    const ownerToken = String(ownerLogin.json().token);
    const owner = ownerLogin.json().user as Record<string, unknown>;
    const created = await app.call({
      method: "POST",
      url: "/api/guilds",
      headers: bearer(ownerToken),
      body: {
        name: "Invite Lab",
        accent: owner.accent,
        templateId: "friends",
        ownerId: owner.id,
        ownerName: owner.displayName,
        ownerHandle: owner.handle,
      },
    });
    expect(created.status).toBe(201);
    const workspace = created.json().workspace as {
      guilds: Array<{ id: string; channels: Array<{ id: string }> }>;
    };
    const guild = workspace.guilds[0]!;
    const channelId = guild.channels[0]!.id;

    const guestLogin = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: {
        ...CREDENTIALS,
        email: "guest@example.com",
        displayName: "Guest",
        handle: "guest",
      },
    });
    const guestToken = String(guestLogin.json().token);
    const guest = guestLogin.json().user as Record<string, unknown>;

    const hidden = await app.call({ url: "/api/workspace", headers: bearer(guestToken) });
    expect((hidden.json().workspace as { guilds: unknown[] }).guilds).toHaveLength(0);
    expect(
      (
        await app.call({
          url: `/api/channels/${encodeURIComponent(channelId)}/messages`,
          headers: bearer(guestToken),
        })
      ).status,
    ).toBe(403);

    const inviteReply = await app.call({
      method: "POST",
      url: `/api/guilds/${encodeURIComponent(guild.id)}/invites`,
      headers: bearer(ownerToken),
    });
    expect(inviteReply.status).toBe(201);
    const invite = inviteReply.json();
    const link = String(invite.link);
    const code = new URL(link).searchParams.get("code") ?? "";
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expiresAt = Date.parse(String((invite.invite as Record<string, unknown>).expiresAt));
    expect(expiresAt - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);

    const forbiddenList = await app.call({
      url: `/api/guilds/${encodeURIComponent(guild.id)}/invites`,
      headers: bearer(guestToken),
    });
    expect(forbiddenList.status).toBe(403);

    const joined = await app.call({
      method: "POST",
      url: "/api/invites/redeem",
      headers: bearer(guestToken),
      body: { code },
    });
    expect(joined.status).toBe(200);
    expect(joined.json().guildId).toBe(guild.id);
    expect(
      (joined.json().workspace as { guilds: Array<{ memberIds: string[] }> }).guilds[0]!.memberIds,
    ).toContain(String(guest.id));

    const sent = await app.call({
      method: "POST",
      url: `/api/channels/${encodeURIComponent(channelId)}/messages`,
      headers: bearer(guestToken),
      body: { body: "Joined through an invite" },
    });
    expect(sent.status).toBe(201);
    expect(sent.json()).toEqual(
      expect.objectContaining({ authorId: guest.id, body: "Joined through an invite" }),
    );

    const reused = await app.call({
      method: "POST",
      url: "/api/invites/redeem",
      headers: bearer(guestToken),
      body: { code },
    });
    expect(reused.status).toBe(200);
    const ownerInvites = await app.call({
      url: `/api/guilds/${encodeURIComponent(guild.id)}/invites`,
      headers: bearer(ownerToken),
    });
    expect((ownerInvites.json().invites as Array<{ useCount: number }>)[0]?.useCount).toBe(2);

    const secondInvite = await app.call({
      method: "POST",
      url: `/api/guilds/${encodeURIComponent(guild.id)}/invites`,
      headers: bearer(ownerToken),
    });
    const secondLink = String(secondInvite.json().link);
    const secondCode = new URL(secondLink).searchParams.get("code") ?? "";
    const secondInviteId = String(
      (secondInvite.json().invite as Record<string, unknown>).id,
    );
    expect(
      (
        await app.call({
          method: "DELETE",
          url: `/api/guilds/${encodeURIComponent(guild.id)}/invites/${encodeURIComponent(secondInviteId)}`,
          headers: bearer(ownerToken),
        })
      ).status,
    ).toBe(204);

    const revokedGuest = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: {
        ...CREDENTIALS,
        email: "revoked@example.com",
        displayName: "Revoked",
        handle: "revoked",
      },
    });
    const revokedToken = String(revokedGuest.json().token);
    const revokedRedemption = await app.call({
      method: "POST",
      url: "/api/invites/redeem",
      headers: bearer(revokedToken),
      body: { code: secondCode },
    });
    expect(revokedRedemption.status).toBe(404);

    const forgedWorkspace = joined.json().workspace as {
      guilds: Array<{ id: string; memberIds: string[] }>;
    };
    const forgedGuild = { ...forgedWorkspace.guilds[0]!, memberIds: [...forgedWorkspace.guilds[0]!.memberIds, "uninvited"] };
    const rejectedMembershipEdit = await app.call({
      method: "PATCH",
      url: `/api/guilds/${encodeURIComponent(guild.id)}`,
      headers: bearer(guestToken),
      body: forgedGuild,
    });
    expect(rejectedMembershipEdit.status).toBe(403);
  });

  it("allows only the recorded server owner to delete a server", async () => {
    const app = harness({ requireAuth: true });
    const ownerLogin = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: CREDENTIALS,
    });
    const ownerToken = String(ownerLogin.json().token);
    const owner = ownerLogin.json().user as Record<string, unknown>;
    const created = await app.call({
      method: "POST",
      url: "/api/guilds",
      headers: bearer(ownerToken),
      body: {
        name: "Delete Me",
        accent: owner.accent,
        templateId: "friends",
        ownerId: owner.id,
        ownerName: owner.displayName,
        ownerHandle: owner.handle,
      },
    });
    const guild = (
      created.json().workspace as { guilds: Array<{ id: string }> }
    ).guilds[0]!;

    const guestLogin = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: {
        ...CREDENTIALS,
        email: "delete-guest@example.com",
        displayName: "Guest",
        handle: "delete-guest",
      },
    });
    const guestToken = String(guestLogin.json().token);
    const forbidden = await app.call({
      method: "DELETE",
      url: `/api/guilds/${encodeURIComponent(guild.id)}`,
      headers: bearer(guestToken),
    });
    expect(forbidden.status).toBe(403);
    expect((await app.call({ url: "/api/workspace", headers: bearer(ownerToken) }))
      .json().workspace).toMatchObject({ guilds: [expect.objectContaining({ id: guild.id })] });

    const deleted = await app.call({
      method: "DELETE",
      url: `/api/guilds/${encodeURIComponent(guild.id)}`,
      headers: bearer(ownerToken),
    });
    expect(deleted.status).toBe(200);
    expect(deleted.json().workspace).toMatchObject({ guilds: [] });

    const repeated = await app.call({
      method: "DELETE",
      url: `/api/guilds/${encodeURIComponent(guild.id)}`,
      headers: bearer(ownerToken),
    });
    expect(repeated.status).toBe(404);
  });

  it("authorizes voice joins and signaling and caps peer calls at six members", async () => {
    const app = harness();
    const owner = {
      id: "voice-owner",
      name: "Voice Owner",
      handle: "voice-owner",
      role: "artist" as const,
      presence: "online" as const,
      accent: 0,
    };
    const { guild } = await app.store.createGuild({
      name: "Voice Test",
      ownerId: owner.id,
      ownerName: owner.name,
      ownerHandle: owner.handle,
      accent: owner.accent,
      templateId: "friends",
    });
    const voiceChannel = guild.channels.find((channel) => channel.kind === "voice");
    const textChannel = guild.channels.find((channel) => channel.kind === "text");
    expect(voiceChannel).toBeDefined();
    expect(textChannel).toBeDefined();

    const inviteHash = "a".repeat(64);
    await app.store.createInvite(
      guild.id,
      owner.id,
      inviteHash,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const participants = [owner];
    for (let index = 1; index < 7; index += 1) {
      const member = {
        id: `voice-member-${index}`,
        name: `Voice Member ${index}`,
        handle: `voice-member-${index}`,
        role: "artist" as const,
        presence: "online" as const,
        accent: 0,
      };
      await app.store.redeemInvite(inviteHash, member);
      participants.push(member);
    }

    const join = async (memberId: string, channelId = voiceChannel!.id) =>
      app.call({
        method: "POST",
        url: "/api/voice/join",
        headers: { "x-aegis-user": memberId },
        body: { channelId },
      });

    const first = await join(participants[0]!.id);
    const second = await join(participants[1]!.id);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json().peers).toContain(participants[0]!.id);

    const signal = await app.call({
      method: "POST",
      url: "/api/voice/signal",
      headers: { "x-aegis-user": participants[0]!.id },
      body: {
        channelId: voiceChannel!.id,
        toMemberId: participants[1]!.id,
        signal: { type: "description", sdpType: "offer", sdp: "test-sdp" },
      },
    });
    expect(signal.status).toBe(204);

    const wrongKind = await join(participants[2]!.id, textChannel!.id);
    expect(wrongKind.status).toBe(404);

    for (const member of participants.slice(2, 6)) {
      expect((await join(member.id)).status).toBe(200);
    }
    expect((await join(participants[6]!.id)).status).toBe(409);
  });

  it("searches only permitted message history", async () => {
    const app = harness();
    const { guild } = await app.store.createGuild({
      name: "Search Test",
      ownerId: "search-owner",
      ownerName: "Search Owner",
      ownerHandle: "search-owner",
      accent: 0,
      templateId: "friends",
    });
    const channel = guild.channels.find((entry) => entry.kind === "text")!;
    await app.store.createMessage(channel.id, "search-owner", "Find this unique phrase");

    const reply = await app.call({
      url: `/api/search?q=${encodeURIComponent("unique phrase")}&guildId=${guild.id}`,
      headers: { "x-aegis-user": "search-owner" },
    });
    expect(reply.status).toBe(200);
    expect(reply.json().messages).toEqual([
      expect.objectContaining({ body: "Find this unique phrase", channelId: channel.id }),
    ]);

    const tooShort = await app.call({
      url: `/api/search?q=x&guildId=${guild.id}`,
      headers: { "x-aegis-user": "search-owner" },
    });
    expect(tooShort.status).toBe(400);

    const nonmember = await app.call({
      url: `/api/search?q=${encodeURIComponent("unique phrase")}&guildId=${guild.id}`,
      headers: { "x-aegis-user": "outsider" },
    });
    expect(nonmember.status).toBe(404);
  });

  it("exports a complete server backup only for its owner", async () => {
    const app = harness();
    const { guild } = await app.store.createGuild({
      name: "Backup Test",
      ownerId: "backup-owner",
      ownerName: "Backup Owner",
      ownerHandle: "backup-owner",
      accent: 0,
      templateId: "friends",
    });
    const channel = guild.channels.find((entry) => entry.kind === "text")!;
    await app.store.createMessage(channel.id, "backup-owner", "Backup content");

    const denied = await app.call({
      url: `/api/guilds/${guild.id}/export`,
      headers: { "x-aegis-user": "someone-else" },
    });
    expect(denied.status).toBe(403);

    const exported = await app.call({
      url: `/api/guilds/${guild.id}/export`,
      headers: { "x-aegis-user": "backup-owner" },
    });
    expect(exported.status).toBe(200);
    expect(exported.json()).toMatchObject({
      schemaVersion: 1,
      guild: { id: guild.id },
      members: [expect.objectContaining({ id: "backup-owner" })],
      messagesByChannel: {
        [channel.id]: [expect.objectContaining({ body: "Backup content" })],
      },
    });
  });

  it("applies timeouts and bans and records immutable moderation history", async () => {
    const app = harness();
    const { guild } = await app.store.createGuild({
      name: "Moderation Test",
      ownerId: "moderation-owner",
      ownerName: "Moderation Owner",
      ownerHandle: "moderation-owner",
      accent: 0,
      templateId: "friends",
    });
    const guest = {
      id: "moderation-target",
      name: "Moderation Target",
      handle: "moderation-target",
      role: "artist" as const,
      presence: "online" as const,
      accent: 0,
    };
    const inviteHash = "b".repeat(64);
    await app.store.createInvite(
      guild.id,
      "moderation-owner",
      inviteHash,
      new Date(Date.now() + 60_000).toISOString(),
    );
    await app.store.redeemInvite(inviteHash, guest);
    const channel = guild.channels.find((entry) => entry.kind === "text")!;
    const headers = { "x-aegis-user": "moderation-owner" };

    const timedOut = await app.call({
      method: "POST",
      url: `/api/guilds/${guild.id}/moderation`,
      headers,
      body: { action: "timeout", targetId: guest.id, reason: "Pause", durationMinutes: 5 },
    });
    expect(timedOut.status).toBe(201);
    expect(await app.store.hasPermission(channel.id, guest.id, "send_messages")).toBe(false);
    expect(await app.store.hasPermission(channel.id, guest.id, "read_history")).toBe(true);

    const unmuted = await app.call({
      method: "POST",
      url: `/api/guilds/${guild.id}/moderation`,
      headers,
      body: { action: "remove_timeout", targetId: guest.id, reason: "Resolved" },
    });
    expect(unmuted.status).toBe(201);
    expect(await app.store.hasPermission(channel.id, guest.id, "send_messages")).toBe(true);

    const banned = await app.call({
      method: "POST",
      url: `/api/guilds/${guild.id}/moderation`,
      headers,
      body: { action: "ban", targetId: guest.id, reason: "Repeated abuse" },
    });
    expect(banned.status).toBe(201);
    expect(await app.store.hasChannel(channel.id, guest.id)).toBe(false);
    expect(await app.store.listBannedMemberIds(guild.id, "moderation-owner")).toEqual([guest.id]);
    const unbanned = await app.call({
      method: "POST",
      url: `/api/guilds/${guild.id}/moderation`,
      headers,
      body: { action: "unban", targetId: guest.id },
    });
    expect(unbanned.status).toBe(201);
    expect(await app.store.listBannedMemberIds(guild.id, "moderation-owner")).toEqual([]);
    expect((await app.store.listModerationAudit(guild.id, "moderation-owner", 100)).map((row) => row.action))
      .toEqual(["unban", "ban", "remove_timeout", "timeout"]);

    const protectedOwner = await app.call({
      method: "POST",
      url: `/api/guilds/${guild.id}/moderation`,
      headers,
      body: { action: "ban", targetId: "moderation-owner" },
    });
    expect(protectedOwner.status).toBe(403);
  });

  it("syncs a verified account without granting access to servers it has not joined", async () => {
    const app = harness({ requireAuth: true });
    const seeded = await app.store.createGuild({
      name: "Existing workspace",
      ownerId: "existing-owner",
      ownerName: "Existing Owner",
      ownerHandle: "existing-owner",
      accent: 1,
      templateId: "friends",
    });
    const created = await app.call({
      method: "POST",
      url: "/api/auth/register",
      body: CREDENTIALS,
    });
    const token = String(created.json().token);
    const user = created.json().user as Record<string, unknown>;

    const first = await app.call({ url: "/api/workspace", headers: bearer(token) });
    expect(first.status).toBe(200);
    const firstWorkspace = first.json().workspace as {
      guilds: unknown[];
      members: Array<Record<string, unknown>>;
    };
    expect(firstWorkspace.guilds).toHaveLength(0);
    expect(firstWorkspace.members).toContainEqual(
      expect.objectContaining({ id: user.id, name: "Nyx", handle: "nyx" }),
    );

    const repeated = await app.call({ url: "/api/workspace", headers: bearer(token) });
    expect(repeated.status).toBe(200);
    const repeatedWorkspace = repeated.json().workspace as { members: Array<Record<string, unknown>> };
    expect(repeatedWorkspace.members.filter((member) => member.id === user.id)).toHaveLength(1);

    const denied = await app.call({
      url: `/api/channels/${encodeURIComponent(seeded.guild.channels[0]!.id)}/messages`,
      headers: bearer(token),
    });
    expect(denied.status).toBe(403);
  });
});

describe("social sign-in", () => {
  const configured: OAuthConfig = {
    ...emptyOAuthConfig(),
    discord: { clientId: "discord-client", clientSecret: "discord-secret" },
  };

  it("reports which providers are configured", async () => {
    const app = harness();
    const reply = await app.call({ url: "/api/auth/providers" });
    expect(reply.status).toBe(200);

    const providers = reply.json().providers as { id: string; configured: boolean }[];
    expect(providers.map((entry) => entry.id)).toEqual(["discord", "google", "apple"]);
    expect(providers.every((entry) => entry.configured === false)).toBe(true);

    expect(providerInfos(configured).find((entry) => entry.id === "discord")?.configured).toBe(
      true,
    );
  });

  it("answers 501 for an unconfigured provider", async () => {
    const app = harness();
    const reply = await app.call({
      method: "POST",
      url: "/api/auth/oauth/start",
      body: { provider: "discord" },
    });

    expect(reply.status).toBe(501);
    expect(String(reply.json().error)).toContain("not configured");
  });

  it("starts a configured attempt, exposes a PKCE URL, and polls until the callback", async () => {
    const app = harness({ oauth: configured });

    const start = await app.call({
      method: "POST",
      url: "/api/auth/oauth/start",
      body: { provider: "discord" },
    });
    expect(start.status).toBe(200);

    const body = start.json();
    const attemptId = String(body.attemptId);
    const url = new URL(String(body.authorizeUrl));

    expect(url.hostname).toBe("discord.com");
    expect(url.searchParams.get("client_id")).toBe("discord-client");
    expect(url.searchParams.get("state")).toBe(attemptId);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge") ?? "").not.toBe("");

    const pending = await app.call({
      url: `/api/auth/oauth/attempt/${attemptId}`,
    });
    expect(pending.status).toBe(200);
    expect(pending.json().status).toBe("pending");

    const unknown = await app.call({
      url: `/api/auth/oauth/attempt/${"a".repeat(32)}`,
    });
    expect(unknown.json().status).toBe("error");
  });

  it("lets the browser callback through without the shared secret, and answers HTML", async () => {
    const app = harness({ oauth: configured, apiKey: "server-key" });

    // The normal API still requires the key...
    const workspace = await app.call({ url: "/api/workspace" });
    expect(workspace.status).toBe(401);

    // ...but a provider redirect cannot carry one, so it must not be refused for that reason.
    const callback = await app.call({ url: "/api/auth/oauth/callback?state=unknown&code=abc" });
    expect(callback.status).toBe(400);
    expect(callback.header("content-type")).toContain("text/html");
    expect(callback.body).toContain("Sign-in failed");
  });

  it("renders a cancellation page when the provider sends an error", async () => {
    const app = harness({ oauth: configured });
    const callback = await app.call({
      url: "/api/auth/oauth/callback?error=access_denied&error_description=Denied",
    });

    expect(callback.status).toBe(400);
    expect(callback.body).toContain("Sign-in cancelled");
    expect(callback.body).toContain("Denied");
  });
});
