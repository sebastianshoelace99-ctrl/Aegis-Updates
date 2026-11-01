import { normalizeWorkspace, type Guild, type Workspace } from "./workspace";
import { deleteGuild as deleteGuildRequest, saveGuild } from "./backend";

/**
 * The live workspace: exactly what the backend returned, plus optimistic edits.
 *
 * There is no local seed and no localStorage overlay. Persistence is the backend's job (Supabase,
 * or the in-memory dev store), which means two windows finally agree about what servers exist.
 * The registry is deliberately outside React: `messages.ts` resolves a channel id inside a query
 * function, where a component-local value would be invisible.
 *
 * The graph is re-validated on every arrival, because a response is still input.
 */

const EMPTY: Workspace = { guilds: [], members: [] };

const listeners = new Set<() => void>();

let snapshot: Workspace = EMPTY;
/** Monotonic write token: a slow reply must not overwrite a newer optimistic edit. */
let revision = 0;

/** Stable identity until the next write - `useSyncExternalStore` compares snapshots by reference. */
export function liveWorkspace(): Workspace {
  return snapshot;
}

export function subscribeWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(): void {
  for (const listener of listeners) listener();
}

/** Replace the whole graph from a backend reply. */
export function replaceWorkspace(next: Workspace): void {
  revision += 1;
  snapshot = normalizeWorkspace(next);
  publish();
}

/** `POST /api/guilds` already returned the authoritative graph, so creation just installs it. */
export function registerGuild(guild: Guild): void {
  replaceWorkspace({
    guilds: [...snapshot.guilds.filter((entry) => entry.id !== guild.id), guild],
    members: snapshot.members,
  });
}

/**
 * `PATCH /api/guilds/:id`: the write server settings uses for a rename, a role edit or an
 * assignment. The local graph updates immediately, then the server's graph replaces it. A failed
 * write rolls the optimistic value back - the UI must not claim a setting that did not persist.
 */
export async function updateGuild(guild: Guild): Promise<boolean> {
  const previous = snapshot;
  const token = (revision += 1);

  snapshot = {
    ...snapshot,
    guilds: snapshot.guilds.map((entry) => (entry.id === guild.id ? guild : entry)),
  };
  publish();

  try {
    const next = await saveGuild(guild);
    if (token === revision) {
      snapshot = normalizeWorkspace(next);
      publish();
    }
    return true;
  } catch {
    if (token === revision) {
      snapshot = previous;
      publish();
    }
    return false;
  }
}

export async function deleteGuild(guildId: string): Promise<Workspace> {
  const next = await deleteGuildRequest(guildId);
  replaceWorkspace(next);
  return snapshot;
}

/** Vitest only: forget server state so one test cannot leak into the next. */
export function resetLiveWorkspace(): void {
  revision += 1;
  snapshot = EMPTY;
  publish();
}
