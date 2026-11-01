import { useEffect } from "react";
import { DM_HOME, dmChannelId, dmPartner, dmPartnerId, isDmChannelId } from "../api/dms";
import { findChannelById, guildOfChannel } from "../api/workspace";
import { decideRoute, formatRoute, isDmRoute, parseRoute, resolveRoute } from "../state/route";
import { useLiveWorkspace } from "../state/useLiveWorkspace";
import { useUiStore } from "../state/uiStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { ChannelHeader } from "../features/chat/ChannelHeader";
import { ChatRoute } from "../features/chat/ChatRoute";
import { DmList } from "../features/dm/DmList";
import { GalleryRoute } from "../features/gallery";
import { MemberRail } from "../features/members/MemberRail";
import { ProfileCard } from "../features/settings/ProfileCard";
import { ServerSettingsModal } from "../features/settings/ServerSettingsModal";
import { SettingsModal } from "../features/settings/SettingsModal";
import { VoiceRoute } from "../features/voice/VoiceRoute";
import { ChannelList } from "../features/workspace/ChannelList";
import { CreateServerModal } from "../features/workspace/CreateServerModal";
import { GuildRail } from "../features/workspace/GuildRail";
import { JoinServerModal } from "../features/workspace/JoinServerModal";
import { ChatGlyph, PlusGlyph } from "../ui/Glyphs";
import styles from "../app/App.module.css";

/**
 * The three-pane shell: rail, channel list, conversation, members.
 *
 * Two rules the layout enforces:
 *
 *  - A media channel owns the right-hand space (its inspector needs it), so the member rail is
 *    suppressed there rather than fighting the inspector for width.
 *  - The route lives in the hash, so back/forward and a pasted `#/guild/channel` both work in
 *    the packaged app without a router or a rewrite layer.
 *
 * An empty workspace is a rendered state, not an error: the rail and the channel list stay, the
 * main pane explains that nothing exists yet and offers the one action that changes it.
 *
 * The DM space (`#/@me`) is the same shell with a different second column. It is checked before
 * the "no server" branch on purpose: an account in no server can still message the people it
 * shares a window with, and `DmList` renders its own empty state for that case.
 */
