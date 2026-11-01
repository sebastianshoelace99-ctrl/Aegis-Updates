import { create } from "zustand";
import { fetchSession, signOut as endSession, type AuthSession, type AuthUser } from "../api/auth";
import { ApiError } from "../api/http";
import { DEV_ACCOUNT, devSkipEnabled } from "./devSession";
import { resetSelfIdentity, setSelfIdentity } from "./identity";
import { getToken, setToken } from "./session";
import { useSettingsStore } from "./settingsStore";

/**
 * Who is signed in.
 *
 * The token lives in `session.ts`; this store owns the *view* of it: restore-on-launch, the
 * signed-in user, and the one way to leave. The gate in `features/auth/AuthGate.tsx` renders from
 * these three states, so there is no second place that can disagree about whether to show the
 * login screen.
 */

export type AuthStatus = "restoring" | "signed-out" | "signed-in" | "unreachable";

export type AuthState = {
  status: AuthStatus;
  user: AuthUser | null;
  /** Why the session could not be restored; only meaningful when `status` is `unreachable`. */
  error: string | null;
  restore: () => Promise<void>;
  authenticate: (session: AuthSession) => void;
  /**
   * The dev-only login skip (`devSession.ts`): enter as a local account with no backend session.
   * Omitted from builds that did not opt in, so no stray caller can bypass authentication.
   */
  devSignIn?: () => void;
  signOut: () => Promise<void>;
  /** Drops the local session without asking the server (used when the backend is unreachable). */
  forget: () => void;
};

const SEED_KEY = "aegis.auth.seeded.v1";

/**
 * Install an account into the local profile.
 *
 * The display name is seeded *once per account*: after that, the name in Settings is the user's
 * choice, and overwriting it on every launch would silently undo a rename.
 */
function adopt(user: AuthUser): void {
  setSelfIdentity({ id: user.id, handle: user.handle });

  try {
    if (window.localStorage.getItem(SEED_KEY) === user.id) return;
    useSettingsStore.getState().setProfile({
      displayName: user.displayName,
      accent: user.accent,
    });
    window.localStorage.setItem(SEED_KEY, user.id);
  } catch {
    /* settings are a convenience; a locked storage area must not block sign-in */
  }
}

let inFlight: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set) => ({
  // No token means there is nothing to check: start on the login screen instead of flashing a
  // splash for one frame on a fresh install.
  status: getToken() ? "restoring" : "signed-out",
  user: null,
  error: null,

  restore: () => {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const token = getToken();
      if (!token) {
        set({ status: "signed-out", user: null, error: null });
        return;
      }

      set({ status: "restoring", error: null });

      try {
        const user = await fetchSession();
        adopt(user);
        set({ status: "signed-in", user, error: null });
      } catch (error) {
        // A rejected token is not an outage: clear it and show the login screen.
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          setToken(null);
          resetSelfIdentity();
          set({ status: "signed-out", user: null, error: null });
          return;
        }

        set({
          status: "unreachable",
          error:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "The Aegis backend could not be reached.",
        });
      }
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  },

  authenticate: (session) => {
    // Token first: `http.ts` reads it for every request the app makes after this point.
    setToken(session.token);
    adopt(session.user);
    set({ status: "signed-in", user: session.user, error: null });
  },

  ...(import.meta.env.VITE_AEGIS_SKIP_AUTH === "1"
    ? {
        devSignIn: () => {
          /*
           * Guarded, not just gated in the UI: a build that did not opt in must have no way to
           * reach this, even if some future caller forgets to check the flag first.
           */
          if (!devSkipEnabled()) return;

          /*
           * No token, on purpose. The backend prefers a session over the `x-aegis-user` claim, so
           * a token left over from an earlier sign-in would put the workspace under that account
           * while this window showed the dev one. Clearing it is what makes the two agree.
           */
          setToken(null);
          setSelfIdentity({ id: DEV_ACCOUNT.id, handle: DEV_ACCOUNT.handle });
           set({
             status: "signed-in",
             user: {
               id: DEV_ACCOUNT.id,
               email: "dev@localhost",
               displayName: DEV_ACCOUNT.displayName,
               handle: DEV_ACCOUNT.handle,
               accent: 2,
               provider: "email",
               createdAt: "1970-01-01T00:00:00.000Z",
             },
             error: null,
           });
        },
      }
    : {}),

  signOut: async () => {
    try {
      await endSession();
    } catch {
      /* the local token is what matters; a backend that is down cannot revoke it anyway */
    }

    setToken(null);
    resetSelfIdentity();
    set({ status: "signed-out", user: null, error: null });

    // The workspace store, query cache and open drafts all belong to the previous account.
    if (typeof window !== "undefined") window.location.reload();
  },

  forget: () => {
    setToken(null);
    resetSelfIdentity();
    set({ status: "signed-out", user: null, error: null });
  },
}));
