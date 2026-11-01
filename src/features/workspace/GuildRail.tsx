import { useEffect, useMemo, useRef } from "react";
import { dmChannelId, dmContacts } from "../../api/dms";
import { guildDescription, guildNotificationLevel } from "../../api/serverSettings";
import { useDmStore } from "../../state/dmStore";
import { getSelfId } from "../../state/identity";
import { guildMentions, guildUnread, useWorkspaceStore } from "../../state/workspaceStore";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { useUiStore } from "../../state/uiStore";
import { Avatar } from "../../ui/Avatar";
import { BellOffGlyph, ChatGlyph, PlusGlyph } from "../../ui/Glyphs";
import styles from "./GuildRail.module.css";

/**
 * The left rail: one squircle per guild, with the two unread signals Discord uses.
 *
 * A red count means "someone said your name"; a plain dot means "there is something new".
 * They are separate states on purpose - collapsing them into one badge makes mentions
 * unactionable, which is the failure this layout exists to avoid.
 *
 * The trailing `+` is the add-server affordance, pinned below a divider. It opens the create
 * dialog rather than a menu, because there is exactly one thing it can do.
 */
export function GuildRail(): React.JSX.Element {
  const activeGuildId = useWorkspaceStore((state) => state.guildId);
  const read = useWorkspaceStore((state) => state.read);
  const openChannel = useWorkspaceStore((state) => state.openChannel);
  const home = useWorkspaceStore((state) => state.home);
  const openHome = useWorkspaceStore((state) => state.openHome);
  const recent = useDmStore((state) => state.recent);
  const live = useLiveWorkspace();

  const creating = useUiStore((state) => state.createServerOpen);
  const openCreateServer = useUiStore((state) => state.openCreateServer);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const wasCreating = useRef(creating);

  /*
   * The home button reopens the last conversation rather than blanking the pane, which is what
   * Discord's home does. A remembered partner who is no longer on the roster is skipped, so the
   * button can never open a conversation with nobody.
   */
  const contacts = useMemo(
    () => new Set(dmContacts(live, getSelfId()).map((member) => member.id)),
    [live],
  );
  const lastConversation = recent.find((id) => contacts.has(id));

  const dmChannels = recent.map(dmChannelId);
  const dmMentions = guildMentions(read, dmChannels);
  const dmUnread = guildUnread(read, dmChannels);

  const openHomeSpace = (): void => {
    if (lastConversation) openChannel(dmChannelId(lastConversation));
    else openHome();
  };

  // Focus returns to the control that opened the dialog, not to the top of the document.
  useEffect(() => {
    if (wasCreating.current && !creating) addRef.current?.focus();
    wasCreating.current = creating;
  }, [creating]);

  return (
    <>
      <nav className={styles.rail} aria-label="Workspaces" data-testid="guild-rail">
        <div className={styles.guilds}>
          {/*
           * Home sits above the servers, where Discord puts it, and is the only rail entry that
           * is not a guild. Its badge is the same two-signal pair the guilds use.
           */}
          <div className={styles.slot} data-testid="guild-home-slot">
            <button
              type="button"
              className={styles.guild}
              data-active={home}
              data-testid="home-button"
              aria-current={home ? "true" : undefined}
              aria-label={
                dmMentions > 0
                  ? `Direct messages, ${dmMentions} mentions`
                  : dmUnread > 0
                    ? "Direct messages, unread"
                    : "Direct messages"
              }
              title="Direct messages"
              onClick={openHomeSpace}
            >
              <span className={styles.pill} aria-hidden="true" />
              <span className={styles.homeIcon} aria-hidden="true">
                <ChatGlyph />
              </span>
              {dmMentions > 0 ? (
                <span className={styles.mention} aria-hidden="true">
                  {dmMentions > 9 ? "9+" : dmMentions}
                </span>
              ) : dmUnread > 0 ? (
                <span className={styles.unread} aria-hidden="true" />
              ) : null}
            </button>
          </div>

          {live.guilds.map((guild) => {
            const channelIds = guild.channels.map((channel) => channel.id);
            const unread = guildUnread(read, channelIds);
            const mentions = guildMentions(read, channelIds);
            const active = guild.id === activeGuildId && !home;
            const level = guildNotificationLevel(guild);
            const muted = level === "none";
            const showMentions = !muted && mentions > 0;
            const showUnread = level === "all" && unread > 0;
            const description = guildDescription(guild);
            const label =
              mentions > 0 && !muted
                ? `${guild.name}, ${mentions} mentions`
                : muted
                  ? `${guild.name}, muted`
                  : guild.name;

            return (
              <div key={guild.id} className={styles.slot} data-divider="true">
                <button
                  type="button"
                  className={styles.guild}
                  data-active={active}
                  data-muted={muted}
                  data-testid="guild-row"
                  aria-current={active ? "true" : undefined}
                  aria-label={label}
                  title={description ? `${guild.name} — ${description}` : guild.name}
                  onClick={() => {
                    const first = guild.channels[0];
                    if (first) openChannel(first.id);
                  }}
                >
                  <span className={styles.pill} aria-hidden="true" />
                  <Avatar
                    name={guild.name}
                    label={guild.initial}
                    accent={guild.accent}
                    image={guild.icon ?? null}
                    size="lg"
                    shape="square"
                  />
                  {showMentions ? (
                    <span className={styles.mention} aria-hidden="true">
                      {mentions > 9 ? "9+" : mentions}
                    </span>
                  ) : showUnread ? (
                    <span className={styles.unread} aria-hidden="true" />
                  ) : muted ? (
                    <span className={styles.mutedBadge} aria-hidden="true">
                      <BellOffGlyph />
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>

        {/*
         * Pinned below the divider rather than scrolling with the list: it is the one control that
         * has to stay reachable when forty servers have pushed the rail past the fold.
         */}
        <div className={styles.footer}>
          <button
            ref={addRef}
            type="button"
            className={styles.guild}
            data-testid="add-server"
            aria-label="Add a Server"
            title="Add a Server"
            aria-haspopup="dialog"
            onClick={openCreateServer}
          >
            <span className={styles.pill} aria-hidden="true" />
            <span className={styles.addIcon} aria-hidden="true">
              <PlusGlyph />
            </span>
          </button>
        </div>
      </nav>
    </>
  );
}
