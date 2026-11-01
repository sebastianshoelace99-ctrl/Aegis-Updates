# Discord Desktop 1.0.9263 — Static Reverse-Engineering Report

**Target** Discord Desktop `1.0.9263`, `stable` channel, Win32 x64, Electron `42.7.1`
**Method** Static, read-only. ASAR inventory + extraction, source scanning, PE fuse reading. No
process attachment, no debugger, no network interception.
**Date** 2026-10-20

Every claim below is tagged **[SEEN]** (directly observed in an artifact) or **[INFERRED]**
(reasoned from what was seen). Numbers are reproducible — see `03-evidence-index.md`.

---

## 1. The headline finding

**Discord's UI is not shipped in either ASAR.** There is no React component tree, no store
layer, no CSS-in-JS bundle to read.

The renderer is fetched over HTTPS at launch. `core.asar` → `bundle.js`:

```js
exports.WEBAPP_ENDPOINT = function () {
  return `https://${buildInfo.releaseChannel}.discord.com`;
}();

let WEBAPP_PATH = function () {
  let explicitSetting = settings?.get("WEBAPP_PATH", null);
  if (null != explicitSetting) return explicitSetting;
  let isConferenceModeEnabled = settings?.get("enableConferenceMode", !1);
  return `${isConferenceModeEnabled
    ? Constants_1.WEBAPP_PATHS.CONFERENCE_MODE
    : Constants_1.WEBAPP_PATHS.APP}?_=${Date.now()}`;
}(),
URL_TO_LOAD = `${exports.WEBAPP_ENDPOINT}${WEBAPP_PATH}`;

function loadMainPage() {
  performance.mark("mainscreen-loadmainpage"),
  ...
  mainWindow?.loadURL(URL_TO_LOAD),
  setTimeout(() => {
    if (!webAppLoaded && .05 > Math.random()) {
      let sentry = ...getGlobalSentry();
      sentry?.captureMessage("WebApp timed out loading (timeout=60s)");
    }
  }, 6e4)
}
```

**[SEEN]** — one `loadURL` call in the whole core bundle; `build_info.json` reports
`releaseChannel: "stable"`, so the effective origin is `https://stable.discord.com` plus the
app path and a cache-busting `?_=<epoch>`.

Three consequences worth internalising:

1. The desktop client is a **shell**: window, tray, updater, voice, keybinds, notifications.
   Everything you think of as "Discord the app" is delivered by the web tier.
2. `WEBAPP_PATH` is overridable by a settings key — the client is designed to be repointed at
   a different web app build without a code change. **[SEEN]** for the override;
   **[INFERRED]** that this exists for internal/staging builds.
3. `?_=Date.now()` on every launch means the shell has no expectation of a cached renderer.
   Cold start is a network round trip, and the 60 s watchdog tolerates that.

### Token counts across both shells

| Token | `mainScreenPreload.js` (1.1 MB) | `core.asar/bundle.js` (439 KB) |
| --- | --- | --- |
| `react-dom` | 0 | 0 |
| `Gateway` | 0 | — |
| `FluxDispatcher` | 0 | — |
| `MessageStore` | 0 | — |
| `useState` | 6 | — |
| `WebSocket` | 2 | — |
| `ipcMain.handle` | — | 21 |
| `ipcMain.on` | — | 15 |
| `BrowserWindow` | — | 22 |

**[SEEN]** The six `useState` and two `WebSocket` hits are Sentry's embedded feedback widget and
Crashpad transport, not application state or the Discord gateway. Verified by reading the
surrounding context, not by counting alone.

**[INFERRED]** Therefore: any architecture advice that starts with "how Discord structures its
Flux stores" cannot be sourced from this install. What *is* fully legible is the **shell
contract** — how a privileged native layer is exposed to an untrusted renderer. That is the
part worth copying, and it is the part the next document uses.

---

## 2. Layer map

