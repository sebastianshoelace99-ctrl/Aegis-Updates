import { create } from "zustand";

/**
 * Recent direct messages, remembered on this device.
 *
 * Deliberately local, and deliberately *only* order-of-attention: there is no conversation-index
 * endpoint, and inventing one would need a table this slice does not have. No message content is
 * kept here - a DM's history still lives in the normal message store under `dm:<memberId>`, so
 * opening a remembered conversation fetches real messages through the same paged API as a channel.
 *
 * The list is capped and de-duplicated on read, because a storage area written by an older build
 * (or by hand) is still input.
 */

export const DM_STORAGE_KEY = "aegis.dms.v1";

/** Long enough to look like a history, short enough that the whole list stays one screen. */
export const MAX_RECENT_DMS = 50;

export type DmStorage = Pick<Storage, "getItem" | "setItem">;

function local(): DmStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Never throws: a locked-down or full storage area must not stop the app from starting. */
export function loadRecent(storage: DmStorage | null): string[] {
  if (!storage) return [];

  try {
    const raw = storage.getItem(DM_STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    const ids: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 64) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      ids.push(entry);
      if (ids.length >= MAX_RECENT_DMS) break;
    }
    return ids;
  } catch {
    return [];
  }
}

export function saveRecent(storage: DmStorage | null, ids: readonly string[]): boolean {
  if (!storage) return false;

  try {
    storage.setItem(DM_STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_RECENT_DMS)));
    return true;
  } catch {
    return false;
  }
}

export type DmState = {
  /** Conversation partners, most recently opened first. Never contains the signed-in member. */
  recent: string[];
  remember: (memberId: string) => void;
  forget: (memberId: string) => void;
};

export const useDmStore = create<DmState>((set, get) => {
  const commit = (next: string[]): void => {
    saveRecent(local(), next);
    set({ recent: next });
  };

  return {
    recent: loadRecent(local()),

    remember: (memberId) => {
      if (memberId.length === 0) return;
      const next = [memberId, ...get().recent.filter((id) => id !== memberId)].slice(
        0,
        MAX_RECENT_DMS,
      );
      commit(next);
    },

    forget: (memberId) => {
      const next = get().recent.filter((id) => id !== memberId);
      if (next.length === get().recent.length) return;
      commit(next);
    },
  };
});
