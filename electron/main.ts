import { join } from "node:path";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  nativeTheme,
  protocol,
  session,
} from "electron";
import { Push } from "./channels";
import { registerHandlers } from "./handlers";
import { currentTheme, updaterStatus } from "./handlers/system";
import { startAutoUpdater } from "./updater";
import { runSmokeTest, seedSmokeSession } from "./smoke";
import {
  APP_SCHEME,
  APP_ORIGIN,
  createMainWindow,
  isTrusted,
  registerAppScheme,
  serveAppRequest,
} from "./window";
import type { PushName, PushPayload } from "../shared/contract";

/**
 * App lifecycle only. No domain logic, no file handling, no React knowledge.
 */

registerAppScheme();

function inviteCodeFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "aegis:" || url.hostname !== "invite") return null;
    const code = url.searchParams.get("code") ?? "";
    return /^[A-Za-z0-9_-]{43}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

function inviteUrl(code: string): string {
  const devServer = process.env.AEGIS_DEV_SERVER;
  const base = devServer ? `${devServer}/index.html` : `${APP_ORIGIN}/index.html`;
  return `${base}?invite=${encodeURIComponent(code)}`;
}

let pendingInviteCode =
  process.argv.map(inviteCodeFromUrl).find((code): code is string => code !== null) ?? null;

// The smoke run must exercise capture without a human clicking a permission prompt or owning a
// microphone. Chromium's fake device pair is the supported way to do that; it applies only to the
// smoke process, never to a normal launch.
if (process.env.AEGIS_SMOKE === "1") {
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  // Never clear or write the real profile's localStorage just because a test ran.
  app.setPath("userData", join(app.getPath("temp"), "aegis-smoke-profile"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    const code = commandLine
      .map(inviteCodeFromUrl)
      .find((entry): entry is string => entry !== null);
    if (code) pendingInviteCode = code;
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (code) {
      void win.loadURL(inviteUrl(code));
      pendingInviteCode = null;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    const code = inviteCodeFromUrl(url);
    if (!code) return;
    pendingInviteCode = code;
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      void win.loadURL(inviteUrl(code));
      pendingInviteCode = null;
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === "win32") {
      app.setAsDefaultProtocolClient(
        "aegis",
        process.execPath,
        app.isPackaged ? [] : [process.argv[1] ?? ""],
      );
    }
    protocol.handle(APP_SCHEME, serveAppRequest);
    registerHandlers(ipcMain);
    startAutoUpdater();
    configureMediaPermissions();

    // Theme is a shell fact with exactly one producer; one listener serves every window.
    nativeTheme.on("updated", () => {
      for (const win of BrowserWindow.getAllWindows()) send(win, Push.themeChanged, currentTheme());
    });

    // A smoke run must start from a clean profile: otherwise a server it saved last time is
    // already in the rail before it creates today's, and the run is no longer deterministic.
    if (process.env.AEGIS_SMOKE === "1") {
      await session.defaultSession.clearStorageData({ storages: ["localstorage"] });
    }

    /*
     * The packaged self-test has no backend process of its own, so it hosts the real HTTP
     * handlers in this process with the in-memory store. Port 8787 must match the renderer's
     * baked VITE_API_BASE_URL; refusing to start when it is taken is deliberate, because reusing
     * an already-running dev backend could point the smoke run at a real database.
     */
    let smokeToken = "";

    if (process.env.AEGIS_SMOKE === "1") {
      try {
        const { startSmokeBackend } = await import("../server/smoke");
        const smoke = await startSmokeBackend();
        smokeToken = smoke.token;
      } catch (error) {
        console.error("[aegis-smoke] backend failed to start", error);
        app.exit(1);
        return;
      }
    }

    const win = createMainWindow(pendingInviteCode ?? undefined);
    pendingInviteCode = null;
    wireShellPushes(win);

    if (process.env.AEGIS_SMOKE === "1") {
      if (smokeToken) await seedSmokeSession(win, smokeToken);
      await runSmokeTest(win);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) wireShellPushes(createMainWindow());
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

function send<K extends PushName>(win: BrowserWindow, name: K, payload: PushPayload<K>): void {
  if (win.isDestroyed()) return;
  win.webContents.send(name, payload);
}

function wireShellPushes(win: BrowserWindow): void {
  win.on("focus", () => send(win, Push.focusChanged, { focused: true }));
  win.on("blur", () => send(win, Push.focusChanged, { focused: false }));

  win.webContents.on("did-finish-load", () => {
    send(win, Push.themeChanged, currentTheme());
    send(win, Push.updaterStatus, updaterStatus());
    send(win, Push.focusChanged, { focused: win.isFocused() });
  });
}

/**
 * Media permissions, scoped to our own origin.
 *
 * Electron's default is not "prompt like a browser": a packaged app needs an explicit policy.
 * Only microphone/camera capture and display capture are granted, and only to the app:// page (or
 * the dev server when AEGIS_DEV_SERVER is set).
 *
 * `useSystemPicker` hands screen selection to Windows where it exists; the handler is the fallback
 * for platforms without a system picker, and prefers a full screen over a window so the first
 * share is never a thumbnail of the app itself.
 */
function configureMediaPermissions(): void {
  const allowed = new Set(["media", "display-capture"]);

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isTrusted(webContents.getURL()) && allowed.has(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return allowed.has(permission) && (requestingOrigin === "" || isTrusted(requestingOrigin));
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
        });
        const source = sources.find((entry) => entry.id.startsWith("screen:")) ?? sources[0];
        callback(source ? { video: source } : {});
      } catch {
        callback({});
      }
    },
    { useSystemPicker: true },
  );
}
