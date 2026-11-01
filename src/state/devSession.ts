import { API_BASE } from "../api/http";

/**
 * The local login skip.
 *
 * Aegis is not in production yet, and iterating on the shell should not mean typing a password on
 * every launch. `VITE_AEGIS_SKIP_AUTH=1` (see `.env.example`) adds one link to the login screen -
 * "continue as the local dev account" - that enters the workspace without a backend session.
 *
 * A link rather than an automatic sign-in is deliberate: `npm run smoke` seeds a real token and
 * walks the ordinary restore path, and an auto-skip would quietly replace the code that gate
 * exists to prove. It also keeps the login screen itself testable.
 *
 * It works because the backend already accepts an `x-aegis-user` claim from a caller that has no
 * session (`userIdOf` in `server/app.ts`) - the same path that keeps `npm run server` usable on a
 * fresh checkout - and `src/api/http.ts` sends that header on every request. So the skip adds no
 * new trust path on the server; it just enters the existing one deliberately.
 *
 * Two limits keep it from turning into a production bypass:
 *  - it is a *build-time* opt-in: without the flag the link is never rendered and the
 *    `devSignIn` action is omitted. Production packaging sets the flag to `0`, allowing the
 *    bundler to remove the bypass implementation from the shipped renderer;
 *  - it refuses to run unless the API base is a loopback address, so a build that did carry the
 *    flag still cannot impersonate anyone against a hosted backend.
 * `AEGIS_REQUIRE_AUTH=1` still wins too: the claim then gets `401` and the workspace reports an
 * error instead of half-signing in.
 */

/** Read once: Vite inlines the literal `import.meta.env.VITE_*` access at build time. */
const FLAG = import.meta.env.VITE_AEGIS_SKIP_AUTH;

/** The stand-in identity. `id` must satisfy the server's `x-aegis-user` grammar. */
export const DEV_ACCOUNT = { id: "dev", handle: "dev", displayName: "Dev Account" } as const;

/** `URL.hostname` keeps the brackets on an IPv6 literal, so both spellings are listed. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1", "[::1]"]);

/**
 * Whether the build asks for the skip *and* the API it would skip against is on this machine.
 *
 * Both inputs are parameters (rather than read inside) so the rule is testable on its own: the
 * tests run after Vite has already replaced `import.meta.env`, so they cannot re-read the flag.
 */
export function devSkipRequested(flag: string | undefined, apiBase: string): boolean {
  const value = (flag ?? "").trim().toLowerCase();
  if (value !== "1" && value !== "true" && value !== "yes") return false;

  try {
    return LOOPBACK.has(new URL(apiBase).hostname);
  } catch {
    return false;
  }
}

/** The one question the login screen asks. */
export function devSkipEnabled(): boolean {
  return devSkipRequested(FLAG, API_BASE);
}
