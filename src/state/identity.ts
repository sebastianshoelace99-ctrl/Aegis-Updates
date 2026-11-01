/**
 * The signed-in identity, in one place.
 *
 * Both the sender (ChatRoute) and the mention highlighter (MessageFeed) need it, and letting
 * each hold its own copy is how "@nyx" stops being highlighted after a rename.
 *
 * This used to be `export const SELF_ID = "nyx"`. It is now a small mutable record because the
 * login screen decides who the user is *after* the modules are imported. Callers must read it
 * inside a function (all of them already did), never capture it at module scope.
 */

export type SelfIdentity = { id: string; handle: string };

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** The pre-login fallback: a dev backend with no accounts still works exactly as before. */
const LEGACY: SelfIdentity = { id: "nyx", handle: "nyx" };

let current: SelfIdentity = { ...LEGACY };

export function getSelfId(): string {
  return current.id;
}

export function getSelfHandle(): string {
  return current.handle;
}

export function setSelfIdentity(next: { id: string; handle?: string }): void {
  if (!ID.test(next.id)) return;

  const handle =
    next.handle && HANDLE.test(next.handle.toLowerCase())
      ? next.handle.toLowerCase()
      : next.id.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 32) || "member";

  current = { id: next.id, handle };
}

/** Used by sign-out and by the tests; restores the pre-account behaviour. */
export function resetSelfIdentity(): void {
  current = { ...LEGACY };
}
