import { nativeTheme } from "electron";
import type { PushPayload } from "../../shared/contract";
import { currentUpdaterStatus } from "../updater";

/**
 * Shell-owned facts that the renderer mirrors (P2). These are read by main and pushed;
 * they are deliberately NOT request/response channels, because a renderer that has to ask
 * "am I focused?" is a renderer that will get the answer wrong under load.
 */

export type ThemeSource = "system" | "light" | "dark";

export function currentTheme(): PushPayload<"system:themeChanged"> {
  return { theme: nativeTheme.shouldUseDarkColors ? "dark" : "light" };
}

export function setThemeSource(source: ThemeSource): void {
  nativeTheme.themeSource = source;
}

export function updaterStatus(): PushPayload<"system:updaterStatus"> {
  return currentUpdaterStatus();
}
