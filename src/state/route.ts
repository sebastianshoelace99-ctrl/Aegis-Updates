import {
  defaultRoute,
  findChannel,
  findChannelById,
  findGuild,
  workspace,
  type Channel,
  type Guild,
  type Workspace,
} from "../api/workspace";
import { DM_HOME, dmChannelId, dmPartner } from "../api/dms";

/**
 * A hand-rolled hash route, because the slice has exactly one axis of navigation and a router
 * dependency would be all overhead: `#/late-shift/general`.
 *
 * The hash (not a path) is what survives `app://bundle/index.html` with no rewrite layer, and
 * it is what makes back/forward and "jump to channel" work in a packaged window.
 */

export type Route = { guildId: string; slug: string };
export type ResolvedRoute = { guild: Guild; channel: Channel };

/** Accepts `#/a/b`, `/a/b` and `a/b`. `#/@me` is the DM space and accepts a single segment. */
export function parseRoute(hash: string): Route | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const parts = raw.split("/").filter((part) => part.length > 0);

  try {
    /*
     * `#/@me` names the DM space, not a server, so it has no second segment. Every other
     * one-segment path is still not a route.
     */
    if (parts.length === 1) {
      const only = parts[0];
      if (only === undefined || decodeURIComponent(only) !== DM_HOME) return null;
      return { guildId: DM_HOME, slug: "" };
    }

    if (parts.length !== 2) return null;

    const [guildId, slug] = parts;
    if (!guildId || !slug) return null;

    return { guildId: decodeURIComponent(guildId), slug: decodeURIComponent(slug) };
  } catch {
    // A malformed escape is a bad route, not a crash.
    return null;
  }
}

export function formatRoute(route: Route): string {
  // `@me` is the DM space, not an id: encoding it to `%40me` would make every DM link unreadable
  // in the address bar it gets pasted into.
  const guild = route.guildId === DM_HOME ? DM_HOME : encodeURIComponent(route.guildId);
  // The DM space with no conversation open has no second segment to name.
  if (route.slug.length === 0) return `#/${guild}`;
  return `#/${guild}/${encodeURIComponent(route.slug)}`;
}

/** True for both DM shapes: the list itself (`#/@me`) and one conversation (`#/@me/<memberId>`). */
export function isDmRoute(route: Route | null): boolean {
  return route?.guildId === DM_HOME;
}

/**
 * Resolve a route against a graph, degrading as far as possible: a stale bookmark or a
 * hand-edited hash falls back to the first channel of the named guild, then to the workspace
 * default.
 *
 * `null` is a real answer now. An account that has not joined a server yet has nothing to open,
 * and inventing a channel would put a fabricated room in front of the reader. The caller renders
 * the empty state instead.
 */
export function resolveRoute(input: Route | null, target = workspace): ResolvedRoute | null {
  if (input) {
    const guild = findGuild(target, input.guildId);
    if (guild) {
      const channel = findChannel(guild, input.slug) ?? guild.channels[0];
      if (channel) return { guild, channel };
    }
  }

  const fallback = defaultRoute(target);
  const guild = findGuild(target, fallback.guildId) ?? target.guilds[0];
  if (!guild) return null;

  const channel = findChannel(guild, fallback.slug) ?? guild.channels[0];
  if (!channel) return null;

  return { guild, channel };
}

export function routeOf(guildId: string, slug: string): Route {
  return { guildId, slug };
}

/**
 * What the store should do about the hash it is looking at.
 *
 * `keep` means "leave the store alone". `home` opens the DM space. `channel` opens one
 * conversation, server or DM.
 */
export type RouteDecision =
  | { kind: "keep" }
  | { kind: "home" }
  | { kind: "channel"; channelId: string };

/**
 * Whether the graph can still open the conversation the store is on.
 *
 * A server channel is openable while the graph still has it. A DM is openable while its
 * partner is on the roster: a DM id is not a channel id, so the roster is the only thing that
 * can vouch for it, and a conversation with nobody in it is not a place to be.
 */
function isOpenable(live: Workspace, channelId: string): boolean {
  if (channelId.length === 0) return false;
  return findChannelById(live, channelId) !== undefined || dmPartner(live, channelId) !== undefined;
}

/**
 * Decide what the hash asks of the store.
 *
 * The hash is a *mirror* of the store, not a second source of truth: the store-to-hash effect
 * writes it. So between a click and that write, the hash still names where the reader **was**.
 * Acting on it then undoes the click - a reader who opened a DM could never select a server
 * again, because the stale `#/@me/...` kept pulling them back.
 *
 * So the store leads whenever it already shows something the graph can open. The hash is only
 * consulted when the store has nothing to show: a cold start, a pasted link, or a conversation
 * the backend has since deleted.
 */
export function decideRoute(input: {
  hash: string;
  live: Workspace;
  channelId: string;
  home: boolean;
}): RouteDecision {
  const route = parseRoute(input.hash);

  if (isOpenable(input.live, input.channelId)) return { kind: "keep" };

  if (isDmRoute(route)) {
    // `#/@me` is the space itself; `#/@me/<memberId>` is one conversation in it.
    if (route && route.slug.length > 0) {
      const target = dmChannelId(route.slug);
      if (target === input.channelId) return { kind: "keep" };
      return { kind: "channel", channelId: target };
    }
    // The space with no conversation open: only worth entering if the reader is not in it.
    return input.home ? { kind: "keep" } : { kind: "home" };
  }

  // The reader chose the DM space; a server route must not pull them out of it.
  if (input.home) return { kind: "keep" };

  // The graph arrived, or the conversation the reader was in is gone: fall back to the hash.
  const resolved = resolveRoute(route, input.live);
  if (!resolved || resolved.channel.id === input.channelId) return { kind: "keep" };
  return { kind: "channel", channelId: resolved.channel.id };
}
