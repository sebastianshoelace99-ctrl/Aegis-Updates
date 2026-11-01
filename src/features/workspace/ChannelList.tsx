import { useMemo, useState } from "react";
import { Channel } from "../../../shared/channels";
import {
  guildDescription,
  guildNotificationLevel,
  isSystemChannel,
} from "../../api/serverSettings";
import { channelsByCategory } from "../../api/workspace";
import { getSelfId } from "../../state/identity";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { useSelfIdentity } from "../../state/useIdentity";
import { useUiStore } from "../../state/uiStore";
import { readFor, useWorkspaceStore } from "../../state/workspaceStore";
import { useShellState } from "../../shell/useShellState";
import { ThemeMenu } from "../../theme/ThemePicker";
import { Avatar } from "../../ui/Avatar";
import {
  ChevronGlyph,
  HashGlyph,
  HeadphonesGlyph,
  HeadphonesOffGlyph,
  MediaGlyph,
  MembersGlyph,
  MicGlyph,
  MicOffGlyph,
  SettingsGlyph,
  SpeakerGlyph,
} from "../../ui/Glyphs";
import { toggleDeafen, toggleMute } from "../../state/voiceSession";
import { useVoice } from "../../state/useVoice";
import { VoiceStatus } from "../voice/VoiceStatus";
import styles from "./ChannelList.module.css";

/**
 * The channel column: guild header, collapsible categories, channels, and the self card.
 *
 * Unread is rendered three different ways - bold name, a white pill for "new", a red count for
 * "mentioned" - because that is the hierarchy a reader needs before they click anything.
 */
export function ChannelList(): React.JSX.Element {
  const guildId = useWorkspaceStore((state) => state.guildId);
  const activeChannelId = useWorkspaceStore((state) => state.channelId);
  const read = useWorkspaceStore((state) => state.read);
  const openChannel = useWorkspaceStore((state) => state.openChannel);
  const openServerSettings = useUiStore((state) => state.openServerSettings);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const live = useLiveWorkspace();

  const guild = useMemo(
    () => live.guilds.find((entry) => entry.id === guildId) ?? live.guilds[0],
    [guildId, live],
  );
  const groups = useMemo(() => (guild ? channelsByCategory(guild) : []), [guild]);
  const notifyLevel = guild ? guildNotificationLevel(guild) : "all";
  const description = guild ? guildDescription(guild) : "";

  const allCollapsed = groups.length > 0 && groups.every((group) => collapsed[group.category.id]);

  return (
    <div className={styles.panel} data-testid="channel-list">
      <div className={styles.header}>
        <h2
          className={styles.guildName}
          title={guild ? (description ? `${guild.name} — ${description}` : guild.name) : "No server"}
        >
          {guild?.name ?? "No server"}
        </h2>
        <button
          type="button"
          className={styles.collapseAll}
          onClick={openServerSettings}
          disabled={!guild}
          aria-label="Server settings"
          title={guild ? "Server settings" : "Create a server first"}
          data-testid="open-server-settings"
        >
          <SettingsGlyph />
        </button>
        <button
          type="button"
          className={styles.collapseAll}
          data-collapsed={allCollapsed}
          onClick={() =>
            setCollapsed(
              allCollapsed
                ? {}
                : Object.fromEntries(groups.map((group) => [group.category.id, true])),
            )
          }
          aria-label={allCollapsed ? "Expand all categories" : "Collapse all categories"}
          title={allCollapsed ? "Expand all categories" : "Collapse all categories"}
        >
          <ChevronGlyph />
        </button>
      </div>

      <nav className={styles.nav} aria-label="Channels">
        {groups.map((group) => {
          const isCollapsed = Boolean(collapsed[group.category.id]);

          return (
            <section key={group.category.id} className={styles.category}>
              <button
                type="button"
                className={styles.categoryLabel}
                onClick={() =>
                  setCollapsed((prev) => ({
                    ...prev,
                    [group.category.id]: !prev[group.category.id],
                  }))
                }
                aria-expanded={!isCollapsed}
              >
                <span className={styles.chevron} data-collapsed={isCollapsed}>
                  <ChevronGlyph />
                </span>
                <span>{group.category.name}</span>
              </button>

              {isCollapsed
                ? null
                : group.channels.map((channel) => {
                    const state = readFor(read, channel.id);
                    const active = channel.id === activeChannelId;
                    const Glyph =
                      channel.kind === "media"
                        ? MediaGlyph
                        : channel.kind === "voice"
                          ? SpeakerGlyph
                          : HashGlyph;

                    return (
                      <button
                        key={channel.id}
                        type="button"
                        className={styles.channel}
                        data-active={active}
                        data-unread={notifyLevel === "all" && state.unread > 0}
                        data-kind={channel.kind}
                        data-testid="channel-row"
                        aria-current={active ? "page" : undefined}
                        title={channel.topic}
                        onClick={() => openChannel(channel.id)}
                      >
                        <Glyph className={styles.glyph} />
                        <span className={styles.channelName}>{channel.name}</span>
                        {guild && isSystemChannel(guild, channel.id) ? (
                          <span className={styles.systemTag} title="System messages channel">
                            SYS
                          </span>
                        ) : null}
                        {notifyLevel !== "none" && state.mentions > 0 ? (
                          <span
                            className={styles.mention}
                            aria-label={`${state.mentions} mentions`}
                          >
                            {state.mentions}
                          </span>
                        ) : notifyLevel === "all" && state.unread > 0 ? (
                          <span className={styles.unread} aria-label={`${state.unread} unread`} />
                        ) : null}
                      </button>
                    );
                  })}
            </section>
          );
        })}
      </nav>

      <VoiceStatus />
      <UserDock />
    </div>
  );
}

