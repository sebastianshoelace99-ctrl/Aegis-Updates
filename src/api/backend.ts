import { z } from "zod";
import { createServerInputSchema, type CreateServerInput } from "../../shared/guildFactory";
import {
  backendEventSchema,
  type BackendEvent,
  type VoiceSignal,
} from "../../shared/events";
import { messageSchema, type FileAttachment, type Message } from "../../shared/messages";
import {
  moderationActionSchema,
  moderationAuditEntrySchema,
  type ModerationAction,
  type ModerationAuditEntry,
} from "../../shared/moderation";
import {
  guildSchema,
  memberSchema,
  presenceSchema,
  workspaceSchema,
  type Presence,
  type Workspace,
} from "../../shared/domain";
import { API_BASE, authHeaders, request } from "./http";

/**
 * The backend surface, typed once.
 *
 * Every reply is parsed with the same schema the server validated against, so a stale server or
 * a hand-edited response cannot put a malformed guild in front of the UI.
 */

export type GuildReply = { guild: unknown; workspace: Workspace };

export const inviteSummarySchema = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  useCount: z.number().int().nonnegative(),
});
export type InviteSummary = z.infer<typeof inviteSummarySchema>;

const workspaceReplySchema = z.object({ workspace: workspaceSchema });
const guildReplySchema = z.object({ guild: z.unknown(), workspace: workspaceSchema });

export async function fetchWorkspace(): Promise<Workspace> {
  const reply = workspaceReplySchema.parse(await request<unknown>("/api/workspace"));
  return reply.workspace;
}

