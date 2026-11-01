import { useEffect } from "react";
import { App } from "../../app/App";
import { useAppearance } from "../../app/useAppearance";
import { ThemeLiveRegion } from "../../theme/ThemeLiveRegion";
import { useTheme } from "../../theme/useTheme";
import { useAuthStore } from "../../state/authStore";
import { useUiStore } from "../../state/uiStore";
import { LoginScreen } from "./LoginScreen";
import styles from "./AuthScreen.module.css";

/**
 * The gate between the signed-out and signed-in halves of the app.
 *
 * `App` is mounted only after a session exists, so its first `GET /api/workspace` already carries
 * the bearer token - there is no window in which the workspace boots as the wrong account.
 *
 * It also owns the two always-mounted appearance hooks: personalization (`useAppearance`) and the
 * theme store's live OS listener (`useTheme`). Both must exist on the login screen too, or the
 * first thing a visitor sees would ignore their saved density and their OS's light/dark choice.
 */
export function AuthGate(): React.JSX.Element {
  const openJoinServer = useUiStore((state) => state.openJoinServer);
  useAppearance();
  useTheme();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("invite");
    if (code && /^[A-Za-z0-9_-]{43}$/.test(code)) openJoinServer(code);
    if (params.has("invite")) {
      params.delete("invite");
      const query = params.size > 0 ? `?${params.toString()}` : "";
      window.history.replaceState(null, "", `${window.location.pathname}${query}${window.location.hash}`);
    }
  }, [openJoinServer]);

  return (
    <>
      <Gate />
      <ThemeLiveRegion />
    </>
  );
}

function Gate(): React.JSX.Element {
  const status = useAuthStore((state) => state.status);
  const error = useAuthStore((state) => state.error);
  const restore = useAuthStore((state) => state.restore);
  const forget = useAuthStore((state) => state.forget);

  useEffect(() => {
    void restore();
  }, [restore]);

  if (status === "signed-in") return <App />;

  if (status === "restoring") {
    return (
      <Splash
        title="Checking this session"
        body="Talking to the Aegis backend to see who is signed in."
      />
    );
  }

  if (status === "unreachable") {
    return (
      <Splash
        title="Backend unavailable"
        body={error ?? "The Aegis backend could not be reached."}
        failed
        onRetry={() => void restore()}
        onSignOut={forget}
      />
    );
  }

  return <LoginScreen />;
}

function Splash({
  title,
  body,
  failed = false,
  onRetry,
  onSignOut,
}: {
  title: string;
  body: string;
  failed?: boolean;
  onRetry?: () => void;
  onSignOut?: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.splash} data-testid="auth-splash">
      <div className={styles.splashPanel} aria-busy={!failed}>
        <span className={styles.splashMark} data-error={failed} aria-hidden="true" />
        <h1 className={styles.splashTitle}>{title}</h1>
        <p className={styles.splashBody}>{body}</p>

        {failed ? (
          <div className={styles.splashActions}>
            <button type="button" className={styles.submit} onClick={onRetry}>
              Try again
            </button>
            <button type="button" className={styles.secondary} onClick={onSignOut}>
              Use another account
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
