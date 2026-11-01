import { z } from "zod";
import { DEFAULT_MEMBER_PERMISSIONS, GUILD_PERMISSIONS } from "./permissions";

/**
 * The workspace graph, as data.
 *
 * Deliberately the same information architecture Discord uses, because that shape is what
 * makes the UI legible: a guild owns ordered categories, a category owns channels, a channel
 * owns messages. Members are global identities so a message author and a member-rail entry are
 * the *same* record - holding two copies is how a name ends up disagreeing with itself.
 *
 * This module is shared by the renderer and the backend. It is pure: no React, no queries, no
 * timers, no `window`. That is what lets the server validate a guild with the exact schema the
 * client will parse, and what lets every test run under Vitest's `environment: "node"`.
 */

export const presenceSchema = z.enum(["online", "idle", "dnd", "offline"]);
export type Presence = z.infer<typeof presenceSchema>;

export const roleSchema = z.enum(["artist", "client", "reviewer"]);
export type Role = z.infer<typeof roleSchema>;

export const memberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The `@` token without the leading `@`. Unique, because mentions resolve through it. */
  handle: z.string().min(1),
  role: roleSchema,
  presence: presenceSchema,
  /** Index into the avatar palette in CSS. A number, not a colour: inline styles are banned. */
  accent: z.number().int().min(0).max(7),
  activity: z.string().optional(),
});
export type Member = z.infer<typeof memberSchema>;

export const channelKindSchema = z.enum(["text", "media", "voice"]);
export type ChannelKind = z.infer<typeof channelKindSchema>;

export const channelSchema = z.object({
  /** Globally unique (`guildId/slug`), so read state can be keyed by it without collisions. */
  id: z.string().min(1),
  /** URL segment. Unique within its guild, which is all a guild-scoped route needs. */
  slug: z.string().min(1),
  name: z.string().min(1),
  topic: z.string(),
  kind: channelKindSchema,
  categoryId: z.string().min(1),
  /** Set when the channel is a commission thread; the gallery asset it points at. */
  commissionId: z.string().nullable(),
  permissionOverwrites: z
    .record(
      z.string(),
      z.object({
        allow: z.array(z.enum(GUILD_PERMISSIONS)).default([]),
        deny: z.array(z.enum(GUILD_PERMISSIONS)).default([]),
      }),
    )
    .default({}),
});
export type Channel = z.infer<typeof channelSchema>;

export const categorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type Category = z.infer<typeof categorySchema>;

/**
 * A guild role, not the person's job title. `color` is an index into the role palette in
 * `tokens.css` for the same CSP reason avatars use indices: a colour string would need a
 * `style` attribute. `position` is explicit so ordering survives a JSON round trip, and
 * `hoist` is what decides whether the role earns its own member-list section.
 */
export const guildRoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(32),
  color: z.number().int().min(0).max(15),
  hoist: z.boolean(),
  position: z.number().int().min(0),
  permissions: z.array(z.enum(GUILD_PERMISSIONS)).default(DEFAULT_MEMBER_PERMISSIONS),
});
export type GuildRole = z.infer<typeof guildRoleSchema>;

/**
 * Per-server notification policy. `mentions` keeps name pings but hides the plain unread dot;
 * `none` mutes the server entirely. Optional so a guild saved before server settings existed
 * still parses - `guildNotificationLevel` fills the default at the call site.
 */
export const notificationLevelSchema = z.enum(["all", "mentions", "none"]);
export type NotificationLevel = z.infer<typeof notificationLevelSchema>;

/**
 * A server icon is a renderer-produced data URL, exactly like a profile picture. It is capped
 * and shape-checked here so a hand-edited record cannot smuggle a remote or script URL into an
 * `<img>`. `.catch(null)` means a corrupt icon costs the icon, not the whole guild.
 */
export const guildIconSchema = z
  .string()
  .max(400_000)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

export const guildSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1).optional(),
  name: z.string().min(1),
  initial: z.string().min(1).max(2),
  accent: z.number().int().min(0).max(7),
  categories: z.array(categorySchema),
  channels: z.array(channelSchema),
  memberIds: z.array(z.string().min(1)).min(1),
  /** Defaults keep every guild written before roles existed parseable. */
  roles: z.array(guildRoleSchema).default([]),
  memberRoles: z.record(z.string(), z.array(z.string())).default({}),
  /**
   * Server-settings fields, optional for the same reason `roles` defaults: a record written by
   * an older build must still load. `src/api/serverSettings.ts` owns their interpretation.
   */
  description: z.string().trim().max(160).optional(),
  notificationLevel: notificationLevelSchema.optional(),
  systemChannelId: z.string().nullable().optional(),
  icon: guildIconSchema.nullable().catch(null).optional(),
});
export type Guild = z.infer<typeof guildSchema>;

