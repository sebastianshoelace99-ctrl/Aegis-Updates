import { useEffect, useLayoutEffect } from "react";
import { useSettingsStore } from "../state/settingsStore";
import { applyAccent } from "../theme/accent";

/**
 * Applies the *personalization* half of the settings document to `<html>`: accent colour, density,
 * message size, display face, motion and texture.
 *
 * Theme and mode are deliberately absent. They are owned by `src/theme/store.ts`, because a change
 * has to happen inside a View Transition callback - a React effect would land one frame later and
 * fight the wipe. Everything here is a `data-*` attribute read by the stylesheets (plus the accent's
 * seven custom properties), so there is no inline style attribute and `style-src 'self'` stays intact.
 *
 * It lives in a hook rather than in `App` because the login screen renders before the workspace:
 * both need the signed-in user's density, and neither owns the other.
 */
export function useAppearance(): void {
  const appearance = useSettingsStore((state) => state.appearance);

  /*
   * A layout effect, not an effect: the accent is derived from the edition's page colour, and doing
   * it after the browser has painted would show the old accent for one frame on every launch.
   */
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.density = appearance.density;
    root.dataset.messageSize = appearance.messageSize;
    root.dataset.font = appearance.font;
    root.dataset.motion = appearance.motion;
    root.dataset.texture = appearance.texture;
    applyAccent(root, appearance.accent, appearance.tint);
  }, [appearance]);

  /*
   * The accent's readable shade is measured against the page it sits on, so it has to be re-measured
   * whenever the edition attributes move - and they move from inside a View Transition callback, not
   * through React. `public/theme-boot.js` writes them before this hook exists, which is why the
   * initial pass above is not enough on its own.
   *
   * MutationObserver callbacks are microtasks: the new values are in place before the browser
   * captures the frame, so a theme switch never paints a half-recoloured accent.
   */
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const { accent, tint } = useSettingsStore.getState().appearance;
      applyAccent(root, accent, tint);
    });

    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-mode"] });
    return () => observer.disconnect();
  }, []);
}