```
Discord.exe  (219.7 MB, Electron 42.7.1)   [SEEN]
│
├── resources\app.asar  (3.64 MB)  pkg "discord" — BOOTSTRAPPER   [SEEN]
│   ├── bundle.js            3,076,973 B   Squirrel install/update, module staging,
│   │                                     launch handoff, crash handling
│   ├── splashScreenPreload.js  12,516 B   vanilla DOM splash driver
│   ├── splash\index.html           198 B   198 bytes of markup
│   ├── splash\index.css          5,859 B
│   ├── splash\*.webm / *.webp           connecting animation
│   ├── splash\ggsans-*.woff2            brand fonts
│   └── data\quotes_copy.json       410 B
│
├── modules\discord_desktop_core-1\discord_desktop_core\      [SEEN]
│   ├── index.js                  42 B   module.exports = require('./core.asar')
│   ├── core.asar          1,832,667 B   pkg "discord_desktop_core" — DESKTOP CORE
│   │   ├── bundle.js            439,665 B   windows, tray, keybinds, IPC handlers
│   │   ├── mainScreenPreload.js  1,116,629 B  THE BRIDGE
│   │   ├── frameViewPreload.js     21,149 B   embedded-frame preload
│   │   └── data\{cacert.pem, riotgames.pem}
│   └── app\images\{systemtray,thumbar,badges}\   per-platform tray art
│
└── modules\<16 other native packages>\        [SEEN]
```

**[SEEN]** `resources\bootstrap\manifest.json` pins eight module names to version `0` —
`discord_desktop_core`, `discord_erlpack`, `discord_notifications`, `discord_premap`,
`discord_spellcheck`, `discord_utils`, `discord_voice`, `discord_zstd`. That is the bootstrapper
declaring the minimum module set it will accept before launching the core.

**[INFERRED]** The split is deliberate: the bootstrapper must be able to run before the core
exists (it is what installs the core), so it cannot depend on core code. Two separate Squirrel
payloads, two separate crash surfaces, two separate Sentry scopes.

---

## 3. The bridge — the only interesting design here

**[SEEN]** `mainScreenPreload.js` contains exactly **one** `contextBridge.exposeInMainWorld`
call, publishing an object named `DiscordNative`:

| Surface | Count |
| --- | --- |
| `contextBridge` | 2 |
| `exposeInMainWorld` | 1 |
| `DiscordNative` | 6 |
| `ipcRenderer.invoke` | 22 |
| `ipcRenderer.send` | 16 |
| `ipcRenderer.on` | 10 |

**[SEEN]** On the main side: 21 `ipcMain.handle` + 15 `ipcMain.on`. There is a real asymmetry in
how channel names are written, and it is worth stating precisely because it is the one seam where
this codebase's discipline lapses:

| Call site | Literal channel strings | Identifier references |
| --- | --- | --- |
| preload `ipcRenderer.invoke(...)` | **0** | `IPCEvents.*` |
| preload `ipcRenderer.send(...)` | **0** | `IPCEvents.*` |
| preload `ipcRenderer.on(...)` | 1 (`"DISCORD_MODULE_INSTALLED"`) | `IPCEvents.*` |
| main `ipcMain.handle(...)` | **0** | `IPCEvents.*`, `CONSTANTS_GET`, … |
| main `webContentsSend(...)` — pushes | **17** | none |

The request/response and fire-and-forget directions go through an `IPCEvents` enum imported as
`DiscordIPC_1.IPCEvents`. The **main→renderer push direction does not** — those 17 channels are
passed to `webContentsSend` as bare string literals:

```
APP_GET_MAIN_BUNDLE_STATS   CRASH_REPORTER_NEW_CRASH   HELP_OPEN
LAUNCH_APPLICATION          MAIN_WINDOW_BLUR          MAIN_WINDOW_FOCUS
MAIN_WINDOW_HIDDEN          MAIN_WINDOW_PATH          NAVIGATE_BACK
NAVIGATE_FORWARD            SPELLCHECK_RESULT         SYSTEM_TRAY_OPEN_VOICE_SETTINGS
SYSTEM_TRAY_TOGGLE_DEAFEN   SYSTEM_TRAY_TOGGLE_MUTE   USER_SETTINGS_OPEN
WINDOW_DEVTOOLS_CLOSED      WINDOW_DEVTOOLS_OPENED
```

**[INFERRED]** This matters more than it looks. The enum protects the direction where a typo
fails loudly (a handler that nothing calls), and abandons the direction where a typo fails
*silently* — a `webContentsSend("MAIN_WINDOW_FOCUS ")` with a stray space throws nothing and
delivers nothing, and the only symptom is a UI that never updates. The renderer-facing mirror of
shell state is exactly the code most likely to rot unnoticed.

That is the single design change the architecture document makes in response: **one contract,
covering both directions, validated on both ends.**

**[SEEN]** What the renderer actually subscribes to is narrower than "all shell state". Across the
10 `ipcRenderer.on` sites, the named channels are dominated by **environment lifecycle**:

