import type { AccentChoice } from "../api/profile";
import type { ResolvedMode } from "./registry";

/**
 * The user's accent colour, derived from one seed hue.
 *
 * A theme owns a palette; this module lets a person repaint the *accent family* of whichever edition
 * is on screen without touching the theme files. That is why the maths lives here rather than in
 * CSS: `color-mix()` can shift a hue but it cannot measure WCAG contrast, and an arbitrary colour
 * from a picker must never be able to produce unreadable text. Every value this module emits has
 * been checked against the edition's own page colour.
 *
 * Five things come out of one seed, and every one of them is either measured against the page or
 * safe by construction:
 *   - `seed`    the hue as chosen. Used for fills (tabs, counters, indicators) where a bold block
 *               of colour is the point.
 *   - `strong`  the hue pushed until it reaches 4.5:1 on the page. Used wherever the accent is
 *               *text* (links, headings, active labels). Light editions darken it, dark editions
 *               keep it or lighten it, and a very pale pick is darkened rather than rejected.
 *   - `dim`     the quiet tone - the accent pulled towards the page, then walked back only as far as
 *               4.5:1 requires. It is what the old `--gold-dim` "muted accent" text wants.
 *   - `tabHot`  the tab block's hover fill, moved away from the block's ink so hovering can only
 *               raise contrast. A fixed "lighten on hover" rule can wash a white label out instead.
 *   - inks      black or white, whichever measures better on the fill being labelled. For any colour
 *               at least one of the two clears 4.5:1, so a label is never illegible.
 */

export type Rgb = { r: number; g: number; b: number };

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Body text. The same threshold `scripts/check-contrast.mjs` enforces on the theme files. */
const BODY = 4.5;

/**
 * The six named hues. They predate the picker: ECHO-net shipped them as its accent family, and the
 * values are unchanged, so anything saved against a name still looks the same.
 */
export const ACCENT_HEX = {
  gold: "#e8a020",
  crimson: "#d8503c",
  emerald: "#3fae74",
  cyan: "#38a8cc",
  violet: "#9a7ae0",
  rose: "#d8649b",
} as const;

export type NamedAccent = keyof typeof ACCENT_HEX;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Round to the eight bits per channel that a hex colour actually stores.
 *
 * The search below has to measure the colour that will be written, not an ideal one: aiming a
 * channel at 4.5:1 and then rounding it can land at 4.49:1.
 */
function snap({ r, g, b }: Rgb): Rgb {
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b) };
}

/** `#abc`, `abc`, `#AABBCC` -> `{r,g,b}`. Anything else -> null, never a guess. */
export function parseHex(value: string): Rgb | null {
  const match = HEX.exec(value.trim());
  if (!match) return null;

  const digits = match[1];
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : digits;

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => clampByte(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** The canonical stored form: lowercase, six digits, always with the hash. */
export function normaliseHex(value: string): string | null {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : null;
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value.trim());
}

/** sRGB relative luminance, with the threshold the contrast script uses so the numbers agree. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** sRGB-space mix, matching what `color-mix(in srgb, ...)` does in the stylesheet. */
export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount));
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
  };
}

/** Ink for text sitting on `fill`. For every colour one of black or white clears 4.5:1. */
export function inkFor(fill: Rgb): string {
  return contrastRatio(BLACK, fill) >= contrastRatio(WHITE, fill) ? "#000000" : "#ffffff";
}

/**
 * Push `seed` towards black or white until it clears `minimum` against `background`.
 *
 * Direction comes from the background, not from the seed: a pale page can only take a darker
 * foreground and a dark page can only take a lighter one, whatever the seed happened to be. A seed
 * that already passes is returned untouched, which is the common case in dark editions.
 */
export function ensureContrast(seed: Rgb, background: Rgb, minimum = BODY): Rgb {
  const start = snap(seed);
  if (contrastRatio(start, background) >= minimum) return start;

  const towards = relativeLuminance(background) > 0.18 ? BLACK : WHITE;

  for (let step = 1; step <= 100; step += 1) {
    const candidate = snap(mix(start, towards, step / 100));
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }

  return towards;
}

export type AccentPaint = {
  /** The hue as chosen - fills only. */
  seed: string;
  seedInk: string;
  /** The hue at 4.5:1 on the page - text and outlines. */
  strong: string;
  strongInk: string;
  /** A hover/pressed variant of `strong`, also held to 4.5:1. */
  strongHover: string;
  /** As quiet as the accent can get while still clearing 4.5:1 - the muted text tone. */
  dim: string;
  /** Hover fill for the `--tab` block, chosen so the block's own ink stays legible on it. */
  tabHot: string;
};

