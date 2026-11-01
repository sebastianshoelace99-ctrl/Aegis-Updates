import { useCallback, useEffect, useRef, useState } from "react";
import {
  SERVER_NAME_MAX,
  SERVER_NAME_MIN,
  SERVER_TEMPLATES,
  createServer,
  templateById,
  type TemplateChoice,
} from "../../api/createServer";
import { getSelfHandle, getSelfId } from "../../state/identity";
import { useSettingsStore } from "../../state/settingsStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { Avatar } from "../../ui/Avatar";
import {
  BookGlyph,
  CompassGlyph,
  GamepadGlyph,
  MembersGlyph,
  PencilGlyph,
  SparkleGlyph,
} from "../../ui/Glyphs";
import styles from "./CreateServerModal.module.css";

/**
 * "Add a Server" -> the create flow.
 *
 * Three steps in the order the product uses them: pick a starting point, name it, then a short
 * "setting up" beat so a server is never presented before the backend has created it.
 *
 * The dialog owns no data: it collects three values and hands them to `createServer`, which
 * validates locally, posts to the backend, and returns the created guild. That is what lets the
 * smoke test drive it with a few synthetic events and then assert on the rail.
 */

type Step = "template" | "customize" | "creating";

const ACCENTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
/** Long enough to read as work, short enough that nobody thinks it hung. */
const SETUP_MS = 620;

const TEMPLATE_GLYPHS = {
  friends: MembersGlyph,
  gaming: GamepadGlyph,
  school: BookGlyph,
  study: PencilGlyph,
  artists: SparkleGlyph,
  community: CompassGlyph,
} as const;

export type CreateServerModalProps = { onClose: () => void };

