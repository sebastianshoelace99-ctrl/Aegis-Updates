/**
 * Minimal stand-in for the `electron` module, used only by Vitest (see vitest.config.ts).
 *
 * The point of the alias is narrow: `electron/handlers/*.ts` must be importable in plain
 * Node so the contract test can check that every channel has a handler. Nothing here
 * emulates Electron - the functions throw if a test actually reaches them.
 */

export const dialog = {
  showOpenDialog: (): Promise<never> => {
    throw new Error("electron stub: showOpenDialog is not available in tests");
  },
  showSaveDialog: (): Promise<never> => {
    throw new Error("electron stub: showSaveDialog is not available in tests");
  },
};

export const shell = {
  showItemInFolder: (): void => {},
  openExternal: (): Promise<void> => Promise.resolve(),
};

export class BrowserWindow {
  static getFocusedWindow(): null {
    return null;
  }
}

export const nativeTheme = {
  themeSource: "system" as "system" | "light" | "dark",
  shouldUseDarkColors: false,
  on: (): void => {},
};

export const app = {
  getVersion: (): string => "0.0.0-test",
};

export const ipcMain = {
  handle: (): void => {
    throw new Error("electron stub: ipcMain.handle is not available in tests");
  },
};
