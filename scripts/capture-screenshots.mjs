/**
 * Capture Cyberpunk-theme screenshots from a built Aegis Shield app.
 *
 * The app is driven over the Chrome DevTools Protocol rather than Playwright: no browser
 * download is needed, and this exercises the real renderer, preload and backend - the same code
 * path the packaged EXE uses.
 *
 * Usage:
 *   node scripts/capture-screenshots.mjs <exePath> <outDir>
 *
 * Environment:
 *   AEGIS_CDP_PORT   the port to open DevTools on (default 9333). Pick a free one: 9222 is
 *                    commonly taken by a browser.
 *
 * It signs in through the built-in "continue as the local dev account" link, so the build must
 * have VITE_AEGIS_SKIP_AUTH=1 and a loopback VITE_API_BASE_URL - the same pair the smoke test
 * and `npm run server` assume. The profile is left on Cyberpunk dark, where it was found.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXE = process.argv[2];
const OUT = process.argv[3];
const PORT = Number.parseInt(process.env.AEGIS_CDP_PORT ?? "9333", 10);
const WIDTH = 1440;
const HEIGHT = 900;

if (!EXE || !OUT) {
  console.error("usage: node scripts/capture-screenshots.mjs <exePath> <outDir>");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP client */

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();

    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
        else resolve(msg.result);
        return;
      }
      const listeners = this.events.get(msg.method);
      if (listeners) for (const fn of listeners.slice()) fn(msg.params);
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("cdp socket error")));
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const list = this.events.get(method) ?? [];
      const fn = (params) => {
        this.events.set(method, (this.events.get(method) ?? []).filter((f) => f !== fn));
        resolve(params);
      };
      list.push(fn);
      this.events.set(method, list);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/* ----------------------------------------------------------------- app control */