/**
 * The colour the user picked, or null when the edition should keep its own palette.
 *
 * `theme` is the default and means "no override". `custom` with an empty tint is the same thing,
 * which is what a half-finished edit in the picker leaves behind.
 */
export function accentSeed(accent: AccentChoice, tint: string): string | null {
  if (isHexColor(tint)) return normaliseHex(tint);
  if (accent === "custom" || accent === "theme") return null;
  return ACCENT_HEX[accent] ?? null;
}

/**
 * Measure one seed into the seven values the stylesheet needs.
 *
 * `background` is the edition's `--color-bg`, passed in rather than guessed: the contrast guarantee
 * is only as good as the surface it is measured against. When it cannot be read (a translucent
 * page, a theme that paints on a wrapper) the mode's nominal page is used instead.
 */
export function paintAccent(seed: string, mode: ResolvedMode, background: string): AccentPaint | null {
  const rgb = parseHex(seed);
  if (!rgb) return null;

  const page = parseHex(background) ?? (mode === "light" ? WHITE : { r: 18, g: 19, b: 22 });

  /*
   * These two shades are the ones ECHO-net has always used - 45% and 60% towards black in light
   * mode, the seed itself and a 24% lift in dark mode - so a named accent still looks the way it
   * did. `ensureContrast` then only moves a value that would otherwise fail; an arbitrary picker
   * colour is the case that needs it.
   */
  const preferredStrong = mode === "light" ? mix(rgb, BLACK, 0.45) : rgb;
  const preferredHover = mode === "light" ? mix(rgb, BLACK, 0.6) : mix(rgb, WHITE, 0.24);

  const strong = ensureContrast(preferredStrong, page);
  const strongHover = ensureContrast(preferredHover, page);

  /*
   * `dim` is the quiet tone: the accent pulled towards the page, then walked back only as far as it
   * has to. It reads as a softer accent rather than a second colour, which is what `--gold-dim` is
   * for - roughly forty places use it as text, so it gets the same 4.5:1 guarantee as `strong`.
   */
  const dim = ensureContrast(mix(rgb, page, mode === "light" ? 0.36 : 0.3), page);

  /*
   * The tab block's hover fill moves towards the end *opposite* its ink: black ink gets lighter,
   * white ink gets darker. Hovering can then only raise the contrast ratio, never lower it. A fixed
   * "always lighten" rule would drift a white label towards the fill colour instead.
   */
  const tabHot = inkFor(rgb) === "#000000" ? mix(rgb, WHITE, 0.18) : mix(rgb, BLACK, 0.18);

  return {
    seed: toHex(rgb),
    seedInk: inkFor(rgb),
    strong: toHex(strong),
    strongInk: inkFor(strong),
    strongHover: toHex(strongHover),
    dim: toHex(dim),
    tabHot: toHex(tabHot),
  };
}

/** The custom properties `tokens.css` composes with. */
export const ACCENT_VARS = [
  "--accent-seed",
  "--accent-seed-ink",
  "--accent-strong",
  "--accent-strong-ink",
  "--accent-strong-hover",
  "--accent-dim",
  "--accent-tab-hot",
] as const;

/**
 * Write the override onto the document, or take it away.
 *
 * The variables go on before the `data-accent` attribute: `tokens.css` switches its override block
 * on only when that attribute is present, so there is never a frame in which a rule reads a seed
 * that has not been written yet. Custom properties written through CSSOM are not an inline style
 * attribute, so `style-src 'self'` is untouched.
 */
export function applyAccent(root: HTMLElement, accent: AccentChoice, tint: string): void {
  const seed = accentSeed(accent, tint);
  const mode: ResolvedMode = root.dataset.mode === "light" ? "light" : "dark";
  const background =
    typeof getComputedStyle === "function"
      ? getComputedStyle(root).getPropertyValue("--color-bg").trim()
      : "";

  const paint = seed ? paintAccent(seed, mode, background) : null;

  if (!paint) {
    for (const name of ACCENT_VARS) root.style.removeProperty(name);
    root.dataset.accent = "theme";
    return;
  }

  root.style.setProperty("--accent-seed", paint.seed);
  root.style.setProperty("--accent-seed-ink", paint.seedInk);
  root.style.setProperty("--accent-strong", paint.strong);
  root.style.setProperty("--accent-strong-ink", paint.strongInk);
  root.style.setProperty("--accent-strong-hover", paint.strongHover);
  root.style.setProperty("--accent-dim", paint.dim);
  root.style.setProperty("--accent-tab-hot", paint.tabHot);
  root.dataset.accent = accent;
}