/**
 * The self card. Also the only place the bridge diagnostics still live: they were a header bar
 * in the gallery slice, and deleting them outright would hide the exact facts the slice exists
 * to prove. `methods` is derived from the shared channel table, so it can never claim a number
 * the preload does not expose.
 */
export function UserDock(): React.JSX.Element {
  const presenceOverrides = useWorkspaceStore((state) => state.presence);
  const memberListOpen = useWorkspaceStore((state) => state.memberListOpen);
  const toggleMemberList = useWorkspaceStore((state) => state.toggleMemberList);

  const runtime = useShellState((state) => state.runtime);
  const focused = useShellState((state) => state.focused);

  const identity = useSelfIdentity();
  const presence = presenceOverrides[getSelfId()] ?? identity.presence;
  const voice = useVoice();
  const openSettings = useUiStore((state) => state.openSettings);

  const methods = Object.keys(Channel).length;
  const muted = voice.muted;
  const deafened = voice.deafened;

  return (
    <div className={styles.dock}>
      <button
        type="button"
        className={styles.self}
        onClick={() => openSettings("profile")}
        aria-label="Open user settings"
        title="User settings"
        data-testid="open-settings"
      >
        <Avatar
          name={identity.name}
          accent={identity.accent}
          image={identity.avatar}
          size="md"
          showPresence
          presence={presence}
        />
        <span className={styles.selfText}>
          <span className={styles.selfName}>{identity.name}</span>
          {identity.statusEmoji || identity.statusText ? (
            <span className={styles.selfStatus}>
              {identity.statusEmoji ? `${identity.statusEmoji} ` : ""}
              {identity.statusText}
            </span>
          ) : null}
          <span className={styles.selfMeta} data-testid="bridge-meta">
            <span className={styles.focusDot} data-focused={focused} aria-hidden="true" />
            {runtime} · {methods} ipc
          </span>
        </span>
      </button>

      <div className={styles.dockActions}>
        <button
          type="button"
          className={styles.iconButton}
          data-on={muted}
          data-audio-off={muted}
          aria-pressed={muted}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          title={muted ? "Unmute (microphone muted)" : "Mute microphone"}
          data-testid="dock-mute"
          onClick={toggleMute}
        >
          {muted ? <MicOffGlyph /> : <MicGlyph />}
        </button>
        <button
          type="button"
          className={styles.iconButton}
          data-on={deafened}
          data-audio-off={deafened}
          aria-pressed={deafened}
          aria-label={deafened ? "Undeafen" : "Deafen"}
          title={deafened ? "Undeafen (audio off)" : "Deafen"}
          data-testid="dock-deafen"
          onClick={toggleDeafen}
        >
          {deafened ? <HeadphonesOffGlyph /> : <HeadphonesGlyph />}
        </button>
        <ThemeMenu />
        <button
          type="button"
          className={styles.iconButton}
          data-on={memberListOpen}
          onClick={toggleMemberList}
          aria-pressed={memberListOpen}
          aria-label="Toggle member list"
          title="Member list"
        >
          <MembersGlyph />
        </button>
      </div>
    </div>
  );
}
