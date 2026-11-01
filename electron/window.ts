import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, net, protocol, shell } from "electron";

/**
 * Window + origin policy (docs/02 section 9).
 *
 * The renderer is served from a privileged custom scheme instead of `file://`. That is a
 * deliberate deviation from the document's snippet, and it is what makes the strict CSP in
 * index.html actually enforceable: `file://` has an opaque origin in Chromium, so
 * `script-src 'self'` there is unreliable (the classic blank-window failure).
 */

export const APP_SCHEME = "app";
export const APP_HOST = "bundle";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** dist/renderer, next to the bundled main.js */
export const RENDERER_DIR = join(__dirname, "renderer");

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/** Serves dist/renderer over app://bundle, refusing anything outside that directory. */
export function serveAppRequest(request: Request): Promise<Response> | Response {
  const url = new URL(request.url);
  if (url.host !== APP_HOST) return new Response("not found", { status: 404 });

  const pathname = decodeURIComponent(url.pathname);
  const resolved = normalize(join(RENDERER_DIR, pathname === "/" ? "/index.html" : pathname));

  if (resolved !== RENDERER_DIR && !resolved.startsWith(RENDERER_DIR + sep)) {
    return new Response("forbidden", { status: 403 });
  }
  return net.fetch(pathToFileURL(resolved).toString());
}

export function isTrusted(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST) return true;
    const devServer = process.env.AEGIS_DEV_SERVER;
    return Boolean(devServer) && url.startsWith(devServer as string);
  } catch {
    return false;
  }
}

export function createMainWindow(inviteCode?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b0d12",
    autoHideMenuBar: true,
    title: "Aegis Shield",
    webPreferences: {
      contextIsolation: true, // non-negotiable
      nodeIntegration: false, // non-negotiable
      sandbox: true, // renderer runs sandboxed; the preload is bundled so it needs no loader
      webSecurity: true,
      spellcheck: false,
      preload: join(__dirname, "preload.js"),
    },
  });

  // Navigation allowlist: nothing but our own origin may load in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrusted(url)) return { action: "allow" };
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrusted(url)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  win.once("ready-to-show", () => win.show());

  const devServer = process.env.AEGIS_DEV_SERVER;
  const query = inviteCode ? `?invite=${encodeURIComponent(inviteCode)}` : "";
  void win.loadURL(
    devServer
      ? `${devServer}/index.html${query}`
      : `${APP_ORIGIN}/index.html${query}`,
  );

  return win;
}
