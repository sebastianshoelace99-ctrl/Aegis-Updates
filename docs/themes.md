# Themes and modes

Nine themes, each with a light and a dark edition: eighteen editions in total. Theme and mode are
separate choices - picking Synthwave while in dark mode gives Synthwave Dark - and both persist.

| id | display name | identity |
| --- | --- | --- |
| `default` | Default | Neutral messenger: one blue, hairlines, system type, no texture |
| `echo-net` | ECHO-net | The original look: chamfered plates, gold, Barlow Condensed italic |
| `mil-sim` | Mil-Sim | Field-manual matte, mono labels, olive/tan, hazard orange |
| `cyberpunk` | Cyberpunk | Chamfered HUD, cold tactical terminal: slate plates, mint status lights, scanlines |
| `synthwave` | Synthwave | Neon sunset, striped sun, receding grid |
| `retro` | Retro | Frutiger Aero glass, gloss, sky gradients, bubbles |
| `neo-industrialist` | Neo-Industrialist | Raw concrete, thick black borders, rust and safety yellow |
| `cassette-futurism` | Cassette Futurism | Bone plastic, mono silkscreen labels, phosphor glow, tape reel |
| `neo-brutalism` | Neo-Brutalism | Flat poster colour, 3px black rules, hard offset shadows |

Default is the first-visit edition; mode defaults to System and follows `prefers-color-scheme`
live. A saved choice always wins. The pre-paint resolution lives in `public/theme-boot.js` (a
blocking classic script - the CSP has no `unsafe-inline`, so an inline snippet would need a hash).

## Where things live

```
src/theme/
  index.css              load order: base, contract, themes, effects
  base.css               fallback edition, mode-shared palettes, transition tokens
  contract.css           canonical --color-* / --shape-* / --type-* / --fx-* -> short names
  themes/<id>.css        one file per theme: shared block, then one block per mode
  effects.css            textures, gloss, gradient headings, scanline wipe, View Transitions
  registry.ts            ids, labels, font families per theme
  accent.ts              one seed colour -> the seven measured values the accent family needs
  storage.ts             aegis.theme.v1 / aegis.mode.v1 (+ migration from appearance.theme)
  apply.ts               writes data-theme / data-mode and <meta name="theme-color">
  store.ts               the only owner of theme + mode; runs the wipe on change
  transition.ts          the scanline wipe (View Transitions + fallback)
  ThemePicker.tsx        theme cards + Light/Dark/System control (dock + Settings)
```

Components keep reading the short names they always used (`--bg`, `--line`, `--accent`, `--gold`,
`--clip-card`); `contract.css` is the only translation layer. New code should prefer the canonical
names documented there.

## Message bubbles

Message text always renders inside the `.bubble` wrapper in
`src/features/chat/MessageFeed.module.css`; the theme decides what that wrapper looks like. Its
identity comes from four token pairs in `contract.css`:

- `--shape-bubble-radius`, `--shape-bubble-radius-tail`, `--shape-bubble-pad` - shape and size. A
  theme that does not want bubbles sets the padding and both radii to zero (ECHO-net, Mil-Sim,
  Cyberpunk, Neo-Industrialist), so the wrapper stays layout-transparent.
- `--color-bubble-sent` / `--color-bubble-received` and their `-text` inks - the fills. These are
  the values `npm run check:contrast` measures.
- `--fx-bubble-gloss` / `--fx-bubble-gloss-self` - an optional `background-image` layer (Retro's
  wet highlight). It is a separate layer on purpose: the fill underneath keeps its checked
  contrast value.
- `--fx-bubble-shadow` / `--fx-bubble-shadow-self` - an optional `box-shadow` for the glass rim,
  inner shading and drop shadow.

`--shape-bubble-align` moves only a self-authored bubble to the opposite edge (`auto`); `0` keeps
every message on the left gutter. Received bubbles always stay next to the avatar.

## Text fields

Text boxes follow two shape tokens instead of borrowing the card radius, so an edition can round
them independently of its panels:

- `--shape-field-radius` - single-line controls (`<input>`, `<select>`).
- `--shape-field-radius-multi` - wrapped controls (the settings `<textarea>` and the composer),
  where a full pill would push the first line onto the curve.

Both default to the edition's existing small radius and `--radius` respectively, which is why the
angular themes stay angular. Retro sets the first to `--shape-radius-pill` and the second to `24px`:
capsules for one-liners, fat glass corners for anything that wraps. `contract.css` exposes them to
components as `--field-radius` and `--field-radius-multi`.

Two details worth keeping if you add a field: the composer is a wrapped field, so `.box` in
`Composer.module.css` reads the multi value, and the password reveal button in
`AuthScreen.module.css` takes the field's right cap (`0 var(--field-radius) var(--field-radius) 0`)
so it never draws a square corner inside a capsule.

