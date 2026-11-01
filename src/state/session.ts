/**
 * The bearer token, and nothing else.
 *
 * It lives in its own module so `api/http.ts` can read it without importing the auth store (which
 * imports the auth API, which imports `http.ts` - a cycle that would leave one of the three
 * undefined at import time). `localStorage` is the right place here: the renderer runs from
 * `app://bundle`, so it is a single origin owned by this app, and a packaged window keeps the
 * session across restarts the way a desktop app should.
 */

const TOKEN_KEY = "aegis.auth.token.v1";
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

let cached: string | null = null;
let read = false;

export function getToken(): string | null {
  if (read) return cached;
  read = true;

  const raw = storage()?.getItem(TOKEN_KEY) ?? null;
  if (raw && TOKEN.test(raw)) {
    cached = raw;
  } else {
    cached = null;
    if (raw) storage()?.removeItem(TOKEN_KEY);
  }
  return cached;
}

export function setToken(next: string | null): void {
  cached = next && TOKEN.test(next) ? next : null;
  read = true;

  const area = storage();
  if (!area) return;

  try {
    if (cached) area.setItem(TOKEN_KEY, cached);
    else area.removeItem(TOKEN_KEY);
  } catch {
    /* a full or locked storage area costs persistence, not the session in this window */
  }
}
