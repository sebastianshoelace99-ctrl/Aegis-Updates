import type { Channel, Guild } from "./domain";

export const GUILD_PERMISSIONS = [
  "view_channel",
  "read_history",
  "send_messages",
  "add_reactions",
  "connect_voice",
  "speak",
  "share_video",
  "share_screen",
  "manage_channels",
  "manage_roles",
  "manage_invites",
  "moderate_members",
  "manage_guild",
  "export_data",
] as const;

export type GuildPermission = (typeof GUILD_PERMISSIONS)[number];

export const DEFAULT_MEMBER_PERMISSIONS: GuildPermission[] = [
  "view_channel",
  "read_history",
  "send_messages",
  "add_reactions",
  "connect_voice",
  "speak",
  "share_video",
  "share_screen",
];

export const OWNER_PERMISSIONS: GuildPermission[] = [...GUILD_PERMISSIONS];

export function permissionsFor(
  guild: Guild,
  memberId: string,
  channel?: Channel,
): ReadonlySet<GuildPermission> {
  if (guild.ownerId === memberId) return new Set(OWNER_PERMISSIONS);

  const memberRoleIds = new Set(guild.memberRoles[memberId] ?? []);
  const effective = new Set<GuildPermission>();

  for (const role of guild.roles) {
    if (!memberRoleIds.has(role.id)) continue;
    for (const permission of role.permissions) effective.add(permission);
  }

  if (effective.has("manage_guild")) {
    for (const permission of GUILD_PERMISSIONS) effective.add(permission);
    return effective;
  }

  if (channel) {
    const denied = new Set<GuildPermission>();
    const allowed = new Set<GuildPermission>();
    for (const roleId of memberRoleIds) {
      const overwrite = channel.permissionOverwrites[roleId];
      if (!overwrite) continue;
      for (const permission of overwrite.deny) denied.add(permission);
      for (const permission of overwrite.allow) allowed.add(permission);
    }
    for (const permission of denied) effective.delete(permission);
    for (const permission of allowed) effective.add(permission);
  }

  return effective;
}

export function hasGuildPermission(
  guild: Guild,
  memberId: string,
  permission: GuildPermission,
): boolean {
  return permissionsFor(guild, memberId).has(permission);
}

export function hasChannelPermission(
  guild: Guild,
  channel: Channel,
  memberId: string,
  permission: GuildPermission,
): boolean {
  return permissionsFor(guild, memberId, channel).has(permission);
}
