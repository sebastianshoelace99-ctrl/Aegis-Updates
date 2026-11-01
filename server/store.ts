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
  hasChannelPermission,
  hasGuildPermission as canGuildPermission,
  type GuildPermission,
} from "../shared/permissions";
import type {
  ModerationAction,
  ModerationAuditEntry,
} from "../shared/moderation";
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

export type GuildBackup = {
  schemaVersion: 1;
  exportedAt: string;
  guild: Guild;
  members: Member[];
  messagesByChannel: Record<string, Message[]>;
};

export type ModerationAuditRecord = ModerationAuditEntry;

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
  exportGuild(guildId: string): Promise<GuildBackup>;
  moderateMember(
    guildId: string,
    actorId: string,
    targetId: string,
    action: ModerationAction,
    reason: string,
    durationMinutes?: number,
  ): Promise<ModerationAuditRecord>;
  listModerationAudit(guildId: string, memberId: string, limit: number): Promise<ModerationAuditRecord[]>;
  listBannedMemberIds(guildId: string, memberId: string): Promise<string[]>;
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
  searchMessages(channelIds: readonly string[], query: string, limit: number): Promise<Message[]>;
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
  hasPermission(
    channelId: string,
    memberId: string,
    permission: GuildPermission,
  ): Promise<boolean>;
  hasGuildPermission(
    guildId: string,
    memberId: string,
    permission: GuildPermission,
  ): Promise<boolean>;
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
  const restrictions = new Map<
    string,
    { kind: "timeout" | "ban"; expiresAt: string | null; reason: string; createdBy: string }
  >();
  const moderationAudit = new Map<string, ModerationAuditRecord[]>();

  const restrictionKey = (guildId: string, memberId: string, kind: "timeout" | "ban"): string =>
    `${guildId}\u0000${memberId}\u0000${kind}`;

  const hasActiveRestriction = (
    guildId: string,
    memberId: string,
    kind: "timeout" | "ban",
  ): boolean => {
    const key = restrictionKey(guildId, memberId, kind);
    const restriction = restrictions.get(key);
    if (!restriction) return false;
    if (restriction.expiresAt && Date.parse(restriction.expiresAt) <= Date.now()) {
      restrictions.delete(key);
      return false;
    }
    return true;
  };

  return {
    kind: "memory",

    async readWorkspace(memberId) {
      const visibleGuilds = memberId
        ? new Map(
            [...guilds].filter(
              ([guildId, guild]) =>
                guild.memberIds.includes(memberId) && !hasActiveRestriction(guildId, memberId, "ban"),
            ),
          )
        : guilds;
      const workspace = workspaceOf(visibleGuilds, members);
      if (!memberId) return clone(workspace);
      const guildsWithVisibleChannels = workspace.guilds.map((guild) => {
        const channels = guild.channels.filter((channel) =>
          hasChannelPermission(guild, channel, memberId, "view_channel"),
        );
        const categoryIds = new Set(channels.map((channel) => channel.categoryId));
        return {
          ...guild,
          channels,
          categories: guild.categories.filter((category) => categoryIds.has(category.id)),
        };
      });
      return clone({
        guilds: guildsWithVisibleChannels,
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
      moderationAudit.delete(guildId);
      const restrictionPrefix = `${guildId}\u0000`;
      for (const key of restrictions.keys()) {
        if (key.startsWith(restrictionPrefix)) restrictions.delete(key);
      }
      for (const channel of guild.channels) messages.delete(channel.id);
      for (const [inviteId, invite] of invites) {
        if (invite.guildId === guildId) invites.delete(inviteId);
      }
    },

    async exportGuild(guildId) {
      const guild = guilds.get(guildId);
      if (!guild) throw new HttpError(404, "Unknown server.");
      const messagesByChannel = Object.fromEntries(
        guild.channels.map((channel) => [channel.id, clone(messages.get(channel.id) ?? [])]),
      );
      return {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        guild: clone(guild),
        members: guild.memberIds
          .map((memberId) => members.get(memberId))
          .filter((member): member is Member => member !== undefined)
          .map(clone),
        messagesByChannel,
      };
    },

    async moderateMember(guildId, actorId, targetId, action, reason, durationMinutes = 30) {
      const guild = guilds.get(guildId);
      if (!guild) throw new HttpError(404, "Unknown server.");
      if (!canGuildPermission(guild, actorId, "moderate_members")) {
        throw new HttpError(403, "You do not have permission to moderate members.");
      }
      if (targetId === actorId || targetId === guild.ownerId) {
        throw new HttpError(403, "You cannot moderate yourself or the server creator.");
      }
      if (action !== "unban" && !guild.memberIds.includes(targetId)) {
        throw new HttpError(404, "That member is not in this server.");
      }

      const now = new Date();
      let expiresAt: string | null = null;
      if (action === "timeout") {
        if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 40_320) {
          throw new HttpError(400, "Timeouts must last between 1 minute and 28 days.");
        }
        expiresAt = new Date(now.getTime() + durationMinutes * 60_000).toISOString();
        restrictions.set(restrictionKey(guildId, targetId, "timeout"), {
          kind: "timeout",
          expiresAt,
          reason,
          createdBy: actorId,
        });
      } else if (action === "remove_timeout") {
        if (!hasActiveRestriction(guildId, targetId, "timeout")) {
          throw new HttpError(404, "That member does not have an active timeout.");
        }
        restrictions.delete(restrictionKey(guildId, targetId, "timeout"));
      } else if (action === "ban") {
        restrictions.set(restrictionKey(guildId, targetId, "ban"), {
          kind: "ban",
          expiresAt: null,
          reason,
          createdBy: actorId,
        });
        const memberRoles = { ...guild.memberRoles };
        delete memberRoles[targetId];
        guilds.set(guildId, {
          ...guild,
          memberIds: guild.memberIds.filter((memberId) => memberId !== targetId),
          memberRoles,
        });
      } else if (action === "kick") {
        const memberRoles = { ...guild.memberRoles };
        delete memberRoles[targetId];
        guilds.set(guildId, {
          ...guild,
          memberIds: guild.memberIds.filter((memberId) => memberId !== targetId),
          memberRoles,
        });
      } else if (action === "unban") {
        if (!restrictions.delete(restrictionKey(guildId, targetId, "ban"))) {
          throw new HttpError(404, "That member is not banned from this server.");
        }
      }

      const record: ModerationAuditRecord = {
        id: randomUUID(),
        guildId,
        actorId,
        targetId,
        action,
        reason,
        expiresAt,
        createdAt: now.toISOString(),
      };
      moderationAudit.set(guildId, [...(moderationAudit.get(guildId) ?? []), record]);
      return clone(record);
    },

    async listModerationAudit(guildId, memberId, limit) {
      const guild = guilds.get(guildId);
      if (!guild) throw new HttpError(404, "Unknown server.");
      if (!canGuildPermission(guild, memberId, "moderate_members")) {
        throw new HttpError(403, "You do not have permission to view moderation history.");
      }
      return clone((moderationAudit.get(guildId) ?? []).slice(-limit).reverse());
    },

    async listBannedMemberIds(guildId, memberId) {
      const guild = guilds.get(guildId);
      if (!guild) throw new HttpError(404, "Unknown server.");
      if (!canGuildPermission(guild, memberId, "moderate_members")) {
        throw new HttpError(403, "You do not have permission to view server bans.");
      }
      const prefix = `${guildId}\u0000`;
      return [...restrictions.entries()]
        .filter(([key, restriction]) => key.startsWith(prefix) && restriction.kind === "ban")
        .map(([key]) => key.split("\u0000")[1] ?? "")
        .filter(Boolean);
    },

    async saveGuild(raw) {
      const guild = normalizeGuild(raw);
      if (!guild) throw new HttpError(400, "That guild is not a valid workspace record.");
      const previous = guilds.get(guild.id);
      if (!previous) throw new HttpError(404, `Unknown guild: ${guild.id}`);
      if (guild.ownerId !== previous.ownerId) {
        throw new HttpError(403, "Server ownership cannot be changed.");
      }
      if (guild.memberRoles[guild.ownerId ?? ""]?.includes("owner") !== true) {
        throw new HttpError(403, "The server creator must retain the owner role.");
      }
      if (
        Object.entries(guild.memberRoles).some(
          ([memberId, roleIds]) => memberId !== guild.ownerId && roleIds.includes("owner"),
        )
      ) {
        throw new HttpError(403, "Only the server creator can hold the owner role.");
      }

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
      const guild = guilds.get(guildId);
      if (!guild || !canGuildPermission(guild, memberId, "manage_invites")) {
        throw new HttpError(403, "You do not have permission to manage invites.");
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
      const guild = guilds.get(guildId);
      if (!guild) throw new HttpError(404, "Unknown server.");
      if (!canGuildPermission(guild, memberId, "manage_invites")) {
        throw new HttpError(403, "You do not have permission to manage invites.");
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
      const guild = guilds.get(guildId);
      if (!guild) throw new HttpError(404, "Unknown server.");
      if (!canGuildPermission(guild, memberId, "manage_invites")) {
        throw new HttpError(403, "You do not have permission to manage invites.");
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
      if (hasActiveRestriction(invite.guildId, member.id, "ban")) {
        throw new HttpError(403, "You are banned from this server.");
      }
      await this.ensureMember(member);
      const guild = guilds.get(invite.guildId);
      if (!guild) throw new HttpError(404, "That invite is invalid, expired or revoked.");
      if (!guild.memberIds.includes(member.id)) {
        const memberRole = guild.roles.find((role) => role.id === "member");
        guilds.set(invite.guildId, {
          ...guild,
          memberIds: [...guild.memberIds, member.id],
          ...(memberRole
            ? {
                memberRoles: {
                  ...guild.memberRoles,
                  [member.id]: [...(guild.memberRoles[member.id] ?? []), memberRole.id],
                },
              }
            : {}),
        });
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

    async searchMessages(channelIds, query, limit) {
      const allowed = new Set(channelIds);
      const needle = query.toLocaleLowerCase();
      return clone(
        [...messages.values()]
          .flat()
          .filter((message) => allowed.has(message.channelId) && message.body.toLocaleLowerCase().includes(needle))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit),
      );
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
      const channel = guild?.channels.find((entry) => entry.id === channelId);
      if (!guild || !channel) return false;
      return Boolean(
        !memberId ||
          (guild.memberIds.includes(memberId) &&
            !hasActiveRestriction(guild.id, memberId, "ban") &&
            hasChannelPermission(guild, channel, memberId, "view_channel")),
      );
    },

    async hasPermission(channelId, memberId, permission) {
      const guild = [...guilds.values()].find((entry) =>
        entry.channels.some((channel) => channel.id === channelId),
      );
      const channel = guild?.channels.find((entry) => entry.id === channelId);
      return Boolean(
        guild &&
          channel &&
          guild.memberIds.includes(memberId) &&
        !hasActiveRestriction(guild.id, memberId, "ban") &&
        !(
          hasActiveRestriction(guild.id, memberId, "timeout") &&
          ["send_messages", "add_reactions", "connect_voice", "speak", "share_video", "share_screen"].includes(permission)
        ) &&
        hasChannelPermission(guild, channel, memberId, permission),
      );
    },

    async hasGuildPermission(guildId, memberId, permission) {
      const guild = guilds.get(guildId);
      return Boolean(
        guild &&
          guild.memberIds.includes(memberId) &&
        !hasActiveRestriction(guild.id, memberId, "ban") &&
        canGuildPermission(guild, memberId, permission),
      );
    },
  };
}
