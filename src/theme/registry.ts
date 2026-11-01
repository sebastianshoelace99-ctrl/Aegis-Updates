/**
 * Theme registry.
 *
 * One list is the single source of truth for the switcher, the CSS attribute values, the font
 * preload map and the announcement text. Order matters: Default is first because it is what a
 * first-time visitor gets.
 */

export const THEMES = [
  {
    id: "default",
    label: "Default",
    blurb: "Clean, neutral, familiar. The baseline.",
  },
  {
    id: "echo-net",
    label: "ECHO-net",
    blurb: "Comic ink, chamfered plates, one gold accent.",
  },
  {
    id: "mil-sim",
    label: "Mil-Sim",
    blurb: "Matte field manual. Olive, tan, hazard orange.",
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    blurb: "Cold tactical terminal. Slate plates, mint status lights.",
  },
  {
    id: "synthwave",
    label: "Synthwave",
    blurb: "Neon sunset, striped sun, receding grid.",
  },
  {
    id: "retro",
    label: "Retro",
    blurb: "Glossy aero glass, sky gradients, soft bubbles.",
  },
  {
    id: "neo-industrialist",
    label: "Neo-Industrialist",
    blurb: "Raw concrete, steel, thick black borders.",
  },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id);

export const DEFAULT_THEME: ThemeId = "default";

/** `system` never reaches CSS: it is resolved against prefers-color-scheme before applying. */
export type Mode = "light" | "dark" | "system";
export type ResolvedMode = "light" | "dark";

export const DEFAULT_MODE: Mode = "system";

export const MODES: readonly { id: Mode; label: string; caption: string }[] = [
  { id: "light", label: "Light", caption: "Always the light edition" },
  { id: "dark", label: "Dark", caption: "Always the dark edition" },
  { id: "system", label: "System", caption: "Follow the operating system" },
];

/**
 * Families each theme can ask for. Only the two Barlow faces are shipped, so `echo-net`,
 * `mil-sim`, `neo-industrialist` and `neo-brutalism` are served by files that are already on disk.
 * Cyberpunk keeps Barlow for body copy but takes its display face from the system (Bahnschrift and
 * friends), so it needs no condensed download; every other stack is a system font and loads
 * nothing.
 */
export const THEME_FONT_FAMILIES: Record<ThemeId, readonly string[]> = {
  default: [],
  "echo-net": ["Barlow Condensed", "Barlow"],
  "mil-sim": ["Barlow"],
  cyberpunk: ["Barlow"],
  synthwave: [],
  retro: [],
  "neo-industrialist": ["Barlow Condensed", "Barlow"],
  /* Display face is a system mono; only the reading face is bundled. */
  "cassette-futurism": ["Barlow"],
  "neo-brutalism": ["Barlow Condensed", "Barlow"],
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

export function isMode(value: unknown): value is Mode {
  return value === "light" || value === "dark" || value === "system";
}

export function themeLabel(id: ThemeId): string {
  return THEMES.find((theme) => theme.id === id)?.label ?? id;
}