async function httpJson(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function findAppTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`, 1);
      const page = list.find((t) => t.type === "page" && t.url.startsWith("app://"));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* keep polling */
    }
    await sleep(500);
  }
  throw new Error("no app:// page target appeared");
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value;
}

/** Poll until the expression returns a truthy value. */
async function waitFor(cdp, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, `(() => { try { return !!(${expression}); } catch (e) { return false; } })()`);
    if (value) return true;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function shoot(cdp, name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`wrote ${file}`);
}

async function click(cdp, selector) {
  const ok = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
  if (!ok) throw new Error(`selector not found: ${selector}`);
}

/**
 * Enter the workspace through the built-in dev-skip link.
 *
 * The flag is baked into the build and the link only renders for a loopback backend, so this
 * exercises the ordinary signed-in path rather than a private back door.
 */
async function signIn(cdp) {
  await waitFor(cdp, `document.querySelector('[data-testid="dev-skip"]')`, "dev-skip link");
  const ok = await evaluate(
    cdp,
    `(() => {
      const host = document.querySelector('[data-testid="dev-skip"]');
      const btn = host && host.querySelector("button");
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
  );
  if (!ok) throw new Error("the dev-skip link is not present in this build");
}


/* ----------------------------------------------------------------------- main */

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[app] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[app] ${d}`));

  let cdp = null;
  const shots = [];

  try {
    const target = await findAppTarget();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    /*
     * Pin the viewport to the window's full size. Without this the capture is the content area
     * (1424x861 on a 1440x900 window), which is smaller than the reference screenshots and makes
     * a pixel comparison meaningless.
     */
    const metrics = await cdp.send("Page.getLayoutMetrics").catch(() => null);
    if (metrics?.cssVisualViewport) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(600);
    }

    /* 1. Force the Cyberpunk edition in dark mode, then reload so theme-boot.js picks it up. */
    await evaluate(
      cdp,
      `(() => {
        localStorage.setItem("aegis.theme.v1", "cyberpunk");
        localStorage.setItem("aegis.mode.v1", "dark");
        /* A token left over from an earlier run would restore that session instead of
           showing the sign-in screen, so the capture starts from a signed-out profile. */
        localStorage.removeItem("aegis.auth.token.v1");
        localStorage.removeItem("aegis.auth.bypass.v1");
        return true;
      })()`,
    );
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.reload");
    await loaded;
    await sleep(1200);

    const themeAttr = await evaluate(cdp, `document.documentElement.getAttribute("data-theme")`);
    const modeAttr = await evaluate(cdp, `document.documentElement.getAttribute("data-mode")`);
    console.log(`theme=${themeAttr} mode=${modeAttr}`);
    if (themeAttr !== "cyberpunk") throw new Error(`theme did not apply (got ${themeAttr})`);

    /* 2. The sign-in screen, in the Cyberpunk edition. */
    try {
      await waitFor(cdp, `document.querySelector('[data-testid="auth-screen"]')`, "login screen");
    } catch (error) {
      const state = await evaluate(
        cdp,
        `JSON.stringify({
          url: location.href,
          theme: document.documentElement.getAttribute("data-theme"),
          bodyText: (document.body?.innerText || "").slice(0, 600),
          testIds: [...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")).slice(0, 30),
          storage: Object.keys(localStorage),
        })`,
      );
      console.error(`page state:\n${state}`);
      throw error;
    }
    await sleep(500);
    await shoot(cdp, "cyberpunk-dark-login");
    shots.push("cyberpunk-dark-login");

    /* 3. Sign in through the built-in dev-skip link (baked flag, loopback backend only). */
    await signIn(cdp);
    await waitFor(cdp, `document.querySelector('[data-testid="guild-rail"]')`, "workspace rail");
    await waitFor(cdp, `document.querySelector('[data-testid="message-feed"]')`, "message feed");
    await sleep(1500);
    await shoot(cdp, "cyberpunk-dark-workspace");
    shots.push("cyberpunk-dark-workspace");

    /* 4. The theme picker, open on Cyberpunk. */
    await click(cdp, '[data-testid="open-theme-menu"]');
    await waitFor(cdp, `document.querySelector('[data-testid="theme-menu"]')`, "theme menu");
    await sleep(500);
    await shoot(cdp, "cyberpunk-dark-theme-menu");
    shots.push("cyberpunk-dark-theme-menu");

    /* The trigger is a toggle, so clicking it again is the way the popover closes. */
    await click(cdp, '[data-testid="open-theme-menu"]');
    await waitFor(cdp, `!document.querySelector('[data-testid="theme-menu"]')`, "theme menu to close");
    await sleep(400);

    /* 5. Settings, in the Cyberpunk edition. */
    await click(cdp, '[data-testid="open-settings"]');
    await waitFor(cdp, `document.querySelector('[data-testid="settings-modal"]')`, "settings modal");
    await sleep(700);
    await shoot(cdp, "cyberpunk-dark-settings");
    shots.push("cyberpunk-dark-settings");

    /* 6. The appearance tab, where the theme and the accent live. */
    await click(cdp, '[data-testid="settings-tab-appearance"]');
    await sleep(600);
    await shoot(cdp, "cyberpunk-dark-appearance");
    shots.push("cyberpunk-dark-appearance");
    await evaluate(cdp, `document.querySelector('[data-testid="settings-modal"] button[aria-label="Close settings"]')?.click(), true`);
    await sleep(500);

    /* 7. The light edition, switched through the real mode control. */
    await click(cdp, '[data-testid="open-theme-menu"]');
    await waitFor(cdp, `document.querySelector('[data-testid="theme-menu"]')`, "theme menu");
    await click(cdp, '[data-testid="mode-option-light"]');
    await sleep(900);
    await click(cdp, '[data-testid="open-theme-menu"]');
    await sleep(600);

    const lightMode = await evaluate(cdp, `document.documentElement.getAttribute("data-mode")`);
    const lightTheme = await evaluate(cdp, `document.documentElement.getAttribute("data-theme")`);
    console.log(`light pass: theme=${lightTheme} mode=${lightMode}`);
    await shoot(cdp, "cyberpunk-light-workspace");
    shots.push("cyberpunk-light-workspace");

    /* 8. Leave the profile on Cyberpunk dark, the way it was found. */
    await click(cdp, '[data-testid="open-theme-menu"]');
    await waitFor(cdp, `document.querySelector('[data-testid="theme-menu"]')`, "theme menu");
    await click(cdp, '[data-testid="mode-option-dark"]');
    await sleep(900);
    await click(cdp, '[data-testid="open-theme-menu"]');
    await sleep(500);

    const restoredMode = await evaluate(cdp, `document.documentElement.getAttribute("data-mode")`);
    console.log(`restored mode=${restoredMode}`);

    console.log(`captured ${shots.length} screenshots: ${shots.join(", ")}`);
  } finally {
    cdp?.close();
    child.kill();
    await sleep(800);
    if (!child.killed) child.kill("SIGKILL");
  }
}

main().catch((error) => {
  console.error(`capture failed: ${error.message}`);
  process.exit(1);
});