export async function createGuild(input: CreateServerInput): Promise<GuildReply> {
  const payload = createServerInputSchema.parse(input);
  return guildReplySchema.parse(
    await request<unknown>("/api/guilds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  ) as GuildReply;
}

function guildIdOf(guild: unknown): string {
  if (guild && typeof guild === "object" && "id" in guild) {
    const id = (guild as { id: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  throw new Error("Cannot save a guild without an id");
}

export async function saveGuild(guild: unknown): Promise<Workspace> {
  const reply = guildReplySchema.parse(
    await request<unknown>(`/api/guilds/${encodeURIComponent(guildIdOf(guild))}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(guild),
    }),
  );
  return reply.workspace;
}

export async function deleteGuild(guildId: string): Promise<Workspace> {
  const reply = workspaceReplySchema.parse(
    await request<unknown>(`/api/guilds/${encodeURIComponent(guildId)}`, {
      method: "DELETE",
    }),
  );
  return reply.workspace;
}

export const guildBackupSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  guild: guildSchema,
  members: z.array(memberSchema),
  messagesByChannel: z.record(z.string(), z.array(messageSchema)),
});
export type GuildBackup = z.infer<typeof guildBackupSchema>;

export async function fetchGuildBackup(guildId: string): Promise<GuildBackup> {
  return guildBackupSchema.parse(
    await request<unknown>(`/api/guilds/${encodeURIComponent(guildId)}/export`),
  );
}

export async function fetchModerationAudit(
  guildId: string,
): Promise<{ entries: ModerationAuditEntry[]; bannedMemberIds: string[] }> {
  return z
    .object({
      entries: z.array(moderationAuditEntrySchema),
      bannedMemberIds: z.array(z.string().min(1)),
    })
    .parse(await request<unknown>(`/api/guilds/${encodeURIComponent(guildId)}/moderation`));
}

export async function moderateMember(input: {
  guildId: string;
  targetId: string;
  action: ModerationAction;
  reason: string;
  durationMinutes?: number;
}): Promise<{ entry: ModerationAuditEntry; workspace: Workspace }> {
  const body = z
    .object({
      targetId: z.string().min(1).max(64),
      action: moderationActionSchema,
      reason: z.string().max(500),
      durationMinutes: z.number().int().min(1).max(40_320).optional(),
    })
    .parse(input);
  return z
    .object({ entry: moderationAuditEntrySchema, workspace: workspaceSchema })
    .parse(
      await request<unknown>(`/api/guilds/${encodeURIComponent(input.guildId)}/moderation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
}

export async function listGuildInvites(guildId: string): Promise<InviteSummary[]> {
  const reply = z
    .object({ invites: z.array(inviteSummarySchema) })
    .parse(await request<unknown>(`/api/guilds/${encodeURIComponent(guildId)}/invites`));
  return reply.invites;
}

export async function createGuildInvite(
  guildId: string,
): Promise<{ invite: InviteSummary; link: string }> {
  return z
    .object({ invite: inviteSummarySchema, link: z.string().startsWith("aegis://invite?code=") })
    .parse(
      await request<unknown>(`/api/guilds/${encodeURIComponent(guildId)}/invites`, {
        method: "POST",
      }),
    );
}

export async function revokeGuildInvite(guildId: string, inviteId: string): Promise<void> {
  await request<void>(
    `/api/guilds/${encodeURIComponent(guildId)}/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  );
}

export async function redeemGuildInvite(
  code: string,
): Promise<{ guildId: string; workspace: Workspace }> {
  return z
    .object({ guildId: z.string().min(1), workspace: workspaceSchema })
    .parse(
      await request<unknown>("/api/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      }),
    );
}

export type FetchMessagesArgs = {
  channelId: string;
  before?: string | null;
  limit?: number;
};

export async function fetchMessagesPage({
  channelId,
  before = null,
  limit,
}: FetchMessagesArgs): Promise<Message[]> {
  const query = new URLSearchParams();
  if (before) query.set("before", before);
  if (limit) query.set("limit", String(limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  const raw = await request<unknown>(
    `/api/channels/${encodeURIComponent(channelId)}/messages${suffix}`,
  );
  return z.array(messageSchema).parse(raw);
}

export async function searchMessages(query: string, guildId?: string): Promise<Message[]> {
  const params = new URLSearchParams({ q: query });
  if (guildId) params.set("guildId", guildId);
  const raw = await request<unknown>(`/api/search?${params.toString()}`);
  return z.object({ messages: z.array(messageSchema) }).parse(raw).messages;
}

export async function postMessage(
  channelId: string,
  body: string,
  attachments: readonly FileAttachment[] = [],
): Promise<Message> {
  const raw = await request<unknown>(
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Only ids travel: the server re-reads name/type/size from its own upload records.
      body: JSON.stringify({
        body,
        attachments: attachments.map((item) => ({ uploadId: item.uploadId })),
      }),
    },
  );
  return messageSchema.parse(raw);
}

export async function postReaction(
  channelId: string,
  messageId: string,
  emoji: string,
  burst: boolean,
): Promise<Message> {
  const raw = await request<unknown>(
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji, burst }),
    },
  );
  return messageSchema.parse(raw);
}

export async function postTyping(channelId: string): Promise<void> {
  await request<void>("/api/typing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId }),
  });
}

export async function postPresence(presence: Presence): Promise<void> {
  await request<void>("/api/presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ presence }),
  });
}

const iceServerSchema = z.object({
  urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export async function joinVoiceChannel(
  channelId: string,
): Promise<{ peers: string[]; iceServers: RTCIceServer[]; participantLimit: number }> {
  const raw = await request<unknown>("/api/voice/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId }),
  });
  const reply = z
    .object({
      peers: z.array(z.string().min(1)),
      iceServers: z.array(iceServerSchema).min(1).max(10),
      participantLimit: z.number().int().min(2).max(6),
    })
    .parse(raw);
  return {
    peers: reply.peers,
    iceServers: reply.iceServers,
    participantLimit: reply.participantLimit,
  };
}

export async function heartbeatVoiceChannel(channelId: string): Promise<void> {
  await request<void>("/api/voice/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId }),
  });
}

export async function leaveVoiceChannel(channelId: string): Promise<void> {
  await request<void>("/api/voice/join", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId }),
  });
}

export async function sendVoiceSignal(
  channelId: string,
  toMemberId: string,
  signal: VoiceSignal,
): Promise<void> {
  await request<void>("/api/voice/signal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId, toMemberId, signal }),
  });
}


export type { BackendEvent } from "../../shared/events";

export type BackendStatus = "connecting" | "online" | "offline";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The live channel, as an SSE stream read through `fetch`.
 *
 * `EventSource` cannot send the auth headers the rest of the API requires, so the stream is read
 * from a `ReadableStream` instead. Reconnects are bounded and cancellable; an app that silently
 * stopped receiving events would look exactly like a quiet server.
 */
export function subscribeEvents(
  onEvent: (event: BackendEvent) => void,
  onStatus?: (status: BackendStatus) => void,
): () => void {
  const controller = new AbortController();
  let stopped = false;

  const deliver = (frame: string): void => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (data.length === 0) return;

    try {
      const parsed = backendEventSchema.safeParse(JSON.parse(data));
      if (parsed.success) onEvent(parsed.data);
    } catch {
      /* A malformed frame is a server bug; dropping it keeps the stream alive. */
    }
  };

  const consume = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        deliver(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  };

  const run = async (): Promise<void> => {
    let attempt = 0;
    /** Set from `Retry-After` on a 429/428/503, so the loop paces itself off the server. */
    let serverWaitMs = 0;

    while (!stopped) {
      onStatus?.("connecting");
      try {
        const response = await fetch(`${API_BASE}/api/events`, {
          headers: authHeaders(),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          // A refusal is a *server instruction*, not just a failure: retrying before the window
          // resets turns one 429 into a loop of them, and every rejection feeds the risk score.
          const hinted = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
          if (Number.isFinite(hinted) && hinted > 0) serverWaitMs = hinted * 1000;
          throw new Error(`Event stream refused: ${response.status}`);
        }

        attempt = 0;
        serverWaitMs = 0;
        onStatus?.("online");
        await consume(response.body);
      } catch {
        if (stopped) return;
      }

      if (stopped) return;
      onStatus?.("offline");
      attempt += 1;
      // Capped: honouring a 120 s hint in full would freeze the feed long after the server has
      // recovered, and the hint is only ever a lower bound on how long to wait.
      const backoff = Math.min(5_000, 400 * 2 ** Math.min(attempt, 4));
      await sleep(Math.min(30_000, serverWaitMs > 0 ? serverWaitMs : backoff));
      serverWaitMs = 0;
    }
  };

  void run();

  return () => {
    stopped = true;
    controller.abort();
  };
}
