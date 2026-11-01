/*
 * WCAG AA check for every theme edition.
 *
 * Reads the real values out of `src/theme/themes/*.css` instead of a duplicated table, so a palette
 * edit can never leave this report lying. Translucent tokens (Retro's glass, Synthwave Light's
 * panels) are alpha-composited over the edition's own background before measuring, which is what
 * the eye actually sees.
 *
 *   node scripts/check-contrast.mjs           # failures only, exit 1 on a failure
 *   node scripts/check-contrast.mjs --all     # every pairing
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const THEMES_DIR = join(process.cwd(), "src", "theme", "themes");
const BODY = 4.5;
const UI = 3;

/** [foreground, background, minimum, label] */
const PAIRS = [
  ["text", "bg", BODY, "body text on page"],
  ["text", "surface", BODY, "body text on surface"],
  ["text", "surface-alt", BODY, "body text on alt surface"],
  ["text", "chat", BODY, "body text on conversation"],
  ["text-muted", "bg", BODY, "muted text on page"],
  ["text-muted", "surface", BODY, "muted text on surface"],
  ["text-muted", "chat", BODY, "muted text on conversation"],
  ["primary", "bg", BODY, "primary text on page"],
  ["primary", "surface", BODY, "primary text on surface"],
  ["link", "bg", BODY, "link on page"],
  ["link", "surface", BODY, "link on surface"],
  ["tab-ink", "tab", BODY, "label on tab fill"],
  ["on-accent", "accent", BODY, "label on accent fill"],
  ["on-danger", "danger", BODY, "label on danger fill"],
  ["counter-text", "counter-bg", BODY, "counter text"],
  ["bubble-sent-text", "bubble-sent", BODY, "sent bubble"],
  ["bubble-received-text", "bubble-received", BODY, "received bubble"],
  ["focus", "bg", UI, "focus ring on page"],
  ["focus", "surface", UI, "focus ring on surface"],
];

/*
 * Tokens a HUD-style theme names directly rather than through the `color-*` family. Measured with
 * the same rules: the selected fill is a label background, and a status light carries meaning.
 */
const HUD_PAIRS = [
  ["selected-text", "selected-bg", BODY, "label on selected fill"],
  ["status-accent", "color-panel", UI, "status light on panel"],
  ["hud-line", "color-panel", UI, "plate outline on panel"],
];

/*
 * Avatar and server-icon plates. The eight slots live in `base.css` and any theme may repaint them;
 * the initials are drawn in `--color-avatar-ink`, so every plate has to carry that ink at AA.
 */
const PALETTE_PAIRS = Array.from({ length: 8 }, (_, index) => [
  "color-avatar-ink",
  `palette-${index}`,
  BODY,
  `initials on palette ${index}`,
]);

function hex(value) {
  const clean = value.replace("#", "");
  const full =
    clean.length === 3
      ? clean.split("").map((c) => c + c).join("")
      : clean;

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
    a: 1,
  };
}

function parse(value) {
  const raw = value.trim();
  if (raw.startsWith("#")) return hex(raw);

  const rgba = raw.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const parts = rgba[1].split(",").map((part) => Number.parseFloat(part.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }

  return null;
}

function composite(fg, bg) {
  const a = fg.a ?? 1;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}


/** `--name: value;` declarations inside one CSS block, ignoring comments. */
function declarations(block) {
  const map = new Map();
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, "");

  for (const match of clean.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    map.set(match[1], match[2].trim());
  }

  return map;
}

function editions() {
  const files = readdirSync(THEMES_DIR).filter((name) => name.endsWith(".css"));
  const out = [];

  for (const file of files) {
    const css = readFileSync(join(THEMES_DIR, file), "utf8");
    const pattern = /\[data-theme="([^"]+)"\]\[data-mode="(light|dark)"\]\s*\{([\s\S]*?)\n\}/g;

    for (const match of css.matchAll(pattern)) {
      out.push({ theme: match[1], mode: match[2], tokens: declarations(match[3]) });
    }
  }

  return out.sort((a, b) => a.theme.localeCompare(b.theme) || a.mode.localeCompare(b.mode));
}

function colour(tokens, name, backdrop) {
  const raw = tokens.get(name);
  if (!raw) return null;

  const parsed = parse(raw);
  if (!parsed) return null;

  return parsed.a < 1 ? composite(parsed, backdrop) : parsed;
}

const rows = [];
const failures = [];

const pairs = [
  ...PAIRS.map(([fg, bg, minimum, label]) => [`color-${fg}`, `color-${bg}`, minimum, label]),
  ...HUD_PAIRS,
  ...PALETTE_PAIRS,
];

for (const edition of editions()) {
  const page = colour(edition.tokens, "color-bg", { r: 255, g: 255, b: 255, a: 1 }) ?? { r: 255, g: 255, b: 255, a: 1 };

  for (const [fgName, bgName, minimum, label] of pairs) {
    const bgRaw = colour(edition.tokens, bgName, page);
    if (!bgRaw) continue;

    const fgRaw = colour(edition.tokens, fgName, page);
    if (!fgRaw) continue;

    // A translucent foreground is measured as it renders on that surface.
    const value = ratio(composite(fgRaw, bgRaw), bgRaw);
    const row = { edition: `${edition.theme} ${edition.mode}`, label, value, minimum, pass: value >= minimum };

    rows.push(row);
    if (!row.pass) failures.push(row);
  }
}

const showAll = process.argv.includes("--all");
const byEdition = new Map();
for (const row of showAll ? rows : failures) {
  if (!byEdition.has(row.edition)) byEdition.set(row.edition, []);
  byEdition.get(row.edition).push(row);
}

for (const [edition, list] of byEdition) {
  console.log(`\n${edition}`);
  for (const row of list) {
    console.log(`  ${row.pass ? "ok  " : "FAIL"} ${row.value.toFixed(2).padStart(5)} : 1  (min ${row.minimum})  ${row.label}`);
  }
}

console.log(`\n${new Set(rows.map((r) => r.edition)).size} editions, ${rows.length} pairings, ${failures.length} below threshold.`);
if (failures.length > 0) process.exitCode = 1;