/**
 * An empty workspace is valid: whether the signed-in account has joined a server yet is a
 * server fact, not a schema violation.
 */
export const workspaceSchema = z.object({
  guilds: z.array(guildSchema),
  members: z.array(memberSchema),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export function findGuild(target: Workspace, guildId: string): Guild | undefined {
  return target.guilds.find((guild) => guild.id === guildId);
}

export function findChannel(guild: Guild, slug: string): Channel | undefined {
  return guild.channels.find((channel) => channel.slug === slug);
}

export function findChannelById(target: Workspace, channelId: string): Channel | undefined {
  for (const guild of target.guilds) {
    const channel = guild.channels.find((candidate) => candidate.id === channelId);
    if (channel) return channel;
  }
  return undefined;
}

/**
 * The guild a channel belongs to. It scans instead of splitting `channelId` on `/`, so a channel
 * that is *named* after one guild but owned by another is never silently routed to the wrong one.
 */
export function guildOfChannel(target: Workspace, channelId: string): Guild | undefined {
  return target.guilds.find((guild) =>
    guild.channels.some((channel) => channel.id === channelId),
  );
}

/** Category order is data, not `Object.keys` order. Empty categories are omitted, as Discord does. */
export function channelsByCategory(guild: Guild): Array<{ category: Category; channels: Channel[] }> {
  return guild.categories
    .map((entry) => ({
      category: entry,
      channels: guild.channels.filter((channel) => channel.categoryId === entry.id),
    }))
    .filter((group) => group.channels.length > 0);
}

export function memberById(target: Workspace, id: string): Member | undefined {
  return target.members.find((member) => member.id === id);
}

/** Guild membership order is meaningful: the member rail renders it top to bottom. */
export function guildMembers(target: Workspace, guild: Guild): Member[] {
  return guild.memberIds.flatMap((id) => {
    const member = memberById(target, id);
    return member ? [member] : [];
  });
}

/* ---------------------------------------------------------------------------------------------
 * Roles
 *
 * Roles are per guild, so every helper takes the guild rather than reaching for global state.
 * The member rail reads `roleGroups`; the profile card reads `rolesOfMember`; server settings
 * writes through `withMemberRole` / `withoutRole`, which return a new guild instead of mutating
 * one in place. That is what makes the persisted snapshot safe to hand to React.
 * ------------------------------------------------------------------------------------------- */

export function roleById(guild: Guild, roleId: string): GuildRole | undefined {
  return guild.roles.find((role) => role.id === roleId);
}

/** Highest first; unknown ids are ignored so a deleted role cannot strand a member. */
export function rolesOfMember(guild: Guild, memberId: string): GuildRole[] {
  const ids = guild.memberRoles[memberId] ?? [];
  return guild.roles
    .filter((role) => ids.includes(role.id))
    .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
}

/** The role that colours a member's name: highest position, hoisted or not. */
export function highestRole(guild: Guild, memberId: string): GuildRole | undefined {
  return rolesOfMember(guild, memberId)[0];
}

/** The role that owns a member's member-list section. Non-hoisted roles never split the list. */
export function highestHoistedRole(guild: Guild, memberId: string): GuildRole | undefined {
  return rolesOfMember(guild, memberId).find((role) => role.hoist);
}

export type RoleGroup = { role: GuildRole | null; members: Member[] };

/**
 * Server settings may delete every role, and a guild created before roles were editable has none.
 * Rather than render an empty rail, `null` is a real group meaning "no hoisted role".
 */
export function roleGroups(guild: Guild, members: readonly Member[]): RoleGroup[] {
  const hoisted = guild.roles
    .filter((role) => role.hoist)
    .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));

  const buckets = new Map<string, Member[]>();
  const unassigned: Member[] = [];

  for (const member of members) {
    const role = highestHoistedRole(guild, member.id);
    if (!role) {
      unassigned.push(member);
      continue;
    }
    buckets.set(role.id, [...(buckets.get(role.id) ?? []), member]);
  }

  const groups: RoleGroup[] = hoisted
    .filter((role) => buckets.has(role.id))
    .map((role) => ({ role, members: buckets.get(role.id) ?? [] }));

  if (unassigned.length > 0) groups.push({ role: null, members: unassigned });
  return groups;
}

/** Pure assignment used by settings: adding an unknown role is a no-op, not a corrupt record. */
export function withMemberRole(guild: Guild, memberId: string, roleId: string): Guild {
  if (!roleById(guild, roleId) || !guild.memberIds.includes(memberId)) return guild;

  const current = guild.memberRoles[memberId] ?? [];
  if (current.includes(roleId)) return guild;

  return {
    ...guild,
    memberRoles: { ...guild.memberRoles, [memberId]: [...current, roleId] },
  };
}