## Accent colour

Every edition can be repainted without touching its file. `appearance.accent` names a hue - `theme`
(the edition's own, the default), `gold`, `crimson`, `emerald`, `cyan`, `violet` or `rose` - and
`appearance.tint` holds a validated `#rrggbb` when the person used the picker.

The split matters: the six named hues are the family ECHO-net introduced and a name survives a
stylesheet change, while a hex survives a picker that produces a colour nobody anticipated.

Five values are derived from the seed, because a stylesheet cannot measure contrast:

| value | used for | rule |
| --- | --- | --- |
| `--accent-seed` | fills: tabs, counters, indicators, selection | the hue itself, with `--accent-seed-ink` (black or white whichever measures better) |
| `--accent-strong` | text and outlines: links, active labels, focus rings | the hue pushed towards black or white until it clears **4.5:1** on the edition's `--color-bg` |
| `--accent-strong-hover` | hover/pressed states | the same, with a light/dark bias |
| `--accent-dim` | the muted accent: `--gold-dim`, roughly forty text sites | the hue pulled towards the page, then walked back only as far as **4.5:1** requires |
| `--accent-tab-hot` | the tab block's hover fill, under `--tab-ink` | the seed moved *away* from its own ink, so hovering can only raise the ratio |

`src/theme/accent.ts` owns that maths and `tokens.css` composes everything else from the seven
custom properties it writes. Three consequences worth knowing:

- The deep shade is measured against *the current page*, so it is re-derived when `data-theme` or
  `data-mode` changes. `useAppearance` watches both attributes, because a theme switch writes them
  from inside a View Transition callback rather than through React.
- `[data-accent]` is written **after** the variables. The override block only matches when the
  attribute is present, so there is never a frame where a rule reads a seed that does not exist.
- The hover fill moves away from the tab's ink rather than always towards white: a white label on a
  lightened fill is exactly the case a fixed rule gets wrong.

Only the accent family moves. Borders, surfaces and danger stay the edition's own - with one
deliberate exception, ECHO-net, whose hairlines are part of "one accent, everything derived from it"
and which opts into a tinted border in the same block.

## Adding a theme

1. Add an entry to `THEMES` in `src/theme/registry.ts` (id in kebab-case, display label, blurb) and
   its font families in `THEME_FONT_FAMILIES`.
2. Create `src/theme/themes/<id>.css` with **three** blocks:
   - `[data-theme="<id>"]` - everything shared by both editions: fonts, heading treatment, radius,
     border width, clip shapes, shadows, bubble shape, effect tokens.
   - `[data-theme="<id>"][data-mode="light"]` - `color-scheme: light` plus every `--color-*`.
   - `[data-theme="<id>"][data-mode="dark"]` - `color-scheme: dark` plus every `--color-*`.
   Both editions are required: the mode control is per-theme, and a missing block falls back to the
   Default edition's tokens, which is a visible bug rather than a graceful degradation.
3. Import the file in `src/theme/index.css` and add the id to the list in `public/theme-boot.js`,
   which resolves the saved edition before the first paint.
4. Run `npm run check:contrast` - it parses the theme files and fails below AA (4.5:1 body, 3:1 UI).
5. If the theme needs a raster/vector backdrop, add it as an inline SVG data URI on
   `--fx-texture-emblem` (or `--fx-backdrop` for a page-wide wash) so it costs one background layer.
   A page-wide wash also needs `--shell-bg: transparent`, or the shell paints over it.

## Accessibility notes

- Every edition is checked by `npm run check:contrast` (322 pairings). The script composites
  translucent tokens over their own surface, which is what the Retro glass needs.
- A user-chosen accent cannot be checked ahead of time, so it is measured at runtime instead: the
  text shade is moved until it reaches 4.5:1 on the page, and the fill's ink is whichever of black
  and white measures better. The minimum possible maximum is ~4.58:1, so a label always reads.
- Chamfered themes use an inner focus ring (`--focus-offset: -3px`); a normal outline would be cut
  off by `clip-path`.
- The wipe is skipped entirely under `prefers-reduced-motion`, and every change is announced in a
  polite live region (`ThemeLiveRegion`) because the visual effect is invisible to a screen reader.
- The scanline is `aria-hidden` and never focusable; `data-scanline-exempt` keeps the appearance
  controls usable while the rest of the page is inert.

## Testing affordances

- Mute and deafen work outside a call: they are preferences that survive leaving voice, and they
  are applied to the microphone tracks when a call starts.
- `src/theme/accent.test.ts` covers the contrast maths directly: parse/normalise, ink selection,
  the push to 4.5:1 on both a paper and a night page, and the guarantee across all six named hues.