export function CreateServerModal({ onClose }: CreateServerModalProps): React.JSX.Element {
  const openChannel = useWorkspaceStore((state) => state.openChannel);
  const profile = useSettingsStore((state) => state.profile);
  const openJoinServer = useUiStore((state) => state.openJoinServer);
  const closeCreateServer = useUiStore((state) => state.closeCreateServer);

  const [step, setStep] = useState<Step>("template");
  const [choice, setChoice] = useState<TemplateChoice>("custom");
  const [name, setName] = useState("");
  const [accent, setAccent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const setupTimer = useRef<number | null>(null);

  const trimmed = name.trim();
  const canCreate = trimmed.length >= SERVER_NAME_MIN;
  const template = templateById(choice);

  // The dialog is the initial focus target: otherwise Escape and Tab both start at the document.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(
    () => () => {
      if (setupTimer.current !== null) window.clearTimeout(setupTimer.current);
    },
    [],
  );

  // Dismissing mid-create would leave the reader unaware whether the server exists, so it is not
  // dismissible until the backend has answered.
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }

      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;

      // Selection is small and static, so querying on each Tab is cheaper than maintaining a list.
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ];

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      // Wrap at both ends: otherwise Tab walks into the rail that `aria-modal` told AT to ignore.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const choose = (next: TemplateChoice): void => {
    const picked = templateById(next);
    setChoice(next);
    if (picked) setAccent(picked.accent);
    setStep("customize");
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canCreate) {
      setError(`A server name needs at least ${SERVER_NAME_MIN} characters.`);
      return;
    }

    setError(null);
    setStep("creating");
    setBusy(true);

    setupTimer.current = window.setTimeout(() => {
      setupTimer.current = null;

      void createServer({
        name: trimmed,
        accent,
        templateId: choice,
        ownerId: getSelfId(),
        ownerName: profile.displayName,
        ownerHandle: getSelfHandle(),
      })
        .then((guild) => {
          const first = guild.channels[0];
          if (first) openChannel(first.id);
          onClose();
        })
        .catch((failure: unknown) => {
          // The backend rejected it: send the reader back to the field with the reason instead
          // of stranding them on a "creating" screen that will never finish.
          setStep("customize");
          setError(failure instanceof Error ? failure.message : "Could not create the server.");
        })
        .finally(() => setBusy(false));
    }, SETUP_MS);
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-server-title"
        aria-describedby="create-server-body"
        tabIndex={-1}
        ref={dialogRef}
        data-testid="create-server-modal"
        data-step={step}
      >
        <button
          type="button"
          className={styles.close}
          onClick={close}
          aria-label="Close"
          title="Close"
          disabled={step === "creating"}
        >
          ✕
        </button>

        {step === "template" ? (
          <>
            <header className={styles.head}>
              <h2 id="create-server-title" className={styles.title}>
                Create a server
              </h2>
              <p id="create-server-body" className={styles.body}>
                Your server is where you and your people hang out. Pick a starting point and the
                first channel is set up for you.
              </p>
            </header>

            <div className={styles.tiles}>
              {SERVER_TEMPLATES.map((entry) => {
                const Glyph = TEMPLATE_GLYPHS[entry.id];

                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={styles.tile}
                    data-template={entry.id}
                    data-testid="template-tile"
                    onClick={() => choose(entry.id)}
                  >
                    <span className={styles.tileIcon}>
                      <Glyph />
                    </span>
                    <span className={styles.tileText}>
                      <span className={styles.tileLabel}>{entry.label}</span>
                      <span className={styles.tileCaption}>{entry.caption}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <footer className={styles.footer}>
              <span className={styles.hint}>Every server starts with #general.</span>
              <button
                type="button"
                className={styles.ghost}
                onClick={() => {
                  closeCreateServer();
                  openJoinServer();
                }}
              >
                Join with an invite
              </button>
              <button type="button" className={styles.ghost} onClick={() => choose("custom")}>
                Skip this question
              </button>
            </footer>
          </>
        ) : null}

        {step === "customize" ? (
          <form className={styles.form} onSubmit={submit}>
            <header className={styles.head}>
              <h2 id="create-server-title" className={styles.title}>
                Customize your server
              </h2>
              <p id="create-server-body" className={styles.body}>
                Give your new server a name and an icon.{" "}
                {template
                  ? `It starts with a #general channel set up for ${template.label.toLowerCase()}.`
                  : "You can change either of these later."}
              </p>
            </header>

            <div className={styles.iconRow}>
              <Avatar
                name={trimmed.length > 0 ? trimmed : "New server"}
                accent={accent}
                size="xl"
                shape="square"
              />

              <fieldset className={styles.swatches}>
                <legend className={styles.swatchLabel}>Icon colour</legend>
                <div className={styles.swatchRow}>
                  {ACCENTS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={styles.swatch}
                      data-accent={value}
                      data-selected={value === accent}
                      onClick={() => setAccent(value)}
                      aria-label={`Colour ${value + 1}`}
                      aria-pressed={value === accent}
                    />
                  ))}
                </div>
              </fieldset>
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Server name</span>
              <input
                className={styles.input}
                data-testid="server-name-input"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                maxLength={SERVER_NAME_MAX}
                placeholder="Aegis Studio"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                aria-invalid={error !== null}
                aria-describedby="server-name-hint"
              />
            </label>

            <p className={styles.hint} id="server-name-hint" data-error={error !== null}>
              {error ??
                `${SERVER_NAME_MIN}–${SERVER_NAME_MAX} characters. Letters, numbers and spaces.`}
            </p>

            <footer className={styles.footer}>
              <button
                type="button"
                className={styles.ghost}
                data-testid="create-server-back"
                onClick={() => setStep("template")}
              >
                Back
              </button>
              <button
                type="submit"
                className={styles.primary}
                data-testid="create-server-submit"
                disabled={!canCreate}
              >
                Create
              </button>
            </footer>
          </form>
        ) : null}

        {step === "creating" ? (
          <div className={styles.form}>
            <header className={styles.head} role="status">
              <h2 id="create-server-title" className={styles.title}>
                Setting up “{trimmed}”
              </h2>
              <p id="create-server-body" className={styles.body}>
                Adding #general and handing you the keys.
              </p>
            </header>

            <span className={styles.progress} aria-hidden="true" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