```
POWER_MONITOR_RESUME          POWER_MONITOR_SUSPEND
POWER_MONITOR_LOCK_SCREEN     POWER_MONITOR_UNLOCK_SCREEN
ACTIVITY_CAPTURE_STREAM_STARTED/PAUSED/STOPPED
APP_GET_MAIN_BUNDLE_STATS     DISCORD_MODULE_INSTALLED
```

Power-management and screen-capture lifecycle, bundle statistics, and module-install notices —
plus one generic `channel` wrapper and one channel resolved through a `getDiscordIPCEvent(...)`
helper. **[INFERRED]** The shell pushes *its own* lifecycle, not the user's data. That is a useful
calibration: a renderer does not need a mirror of everything the shell knows, only a small set of
environment facts it cannot observe itself.



**The contract shape, stated plainly:**

- **22 request/response** operations (`invoke` ⇄ `handle`) — anything that must return a value.
- **16 fire-and-forget** operations (`send` ⇄ `on`) — imperative commands, no reply expected.
- **10 main→renderer push** subscriptions (`on`) — state the shell owns and the UI must mirror.

**[INFERRED]** That 10 is the number that matters for architecture. The shell owns real state —
window focus, tray availability, voice connection, updater status, notification permissions,
keybind state. It pushes changes; it does not let the renderer poll. A renderer that models
those as React state fed by a push channel will not fight the shell. One that assumes it can
query on demand will.

**[INFERRED]** `mainScreenPreload.js` is 1.1 MB because the preload carries its own bundled
dependency graph (validation, platform shims, voice plumbing) rather than being a thin facade.
That is a deliberate trade: preload cannot `require` arbitrary modules from `node_modules`
outside the ASAR, so it ships self-contained. It also makes the preload the largest single
attack surface in the product.

---

## 4. Native surface

**[SEEN]** 17 native module packages; **14** of them ship a compiled `.node` binary (the others
are JS-only shims or install `discord_desktop_core` itself).

| Package | Binary | Size |
| --- | --- | --- |
| `discord_voice` | `discord_voice.node` | 22,325,176 |
| `discord_krisp` | `discord_krisp.node` | 15,068,600 |
| `discord_dispatch` | `discord_dispatch.node` | 10,493,880 |
| `discord_cloudsync` | `discord_cloudsync.node` | 4,432,824 |
| `discord_utils` | `discord_utils.node` | 2,132,408 |
| `discord_spellcheck` | `cld.node` (via `node_modules\cld`) | 2,017,720 |
| `discord_game_utils` | `discord_game_utils.node` | 1,024,440 |
| `discord_overlay2` | `discord_overlay2.node` | 957,880 |
| `discord_hook` | `discord_hook.node` | 942,520 |
| `discord_desktop_overlay` | `discord_desktop_overlay.node` | 900,536 |
| `discord_zstd` | `discord_zstd.node` | 740,280 |
| `discord_media` | `discord_media.node` | 720,312 |
| `discord_erlpack` | `discord_erlpack.node` | 566,200 |
| `discord_modules` | `discord_modules.node` | 520,120 |
| `discord_utils` | `notificationstate.node` (via `windows-notification-state`) | 141,240 |

**[SEEN]** `updater.node` (4.55 MB) also sits at the app root, outside `modules\`.

**[INFERRED]** The size distribution shows where the engineering went: voice + Krisp noise
suppression is ~37 MB of the native budget. Everything else is supporting cast. `discord_hook`
is the keyboard/mouse hook layer (keybinds work while unfocused); `discord_overlay2` is the
in-game overlay; `discord_dispatch` is the Erlang-style event dispatcher.

---

## 5. Hardening posture

**[SEEN]** All nine fuses read from `Discord.exe` (sentinel at file offset `182,142,720`,
wire version 1, `complete: true`):

| # | Fuse | State | Meaning |
| --- | --- | --- | --- |
| 0 | `RunAsNode` | **disabled** | `ELECTRON_RUN_AS_NODE` ignored — the binary cannot be used as a plain Node host |
| 1 | `EnableCookieEncryption` | disabled | cookies in the profile store are not OS-encrypted |
| 2 | `EnableNodeOptionsEnvironmentVariable` | **enabled** | `NODE_OPTIONS` is honoured — injectable |
| 3 | `EnableNodeCliInspectArguments` | disabled | `--inspect` refused |
| 4 | `EnableEmbeddedAsarIntegrityValidation` | **disabled** | ASAR is not hash-verified at load |
| 5 | `OnlyLoadAppFromAsar` | **disabled** | a loose `app\` directory can shadow `app.asar` |
| 6 | `LoadBrowserProcessSpecificV8Snapshot` | disabled | shared V8 snapshot |
| 7 | `GrantFileProtocolExtraPrivileges` | enabled | `file://` keeps elevated privileges |
| 8 | `WasmTrapHandlers` | enabled | Wasm traps surface as JS exceptions |

