import { create } from "zustand";
import { applyEdition, systemMode } from "./apply";
import { ensureThemeFonts } from "./fonts";
import {
  DEFAULT_MODE,
  themeLabel,
  type Mode,
  type ResolvedMode,
  type ThemeId,
} from "./registry";
import { readMode, readTheme, writeMode, writeTheme } from "./storage";
import { runScanline } from "./transition";

/**
 * The one owner of theme and mode.
 *
 * Choices are written to localStorage in the action itself, before the transition starts: the
 * visual effect must never be the thing that makes a choice durable. `resolved` is the mode that
 * actually reached CSS, so a `system` change from dark to dark is a no-op - no wipe, no repaint.
 */

export type ThemeState = {
  theme: ThemeId;
  mode: Mode;
  resolved: ResolvedMode;
  /** Consumed by the politely-announced live region, never rendered visually. */
  announcement: { text: string; id: number } | null;
  setTheme: (theme: ThemeId) => void;
  setMode: (mode: Mode) => void;
  toggleMode: () => void;
  /** Called by the prefers-color-scheme listener; only does anything in System mode. */
  syncSystem: () => void;
};

const initialTheme = readTheme();
const initialMode = readMode();
const initialResolved: ResolvedMode = initialMode === "system" ? systemMode() : initialMode;

let announcementId = 0;
/** Guards against a queued font-wait callback applying an edition the user already replaced. */
let changeGeneration = 0;

/**
 * The edition currently on the document.
 *
 * Kept separately from the store because `setTheme` updates the store *before* the wipe starts
 * (the controls have to respond immediately), so comparing against store state inside `commit`
 * would see the new theme and reject the change as a no-op.
 */
let applied: { theme: ThemeId; resolved: ResolvedMode } = {
  theme: initialTheme,
  resolved: initialResolved,
};

export const useThemeStore = create<ThemeState>((set, get) => {
  /**
   * Apply an edition, with the wipe, once the destination fonts are ready. Everything that changes
   * the edition funnels through here so "same edition" can be rejected in exactly one place.
   */
  const commit = (theme: ThemeId, resolved: ResolvedMode): void => {
    if (applied.theme === theme && applied.resolved === resolved) return;
    applied = { theme, resolved };

    const generation = ++changeGeneration;
    const text = `Theme changed to ${themeLabel(theme)}, ${resolved} mode`;
    set({ resolved, announcement: { text, id: ++announcementId } });

    void ensureThemeFonts(theme).then(() => {
      // A newer change arrived while the fonts were loading: it owns the screen now.
      if (generation !== changeGeneration) return;
      runScanline(() => applyEdition(theme, resolved));
    });
  };

  return {
    theme: initialTheme,
    mode: initialMode,
    resolved: initialResolved,
    announcement: null,

    setTheme: (theme) => {
      const state = get();
      if (state.theme === theme) return;

      writeTheme(theme);
      set({ theme });
      commit(theme, state.resolved);
    },

    setMode: (mode) => {
      const state = get();
      if (state.mode === mode) return;

      writeMode(mode);
      const resolved = mode === "system" ? systemMode() : mode;
      set({ mode });
      commit(state.theme, resolved);
    },

    toggleMode: () => {
      const state = get();
      get().setMode(state.resolved === "dark" ? "light" : "dark");
    },

    syncSystem: () => {
      const state = get();
      if (state.mode !== "system") return;

      const resolved = systemMode();
      if (resolved === state.resolved) return;

      commit(state.theme, resolved);
    },
  };
});

/**
 * Reconcile the document with the store after the boot script has run.
 *
 * Normally a no-op (the head script already set both attributes); it still runs so the
 * `<meta name="theme-color">` can only be computed once CSS exists, and so a blocked or missing
 * boot script still ends in a themed document.
 */
if (typeof document !== "undefined") {
  applyEdition(initialTheme, initialResolved);
  // A user with no explicit choice gets one recorded, so the boot script and the store agree.
  if (initialMode === DEFAULT_MODE) writeMode(DEFAULT_MODE);
}
