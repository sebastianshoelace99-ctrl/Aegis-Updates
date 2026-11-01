import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Generates the mock artwork the gallery loads: 24 variants x 3 sizes.
 *
 *   blur-XX.svg     32 x 24    placeholder, painted immediately
 *   thumb-XX.svg   320 x 240   the only size the grid ever requests
 *   display-XX.svg 1280 x 960  inspector only
 *
 * Real PNGs would be better, but deterministic SVGs keep the repo small and make the three
 * size tiers explicit without a build step that needs network access.
 */

const OUT_DIR = join("public", "art");
const VARIANTS = 24;

const SIZES = {
  blur: [32, 24],
  thumb: [320, 240],
  display: [1280, 960],
};

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function svgFor(index, width, height) {
  const random = mulberry32(index * 9301 + 49297);
  const hue = Math.round((index * 360) / VARIANTS);
  const hue2 = (hue + 55) % 360;
  const scale = Math.min(width, height);

  const shapes = Array.from({ length: 3 + Math.floor(random() * 3) }, (_, i) => {
    const cx = Math.round(random() * width);
    const cy = Math.round(random() * height);
    const r = Math.round((0.12 + random() * 0.3) * scale);
    const opacity = (0.16 + random() * 0.42).toFixed(2);
    const lightness = Math.round(42 + random() * 38);
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${(hue2 + i * 24) % 360} 72% ${lightness}%)" opacity="${opacity}"/>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 62% 34%)"/>
      <stop offset="1" stop-color="hsl(${hue2} 68% 11%)"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  ${shapes.join("\n  ")}
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="rgba(255,255,255,0.10)"/>
</svg>
`;
}

mkdirSync(OUT_DIR, { recursive: true });

let written = 0;
for (let index = 0; index < VARIANTS; index += 1) {
  const suffix = String(index + 1).padStart(2, "0");
  for (const [kind, [width, height]] of Object.entries(SIZES)) {
    writeFileSync(join(OUT_DIR, `${kind}-${suffix}.svg`), svgFor(index, width, height), "utf8");
    written += 1;
  }
}

console.log(`art: ${written} files (${VARIANTS} variants x ${Object.keys(SIZES).length} sizes)`);
