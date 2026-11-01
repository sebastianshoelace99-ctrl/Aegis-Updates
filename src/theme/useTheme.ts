import { useEffect } from "react";
import { useThemeStore } from "./store";

/**
 * Reads the theme store and keeps System mode honest.
 *
 * The media listener is registered once, from the component that always exists (the auth gate), so
 * an OS light/dark change while the app is open plays the same wipe as a manual switch. Reduced
 * motion is handled inside `runScanline`, which then swaps instantly.
 */
export function useTheme(): {
  theme: ReturnType<typeof useThemeStore.getState>["theme"];
  mode: ReturnType<typeof useThemeStore.getState>["mode"];
  resolved: ReturnType<typeof useThemeStore.getState>["resolved"];
  setTheme: ReturnType<typeof useThemeStore.getState>["setTheme"];
  setMode: ReturnType<typeof useThemeStore.getState>["setMode"];
  toggleMode: ReturnType<typeof useThemeStore.getState>["toggleMode"];
} {
  const theme = useThemeStore((state) => state.theme);
  const mode = useThemeStore((state) => state.mode);
  const resolved = useThemeStore((state) => state.resolved);
  const setTheme = useThemeStore((state) => state.setTheme);
  const setMode = useThemeStore((state) => state.setMode);
  const toggleMode = useThemeStore((state) => state.toggleMode);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => useThemeStore.getState().syncSystem();

    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return { theme, mode, resolved, setTheme, setMode, toggleMode };
}
