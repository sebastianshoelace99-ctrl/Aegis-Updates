import { useThemeStore } from "./store";

/**
 * The accessible half of the theme change.
 *
 * A visual wipe is invisible to a screen reader, so the store publishes a sentence and this polite
 * live region speaks it. `.sr-only` keeps it out of the layout; the node is present from first
 * paint, because a live region that mounts with its text does not reliably announce.
 */
export function ThemeLiveRegion(): React.JSX.Element {
  const announcement = useThemeStore((state) => state.announcement);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="theme-live">
      {announcement?.text ?? ""}
    </div>
  );
}
