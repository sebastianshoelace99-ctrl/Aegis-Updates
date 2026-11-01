import { useEffect, useRef, useState } from "react";
import {
  fetchProviders,
  loginWithPassword,
  pollOAuth,
  startOAuth,
  type ProviderId,
  type ProviderStatus,
} from "../../api/auth";
import { ApiError } from "../../api/http";
import { hasShell } from "../../bridge/client";
import { useAuthStore } from "../../state/authStore";
import { devSkipEnabled } from "../../state/devSession";
import { RegisterFlow } from "./RegisterFlow";
import { AppleGlyph, DiscordGlyph, GoogleGlyph } from "./ProviderGlyphs";
import styles from "./AuthScreen.module.css";

/**
 * The sign-in screen.
 *
 * Discord's shape - brand panel, one card, "Welcome back!", OR, three provider buttons - in
 * Aegis's chamfered gold language. Everything below the form is real: the provider buttons start a
 * genuine OAuth attempt, and the card tells the operator which environment variable is missing
 * instead of pretending the button works.
 */

const PROVIDERS: readonly { id: ProviderId; label: string }[] = [
  { id: "discord", label: "Discord" },
  { id: "google", label: "Google" },
  { id: "apple", label: "Apple" },
];

const OAUTH_TIMEOUT_MS = 5 * 60_000;
// The auth bucket allows 30 requests a minute. Polling every 3 s stays well inside it, while a
// provider round-trip normally finishes in under 30 s.
const POLL_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError || error instanceof Error) {
    return error.message.length > 0 ? error.message : fallback;
  }
  return fallback;
}

function ProviderIcon({ id }: { id: ProviderId }): React.JSX.Element {
  if (id === "discord") return <DiscordGlyph />;
  if (id === "google") return <GoogleGlyph />;
  return <AppleGlyph />;
}

