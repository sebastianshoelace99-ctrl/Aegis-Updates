import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { Push } from "../shared/channels";
import type { PushPayload } from "../shared/contract";

const initialStatus: PushPayload<"system:updaterStatus"> = {
  state: "idle",
  version: app.getVersion(),
};

let status = initialStatus;
let configured = false;
let enabled = false;

export function currentUpdaterStatus(): PushPayload<"system:updaterStatus"> {
  return status;
}

function publish(next: PushPayload<"system:updaterStatus">): void {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(Push.updaterStatus, status);
  }
}

function reportUpdaterError(error: Error): void {
  console.error("[updater] update operation failed", error);
  publish({
    state: "error",
    version: app.getVersion(),
    message: "Aegis Shield couldn't complete the update. Check your connection and try again.",
  });
}

export function startAutoUpdater(): void {
  if (configured) return;
  configured = true;

  enabled =
    app.isPackaged &&
    process.platform === "win32" &&
    !process.env.PORTABLE_EXECUTABLE_DIR &&
    process.env.AEGIS_SMOKE !== "1";
  if (!enabled) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => {
    publish({ state: "checking", version: app.getVersion() });
  });
  autoUpdater.on("update-available", (info) => {
    publish({ state: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", () => {
    publish({ state: "idle", version: app.getVersion() });
  });
  autoUpdater.on("download-progress", ({ percent }) => {
    publish({
      state: "downloading",
      version: status.version,
      percent: Math.min(100, Math.max(0, Math.round(percent))),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    publish({ state: "ready", version: info.version });
  });
  autoUpdater.on("error", reportUpdaterError);

  const check = (): void => {
    void checkForUpdates();
  };
  setTimeout(check, 10_000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

export async function checkForUpdates(): Promise<void> {
  if (!enabled) throw new Error("Automatic updates are available only in the installed Windows app.");
  if (status.state === "ready") return;

  publish({ state: "checking", version: app.getVersion() });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    reportUpdaterError(error instanceof Error ? error : new Error(String(error)));
  }
}

export function installUpdate(): void {
  if (!enabled || status.state !== "ready") {
    throw new Error("There is no downloaded update ready to install.");
  }

  autoUpdater.quitAndInstall(false, true);
}
