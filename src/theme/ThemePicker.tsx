import { useEffect, useRef, useState } from "react";
import { MODES, THEMES, themeLabel } from "./registry";
import { useTheme } from "./useTheme";
import { MonitorGlyph, MoonGlyph, SunGlyph } from "../ui/Glyphs";
import styles from "./ThemePicker.module.css";

/**
 * Theme + mode controls.
 *
 * The previews are not images: every card repeats `data-theme` / `data-mode`, so the contract
 * resolves that edition's tokens on the card itself. A preview therefore always shows the palette
 * of the mode the user is currently in, without a second table of hex values to keep in sync.
 */

function ModeIcon({ id }: { id: "light" | "dark" | "system" }): React.JSX.Element {
  if (id === "light") return <SunGlyph />;
  if (id === "dark") return <MoonGlyph />;
  return <MonitorGlyph />;
}

export function ThemePicker(): React.JSX.Element {
  const { theme, mode, resolved, setTheme, setMode } = useTheme();

  return (
    <div className={styles.picker}>
      <div className={styles.group}>
        <span className={styles.legend} id="theme-picker-label">
          Theme
        </span>
        <div className={styles.themes} role="radiogroup" aria-labelledby="theme-picker-label">
          {THEMES.map((entry) => {
            const selected = entry.id === theme;

            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={styles.theme}
                data-selected={selected}
                data-theme={entry.id}
                data-mode={resolved}
                data-testid={`theme-option-${entry.id}`}
                onClick={() => setTheme(entry.id)}
              >
                <span className={styles.preview} aria-hidden="true">
                  <span className={styles.previewRail} />
                  <span className={styles.previewBody}>
                    <span className={styles.previewLine} />
                    <span className={styles.previewLine} data-short="true" />
                    <span className={styles.previewDot} />
                  </span>
                </span>
                <span className={styles.themeText}>
                  <span className={styles.themeName}>{entry.label}</span>
                  <span className={styles.themeBlurb}>{entry.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.legend} id="mode-picker-label">
          Mode
        </span>
        <div className={styles.modes} role="radiogroup" aria-labelledby="mode-picker-label">
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={mode === entry.id}
              className={styles.mode}
              data-selected={mode === entry.id}
              data-testid={`mode-option-${entry.id}`}
              title={entry.caption}
              onClick={() => setMode(entry.id)}
            >
              <span className={styles.modeIcon} aria-hidden="true">
                <ModeIcon id={entry.id} />
              </span>
              {entry.label}
            </button>
          ))}
        </div>
        <p className={styles.note}>
          {mode === "system"
            ? `Following the system — currently ${resolved}.`
            : `Pinned to ${mode}; ${themeLabel(theme)} has a matching edition.`}
        </p>
      </div>
    </div>
  );
}

/**
 * The dock affordance: one icon button and a small dialog.
 *
 * It is marked `data-scanline-exempt` so it keeps working while a wipe is running - the rest of the
 * page is inert, which is exactly what stops a layout shift mid-transition from stealing a click.
 */
export function ThemeMenu(): React.JSX.Element {
  const { resolved } = useTheme();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };

    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  return (
    <div className={styles.wrap} data-scanline-exempt>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Theme and appearance"
        title="Theme and appearance"
        data-testid="open-theme-menu"
        onClick={() => setOpen((value) => !value)}
      >
        {resolved === "dark" ? <MoonGlyph /> : <SunGlyph />}
      </button>

      {open ? (
        <div
          ref={panel}
          className={styles.popover}
          role="dialog"
          aria-label="Theme and appearance"
          data-testid="theme-menu"
        >
          <ThemePicker />
        </div>
      ) : null}
    </div>
  );
}