export function withoutMemberRole(guild: Guild, memberId: string, roleId: string): Guild {
  const current = guild.memberRoles[memberId];
  if (!current?.includes(roleId)) return guild;

  const next = current.filter((id) => id !== roleId);
  const memberRoles = { ...guild.memberRoles };
  if (next.length === 0) delete memberRoles[memberId];
  else memberRoles[memberId] = next;

  return { ...guild, memberRoles };
}

/** Deleting a role also removes every assignment, so the record cannot point at a ghost. */
export function withoutRole(guild: Guild, roleId: string): Guild {
  const memberRoles: Record<string, string[]> = {};
  for (const [memberId, ids] of Object.entries(guild.memberRoles)) {
    const kept = ids.filter((id) => id !== roleId);
    if (kept.length > 0) memberRoles[memberId] = kept;
  }

  return {
    ...guild,
    roles: guild.roles.filter((role) => role.id !== roleId),
    memberRoles,
  };
}

/**
 * First guild, first channel. Also the fallback when a route is stale or hand-edited. An empty
 * workspace has no route, which is why both halves can be empty strings.
 */
export function defaultRoute(target: Workspace): { guildId: string; slug: string } {
  const guild = target.guilds[0];
  const channel = guild?.channels[0];
  return { guildId: guild?.id ?? "", slug: channel?.slug ?? "" };
}
/**
 * Structural checks the schema cannot express. A channel pointing at a missing category, or an
 * assignment pointing at a deleted role, is how a malformed graph renders a broken pane. The
 * backend runs this before it writes; the renderer runs it before it reads.
 */
export function normalizeGuild(raw: unknown): Guild | null {
  const parsed = guildSchema.safeParse(raw);
  if (!parsed.success) return null;

  const guild = parsed.data;
  const categoryIds = new Set<string>();
  for (const category of guild.categories) {
    // A category id is `${guildId}:${slug}` by construction. Enforcing that here is what stops a
    // hand-edited PATCH from re-pointing another guild's category at this one.
    if (!category.id.startsWith(`${guild.id}:`)) return null;
    if (categoryIds.has(category.id)) return null;
    categoryIds.add(category.id);
  }

  const channelIds = new Set<string>();
  for (const channel of guild.channels) {
    if (!categoryIds.has(channel.categoryId)) return null;
    if (!channel.id.startsWith(`${guild.id}/`)) return null;
    if (channelIds.has(channel.id)) return null;
    channelIds.add(channel.id);
  }

  const roleIds = new Set(guild.roles.map((role) => role.id));
  const memberIds = new Set(guild.memberIds);
  const memberRoles: Record<string, string[]> = {};

  for (const [memberId, ids] of Object.entries(guild.memberRoles)) {
    if (!memberIds.has(memberId)) continue;
    const kept = ids.filter((id) => roleIds.has(id));
    if (kept.length > 0) memberRoles[memberId] = [...new Set(kept)];
  }

  // A system channel that points at a removed (or voice) channel is a dangling setting, not a
  // reason to discard the whole guild. Clear it so the UI never offers a channel that cannot exist.
  const system = guild.systemChannelId;
  const systemChannel =
    system === null || system === undefined
      ? undefined
      : guild.channels.find((channel) => channel.id === system && channel.kind !== "voice");
  const systemChannelId = systemChannel?.id ?? null;

  const seenMembers = new Set<string>();
  const dedupedMembers = guild.memberIds.filter((id) => {
    if (seenMembers.has(id)) return false;
    seenMembers.add(id);
    return true;
  });

  return { ...guild, memberIds: dedupedMembers, memberRoles, systemChannelId };
}

/** Validate a whole workspace, dropping guilds or members that cannot be rendered. */
export function normalizeWorkspace(raw: unknown): Workspace {
  const parsed = workspaceSchema.safeParse(raw);
  if (!parsed.success) return { guilds: [], members: [] };

  const guilds: Guild[] = [];
  const guildIds = new Set<string>();
  for (const candidate of parsed.data.guilds) {
    const guild = normalizeGuild(candidate);
    if (!guild || guildIds.has(guild.id)) continue;
    guildIds.add(guild.id);
    guilds.push(guild);
  }

  const members: Member[] = [];
  const memberIds = new Set<string>();
  for (const member of parsed.data.members) {
    if (memberIds.has(member.id)) continue;
    memberIds.add(member.id);
    members.push(member);
  }

  return { guilds, members };
}
