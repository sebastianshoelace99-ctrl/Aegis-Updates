import { create } from "zustand";
import { dmPartner } from "../api/dms";
import { liveWorkspace } from "../api/liveWorkspace";
import {
  defaultRoute,
  guildOfChannel,
  workspace,
  type Presence,
} from "../api/workspace";

/**
 * Navigation and read state - the part of the app that is *not* server data.
 *
 * Kept out of React Query on purpose: unread counts, drafts and the active channel are local
 * facts about this window, and putting them in the query cache would make them look
 * refetchable and lose them to a `staleTime`.
 *
 * Deliberately not persisted. Drafts die with the window, which is honest for a slice with no
 * message backend; adding `persist` later touches this file only.
 */

export type ChannelRead = {
  /** Everything at or before this instant has been seen. */
  lastReadAt: string;
  unread: number;
  mentions: number;
};

export type WorkspaceState = {
  guildId: string;
  channelId: string;
  read: Record<string, ChannelRead>;
  drafts: Record<string, string>;
  /** Transient: who is typing where. Never persisted, never counted as unread. */
  typing: Record<string, string[]>;
  /** Realtime overrides laid over the roster's initial presence. */
  presence: Record<string, Presence>;
  jumpToMessageId: string | null;
  /**
   * The marker each channel had when it was last opened. The feed draws its "new messages"
   * divider from this, because `read` has already been advanced by the time it renders.
   */
  previousReadAt: Record<string, string>;
  memberListOpen: boolean;
  /**
   * True while the DM space owns the second column. Kept apart from `channelId` because the space
   * and the conversation are independent: Discord's home shows the last DM you had open, and a
   * home with no conversations at all still has to render something.
   */
  home: boolean;

  openChannel: (channelId: string, at?: string, jumpToMessageId?: string) => void;
  clearJumpToMessage: () => void;
  openHome: () => void;
  markRead: (channelId: string, at: string) => void;
  receive: (channelId: string, at: string, mentions: number) => void;
  setDraft: (channelId: string, draft: string) => void;
  setTyping: (channelId: string, memberIds: string[]) => void;
  setPresence: (memberId: string, presence: Presence) => void;
  toggleMemberList: () => void;
};

function initialChannelId(): string {
  const route = defaultRoute(workspace);
  if (route.guildId.length === 0) return "";
  const guild = workspace.guilds.find((entry) => entry.id === route.guildId);
  const channel =
    guild?.channels.find((candidate) => candidate.slug === route.slug) ?? guild?.channels[0];
  return channel?.id ?? "";
}

function guildOf(channelId: string): string {
  return channelId.split("/")[0] ?? "";
}

const EMPTY_READ: ChannelRead = {
  lastReadAt: new Date(0).toISOString(),
  unread: 0,
  mentions: 0,
};

/**
 * Everything starts read. Otherwise a first launch would report 240 backlog messages as "new"
 * on fourteen channels, which is noise, not state - and the divider would be meaningless.
 */
function initialRead(): Record<string, ChannelRead> {
  const at = new Date().toISOString();
  const entries = workspace.guilds.flatMap((guild) =>
    guild.channels.map((channel) => [channel.id, { lastReadAt: at, unread: 0, mentions: 0 }] as const),
  );
  return Object.fromEntries(entries);
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  guildId: guildOf(initialChannelId()),
  channelId: initialChannelId(),
  read: initialRead(),
  drafts: {},
  typing: {},
  presence: {},
  jumpToMessageId: null,
  previousReadAt: {},
  memberListOpen: true,
  home: false,

  openChannel: (channelId, at = new Date().toISOString(), jumpToMessageId = undefined) => {
    /*
     * Validated against the live graph: a server created in this window is navigable immediately.
     * A DM is validated the same way but against the roster instead of the graph, so a stale or
     * hand-edited `dm:<id>` cannot put a conversation with nobody in front of the reader.
     */
    const guild = guildOfChannel(liveWorkspace(), channelId);
    if (!guild && !dmPartner(liveWorkspace(), channelId)) return;
    set((state) => {
      const known = state.read[channelId];
      return {
        channelId,
        jumpToMessageId: jumpToMessageId ?? null,
        home: guild === undefined,
        // A DM belongs to no server, so the rail keeps pointing at the server you came from.
        guildId: guild ? guild.id : state.guildId,
        // Captured before `read` advances: this is what the feed's divider is drawn from. No
        // entry means this channel was never opened, not that it was last read in 1970 - an
        // epoch marker would draw "new messages" above the entire history.
        previousReadAt: known
          ? { ...state.previousReadAt, [channelId]: known.lastReadAt }
          : state.previousReadAt,
        read: { ...state.read, [channelId]: { lastReadAt: at, unread: 0, mentions: 0 } },
      };
    });
  },

  clearJumpToMessage: () => set({ jumpToMessageId: null }),

  openHome: () => {
    // The open conversation is left alone: coming back to the DM space should land on the last
    // person you were talking to, not on an empty pane.
    set({ home: true });
  },

  markRead: (channelId, at) => {
    set((state) => {
      const known = state.read[channelId];
      return {
        previousReadAt: known
          ? { ...state.previousReadAt, [channelId]: known.lastReadAt }
          : state.previousReadAt,
        read: { ...state.read, [channelId]: { lastReadAt: at, unread: 0, mentions: 0 } },
      };
    });
  },

  receive: (channelId, at, mentions) => {
    set((state) => {
      // Reading the channel you are looking at is the definition of read.
      if (state.channelId === channelId) {
        return { read: { ...state.read, [channelId]: { lastReadAt: at, unread: 0, mentions: 0 } } };
      }

      const previous = state.read[channelId] ?? EMPTY_READ;
      return {
        read: {
          ...state.read,
          [channelId]: {
            lastReadAt: previous.lastReadAt,
            unread: previous.unread + 1,
            mentions: previous.mentions + (mentions > 0 ? 1 : 0),
          },
        },
      };
    });
  },

  setDraft: (channelId, draft) => {
    set((state) => ({ drafts: { ...state.drafts, [channelId]: draft } }));
  },

  setTyping: (channelId, memberIds) => {
    set((state) => ({ typing: { ...state.typing, [channelId]: memberIds } }));
  },

  setPresence: (memberId, presence) => {
    set((state) => ({ presence: { ...state.presence, [memberId]: presence } }));
  },

  toggleMemberList: () => {
    set((state) => ({ memberListOpen: !state.memberListOpen }));
  },
}));

/** Server-shaped read state with defaults filled in, so callers never branch on `undefined`. */
export function readFor(read: Record<string, ChannelRead>, channelId: string): ChannelRead {
  return read[channelId] ?? EMPTY_READ;
}

/** The guild rail dot: any unread channel in this guild lights the icon. */
export function guildUnread(
  read: Record<string, ChannelRead>,
  channelIds: readonly string[],
): number {
  return channelIds.reduce((total, id) => total + (read[id]?.unread ?? 0), 0);
}

export function guildMentions(
  read: Record<string, ChannelRead>,
  channelIds: readonly string[],
): number {
  return channelIds.reduce((total, id) => total + (read[id]?.mentions ?? 0), 0);
}
