import { getSelfId } from "../state/identity";
import { getToken } from "../state/session";

/**
 * One place that knows where the backend is and who this window claims to be.
 *
 * `VITE_*` values are baked in by Vite at build time (see `.env`). The defaults are deliberate:
 * a developer who clones the repo and runs `npm run server` should not have to configure
 * anything before the app talks to it.
 */

const DEFAULT_BASE = "http://127.0.0.1:8787";

/*
 * These two reads must stay static member accesses. Vite rewrites the literal text
 * `import.meta.env.VITE_SOMETHING` at build time; a computed lookup such as
 * `import.meta.env[key]` is left in the bundle, where `import.meta.env` does not exist, so the
 * value silently falls back to "" and every request is rejected with
 * "Bad or missing x-aegis-key."
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
export const API_KEY: string = import.meta.env.VITE_API_KEY ?? "";

/** A non-2xx reply, carrying the server's own message when it sent one. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function headers(extra?: HeadersInit): Headers {
  const next = new Headers(extra);
  next.set("accept", "application/json");
  /*
   * `x-aegis-user` stays for the backend's rate-limit attribution and for a dev server without
   * accounts. The bearer token is what actually proves identity: the handler resolves it first and
   * refuses a token that does not resolve, so the header cannot be used to impersonate.
   */
  next.set("x-aegis-user", getSelfId());
  const token = getToken();
  if (token) next.set("authorization", `Bearer ${token}`);
  if (API_KEY) next.set("x-aegis-key", API_KEY);
  return next;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: headers(init.headers),
    });
  } catch (cause) {
    throw new ApiError(
      0,
      `Cannot reach the Aegis backend at ${API_BASE}. Start it with "npm run server".`,
    );
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`.trim();
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body) {
        const message = (body as { error: unknown }).error;
        if (typeof message === "string" && message.length > 0) detail = message;
      }
    } catch {
      /* a non-JSON error body still has a status line */
    }
    throw new ApiError(response.status, detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function authHeaders(extra?: HeadersInit): Headers {
  return headers(extra);
}
