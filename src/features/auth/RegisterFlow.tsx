import { useEffect, useRef, useState } from "react";
import { registerAccount, type AuthSession } from "../../api/auth";
import { ApiError } from "../../api/http";
import { useAuthStore } from "../../state/authStore";
import { Avatar } from "../../ui/Avatar";
import styles from "./AuthScreen.module.css";

/**
 * Account creation, in the three steps the task actually has.
 *
 * Discord asks for a code from your inbox here; this build has no mail service, so the middle
 * step is the password and the last one is a real summary of the account that was just created,
 * not a fake "verify your email" screen.
 */

const STEP_LABEL: Record<number, string> = {
  1: "Step 1 of 3 · Account",
  2: "Step 2 of 3 · Security",
  3: "Step 3 of 3 · Ready",
};

function suggestHandle(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 32);
}

function strengthOf(value: string): { score: number; label: string } {
  if (value.length === 0) return { score: 0, label: "Use at least 8 characters." };
  if (value.length < 8) return { score: 1, label: "Too short - 8 characters minimum." };

  let score = 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score += 1;

  const capped = Math.min(4, score);
  return { score: capped, label: ["", "Weak", "Okay", "Good", "Strong"][capped] ?? "Weak" };
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError || error instanceof Error) {
    return error.message.length > 0 ? error.message : fallback;
  }
  return fallback;
}

export function RegisterFlow({ onCancel }: { onCancel: () => void }): React.JSX.Element {
  const authenticate = useAuthStore((state) => state.authenticate);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AuthSession | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const shownHandle = handleTouched ? handle : suggestHandle(displayName);
  const strength = strengthOf(password);

  const goSecurity = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const nextEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(nextEmail)) {
      setError("That does not look like an email address.");
      return;
    }

    const nextName = displayName.trim().replace(/\s+/g, " ");
    if (nextName.length === 0) {
      setError("A display name is required.");
      return;
    }
    if ([...nextName].length > 32) {
      setError("Use at most 32 characters for the display name.");
      return;
    }

    const nextHandle = shownHandle.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(nextHandle)) {
      setError(
        "Pick a handle: 2-32 lowercase letters, numbers, dots, dashes or underscores. " +
          "It has to start with a letter or a number.",
      );
      setHandleTouched(true);
      return;
    }

    setEmail(nextEmail);
    setDisplayName(nextName);
    setHandle(nextHandle);
    setHandleTouched(true);
    setError(null);
    setStep(2);
  };

  const create = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;

    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those two passwords do not match.");
      return;
    }
    if (!accepted) {
      setError("Tick the box to continue.");
      return;
    }

    setBusy(true);
    setError(null);

    void registerAccount({
      email,
      password,
      displayName,
      handle: shownHandle.trim().toLowerCase(),
    })
      .then((session) => {
        if (!alive.current) return;
        setCreated(session);
        setStep(3);
      })
      .catch((failure: unknown) => {
        if (!alive.current) return;
        setError(messageOf(failure, "The account could not be created."));
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  };

  return (
    <>
      <p className={styles.eyebrow}>Create an account</p>
      <h1 className={styles.title}>{step === 3 ? "You're in" : "Join Aegis Shield"}</h1>
      <p className={styles.sub}>
        {step === 1
          ? "Pick the name people will see, and the address you will sign in with."
          : step === 2
            ? "Choose a password. Eight characters is the floor, a passphrase is better."
            : "The account exists. Nothing else is required."}
      </p>

      <div className={styles.steps} aria-hidden="true">
        {[1, 2, 3].map((index) => (
          <span
            key={index}
            className={styles.stepBar}
            data-state={step > index ? "done" : step === index ? "active" : "pending"}
          />
        ))}
      </div>
      <p className={styles.stepCaption} aria-live="polite">
        {STEP_LABEL[step]}
      </p>

      {step === 1 ? (
        <form className={styles.form} onSubmit={goSecurity} noValidate>
          <label className={styles.label} htmlFor="register-email">
            Email
          </label>
          <input
            id="register-email"
            className={styles.input}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            placeholder="you@example.com"
            autoFocus
            required
          />

          <div className={styles.grid2}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="register-name">
                Display name
              </label>
              <input
                id="register-name"
                className={styles.input}
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="nickname"
                maxLength={32}
                placeholder="Nyx"
                required
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="register-handle">
                Handle
              </label>
              <input
                id="register-handle"
                className={styles.input}
                type="text"
                value={shownHandle}
                onChange={(event) => {
                  setHandleTouched(true);
                  setHandle(event.target.value.toLowerCase());
                }}
                autoComplete="off"
                spellCheck={false}
                maxLength={32}
                placeholder="nyx"
                required
              />
            </div>
          </div>

          <p className={styles.providerHint}>
            Your handle is how people mention you: <code>@{shownHandle || "handle"}</code>. It can
            be changed later, but not to a name someone else already took.
          </p>

          {error ? (
            <p className={styles.alert} role="alert">
              {error}
            </p>
          ) : null}

          <div className={styles.actions}>
            <button type="submit" className={styles.submit}>
              Continue
            </button>
          </div>
        </form>
      ) : null}


      {step === 2 ? (
        <form className={styles.form} onSubmit={create} noValidate>
          <label className={styles.label} htmlFor="register-password">
            Password
          </label>
          <div className={styles.passwordWrap}>
            <input
              id="register-password"
              className={styles.input}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              autoFocus
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

          <div className={styles.strength} data-score={strength.score} aria-hidden="true">
            {[1, 2, 3, 4].map((index) => (
              <span
                key={index}
                className={styles.strengthSegment}
                data-on={index <= strength.score}
              />
            ))}
          </div>
          <p className={styles.strengthLabel} aria-live="polite">
            {strength.label}
          </p>

          <label className={styles.label} htmlFor="register-confirm">
            Confirm password
          </label>
          <input
            id="register-confirm"
            className={styles.input}
            type={showPassword ? "text" : "password"}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            placeholder="Repeat it"
            required
          />

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>
              I understand this account lives on this Aegis backend, and that whoever runs the
              server can read its account file.
            </span>
          </label>

          {error ? (
            <p className={styles.alert} role="alert">
              {error}
            </p>
          ) : null}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setError(null);
                setStep(1);
              }}
              disabled={busy}
            >
              Back
            </button>
            <button type="submit" className={styles.submit} disabled={busy}>
              {busy ? "Creating…" : "Create account"}
            </button>
          </div>
        </form>
      ) : null}

      {step === 3 && created ? (
        <div className={styles.done}>
          <span className={styles.doneMark} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="34" height="34">
              <path
                d="m5 12.5 4.5 4.5L19 7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="square"
              />
            </svg>
          </span>

          <Avatar
            name={created.user.displayName}
            accent={created.user.accent}
            size="xl"
          />

          <h2 className={styles.doneName}>{created.user.displayName}</h2>
          <p className={styles.doneHandle}>@{created.user.handle}</p>
          <p className={styles.doneBody}>
            Signed in as <strong>{created.user.email}</strong>. You can create a server, or join one
            you are invited to.
          </p>

          <button
            type="button"
            className={styles.submit}
            onClick={() => authenticate(created)}
          >
            Enter Aegis Shield
          </button>
        </div>
      ) : null}

      {step !== 3 ? (
        <p className={styles.switch}>
          Already have an account?
          <button type="button" className={styles.link} onClick={onCancel}>
            Log in
          </button>
        </p>
      ) : null}
    </>
  );
}

