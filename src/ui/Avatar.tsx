import type { Presence } from "../api/workspace";
import styles from "./Avatar.module.css";

/**
 * Initials avatar with an optional presence dot.
 *
 * The accent is an index into a palette in CSS, not a colour string. That is what keeps the
 * strict CSP honest: a `style` attribute would need `'unsafe-inline'` in `style-src`, which
 * this app does not have, so every per-instance visual difference is a `data-*` attribute.
 */

export type AvatarProps = {
  name: string;
  accent: number;
  size?: "sm" | "md" | "lg" | "xl";
  presence?: Presence | undefined;
  /** `--avatar-ring` lets the dot's ring match whatever surface it sits on. */
  showPresence?: boolean;
  /** Overrides the derived initials, for guild icons that are not a person's name. */
  label?: string;
  shape?: "circle" | "square";
  /** A stored data URL from the profile. Falls back to initials when absent. */
  image?: string | null;
  /**
   * Ring style index; 0 = none. Discord sells these as "avatar decorations".
   *
   * An index rather than a CSS value, so the stylesheet stays the only place that decides what a
   * ring looks like - and so the property can be `data-decoration` instead of a `style`.
   */
  decoration?: number;
};

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

export function Avatar({
  name,
  accent,
  size = "md",
  presence,
  showPresence = false,
  label,
  shape = "circle",
  image = null,
  decoration = 0,
}: AvatarProps): React.JSX.Element {
  return (
    <span
      className={styles.avatar}
      data-accent={accent % 8}
      data-size={size}
      data-shape={shape}
      data-image={image !== null}
      data-decoration={decoration % 7}
      aria-hidden="true"
      title={name}
    >
      {image ? <img className={styles.image} src={image} alt="" draggable={false} /> : (label ?? initials(name))}
      {showPresence ? (
        <span className={styles.dot} data-presence={presence ?? "offline"} />
      ) : null}
    </span>
  );
}
