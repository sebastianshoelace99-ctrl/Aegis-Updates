# Evidence Index

Every quantitative claim in `01-discord-desktop-re-report.md`, with the command that reproduces
it. All commands are PowerShell, read-only, and safe to re-run.

Paths assume:

```powershell
$APP = "$env:LOCALAPPDATA\Discord\app-1.0.9263"
$CORE = "$APP\modules\discord_desktop_core-1\discord_desktop_core"
```

---

## E1 — Artifact identity

```powershell
Get-Item "$APP\Discord.exe" | Select-Object Length
Get-FileHash "$APP\Discord.exe" -Algorithm SHA256
Get-Item "$APP\resources\app.asar", "$CORE\core.asar" | Select-Object Name, Length
```

| Observation | Value |
| --- | --- |
| `Discord.exe` size | 219,698,104 |
| `Discord.exe` SHA-256 | `7a84bc6f48118ed4716a7f7bec637e7e5c5208a94edc4600d72f544a0adab2cb` |
| `resources\app.asar` | 3,635,916 |
| `core.asar` | 1,832,667 |

Corroborated by the `rea` MCP `inspect_electron_fuses` result, which reports the same digest and
size for the PE.

---

## E2 — Build identity

```powershell
Get-Content "$APP\resources\build_info.json" -Raw
Get-Content "$APP\modules\discord_desktop_core-1\discord_desktop_core\package.json" -Raw
Get-Content "$APP\resources\app.asar" -AsByteStream -TotalCount 0   # (asar is binary; see E3)
```

`build_info.json` →
`{"releaseChannel":"stable","sentryDist":"stable-win-x64","sentryRelease":"discord-desktop-a5ddfe67879a89c713452a4ad09cb5796de28933","version":"1.0.9263"}`

`releaseChannel: "stable"` is what makes `https://${releaseChannel}.discord.com` resolve to
`https://stable.discord.com` in the report's §1.

---

## E3 — Extracting the ASARs

Both archives were extracted with the `rea` MCP `extract_artifact` tool (integrity policy
`fail`). The extracted trees used for measurement were:

```
%TEMP%\rea-extracted-877ef6bc-3cbf-4681-908b-84a79f906480   app.asar
    bundle.js 3,076,973 | splashScreenPreload.js 12,516 | package.json 883 | splash\ | data\
%TEMP%\rea-extracted-67e38d19-4eb5-4355-8f8d-2af3ad0e7421   core.asar
    bundle.js 439,665 | mainScreenPreload.js 1,116,629 | frameViewPreload.js 21,149
    package.json 1,536 | data\cacert.pem 250,607 | data\riotgames.pem 1,493
```

These directories are in `%TEMP%` and may be cleaned by the OS. To re-create them, either re-run
`extract_artifact` against each archive, or use any ASAR reader (both files are standard ASAR
format, header at offset 0, JSON length-prefixed).

**Note on file size vs. layer:** `app.asar` contains the *bigger* `bundle.js` (3.08 MB, the
bootstrapper) while `core.asar` contains the *smaller* one (440 KB, the desktop core) plus the
1.1 MB bridge. The report's layer map follows `package.json` names, not file sizes — this is
easy to get backwards.

---

## E4 — Token counts

Counts are case-sensitive literal substring occurrences via `[regex]::Matches` with
`[regex]::Escape`. They are **not** AST facts; see the report's §8 limitation.

