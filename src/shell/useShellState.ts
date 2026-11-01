import { create } from "zustand";
import type { PushPayload } from "../../shared/contract";
import { bridge, hasShell } from "../bridge/client";

/**
 * The shell mirror (P2). Fed exclusively by pushes; nothing here is fetched or polled.
 * Selector-based reads keep a focus change from re-rendering the gallery.
 */

export type Theme = "light" | "dark";

export type ShellState = {
  focused: boolean;
  theme: Theme;
  updater: PushPayload<"system:updaterStatus">;
  /** Static, not pushed: which implementation of the bridge this renderer is running on. */
  runtime: "shell" | "browser";
};

export const useShellState = create<ShellState>(() => ({
  focused: true,
  theme: "light",
  updater: { state: "idle" },
  runtime: hasShell ? "shell" : "browser",
}));

/** Call once, at the app entry - not inside a component. Returns the unsubscribe. */
export function initShellSync(): () => void {
  if (!hasShell) return () => {};

  const set = useShellState.setState;
  const offs = [
    bridge.subscribe("window:focusChanged", ({ focused }) => set({ focused })),
    bridge.subscribe("system:themeChanged", ({ theme }) => set({ theme })),
    bridge.subscribe("system:updaterStatus", (updater) => set({ updater })),
  ];
  return () => offs.forEach((off) => off());
}
