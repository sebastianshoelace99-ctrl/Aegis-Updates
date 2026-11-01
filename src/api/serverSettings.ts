import {
  guildIconSchema,
  notificationLevelSchema,
  type Channel,
  type Guild,
  type NotificationLevel,
} from "./workspace";

/**
 * Server settings, interpreted.
 *
 * The guild record stores these three fields as optional values so an overlay saved by an older
 * build still loads. Every read goes through a helper here, and every write goes through
 * `applyServerSettings`: that is what keeps "no system channel" and "muted" from becoming two
 * different spellings of the same state in three components.
 */

export const SERVER_DESCRIPTION_MAX = 160;

export const NOTIFICATION_LEVELS: readonly NotificationLevel[] = ["all", "mentions", "none"];

export const NOTIFICATION_COPY: Record<
  NotificationLevel,
  { label: string; caption: string }
> = {
  all: {
    label: "All messages",
    caption: "Unread dots and mention counts appear on the rail and in the channel list.",
  },
  mentions: {
    label: "Only @mentions",
    caption: "Name pings still count; plain unread dots stay quiet.",
  },
  none: {
    label: "Nothing",
    caption: "The server stops reporting unread activity until you switch this back on.",
  },
};

export function guildNotificationLevel(guild: Guild): NotificationLevel {
  return notificationLevelSchema.safeParse(guild.notificationLevel).success
    ? (guild.notificationLevel as NotificationLevel)
    : "all";
}

export function guildDescription(guild: Guild): string {
  return guild.description ?? "";
}

/** A channel is eligible for system messages only if it is a text or media channel in this guild. */
export function isSystemChannelCandidate(channel: Channel): boolean {
  return channel.kind !== "voice";
}

/** `null` covers both "never set" and "points at a channel that has since been removed". */
export function systemChannelOf(guild: Guild): Channel | null {
  const id = guild.systemChannelId;
  if (!id) return null;
  return guild.channels.find((channel) => channel.id === id && isSystemChannelCandidate(channel)) ?? null;
}

export function isSystemChannel(guild: Guild, channelId: string): boolean {
  return guild.systemChannelId === channelId && systemChannelOf(guild)?.id === channelId;
}

export type ServerSettingsPatch = {
  description?: string;
  notificationLevel?: NotificationLevel;
  systemChannelId?: string | null;
  icon?: string | null;
};

/**
 * The only write path. An unknown or voice channel resolves to `null` rather than being stored,
 * the description is trimmed and capped here, and an icon must be a bounded image data URL.
 */
export function applyServerSettings(guild: Guild, patch: ServerSettingsPatch): Guild {
  const next: Guild = { ...guild };

  if (patch.description !== undefined) {
    next.description = patch.description.trim().slice(0, SERVER_DESCRIPTION_MAX);
  }

  if (patch.notificationLevel !== undefined) {
    const parsed = notificationLevelSchema.safeParse(patch.notificationLevel);
    next.notificationLevel = parsed.success ? parsed.data : "all";
  }

  if (patch.systemChannelId !== undefined) {
    const candidate = patch.systemChannelId;
    const channel = candidate
      ? guild.channels.find((entry) => entry.id === candidate && isSystemChannelCandidate(entry))
      : undefined;
    next.systemChannelId = channel?.id ?? null;
  }

  if (patch.icon !== undefined) {
    const parsed = guildIconSchema.safeParse(patch.icon);
    next.icon = parsed.success ? parsed.data : null;
  }

  return next;
}
