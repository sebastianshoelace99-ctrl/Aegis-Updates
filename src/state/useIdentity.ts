import { effectivePresence } from "../api/profile";
import type { Member, Presence } from "../api/workspace";
import { getSelfHandle, getSelfId } from "./identity";
import { useSettingsStore } from "./settingsStore";

/**
 * A member as the UI should present them.
 *
 * For everyone else this is the roster record. For the signed-in member it is the local profile:
 * display name, picture, accent and presence choice. One function means the feed, the member rail
 * and the profile card cannot disagree about what "you" are called.
 */

export type IdentityView = {
  id: string;
  name: string;
  handle: string;
  accent: number;
  avatar: string | null;
  presence: Presence;
  statusEmoji: string;
  statusText: string;
  isSelf: boolean;
};

const UNKNOWN: IdentityView = {
  id: "unknown",
  name: "Unknown",
  handle: "unknown",
  accent: 7,
  avatar: null,
  presence: "offline",
  statusEmoji: "",
  statusText: "",
  isSelf: false,
};

export function useMemberIdentity(member: Member | undefined): IdentityView {
  const profile = useSettingsStore((state) => state.profile);
  const status = useSettingsStore((state) => state.status);

  if (!member) return UNKNOWN;

  const isSelf = member.id === getSelfId();

  return {
    id: member.id,
    name: isSelf ? profile.displayName : member.name,
    handle: member.handle,
    accent: isSelf ? profile.accent : member.accent,
    avatar: isSelf ? profile.avatar : null,
    presence: isSelf ? effectivePresence(status.presence) : member.presence,
    statusEmoji: isSelf ? status.emoji : "",
    statusText: isSelf ? status.text : "",
    isSelf,
  };
}

/**
 * The signed-in member even when the server has no member row for them yet.
 *
 * A fresh account has never joined a guild, so `workspace.members` is empty. Falling back to
 * "Unknown" would make the user dock lie about who is signed in; the settings document is the
 * only record that exists at that point, so it is the one this hook reads.
 */
export function useSelfIdentity(): IdentityView {
  const profile = useSettingsStore((state) => state.profile);
  const status = useSettingsStore((state) => state.status);

  return {
    id: getSelfId(),
    name: profile.displayName,
    handle: getSelfHandle(),
    accent: profile.accent,
    avatar: profile.avatar,
    presence: effectivePresence(status.presence),
    statusEmoji: status.emoji,
    statusText: status.text,
    isSelf: true,
  };
}
