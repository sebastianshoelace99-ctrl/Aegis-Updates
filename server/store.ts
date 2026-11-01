import { randomUUID } from "node:crypto";
import {
  buildGuild,
  createServerInputSchema,
  ownerMember,
  type CreateServerInput,
} from "../shared/guildFactory";
import {
  normalizeGuild,
  normalizeWorkspace,
  type Channel,
  type Guild,
  type Member,
  type Presence,
  type Workspace,
} from "../shared/domain";
import {
  mentionedHandles,
  toggleReaction as applyReaction,
  type FileAttachment,
  type Message,
} from "../shared/messages";
import { HttpError } from "./errors";

export type InviteSummary = {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  useCount: number;
};

/**
 * The persistence contract.
 *
 * Both implementations answer with a whole `Workspace` after a write, instead of an ack. That is
 * what lets the rail replace its graph atomically: a client that patched its local copy from a
 * partial reply would eventually disagree with the server about roles or member order.
 */
export type Store = {
  readonly kind: "memory" | "supabase";
  readWorkspace(memberId?: string): Promise<Workspace>;
  ensureMember(member: Member): Promise<Member>;
  createGuild(input: CreateServerInput): Promise<{ guild: Guild; workspace: Workspace }>;
  deleteGuild(guildId: string, memberId: string): Promise<void>;
  saveGuild(raw: unknown): Promise<{ guild: Guild; workspace: Workspace }>;
  isGuildOwner(guildId: string, memberId: string): Promise<boolean>;
  createInvite(
    guildId: string,
    memberId: string,
    codeHash: string,
    expiresAt: string,
  ): Promise<InviteSummary>;
  listInvites(guildId: string, memberId: string): Promise<InviteSummary[]>;
  revokeInvite(guildId: string, inviteId: string, memberId: string): Promise<void>;
  redeemInvite(codeHash: string, member: Member): Promise<string>;
  listMessages(channelId: string, before: string | null, limit: number): Promise<Message[]>;
  createMessage(
    channelId: string,
    authorId: string,
    body: string,
    attachments?: readonly FileAttachment[],
  ): Promise<Message>;
  /**
   * Add or remove one member's reaction and answer with the *whole updated message*.
   *
   * The whole row, not a reaction delta, for the same reason a guild write answers with the whole
   * workspace: a client that patched counters locally would eventually disagree with the server
   * about who reacted.
   */
  toggleReaction(
    channelId: string,
    messageId: string,
    memberId: string,
    emoji: string,
    burst: boolean,
  ): Promise<Message>;
  setPresence(memberId: string, presence: Presence): Promise<void>;
  hasChannel(channelId: string, memberId?: string): Promise<boolean>;
};

const clone = <T>(value: T): T => structuredClone(value);

function uniqueHandle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function placeholderMember(id: string, taken: Set<string>): Member {
  return {
    id,
    name: id,
    handle: uniqueHandle(id.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "member", taken),
    role: "artist",
    presence: "offline",
    accent: 0,
  };
}

function channelOf(guilds: Iterable<Guild>, channelId: string): Channel | undefined {
  for (const guild of guilds) {
    const channel = guild.channels.find((entry) => entry.id === channelId);
    if (channel) return channel;
  }
  return undefined;
}

function workspaceOf(guilds: Map<string, Guild>, members: Map<string, Member>): Workspace {
  return normalizeWorkspace({
    guilds: [...guilds.values()],
    members: [...members.values()],
  });
}


/**
 * The dev store: the whole database in two Maps, gone when the process exits.
 *
 * It exists so `npm run server` and the packaged smoke test work before Supabase is configured,
 * and so tests never depend on a network. It implements the same contract as the Supabase store,
 * including the ordering guarantees, so an app that works here works there.
 */
