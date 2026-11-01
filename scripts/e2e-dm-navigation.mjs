/**
 * End-to-end check for the DM/server navigation regression.
 *
 * The bug: clicking a DM contact left the app unable to select a server again. The hash is a
 * mirror of the store, written a render late, so a hash-to-store effect that trusted it would
 * pull the reader straight back into the DM they had just left.
 *
 * This drives the real renderer over CDP: sign in, open a DM, then click a server, and assert
 * that the server view is what stays on screen.
 *
 * Usage: node scripts/e2e-dm-navigation.mjs
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const PORT = Number.parseInt(process.env.AEGIS_CDP_PORT ?? "9334", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP client */

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();

    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
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
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 30_000);
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

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => { try { return (${expression}); } catch (e) { return { __error: String(e) }; } })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value;
}

/** Poll until the expression is truthy. The expression must be a boolean, not a DOM node. */
async function waitFor(cdp, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, `!!(${expression})`);
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function click(cdp, selector) {
  const ok = await evaluate(
    cdp,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
  );
  if (!ok) throw new Error(`selector not found: ${selector}`);
}

/* ------------------------------------------------------------------ the check */

let failures = 0;

function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(
      `  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`,
    );
  }
}

/** True when the rail shows a server as the active one. */
const SERVER_ACTIVE = `(() => {
  const rows = [...document.querySelectorAll('[data-testid="guild-row"]')];
  return rows.some((r) => r.getAttribute('data-active') === 'true');
})()`;

async function main() {
  /*
   * The app is launched *without* AEGIS_SMOKE=1 on purpose: that mode hosts its own backend on
   * port 8787 and would fight any backend already running there. This run talks to the backend
   * the renderer was built against, so the seed data can be prepared first.
   */
  const child = spawn(electronPath, [".", `--remote-debugging-port=${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AEGIS_SMOKE: "0" },
  });
  child.stdout.on("data", (d) => process.stdout.write(`[app] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`[app] ${d}`));

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`, 1);
        target = list.find((t) => t.type === "page" && t.url.startsWith("app://"));
      } catch {
        /* keep polling */
      }
      if (!target) await sleep(500);
    }
    if (!target) throw new Error("no app:// page target appeared");

    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Runtime.enable");

    // Sign in through the built-in dev-skip link.
    await waitFor(cdp, `document.querySelector('[data-testid="dev-skip"] button')`, "the dev sign-in link");
    await click(cdp, '[data-testid="dev-skip"] button');

    // The workspace shell, with a server in the rail.
    try {
      await waitFor(cdp, `document.querySelector('[data-testid="guild-row"]')`, "the guild rail", 25_000);
    } catch (error) {
      const body = await evaluate(cdp, "document.body.innerText.slice(0, 600)");
      throw new Error(`${error.message}\n--- page text ---\n${body}`);
    }

    console.log("\nDM -> server navigation");

    // 1. Open the DM space and a conversation in it.
    await click(cdp, '[data-testid="home-button"]');
    await waitFor(cdp, `document.querySelector('[data-testid="dm-row"]')`, "a DM contact");
    await click(cdp, '[data-testid="dm-row"]');
    await waitFor(cdp, `location.hash.startsWith('#/@me/')`, "the DM hash");
    console.log(`  (opened DM at ${await evaluate(cdp, "location.hash")})`);

    // 2. Now click a server. This is the step that used to be impossible.
    await click(cdp, '[data-testid="guild-row"]');
    await sleep(1_500);

    const afterHash = await evaluate(cdp, "location.hash");
    const onServer = await evaluate(cdp, SERVER_ACTIVE);
    const dmStillOpen = await evaluate(
      cdp,
      `document.querySelector('[data-testid="dm-empty"]') !== null`,
    );

    check("the hash names a server, not the DM", afterHash.startsWith("#/@me"), false);
    check("the server is the active row in the rail", onServer, true);
    check("the DM space is no longer the open view", dmStillOpen, false);

    // 3. And the server view is what is actually on screen.
    const heading = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('[data-testid="channel-name"]');
        return el ? el.textContent : null;
      })()`,
    );
    check("a server channel is rendered", typeof heading === "string" && heading.length > 0, true);

    // 4. A second server click must work too - the old bug latched permanently.
    await click(cdp, '[data-testid="guild-row"]');
    await sleep(1_000);
    check("the server stays selected after another click", await evaluate(cdp, SERVER_ACTIVE), true);

    cdp.close();
  } finally {
    child.kill();
  }

  console.log(failures === 0 ? "\ne2e: PASS" : `\ne2e: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`e2e: ${error.message}`);
  process.exit(1);
});