```powershell
$c = "$env:TEMP\rea-extracted-67e38d19-4eb5-4355-8f8d-2af3ad0e7421"
$pre  = Get-Content "$c\mainScreenPreload.js" -Raw
$main = Get-Content "$c\bundle.js" -Raw
foreach ($p in 'react-dom','useState','Gateway','FluxDispatcher','MessageStore','WebSocket',
               'contextBridge','exposeInMainWorld','DiscordNative',
               'ipcRenderer.invoke','ipcRenderer.send','ipcRenderer.on') {
  "$p`t" + ([regex]::Matches($pre, [regex]::Escape($p))).Count
}
foreach ($p in 'loadURL','react-dom','ipcMain.handle','ipcMain.on','BrowserWindow') {
  "$p`t" + ([regex]::Matches($main, [regex]::Escape($p))).Count
}
```

Measured:

| Token | `mainScreenPreload.js` | `core.asar/bundle.js` |
| --- | --- | --- |
| `contextBridge` | 2 | — |
| `exposeInMainWorld` | 1 | — |
| `DiscordNative` | 6 | — |
| `ipcRenderer.invoke` | 22 | — |
| `ipcRenderer.send` | 16 | — |
| `ipcRenderer.on` | 10 | — |
| `react-dom` | 0 | 0 |
| `Gateway` | 0 | — |
| `FluxDispatcher` | 0 | — |
| `MessageStore` | 0 | — |
| `useState` | 6 | — |
| `WebSocket` | 2 | — |
| `loadURL` | — | 1 |
| `ipcMain.handle` | — | 21 |
| `ipcMain.on` | — | 15 |
| `BrowserWindow` | — | 22 |

**Correction against an earlier draft of the report:** `WebSocket` was written as 3; the measured
value is **2**. Also `ipcMain` totals are 21 `handle` + 15 `on` (36 registration sites), not the
"77 ipcMain refs" that a broader unanchored count produces — `ipcMain` also appears in imports,
type positions and comments. The report uses the anchored numbers.

---

## E5 — The remote-renderer call site

```powershell
$main = Get-Content "$env:TEMP\rea-extracted-67e38d19-4eb5-4355-8f8d-2af3ad0e7421\bundle.js" -Raw
$i = $main.IndexOf('URL_TO_LOAD'); $main.Substring([Math]::Max(0,$i-450), 700)
$j = $main.IndexOf('loadURL');     $main.Substring([Math]::Max(0,$j-700), 1000)
```

Produces, verbatim from the artifact:

```js
exports.WEBAPP_ENDPOINT = function(){ ... return `https://${buildInfo.releaseChannel}.discord.com`; }()
let WEBAPP_PATH = function(){
  let explicitSetting = settings?.get("WEBAPP_PATH", null);
  if (null != explicitSetting) return explicitSetting;
  let isConferenceModeEnabled = settings?.get("enableConferenceMode", !1);
  return `${isConferenceModeEnabled ? Constants_1.WEBAPP_PATHS.CONFERENCE_MODE
                                    : Constants_1.WEBAPP_PATHS.APP}?_=${Date.now()}`;
}(),
URL_TO_LOAD = `${exports.WEBAPP_ENDPOINT}${WEBAPP_PATH}`
```

and

```js
function loadMainPage(){ ... mainWindow?.loadURL(URL_TO_LOAD), setTimeout(()=>{ if(!webAppLoaded
  && .05>Math.random()){ ... captureMessage("WebApp timed out loading (timeout=60s)") } },6e4) }
```

This single pair is the entire evidence base for the report's headline finding.

---

## E6 — Channel naming: a measured asymmetry

The report claims the `IPCEvents` enum covers request/response but not pushes. Reproduce with
five counts:

```powershell
$c    = "$env:TEMP\rea-extracted-67e38d19-4eb5-4355-8f8d-2af3ad0e7421"
$pre  = Get-Content "$c\mainScreenPreload.js" -Raw
$main = Get-Content "$c\bundle.js" -Raw

'preload invoke literal : ' + ([regex]::Matches($pre,'ipcRenderer\.invoke\("')).Count
'preload send   literal : ' + ([regex]::Matches($pre,'ipcRenderer\.send\("')).Count
'preload on     literal : ' + ([regex]::Matches($pre,'ipcRenderer\.on\("')).Count
'main    handle literal : ' + ([regex]::Matches($main,'ipcMain\.handle\("')).Count
'main    push   literal : ' + ([regex]::Matches($main,'webContentsSend\("')).Count
```

| Call site | Literal | Total sites |
| --- | --- | --- |
| preload `ipcRenderer.invoke` | 0 | 22 |
| preload `ipcRenderer.send` | 0 | 16 |
| preload `ipcRenderer.on` | 1 | 10 |
| main `ipcMain.handle` | 0 | 21 |
| main `webContentsSend` (pushes) | **17** | 17 |

The 17 push literals, enumerated:

```powershell
[regex]::Matches($main, 'webContentsSend\("([A-Z_]+)"') |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
```

```
APP_GET_MAIN_BUNDLE_STATS   CRASH_REPORTER_NEW_CRASH   HELP_OPEN
LAUNCH_APPLICATION          MAIN_WINDOW_BLUR          MAIN_WINDOW_FOCUS
MAIN_WINDOW_HIDDEN          MAIN_WINDOW_PATH          NAVIGATE_BACK
NAVIGATE_FORWARD            SPELLCHECK_RESULT         SYSTEM_TRAY_OPEN_VOICE_SETTINGS
SYSTEM_TRAY_TOGGLE_DEAFEN   SYSTEM_TRAY_TOGGLE_MUTE   USER_SETTINGS_OPEN
WINDOW_DEVTOOLS_CLOSED      WINDOW_DEVTOOLS_OPENED
```

And the 10 preload subscriptions:

```powershell
[regex]::Matches($pre, 'ipcRenderer\.on\((.{0,90}?)\)') |
  ForEach-Object { $_.Groups[1].Value }
