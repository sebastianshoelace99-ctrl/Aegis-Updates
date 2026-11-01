import { describe, expect, it } from "vitest";
import {
  ACCENT_HEX,
  accentSeed,
  contrastRatio,
  ensureContrast,
  inkFor,
  isHexColor,
  normaliseHex,
  paintAccent,
  parseHex,
  type Rgb,
} from "./accent";

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
/** The lightest and darkest pages the shipped editions actually use. */
const PAPER = "#f3f0e7";
const NIGHT = "#0d0d0d";
const MID: Rgb = { r: 128, g: 128, b: 128 };

describe("accent colour maths", () => {
  it("parses the three shapes a person can type", () => {
    expect(parseHex("#1a2b3c")).toEqual({ r: 26, g: 43, b: 60 });
    expect(parseHex("1a2b3c")).toEqual({ r: 26, g: 43, b: 60 });
    expect(parseHex("#ABC")).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseHex("  #E8A020  ")).toEqual({ r: 232, g: 160, b: 32 });
  });

  it("refuses anything that is not a colour instead of guessing one", () => {
    expect(parseHex("red")).toBeNull();
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("#1234567")).toBeNull();
    expect(parseHex("")).toBeNull();
    expect(isHexColor("gold")).toBe(false);
    expect(isHexColor(42)).toBe(false);
  });

  it("canonicalises to lowercase six digits, because that is what gets stored", () => {
    expect(normaliseHex("#ABC")).toBe("#aabbcc");
    expect(normaliseHex("E8A020")).toBe("#e8a020");
    expect(normaliseHex("nope")).toBeNull();
  });

  it("measures contrast on the same scale as the contrast script", () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 5);
    expect(contrastRatio(BLACK, BLACK)).toBeCloseTo(1, 5);
    // The worst case for a fixed ink: a mid grey, where neither black nor white is generous.
    expect(contrastRatio(BLACK, MID)).toBeGreaterThan(5);
  });

  it("picks the ink that actually reads on the fill, never the pretty one", () => {
    expect(inkFor({ r: 255, g: 214, b: 10 })).toBe("#000000");
    expect(inkFor({ r: 10, g: 20, b: 90 })).toBe("#ffffff");
    // Guaranteed by construction: one of the two always clears body text.
    for (const hex of ["#808080", "#ff4d9d", "#1a2fe0", "#b26a1f", "#f5f2e8", "#0b0b0b"]) {
      const fill = parseHex(hex) as Rgb;
      expect(contrastRatio(parseHex(inkFor(fill)) as Rgb, fill)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("leaves a seed that already passes untouched", () => {
    const seed = { r: 159, g: 217, b: 138 };

    expect(ensureContrast(seed, { r: 25, g: 23, b: 18 })).toEqual(seed);
  });

  it("darkens on a pale page and lightens on a dark one", () => {
    const pale = ensureContrast({ r: 255, g: 214, b: 10 }, parseHex(PAPER) as Rgb);
    const dark = ensureContrast({ r: 20, g: 26, b: 90 }, parseHex(NIGHT) as Rgb);

    expect(contrastRatio(pale, parseHex(PAPER) as Rgb)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark, parseHex(NIGHT) as Rgb)).toBeGreaterThanOrEqual(4.5);
    expect(pale.r).toBeLessThan(255);
    expect(dark.g).toBeGreaterThan(26);
  });

  it("resolves a choice to a seed, and 'theme' to no override at all", () => {
    expect(accentSeed("theme", "")).toBeNull();
    expect(accentSeed("custom", "")).toBeNull();
    expect(accentSeed("gold", "")).toBe(ACCENT_HEX.gold);
    expect(accentSeed("custom", "#1A2B3C")).toBe("#1a2b3c");
    // A stray tint must not fight a named hue.
    expect(accentSeed("rose", "#1A2B3C")).toBe("#1a2b3c");
  });
});

describe("accent paint", () => {
  it("emits a fill, a text-safe deep shade and readable inks", () => {
    const paint = paintAccent("#e8a020", "light", PAPER);

    expect(paint).not.toBeNull();
    if (!paint) return;

    expect(paint.seed).toBe("#e8a020");
    expect(contrastRatio(parseHex(paint.seed) as Rgb, parseHex(paint.seedInk) as Rgb)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(parseHex(paint.strong) as Rgb, parseHex(PAPER) as Rgb),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(parseHex(paint.strong) as Rgb, parseHex(paint.strongInk) as Rgb),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(parseHex(paint.strongHover) as Rgb, parseHex(PAPER) as Rgb),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("holds the guarantee for every named hue against both extremes of page", () => {
    for (const [name, hex] of Object.entries(ACCENT_HEX)) {
      for (const [mode, page] of [["light", PAPER] as const, ["dark", NIGHT] as const]) {
        const paint = paintAccent(hex, mode, page);
        expect(paint, `${name} ${mode}`).not.toBeNull();
        if (!paint) continue;

        expect(contrastRatio(parseHex(paint.strong) as Rgb, parseHex(page) as Rgb)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(parseHex(paint.strongHover) as Rgb, parseHex(page) as Rgb)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("falls back to the mode's nominal page when the edition's is unreadable", () => {
    // Retro ships translucent surfaces; a page that cannot be parsed must not stop the derivation.
    expect(paintAccent("#e8a020", "dark", "rgba(8, 38, 64, 0.5)")).not.toBeNull();
    expect(paintAccent("not-a-colour", "dark", NIGHT)).toBeNull();
  });

  it("keeps the quiet tone and the tab hover legible, not just the main shade", () => {
    for (const [mode, page] of [["light", PAPER] as const, ["dark", NIGHT] as const]) {
      const paint = paintAccent("#e8a020", mode, page);
      if (!paint) throw new Error("expected a paint");

      expect(
        contrastRatio(parseHex(paint.dim) as Rgb, parseHex(page) as Rgb),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(parseHex(paint.tabHot) as Rgb, parseHex(paint.seedInk) as Rgb),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("never loses label contrast by hovering, whatever colour was chosen", () => {
    /*
     * A sweep rather than a handful of examples: the picker lets a person choose any colour, and
     * `--tab-hot` is a hover *fill* over which `--tab-ink` keeps its base colour. Moving the fill
     * away from its ink is what makes "hover" safe by construction.
     */
    const seeds = [
      "#000000", "#ffffff", "#808080", "#101010", "#e8a020", "#38a8cc",
      "#7f7f7f", "#c02020", "#2040ff", "#0b6b2f", "#f0e0b0", "#3c3c3c",
    ];

    for (const hex of seeds) {
      for (const [mode, page] of [["light", PAPER] as const, ["dark", NIGHT] as const]) {
        const paint = paintAccent(hex, mode, page);
        if (!paint) throw new Error(`expected a paint for ${hex}`);

        const ink = parseHex(paint.seedInk) as Rgb;
        const base = contrastRatio(parseHex(paint.seed) as Rgb, ink);
        const hot = contrastRatio(parseHex(paint.tabHot) as Rgb, ink);

        expect(hot, `${hex} ${mode}`).toBeGreaterThanOrEqual(4.5);
        expect(hot, `${hex} ${mode}`).toBeGreaterThanOrEqual(base - 1e-9);
      }
    }
  });
});
