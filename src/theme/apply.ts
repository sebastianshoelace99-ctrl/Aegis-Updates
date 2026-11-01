import type { ResolvedMode, ThemeId } from "./registry";

/**
 * Write the edition to the document.
 *
 * Deliberately the only place that touches `data-theme` / `data-mode`: the wipe needs the attribute
 * change to happen inside the View Transition callback, so a React effect must not race it.
 */
export function applyEdition(theme: ThemeId, mode: ResolvedMode): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.mode = mode;

  updateThemeColor();
}

/**
 * `<meta name="theme-color">` for the active edition.
 *
 * Read back from CSS instead of duplicating fourteen hex values in TypeScript; `getComputedStyle`
 * forces the recalculation, so this is the *new* edition's background even inside a transition.
 */
export function updateThemeColor(): void {
  if (typeof document === "undefined") return;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;

  const background = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-bg")
    .trim();

  if (background.length > 0) meta.setAttribute("content", background);
}

/** `system` resolved against the live OS preference. */
export function systemMode(): ResolvedMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