**Reading this honestly:** the interesting ones are 2, 4 and 5 together. `NODE_OPTIONS` is
honoured, the ASAR is not integrity-checked, and a loose `app\` directory takes precedence over
`app.asar`. Any one alone is unremarkable; together they mean the local installation directory
is the trust boundary, and the binary does not defend it.

That is consistent with a product whose real integrity story is server-side: the renderer is
downloaded per launch over TLS from the vendor's own origin, so tampering with local files gets
an attacker the *shell*, never the *UI*. Whether that trade is good depends entirely on what the
shell is trusted to do — and per §3, the shell is trusted to do a great deal.

**[INFERRED]** This is the most transferable security lesson in the report: if you split
privilege, put the untrusted-but-valuable half somewhere you can re-fetch, and keep the
privileged half small, auditable and boring. Discord's shell is privileged and large; they
mitigate by making the privileged half non-extensible — one bridge, 48 methods — rather than
small.

---

## 6. Splash screen

**[SEEN]** `splash/index.html` is 198 bytes. `splashScreenPreload.js` (12,516 B) drives it with
`createElement` / `textContent` / `appendChild`, with zero framework hits.

**[INFERRED]** Correct call. A splash screen that needs a framework to show a logo before the
framework exists is a bug. Vanilla DOM over static markup, ~12 KB of driver, a brand font and a
`connecting.webm` — that is the whole thing.

---

## 7. Hypotheses (explicitly unproven)

| # | Hypothesis | Confidence | Cheapest way to falsify |
| --- | --- | --- | --- |
| H1 | `WEBAPP_PATHS` resolves to versioned app paths, and `CONFERENCE_MODE` selects a distinct bundle for stage/video mode. | medium | Dump the `Constants_1` object literal from `core.asar/bundle.js`. |
| H2 | The renderer's shell mirror is small: the 10 `ipcRenderer.on` sites are dominated by power/capture lifecycle (7 of 10 named channels), so the UI mirrors *environment* state, not domain state. | high (partly answered by measurement) | Enumerate all 10 subscriptions exhaustively, including the two indirect ones (a generic `channel` wrapper and a `getDiscordIPCEvent(...)` lookup). |
| H3 | The web app authenticates against the same origin it is served from, so the shell never handles the session token. | medium | Search the shell for token/credential handling; absence in `mainScreenPreload.js` corroborates. |
| H4 | `discord_hook` implements global input capture for push-to-talk while the window is unfocused, and the shell forwards only resulting key state to the renderer. | medium | Inspect `discord_hook.node` exports and the channels that reference them. |
| H5 | `EnableCookieEncryption: disabled` is intentional because the shell's cookie jar is disposable and re-derivable from the web tier. | low-medium | Not falsifiable statically. Needs live profile inspection. |

None of these are load-bearing for the architecture document. They are listed so they do not
silently harden into "facts" on a re-read.

---

## 8. Limitations of this study

- **No renderer analysis.** By construction — there is no renderer on disk to analyse.
- **`analyze_javascript_application` on `core.asar` did not complete** (60 s MCP timeout against
  a 1.1 MB preload with a large dependency graph). Every quantitative claim above therefore
  comes from direct byte/string measurement, which is why counts are stated as token
  occurrences rather than AST facts.
- **Deobfuscation not attempted.** The JavaScript is minified but identifiers survive; the
  Wakaru-based recovery path is Linux-only and unavailable on this host.
- **Native binaries not disassembled.** Sizes and roles only. Statements about what `.node`
  modules *do* are inferences from package name plus role.
- **Fuse state ≠ runtime behaviour.** A disabled fuse proves the binary will not honour a
  switch; it does not prove the app never enables the capability another way (e.g.
  `app.commandLine.appendSwitch` in application code).

---

## 9. What this report is actually good for

If the goal was "read Discord's UI code and learn from it", the answer is that the code is not
here, and it is worth knowing that definitively rather than assuming a bad extraction.

If the goal was "learn how a large Electron app separates a trusted native shell from an
untrusted UI", this install is an unusually clean specimen, and the pattern is small enough to
state in one page — which is exactly what `02-aegis-shield-architecture.md` does.



