/**
 * Aspect bucket for a media box.
 *
 * The four values map to `[data-ratio]` rules in CSS. Computing them here rather than emitting
 * `aspect-ratio` inline is what keeps `style-src 'self'` viable - the grid, the inspector and
 * message attachments all share one vocabulary instead of three.
 */
export type RatioKey = "1x1" | "16x9" | "3x4" | "4x3";

export function ratioKey(width: number, height: number): RatioKey {
  if (width === height) return "1x1";
  if (width === 16 && height === 9) return "16x9";
  if (width === 3 && height === 4) return "3x4";
  return "4x3";
}