export function LoginScreen(): React.JSX.Element {
  const authenticate = useAuthStore((state) => state.authenticate);
  const devSignIn = useAuthStore(
    import.meta.env.VITE_AEGIS_SKIP_AUTH === "1"
      ? (state) => state.devSignIn
      : () => undefined,
  );

  // Constant for the life of a build: the flag is inlined by Vite and the API base is baked.
  const canSkip = import.meta.env.VITE_AEGIS_SKIP_AUTH === "1" && devSkipEnabled();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);

  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void fetchProviders()
      .then((next) => {
        if (!cancelled) setProviders(next);
      })
      .catch(() => {
        // Not fatal: signing in still works, and `startOAuth` will explain a missing provider.
        if (!cancelled) setProviders(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || oauthBusy) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    void loginWithPassword({ email: email.trim(), password })
      .then((session) => {
        authenticate(session);
      })
      .catch((failure: unknown) => {
        if (!alive.current) return;
        setError(messageOf(failure, "Could not sign in."));
        setBusy(false);
      });
  };

  const beginOAuth = async (provider: ProviderId, label: string): Promise<void> => {
    if (busy || oauthBusy) return;

    setOauthBusy(provider);
    setError(null);
    setNotice(null);
    setPendingUrl(null);

    try {
      const { attemptId, authorizeUrl } = await startOAuth(provider);

      /*
       * In Electron this is intercepted by the window-open handler and handed to the system
       * browser; in a browser tab it is a normal popup. Either way the page below keeps polling,
       * so a blocked popup only costs the fallback link, never the sign-in.
       */
      const opened = window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      if (!opened && !hasShell) setPendingUrl(authorizeUrl);

      const deadline = Date.now() + OAUTH_TIMEOUT_MS;

      while (alive.current && Date.now() < deadline) {
        await sleep(POLL_MS);
        if (!alive.current) return;

        const result = await pollOAuth(attemptId);

        if (result.status === "complete") {
          authenticate({ token: result.token, user: result.user });
          return;
        }
        if (result.status === "error") {
          setError(result.message);
          return;
        }
      }

      if (alive.current) setError("That sign-in took too long. Try again.");
    } catch (failure) {
      if (alive.current) setError(messageOf(failure, `${label} sign-in failed.`));
    } finally {
      if (alive.current) setOauthBusy(null);
    }
  };

  const switchToRegister = (): void => {
    setMode("register");
    setError(null);
    setNotice(null);
    setPendingUrl(null);
  };

  const unavailable = providers?.filter((entry) => !entry.configured) ?? [];

  return (
    <div className={styles.screen} data-testid="auth-screen">
      <section className={styles.hero} aria-label="About Aegis Shield">
        <div className={styles.heroInner}>
          <div className={styles.brandRow}>
            <span className={styles.mark} aria-hidden="true" />
            <span className={styles.wordmark}>Aegis Shield</span>
          </div>

          <h2 className={styles.heroTitle}>
            Your people.
            <em>Your servers.</em>
          </h2>

          <p className={styles.heroBody}>
            One identity for every server you belong to. Sign in with the account you already use,
            or make a new one and start a server in a couple of clicks.
          </p>

          <ul className={styles.points}>
            <li>Text, voice and gallery channels in one window</li>
            <li>Live presence, replies and attachments</li>
            <li>Your profile and appearance stay on this device</li>
          </ul>
        </div>

        <p className={styles.heroFoot}>Self-hosted · your backend, your data</p>
      </section>

      <main className={styles.panel}>
        <div className={styles.stack}>
          <div className={styles.card}>
            <div className={styles.mobileBrand}>
              <span className={styles.mark} aria-hidden="true" />
              <span className={styles.wordmark}>Aegis Shield</span>
            </div>

            {mode === "register" ? (
              <RegisterFlow onCancel={() => setMode("login")} />
            ) : (
              <>
                <h1 className={styles.title}>Welcome back!</h1>
                <p className={styles.sub}>We&apos;re so excited to see you again.</p>

                <form className={styles.form} onSubmit={submit} noValidate>
                  <label className={styles.label} htmlFor="auth-email">
                    Email
                  </label>
                  <input
                    id="auth-email"
                    className={styles.input}
                    type="email"
                    name="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="username"
                    inputMode="email"
                    spellCheck={false}
                    placeholder="you@example.com"
                    disabled={busy || oauthBusy !== null}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "auth-error" : undefined}
                    autoFocus
                    required
                  />

                  <div className={styles.labelRow}>
                    <label className={styles.label} htmlFor="auth-password">
                      Password
                    </label>
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() =>
                        setNotice(
                          "Password recovery needs an email service, which this build does not ship. " +
                            "Sign in with a linked provider instead, or ask the person running this " +
                            "server to reset the account file.",
                        )
                      }
                    >
                      Forgot your password?
                    </button>
                  </div>

                  <div className={styles.passwordWrap}>
                    <input
                      id="auth-password"
                      className={styles.input}
                      type={showPassword ? "text" : "password"}
                      name="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                      placeholder="Your password"
                      disabled={busy || oauthBusy !== null}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? "auth-error" : undefined}
                      required
                    />
                    <button
                      type="button"
                      className={styles.reveal}
                      aria-pressed={showPassword}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowPassword((value) => !value)}
                      tabIndex={-1}
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>


                  {error ? (
                    <p className={styles.alert} id="auth-error" role="alert">
                      {error}
                    </p>
                  ) : null}
                  {notice ? <p className={styles.notice}>{notice}</p> : null}

                  <button
                    type="submit"
                    className={styles.submit}
                    disabled={busy || oauthBusy !== null}
                  >
                    {busy ? "Signing in…" : "Log In"}
                  </button>
                </form>

                <p className={styles.switch}>
                  Need an account?
                  <button type="button" className={styles.link} onClick={switchToRegister}>
                    Register
                  </button>
                </p>

                <div className={styles.divider}>or</div>

                <div className={styles.providers}>
                  {PROVIDERS.map((provider) => {
                    const status = providers?.find((entry) => entry.id === provider.id);
                    const disabled = busy || oauthBusy !== null || status?.configured === false;
                    const busyHere = oauthBusy === provider.id;

                    return (
                      <button
                        key={provider.id}
                        type="button"
                        className={styles.provider}
                        data-provider={provider.id}
                        disabled={disabled}
                        aria-busy={busyHere}
                        title={
                          status && !status.configured
                            ? `Set ${status.missing.join(", ")} to enable this button.`
                            : `Continue with ${provider.label}`
                        }
                        onClick={() => void beginOAuth(provider.id, provider.label)}
                      >
                        <span className={styles.providerIcon}>
                          <ProviderIcon id={provider.id} />
                        </span>
                        {busyHere
                          ? `Waiting for ${provider.label}…`
                          : `Continue with ${provider.label}`}
                        {status && !status.configured ? (
                          <span className={styles.providerSuffix}>setup</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>

                {unavailable.length > 0 ? (
                  <div className={styles.setupNote}>
                    <p className={styles.setupLabel}>Credentials needed in .env</p>
                    <ul className={styles.setupList}>
                      {unavailable.map((entry) => (
                        <li key={entry.id}>
                          <strong>{entry.label}</strong>
                          <span>{entry.missing.join(", ")}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {pendingUrl ? (
                  <p className={styles.notice}>
                    Your browser blocked the sign-in window.{" "}
                    <a className={styles.link} href={pendingUrl} target="_blank" rel="noreferrer">
                      Open it here
                    </a>
                    .
                  </p>
                ) : null}

                {canSkip ? (
                  <p className={styles.switch} data-testid="dev-skip">
                    Pre-production build:
                    <button type="button" className={styles.link} onClick={devSignIn}>
                      continue as the local dev account
                    </button>
                  </p>
                ) : null}
              </>
            )}
          </div>

          <p className={styles.legal}>
            By signing in you agree to keep this server&apos;s rules. Sessions last 30 days on this
            device.
          </p>
        </div>
      </main>
    </div>
  );
}
