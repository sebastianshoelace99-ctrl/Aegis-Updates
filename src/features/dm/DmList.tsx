import { useMemo, useRef, useState } from "react";
import { dmChannelId, dmContacts } from "../../api/dms";
import type { Member } from "../../api/workspace";
import { useDmStore } from "../../state/dmStore";
import { getSelfId } from "../../state/identity";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { useMemberIdentity } from "../../state/useIdentity";
import { readFor, useWorkspaceStore } from "../../state/workspaceStore";
import { Avatar } from "../../ui/Avatar";
import { ChevronGlyph, PlusGlyph, SearchGlyph } from "../../ui/Glyphs";
import { VoiceStatus } from "../voice/VoiceStatus";
import { UserDock } from "../workspace/ChannelList";
/*
 * The panel, the header, the rows and the badges are `ChannelList.module.css` classes, imported
 * rather than copied. The DM space is the same column with different rows: re-declaring that
 * chrome here would mean a second copy of the item-card theme layer, and two copies drift.
 */
import chrome from "../workspace/ChannelList.module.css";
import styles from "./DmList.module.css";

/**
 * The direct-message column, the counterpart of `ChannelList` for the `#/@me` space.
 *
 * Two lists, both from real data:
 *
 *  - **Direct messages** - conversations this install remembers opening (`state/dmStore`), in the
 *    order they were opened, each with the unread/mention signals the channel list uses, because
 *    it is the same read state keyed by `dm:<memberId>`.
 *  - **People** - everyone else on the roster you share a server with, collapsed until asked for.
 *    Without it a first launch would show an empty column with no way to start anything.
 *
 * The filter searches both. Typing forces People open, because the only reason to type here is
 * that the person you want is not in the remembered list yet.
 */

function matchesName(member: Member, needle: string): boolean {
  return member.name.toLowerCase().includes(needle) || member.handle.includes(needle);
}

type DmRowProps = { member: Member; onOpen: (memberId: string) => void };

function DmRow({ member, onOpen }: DmRowProps): React.JSX.Element {
  const identity = useMemberIdentity(member);
  // Realtime presence first, then the roster value: the same precedence the member rail uses.
  const presence = useWorkspaceStore((state) => state.presence[member.id]) ?? identity.presence;
  const read = useWorkspaceStore((state) => state.read);
  const activeChannelId = useWorkspaceStore((state) => state.channelId);

  const channelId = dmChannelId(member.id);
  const state = readFor(read, channelId);
  const active = channelId === activeChannelId;

  return (
    <button
      type="button"
      className={`${chrome.channel} ${styles.row}`}
      data-active={active}
      data-unread={state.unread > 0}
      data-testid="dm-row"
      aria-current={active ? "page" : undefined}
      title={`${identity.name} (@${member.handle})`}
      onClick={() => onOpen(member.id)}
    >
      <Avatar
        name={identity.name}
        accent={identity.accent}
        size="sm"
        showPresence
        presence={presence}
      />
      <span className={chrome.channelName}>{identity.name}</span>
      {state.mentions > 0 ? (
        <span className={chrome.mention} aria-label={`${state.mentions} mentions`}>
          {state.mentions}
        </span>
      ) : state.unread > 0 ? (
        <span className={chrome.unread} aria-label={`${state.unread} unread`} />
      ) : null}
    </button>
  );
}

export function DmList(): React.JSX.Element {
  const live = useLiveWorkspace();
  const recent = useDmStore((state) => state.recent);
  const remember = useDmStore((state) => state.remember);
  const openChannel = useWorkspaceStore((state) => state.openChannel);

  const [filter, setFilter] = useState("");
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [conversationsOpen, setConversationsOpen] = useState(true);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const contacts = useMemo(() => dmContacts(live, getSelfId()), [live]);
  const needle = filter.trim().toLowerCase();

  const visible = useMemo(
    () =>
      needle.length === 0 ? contacts : contacts.filter((member) => matchesName(member, needle)),
    [contacts, needle],
  );

  const byId = useMemo(() => new Map(contacts.map((member) => [member.id, member])), [contacts]);

  /*
   * Remembered partners are resolved against the live roster on every render: someone who left
   * the server drops out instead of leaving a row that opens a conversation with nobody.
   */
  const conversations = useMemo(() => {
    const remembered = recent.flatMap((id) => {
      const member = byId.get(id);
      return member ? [member] : [];
    });
    return needle.length === 0
      ? remembered
      : remembered.filter((member) => matchesName(member, needle));
  }, [byId, recent, needle]);

  const known = useMemo(() => new Set(recent), [recent]);
  const people = useMemo(
    () => visible.filter((member) => !known.has(member.id)),
    [visible, known],
  );

  const peopleExpanded = peopleOpen || needle.length > 0;

  const open = (memberId: string): void => {
    // Remembered before opening, so the row is already in place when the column re-renders.
    remember(memberId);
    openChannel(dmChannelId(memberId));
  };

  const startConversation = (): void => {
    setPeopleOpen(true);
    searchRef.current?.focus();
  };

  return (
    <div className={`${chrome.panel} ${styles.panel}`} data-testid="dm-list">
      <div className={chrome.header}>
        <h2 className={chrome.guildName}>Direct messages</h2>
        <button
          type="button"
          className={chrome.collapseAll}
          onClick={startConversation}
          aria-label="Start a conversation"
          title="Start a conversation"
          data-testid="dm-start"
        >
          <PlusGlyph />
        </button>
      </div>

      <label className={styles.search}>
        <SearchGlyph className={styles.searchGlyph} />
        <input
          ref={searchRef}
          type="search"
          className={styles.searchInput}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Find someone"
          aria-label="Find someone to message"
          data-testid="dm-search"
        />
      </label>

      <nav className={chrome.nav} aria-label="Direct messages">
        {contacts.length === 0 ? (
          <p className={styles.note} data-testid="dm-no-contacts">
            You are not in a server with anyone yet. The people in a server you join appear here.
          </p>
        ) : null}

        {conversations.length > 0 ? (
          <section className={chrome.category}>
            <button
              type="button"
              className={chrome.categoryLabel}
              onClick={() => setConversationsOpen((open) => !open)}
              aria-expanded={conversationsOpen}
            >
              <span className={chrome.chevron} data-collapsed={!conversationsOpen}>
                <ChevronGlyph />
              </span>
              <span>Direct messages</span>
            </button>

            {conversationsOpen
              ? conversations.map((member) => (
                  <DmRow key={member.id} member={member} onOpen={open} />
                ))
              : null}
          </section>
        ) : needle.length === 0 && contacts.length > 0 ? (
          <p className={styles.note}>No conversations yet. Open “People” to start one.</p>
        ) : null}

        {people.length > 0 ? (
          <section className={chrome.category}>
            <button
              type="button"
              className={chrome.categoryLabel}
              onClick={() => setPeopleOpen((open) => !open)}
              aria-expanded={peopleExpanded}
              data-testid="dm-people"
            >
              <span className={chrome.chevron} data-collapsed={!peopleExpanded}>
                <ChevronGlyph />
              </span>
              <span>People</span>
            </button>

            {peopleExpanded
              ? people.map((member) => <DmRow key={member.id} member={member} onOpen={open} />)
              : null}
          </section>
        ) : null}

        {contacts.length > 0 && people.length === 0 && conversations.length === 0 ? (
          <p className={styles.note} data-testid="dm-no-match">
            No one here matches “{filter.trim()}”.
          </p>
        ) : null}
      </nav>

      <VoiceStatus />
      <UserDock />
    </div>
  );
}