export function createMemoryStore(): Store {
  const guilds = new Map<string, Guild>();
  const owners = new Map<string, string>();
  const members = new Map<string, Member>();
  const messages = new Map<string, Message[]>();
  const invites = new Map<
    string,
    InviteSummary & { guildId: string; createdBy: string; codeHash: string }
  >();

  return {
    kind: "memory",

    async readWorkspace(memberId) {
      const visibleGuilds = memberId
        ? new Map(
            [...guilds].filter(([, guild]) => guild.memberIds.includes(memberId)),
          )
        : guilds;
      const workspace = workspaceOf(visibleGuilds, members);
      if (!memberId) return clone(workspace);
      return clone({
        guilds: workspace.guilds,
        members: workspace.members,
      });
    },

    async ensureMember(member) {
      const existing = members.get(member.id);
      if (existing) {
        const updated = { ...existing, name: member.name, accent: member.accent };
        members.set(member.id, updated);
        return clone(updated);
      }

      const takenHandles = new Set([...members.values()].map((entry) => entry.handle));
      const added = {
        ...member,
        handle: uniqueHandle(member.handle, takenHandles),
      };
      members.set(member.id, added);
      return clone(added);
    },

    async createGuild(raw) {
      const input = createServerInputSchema.parse(raw);
      const owner = ownerMember(input);
      const existing = members.get(owner.id);

      const takenHandles = new Set(
        [...members.values()].filter((member) => member.id !== owner.id).map((m) => m.handle),
      );
      const handle = existing?.handle ?? uniqueHandle(owner.handle, takenHandles);

      members.set(owner.id, {
        ...owner,
        handle,
        presence: existing?.presence ?? "online",
      });

      const guild = { ...buildGuild(input, guilds.keys()), ownerId: owner.id };
      guilds.set(guild.id, guild);
      owners.set(guild.id, owner.id);

      return { guild: clone(guild), workspace: clone(workspaceOf(guilds, members)) };
    },

    async deleteGuild(guildId, memberId) {
      if (!guilds.has(guildId)) throw new HttpError(404, "Unknown server.");
      if (owners.get(guildId) !== memberId) {
        throw new HttpError(403, "Only the server owner can delete this server.");
      }
      const guild = guilds.get(guildId);
      if (!guild) throw new HttpError(404, "Unknown server.");
      guilds.delete(guildId);
      owners.delete(guildId);
      for (const channel of guild.channels) messages.delete(channel.id);
      for (const [inviteId, invite] of invites) {
        if (invite.guildId === guildId) invites.delete(inviteId);
      }
    },

    async saveGuild(raw) {
      const guild = normalizeGuild(raw);
      if (!guild) throw new HttpError(400, "That guild is not a valid workspace record.");
      const previous = guilds.get(guild.id);
      if (!previous) throw new HttpError(404, `Unknown guild: ${guild.id}`);

      // Supabase cascades a deleted channel's messages; the memory store must match.
      const keptChannels = new Set(guild.channels.map((channel) => channel.id));
      for (const channel of previous.channels) {
        if (!keptChannels.has(channel.id)) messages.delete(channel.id);
      }

      const takenHandles = new Set([...members.values()].map((member) => member.handle));
      for (const id of guild.memberIds) {
        if (members.has(id)) continue;
        const member = placeholderMember(id, takenHandles);
        takenHandles.add(member.handle);
        members.set(id, member);
      }

      guilds.set(guild.id, guild);
      return { guild: clone(guild), workspace: clone(workspaceOf(guilds, members)) };
    },

    async isGuildOwner(guildId, memberId) {
      return owners.get(guildId) === memberId;
    },

    async createInvite(guildId, memberId, codeHash, expiresAt) {
      if (!guilds.has(guildId)) throw new HttpError(404, "Unknown server.");
      if (owners.get(guildId) !== memberId) {
        throw new HttpError(403, "Only the server owner can manage invite links.");
      }
      const invite: InviteSummary & {
        guildId: string;
        createdBy: string;
        codeHash: string;
      } = {
        id: randomUUID(),
        guildId,
        createdBy: memberId,
        codeHash,
        createdAt: new Date().toISOString(),
        expiresAt,
        revokedAt: null,
        useCount: 0,
      };
      invites.set(invite.id, invite);
      const { guildId: _guildId, createdBy: _createdBy, codeHash: _codeHash, ...summary } = invite;
      return clone(summary);
    },

    async listInvites(guildId, memberId) {
      if (!guilds.has(guildId)) throw new HttpError(404, "Unknown server.");
      if (owners.get(guildId) !== memberId) {
        throw new HttpError(403, "Only the server owner can manage invite links.");
      }
      return clone(
        [...invites.values()]
          .filter((invite) => invite.guildId === guildId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(({ guildId: _guildId, createdBy: _createdBy, codeHash: _codeHash, ...summary }) =>
            summary,
          ),
      );
    },

    async revokeInvite(guildId, inviteId, memberId) {
      if (!guilds.has(guildId)) throw new HttpError(404, "Unknown server.");
      if (owners.get(guildId) !== memberId) {
        throw new HttpError(403, "Only the server owner can manage invite links.");
      }
      const invite = invites.get(inviteId);
      if (!invite || invite.guildId !== guildId) throw new HttpError(404, "Unknown invite.");
      invite.revokedAt ??= new Date().toISOString();
    },

    async redeemInvite(codeHash, member) {
      const invite = [...invites.values()].find((entry) => entry.codeHash === codeHash);
      if (
        !invite ||
        invite.revokedAt ||
        Date.parse(invite.expiresAt) <= Date.now() ||
        !guilds.has(invite.guildId)
      ) {
        throw new HttpError(404, "That invite is invalid, expired or revoked.");
      }
      await this.ensureMember(member);
      const guild = guilds.get(invite.guildId);
      if (!guild) throw new HttpError(404, "That invite is invalid, expired or revoked.");
      if (!guild.memberIds.includes(member.id)) {
        guilds.set(invite.guildId, { ...guild, memberIds: [...guild.memberIds, member.id] });
      }
      invite.useCount += 1;
      return invite.guildId;
    },

    async listMessages(channelId, before, limit) {
      const all = messages.get(channelId) ?? [];
      const boundary = before ? all.findIndex((message) => message.createdAt >= before) : all.length;
      const end = boundary === -1 ? all.length : boundary;
      const start = Math.max(0, end - limit);
      return clone(all.slice(start, end));
    },

    async createMessage(channelId, authorId, body, attachments = []) {
      const channel = channelOf(guilds.values(), channelId);
      if (!channel) throw new HttpError(404, `Unknown channel: ${channelId}`);
      if (channel.kind === "voice") throw new HttpError(400, "A voice channel cannot hold messages.");

      const author = members.get(authorId);
      if (!author) throw new HttpError(403, "That member is not in this workspace.");

      const all = messages.get(channelId) ?? [];
      const last = all[all.length - 1];
      const now = Date.now();
      // Strictly increasing per channel: a timestamp cursor must never reselect a row.
      const at = last ? Math.max(now, Date.parse(last.createdAt) + 1) : now;

      const message: Message = {
        id: randomUUID(),
        channelId,
        authorId,
        body,
        createdAt: new Date(at).toISOString(),
        kind: "user",
        attachments: attachments.map((item) => ({ ...item })),
        mentions: mentionedHandles(body),
        replyToId: null,
        editedAt: null,
        reactions: [],
      };

      messages.set(channelId, [...all, message]);
      return clone(message);
    },

    async toggleReaction(channelId, messageId, memberId, emoji, burst) {
      const rows = messages.get(channelId);
      const index = rows?.findIndex((message) => message.id === messageId) ?? -1;
      if (!rows || index < 0) throw new HttpError(404, `Unknown message: ${messageId}`);

      if (!members.has(memberId)) {
        throw new HttpError(403, "That member is not in this workspace.");
      }

      // Replace exactly one row: the feed's order and every timestamp stay untouched, which is what
      // lets the client swap the row in place instead of refetching the page.
      const next = rows.slice();
      const current = rows[index]!;
      next[index] = {
        ...current,
        reactions: applyReaction(current.reactions, emoji, memberId, burst),
      };

      messages.set(channelId, next);
      return clone(next[index]!);
    },

    async setPresence(memberId, presence) {
      const member = members.get(memberId);
      if (!member) return;
      members.set(memberId, { ...member, presence });
    },

    async hasChannel(channelId, memberId) {
      const guild = [...guilds.values()].find((entry) =>
        entry.channels.some((channel) => channel.id === channelId),
      );
      return Boolean(guild && (!memberId || guild.memberIds.includes(memberId)));
    },
  };
}
