import { findChannelById, memberById, type Channel, type Member, type Workspace } from "./workspace";

/**
 * Direct messages, expressed as channel identity.
 *
 * The app already has exactly one conversation pipeline: `features/chat/ChatRoute` renders any
 * channel id, `api/messages` pages any channel id, and `state/workspaceStore` keeps read state per
 * channel id. A DM is a two-person conversation, so it is modelled as a channel rather than given
 * a parallel feed, composer and unread tracker - the DM pane *is* the channel pane.
 *
 * The id is `dm:<memberId>`. The colon is the point: a guild id comes from `slugifyServerName`
 * and can only ever be `[a-z0-9-]`, so a server literally named "DM" (id `dm`, channels
 * `dm/general`) can never be mistaken for the DM space. Everything else follows from the shape -
 * `workspaceStore` keys drafts, unread and the "new messages" divider off it unchanged, and the
 * message API takes it as an opaque channel id.
 */

export const DM_PREFIX = "dm:";

/** The DM space itself (`#/@me`). Not a member id, so it can never collide with a conversation. */
export const DM_HOME = "@me";

export function dmChannelId(memberId: string): string {
  return `${DM_PREFIX}${memberId}`;
}

export function isDmChannelId(channelId: string): boolean {
  return channelId.startsWith(DM_PREFIX) && channelId.length > DM_PREFIX.length;
}

/** The partner a DM channel id names, or `null` when the id is an ordinary channel. */
export function dmPartnerId(channelId: string): string | null {
  return isDmChannelId(channelId) ? channelId.slice(DM_PREFIX.length) : null;
}

/**
 * A DM as a `Channel`, so the header and the feed can render it without a second code path.
 *
 * `categoryId` is the literal `dm`: the DM space has no categories, and keeping the field
 * non-empty means no caller has to branch on it.
 */
export function dmChannel(member: Member): Channel {
  return {
    id: dmChannelId(member.id),
    slug: member.id,
    name: member.name,
    topic: `@${member.handle}`,
    kind: "text",
    categoryId: "dm",
    commissionId: null,
    permissionOverwrites: {},
  };
}

/** The person a DM channel id names, resolved against the live roster. */
export function dmPartner(workspace: Workspace, channelId: string): Member | undefined {
  const id = dmPartnerId(channelId);
  return id === null ? undefined : memberById(workspace, id);
}

/**
 * A channel id resolved against the graph, falling back to the DM space.
 *
 * Reads that only need "what is this conversation called" (the header, the feed banner) call this
 * instead of `findChannelById`, so a DM is not a hole in the graph they have to special-case.
 */
export function resolveChannel(workspace: Workspace, channelId: string): Channel | undefined {
  const channel = findChannelById(workspace, channelId);
  if (channel) return channel;

  const partner = dmPartner(workspace, channelId);
  return partner ? dmChannel(partner) : undefined;
}

/**
 * The people the signed-in member can start a conversation with.
 *
 * "Anyone you share a server with" is Discord's rule and the only roster this client can actually
 * see. A member of several servers appears once, so a shared friend cannot produce two
 * conversations with the same id. An account that has joined nothing yet still gets the whole
 * roster: an empty DM space on a fresh install is a dead end, and every member returned here is
 * already someone the backend vouched for.
 */
export function dmContacts(workspace: Workspace, selfId: string): Member[] {
  const shared = new Set<string>();
  for (const guild of workspace.guilds) {
    if (!guild.memberIds.includes(selfId)) continue;
    for (const id of guild.memberIds) shared.add(id);
  }

  const allowed =
    shared.size > 0 ? shared : new Set(workspace.members.map((member) => member.id));

  return workspace.members
    .filter((member) => member.id !== selfId && allowed.has(member.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}
