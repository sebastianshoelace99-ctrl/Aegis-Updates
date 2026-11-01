import { THEME_FONT_FAMILIES, type ThemeId } from "./registry";

/**
 * Make sure the destination theme's faces are decoded before the wipe starts.
 *
 * Only the two bundled Barlow families are ever loaded (ECHO-net and the three themes that borrow
 * its condensed display face); everything else is a system stack. The race means a slow or missing
 * font costs at most 600 ms and never blocks the switch - the wipe proceeds and the text swaps in.
 */
const TIMEOUT_MS = 600;

export async function ensureThemeFonts(theme: ThemeId): Promise<void> {
  const families = THEME_FONT_FAMILIES[theme];

  if (families.length === 0) return;
  if (typeof document === "undefined" || !("fonts" in document)) return;

  let timer = 0;

  const timeout = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, TIMEOUT_MS);
  });

  const load = Promise.all(
    families.map((family) =>
      document.fonts.load(`600 1em "${family}"`).catch(() => undefined),
    ),
  ).then(() => undefined);

  try {
    await Promise.race([load, timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}