```

Eight name a channel explicitly (4× `POWER_MONITOR_*`, 2× `ACTIVITY_CAPTURE_STREAM_*`,
`APP_GET_MAIN_BUNDLE_STATS`, literal `"DISCORD_MODULE_INSTALLED"`); the remaining two are a
generic `channel` parameter (a wrapper helper) and a `getDiscordIPCEvent(...)` lookup, so they
cannot be named without resolving that helper.

**Correction against an earlier draft:** §3 originally stated that channel names were centralised
throughout. That is true for `invoke`/`send`/`handle` and false for `webContentsSend`, which uses
bare literals. The report now states the asymmetry explicitly, because it is the more useful
finding — it shows where a typed contract would have caught a class of silent failure.


---

## E7 — Fuses

Via `rea` MCP:

```
inspect_electron_fuses(path: "<APP>\\Discord.exe")
```

Result `ev_ca6343ca2fbf8235b7eee3ad263fe2eb06a50bc4b388769f49cb2ed63698b5f4`:

| # | Fuse | raw_byte | State |
| --- | --- | --- | --- |
| 0 | `RunAsNode` | 48 (`0`) | disabled |
| 1 | `EnableCookieEncryption` | 48 | disabled |
| 2 | `EnableNodeOptionsEnvironmentVariable` | 49 (`1`) | **enabled** |
| 3 | `EnableNodeCliInspectArguments` | 48 | disabled |
| 4 | `EnableEmbeddedAsarIntegrityValidation` | 48 | **disabled** |
| 5 | `OnlyLoadAppFromAsar` | 48 | **disabled** |
| 6 | `LoadBrowserProcessSpecificV8Snapshot` | 48 | disabled |
| 7 | `GrantFileProtocolExtraPrivileges` | 49 | enabled |
| 8 | `WasmTrapHandlers` | 49 | enabled |

Sentinel at file offset **182,142,720**, `wire_version: 1`, `declared_length: 9`, `complete: true`
— all nine fuses were read, so no fuse state is unknown.

Provider limitations recorded with that Evidence, and repeated here because they bound the claim:
fuse state does not prove the app never enables Inspector by other means (`app.commandLine`); a
missing sentinel would mean unknown, not disabled.

---

## E8 — Native modules

```powershell
$m = "$APP\modules"
Get-ChildItem $m -Directory | Select-Object -ExpandProperty Name | Sort-Object
Get-ChildItem $m -Recurse -Filter *.node -File |
  Select-Object @{n='Rel';e={$_.FullName.Replace("$m\","")}}, Length | Sort-Object Rel
```

| Observation | Value |
| --- | --- |
| module package directories | **17** |
| compiled `.node` files under `modules\` | **14** |
| largest | `discord_voice.node` 22,325,176 |
| second | `discord_krisp.node` 15,068,600 |
| third | `discord_dispatch.node` 10,493,880 |
| `updater.node` at app root | 4,550,072 |

**Correction against an earlier draft:** the report originally said "17 N-API addons". The
measured split is 17 *packages* containing **14** `.node` binaries (the remainder are JS-only
shims, and `discord_desktop_core-1` carries the core ASAR rather than an addon). The report and
architecture document use 17 packages / 14 binaries.

---

## E9 — Bootstrap manifest and module pinning

```powershell
Get-Content "$APP\resources\bootstrap\manifest.json" -Raw
```

Eight entries, all pinned to `0`: `discord_desktop_core`, `discord_erlpack`,
`discord_notifications`, `discord_premap`, `discord_spellcheck`, `discord_utils`, `discord_voice`,
`discord_zstd`.

---

## E10 — Splash

```powershell
$s = "$env:TEMP\rea-extracted-877ef6bc-3cbf-4681-908b-84a79f906480\splash"
Get-Item "$s\index.html" | Select-Object Length          # 198
$pre = Get-Content "$env:TEMP\rea-extracted-877ef6bc-3cbf-4681-908b-84a79f906480\splashScreenPreload.js" -Raw
foreach ($p in 'createElement','textContent','appendChild','react','useState') {
  "$p`t" + ([regex]::Matches($pre,[regex]::Escape($p))).Count
}
```

`react` and `useState` return 0; `createElement` / `textContent` / `appendChild` are present — the
basis for "vanilla DOM splash".

---

## What could not be measured, and why

| Attempt | Outcome | Basis for the claim in the report |
| --- | --- | --- |
| Full AST analysis of `core.asar` (`analyze_javascript_application`) | timed out at the MCP 60 s ceiling against the 1.1 MB preload | All counts are string-occurrence measurements instead; explicitly flagged in the report §8. |
| Deobfuscation via the Wakaru-backed path (`recover_javascript_sources`) | not runnable — Linux-only, host is Windows | No deobfuscation was needed; the bundle is minified but identifiers are intact. |
| Renderer component analysis | nothing to analyse | There is no renderer bundle on disk. This is the finding, not a gap. |
| Native binary behaviour | not disassembled | Report states role inferences (`discord_hook` = input hook, etc.) as **[INFERRED]** only. |
| Live runtime observation | not performed — static-only scope | Nothing in the report depends on runtime behaviour. |

Every **[SEEN]** claim above is reproducible with the commands in this file. Every claim not
listed here is **[INFERRED]** and is labelled as such in the report.

