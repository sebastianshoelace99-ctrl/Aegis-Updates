/**
 * The scanline wipe.
 *
 * Primary path: the View Transitions API. The new edition is revealed behind the line with a
 * `clip-path` animation on `::view-transition-new(root)` (declared in effects.css, so no inline
 * style is created and `style-src 'self'` stays intact), while a fixed white bar is animated with
 * the Web Animations API on `transform` only. Both read the same duration and easing tokens, so the
 * bar sits exactly on the boundary for the whole run.
 *
 * Fallback: no `document.startViewTransition` (or it throws) means the edition is applied
 * immediately and the bar still sweeps - never a half-switched page.
 *
 * Reduced motion: no bar, instant switch.
 */

type Run = {
  line: HTMLDivElement;
  animation: Animation | null;
  transition: ViewTransitionHandle | null;
};

/**
 * Minimal local shape for the API. `lib.dom` in some TypeScript builds does not declare it yet,
 * and the app only needs three members - so the type lives here instead of depending on the lib.
 */
type ViewTransitionHandle = {
  readonly finished: Promise<void>;
  skipTransition: () => void;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionHandle;
};

let current: Run | null = null;

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function readTime(raw: string, fallbackMs: number): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return fallbackMs;
  return raw.trim().endsWith("ms") ? value : value * 1000;
}

function token(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function teardown(run: Run): void {
  run.animation?.cancel();
  run.line.remove();

  if (current === run) {
    current = null;
    document.documentElement.removeAttribute("data-scanline");
  }
}

/** Stop any run in flight. Safe to call when nothing is running. */
export function cancelScanline(): void {
  if (!current) return;

  const run = current;
  current = null;

  try {
    run.transition?.skipTransition();
  } catch {
    /* a transition that already finished cannot be skipped; teardown handles the rest */
  }

  teardown(run);
}

/**
 * Apply an edition change behind the wipe.
 *
 * `mutate` must be synchronous and must set the document attributes itself: inside a View
 * Transition it runs after the "before" snapshot has been taken, which is the only point at which
 * both editions exist at once.
 */
export function runScanline(mutate: () => void): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    mutate();
    return;
  }

  /*
   * Two switches, one behaviour: the OS preference (`prefers-reduced-motion`) and the app's own
   * Motion setting. Either one means "switch instantly, no line".
   */
  const motionOff =
    document.documentElement.dataset.motion === "reduced" || prefersReducedMotion();

  if (motionOff) {
    cancelScanline();
    mutate();
    return;
  }

  // A second request mid-wipe skips the first cleanly and starts from the state it left behind.
  cancelScanline();

  const root = document.documentElement;
  const line = document.createElement("div");
  line.className = "aegis-scanline";
  line.setAttribute("aria-hidden", "true");
  document.body.append(line);

  const run: Run = { line, animation: null, transition: null };
  current = run;

  const duration = readTime(token("--scanline-duration"), 1500);
  const easing = token("--scanline-ease") || "cubic-bezier(0.45, 0, 0.55, 1)";
  const height = line.getBoundingClientRect().height || 50;
  const travel = Math.max(0, window.innerHeight - height);

  const supportsViewTransition =
    typeof (document as ViewTransitionDocument).startViewTransition === "function";

  if (supportsViewTransition) {
    /*
     * Present before the transition starts so the pseudo-element rules match immediately. The bar
     * is moved by `::view-transition-group(aegis-scanline)` (effects.css), not by this animation:
     * during a transition the element itself is hidden and only its snapshot is visible.
     */
    root.setAttribute("data-scanline", "wipe");
  } else {
    // No View Transitions: sweep the real element over the edition that was just applied.
    run.animation = line.animate(
      [
        { transform: `translateY(${-height}px)` },
        { transform: `translateY(${travel}px)` },
      ],
      { duration, easing, fill: "forwards" },
    );
    run.animation.onfinish = () => teardown(run);
  }

  if (!supportsViewTransition) {
    // Instant switch, then the sweep plays over the new edition; `onfinish` removes it.
    try {
      mutate();
    } catch {
      teardown(run);
    }
    return;
  }

  try {
    const start = (document as ViewTransitionDocument).startViewTransition;
    if (!start) throw new Error("View Transitions unavailable");

    const transition = start.call(document, () => {
      mutate();
    });
    run.transition = transition;
    void transition.finished
      .catch(() => undefined)
      .finally(() => teardown(run));
  } catch {
    /*
     * A browser that advertises the API but refuses this document: fall back to a direct switch
     * plus the element sweep, so the user still sees a scanline instead of nothing.
     */
    root.removeAttribute("data-scanline");
    mutate();

    run.animation = line.animate(
      [
        { transform: `translateY(${-height}px)` },
        { transform: `translateY(${travel}px)` },
      ],
      { duration, easing, fill: "forwards" },
    );
    run.animation.onfinish = () => teardown(run);
  }
}