export function Workspace(): React.JSX.Element {
  const channelId = useWorkspaceStore((state) => state.channelId);
  const openChannel = useWorkspaceStore((state) => state.openChannel);
  const openHome = useWorkspaceStore((state) => state.openHome);
  const home = useWorkspaceStore((state) => state.home);
  const memberListOpen = useWorkspaceStore((state) => state.memberListOpen);
  const live = useLiveWorkspace();

  const createServerOpen = useUiStore((state) => state.createServerOpen);
  const openCreateServer = useUiStore((state) => state.openCreateServer);
  const openJoinServer = useUiStore((state) => state.openJoinServer);
  const closeCreateServer = useUiStore((state) => state.closeCreateServer);

  /*
   * store <- graph.
   *
   * The hash is a *mirror* of the store, not a second source of truth: the store-to-hash effect
   * below writes it, one render after the store has already moved. So the hash read here still
   * names where the reader *was*, and treating it as a command undid the click that had just
   * been made - which is why opening a DM made servers unselectable.
   *
   * So the store leads: this only acts when the store has nothing to show (a cold start, a
   * pasted link) or shows something the graph has since deleted.
   */
  useEffect(() => {
    const decision = decideRoute({
      hash: window.location.hash,
      live,
      channelId,
      home,
    });

    if (decision.kind === "home") openHome();
    else if (decision.kind === "channel") openChannel(decision.channelId);
  }, [live, channelId, home, openChannel, openHome]);

  // Back/forward and hand-edited hashes. Re-registered so the resolver always sees new servers.
  useEffect(() => {
    const apply = (): void => {
      const route = parseRoute(window.location.hash);

      if (isDmRoute(route)) {
        if (route && route.slug.length > 0) {
          // Already open: re-opening it would move the "new messages" divider to the present.
          const target = dmChannelId(route.slug);
          if (target !== useWorkspaceStore.getState().channelId) openChannel(target);
        } else {
          openHome();
        }
        return;
      }

      const resolved = resolveRoute(route, live);
      if (resolved && resolved.channel.id !== useWorkspaceStore.getState().channelId) {
        openChannel(resolved.channel.id);
      }
    };

    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [live, openChannel, openHome]);

  // store -> hash. Guarded by equality, so this cannot ping-pong with the listener above.
  useEffect(() => {
    let next: string;

    if (home) {
      // No conversation open is a real state: `#/@me`, one segment, no server to name.
      next = formatRoute({ guildId: DM_HOME, slug: dmPartnerId(channelId) ?? "" });
    } else {
      const channel = findChannelById(live, channelId);
      const guild = guildOfChannel(live, channelId);
      if (!channel || !guild) return;
      next = formatRoute({ guildId: guild.id, slug: channel.slug });
    }

    if (window.location.hash === next) return;

    try {
      window.location.hash = next;
    } catch {
      /* A scheme without history support still navigates; only the URL stops updating. */
    }
  }, [channelId, home, live]);

  const channel = findChannelById(live, channelId);
  const guild = guildOfChannel(live, channelId);

  /*
   * The DM space. Deliberately before the "no server" branch: an account that has joined nothing
   * still has a rail, and the DM column carries its own empty state for exactly that case.
   *
   * No member rail here - a DM has two people, and a roster would be a lie about the audience.
   */
  if (home) {
    const partner = dmPartner(live, channelId);

    return (
      <>
        <div className={styles.columns}>
          <GuildRail />
          <DmList />

          <div className={styles.main}>
            {isDmChannelId(channelId) && partner ? (
              <>
                <ChannelHeader />
                <ChatRoute key={channelId} />
              </>
            ) : (
              <div className={styles.empty} data-testid="dm-empty">
                <span className={styles.emptyMark} aria-hidden="true">
                  <ChatGlyph />
                </span>
                <h2 className={styles.emptyTitle}>Direct messages</h2>
                <p className={styles.emptyBody}>
                  Pick a conversation on the left, or find someone to start one with. A message
                  here reaches only that person.
                </p>
              </div>
            )}
          </div>
        </div>

        <SettingsModal />
        <ProfileCard />
        {createServerOpen ? <CreateServerModal onClose={closeCreateServer} /> : null}
        <JoinServerModal />
      </>
    );
  }

  if (!guild || !channel) {
    return (
      <>
        <div className={styles.columns}>
          <GuildRail />
          <ChannelList />

          <div className={styles.main}>
            <div className={styles.empty} data-testid="empty-workspace">
              <span className={styles.emptyMark} aria-hidden="true">
                <PlusGlyph />
              </span>
              <h2 className={styles.emptyTitle}>No servers yet</h2>
              <p className={styles.emptyBody}>
                This account is not in a server. Create one here and it is stored by the backend,
                so it is still here after a restart and on every window that signs in.
              </p>
              <button
                type="button"
                className={styles.emptyAction}
                data-testid="empty-create-server"
                onClick={openCreateServer}
              >
                Create a server
              </button>
              <button
                type="button"
                className={styles.emptyAction}
                onClick={() => openJoinServer()}
              >
                Join with an invite
              </button>
            </div>
          </div>
        </div>

        <SettingsModal />
        <ProfileCard />
        {createServerOpen ? <CreateServerModal onClose={closeCreateServer} /> : null}
        <JoinServerModal />
      </>
    );
  }

  const isMedia = channel.kind === "media";
  const isVoice = channel.kind === "voice";

  return (
    <>
      <div className={styles.columns}>
        <GuildRail />
        <ChannelList />

        <div className={styles.main}>
          <ChannelHeader />
          {isMedia ? <GalleryRoute /> : isVoice ? <VoiceRoute /> : <ChatRoute key={channelId} />}
        </div>

        {!isMedia && memberListOpen ? <MemberRail /> : null}
      </div>

      <SettingsModal />
      <ServerSettingsModal />
      <ProfileCard />
      {createServerOpen ? <CreateServerModal onClose={closeCreateServer} /> : null}
      <JoinServerModal />
    </>
  );
}
