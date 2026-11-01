import { DEFAULT_MODE, DEFAULT_THEME, isMode, isThemeId, type Mode, type ThemeId } from "./registry";

/**
 * Theme and mode persistence, kept deliberately separate from the settings document.
 *
 * Two keys, because the two choices are independent: switching from ECHO-net Dark to Synthwave
 * must produce Synthwave Dark. Both are read by `public/theme-boot.js` before the first paint and
 * by the store afterwards, so the two readers must agree on the keys and the shapes - both are
 * plain strings, which is what makes that safe.
 */

export const THEME_KEY = "aegis.theme.v1";
export const MODE_KEY = "aegis.mode.v1";

/** The pre-theme-system document; `appearance.theme` was the mode. Read once, for migration. */
const LEGACY_SETTINGS_KEY = "aegis.settings.v1";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    /* a full or locked storage area costs persistence, not the current session */
  }
}

/** A saved theme always wins; anything unrecognised falls back to Default. */
export function readTheme(): ThemeId {
  const raw = read(THEME_KEY);
  return isThemeId(raw) ? raw : DEFAULT_THEME;
}

export function writeTheme(theme: ThemeId): void {
  write(THEME_KEY, theme);
}

/**
 * Read the mode, migrating the old `appearance.theme` value the first time this build runs.
 * Without the migration a returning user would silently lose an explicit Light choice.
 */
export function readMode(): Mode {
  const raw = read(MODE_KEY);
  if (isMode(raw)) return raw;

  try {
    const legacy = read(LEGACY_SETTINGS_KEY);
    if (legacy) {
      const parsed: unknown = JSON.parse(legacy);
      const mode = (parsed as { appearance?: { theme?: unknown } } | null)?.appearance?.theme;
      if (isMode(mode)) {
        write(MODE_KEY, mode);
        return mode;
      }
    }
  } catch {
    /* a corrupt document is not a reason to block startup */
  }

  return DEFAULT_MODE;
}

export function writeMode(mode: Mode): void {
  write(MODE_KEY, mode);
}
