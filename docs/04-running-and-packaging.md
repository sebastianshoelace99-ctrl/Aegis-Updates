# Running, testing, and packaging

The vertical slice from `02-aegis-shield-architecture.md` §11 is implemented. This file is the
command reference plus an honest list of where the implementation deviates from the design doc.

## What exists

| Layer | Files | Notes |
| --- | --- | --- |
| Shell | `electron/main.ts`, `window.ts` | lifecycle, single-instance lock, `app://` protocol, navigation allowlist |
| Backend | `server/` | Node HTTP + SSE, Supabase PostgREST or in-memory store, shared Zod domain |
| Contract | `shared/channels.ts`, `shared/contract.ts`, `shared/domain.ts` | Typed request channels + push channels; one domain schema for both processes |
| Bridge | `electron/preload.ts` | frozen `window.aegis`, validated methods + `subscribe`, nothing else |
| Handlers | `electron/handlers/`, `electron/updater.ts` | File dialogs, exports, update checks, and consent-based installation |
| Renderer | `src/` | React 19, TanStack Query, Zustand mirror, CSS Modules, virtualised gallery |
| Self-test | `electron/smoke.ts` | 36 assertions through the real preload and real HTTP backend, packaged or not |

## Commands

```powershell
npm install          # once
Copy-Item .env.example .env # then fill in Supabase values (or leave them out for the memory store)
npm run server        # builds server-dist/ and starts the backend on 127.0.0.1:8787
npm start             # in a second terminal: build, then run Electron against dist/
npm test              # 105 Vitest tests (contract, handlers, domain, messages, uploads, roles, voice)
npm run typecheck     # tsc --noEmit, strict
npm run smoke         # build, launch with AEGIS_SMOKE=1 (hosts an in-memory backend), exit 0/1
npm run dist          # build + Windows NSIS installer and portable executable
npm run dist:release  # production build + publish release metadata and assets to GitHub
npm run capture -- <exe> <outDir>   # screenshot a built app over CDP (no browser download)
```

`npm start` is **not** a dev server: it builds first, then launches. There is no HMR loop, on
purpose - the window serves `dist/renderer` through `app://bundle`, which is the same code path
the packaged EXE uses. If you want HMR later, point `AEGIS_DEV_SERVER` at a Vite dev server and
the window will load that URL instead; the CSP in `index.html` would then need
`connect-src 'self' ws://localhost:5173`.

The renderer's backend URL and shared key are baked in by Vite from `VITE_API_BASE_URL` and
`VITE_API_KEY`. Editing `.env` while a window is open has no effect until the next build.

The smoke run is self-contained: `AEGIS_SMOKE=1` makes Electron main host the real HTTP handlers
with the in-memory store on port 8787. It deliberately refuses to start if that port is occupied,
so a self-test can never write to a running Supabase-backed server. Its upload directory is a
per-process folder under `%TEMP%`, removed when the run ends, because the packaged app's own
directory may be read-only.

## Attachments on disk

Uploaded files are **not** stored in Supabase. `server/uploads.ts` writes:

```
data/uploads/                     <- AEGIS_UPLOAD_DIR, git-ignored
  <sha256>                        <- the bytes, content-addressed
  <upload-id>.json                <- id, name, mime, size, sha256, authorId, createdAt
  .incoming/<id>.part             <- in-flight body; removed on completion or failure
```

The defaults are deliberately boring: `data/uploads` under the backend's working directory, a
100 MB cap per file and ten files per message. Back up that directory alongside the database - a
`messages.attachments` row is only a pointer, so a restored database without the blobs renders
cards that 404. There is no garbage collection yet: deleting a message does not delete its file,
because one blob can be referenced by several upload records. Add reference counting before you
add a delete endpoint.

## Output

```
release/Aegis Shield Setup 0.1.0.exe       interactive Windows installer
release/AegisShield-0.1.0-portable.exe     single file, no installer, no admin rights
release/win-unpacked/                      the same app unpacked (useful for debugging)
```

The installer offers an install-location choice and creates Start Menu and desktop shortcuts.
The Windows app icon is `build/icon.ico` (256×256). The portable EXE extracts to `%TEMP%` at
launch, which is also where the smoke report lands (`%TEMP%\aegis-smoke.json`) because a packaged
Windows GUI app has no console attached.

## Automatic updates

The NSIS installer uses `electron-updater` to check GitHub Releases, download updates in the
background, and wait for the user to choose **Restart and install**. Portable builds do not
self-update. The source repository's `.github/workflows/release.yml` publishes on version tags
such as `v1.0.1`; the tag must match `package.json`.

The public repository `sebastianshoelace99-ctrl/Aegis-Updates` contains both the source and its
releases. Configure `AEGIS_MASTER_SERVER_URL` as an Actions secret. The workflow uses
`github.token` with `contents: write` permission, so no additional GitHub token is stored. Existing
1.0.0 installers need a manual install of the first updater-enabled release.

## Deviations from `02-aegis-shield-architecture.md`

Four, all deliberate. Each one is a place where following the document literally would have cost
more than it bought for a testable first slice.

| # | Document says | Implemented | Why |
| --- | --- | --- | --- |
| 1 | `vite-plugin-electron` produces renderer + main + preload from one config | Vite for the renderer, esbuild for main/preload (`scripts/build-electron.mjs`) | The plugin's API has churned repeatedly; one explicit esbuild pass is 40 lines, debuggable, and keeps `sandbox: true` easy to reason about (the only remaining `require` in the preload is `electron`) |
| 2 | `file://` preload path + strict CSP | privileged `app://bundle` scheme (`electron/window.ts`) | `file://` has an opaque origin in Chromium, so `script-src 'self'` there is the classic blank-window trap. A real origin makes the CSP mean what it says and gives relative asset URLs a host |
| 3 | Playwright smoke test | `AEGIS_SMOKE=1` self-test inside the app (`electron/smoke.ts`) | Same assertions (method list, frozen bridge, no `window.require`, push delivery, fail-closed validation), no browser download, runs offline, and it works against the packaged EXE |
| 4 | Set all nine Electron fuses | not applied | `portable` wraps the exe in an NSIS archive, and `EnableEmbeddedAsarIntegrityValidation` needs integrity metadata embedded in the exe that electron-builder does not produce for this target. Flipping it blindly yields an app that will not boot. Do this with `@electron/fuses` in an `afterPack` hook on an NSIS/installer target, not here |

There is one smaller change worth naming: the document's preload snippet does not compile under
`strict` with a generic channel key (the contract table is heterogeneous). The two casts that fix
it are confined to the schema lookups inside `invoke` and `subscribe`, so every call site stays
precisely typed.

## What is deliberately not here

- **The gallery is still local.** `src/api/gallery.ts` is a deterministic generator behind a real
  async boundary and a Zod schema, so replacing it with `fetch("/api/gallery")` changes nothing
  downstream. It is the one remaining mock, and it is not server data.
- **No seed data.** The workspace boots empty on purpose. A first launch with invented servers
  made it impossible to tell "the backend answered with nothing" from "the app shipped demo
  content", which is exactly the confusion this migration removed.
- **No WebRTC signaling.** `src/state/voiceSession.ts` captures and previews local media, and the
  backend carries `message`/`typing`/`presence` events, but no media is negotiated. The peer
  connection is the missing piece behind `joinVoice`; the state machine, constraints and controls
  are already the ones it would use.
- **No inline styles anywhere.** That is why `VirtualGrid` uses repeated spacer rows instead of a
  `transform`, why grid geometry lives in CSS custom properties read at runtime, and why the mic
  meter is twelve `data-on` segments instead of an inline width.

## Verification performed

| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `vitest run` | 105 passed (contract, handlers, domain, messages, uploads, roles, voice maths, persistence validation) |
| Backend smoke (memory store) | health, `POST /api/guilds`, `POST`/`GET` messages all round-trip |
| Upload end-to-end (live backend) | 2 MiB `POST /api/uploads` → 201 with name/size; `HEAD` reports length; `Range: bytes=0-1023` → 206 with `Content-Range`; full GET byte-identical; attachment-only message → 201; empty message → 400 |
| `npm run smoke` (dev Electron) | `ok: true`, 36/36 checks, including the empty first run and a real message POST |
| `AegisShield-0.1.0-portable.exe` with `AEGIS_SMOKE=1` | exits `0`, same 36/36 report (hosts its own in-memory backend) |
| Manual, packaged app | starts empty; create-server flow lands in an empty `#general`; a sent message survives a channel switch and a window reload; settings, roles, profile card and voice stage render; fake-device call connects, mutes, streams camera and leaves; no inline styles |

## Next

1. Fuses via `afterPack` on an installer target (see deviation 4).
2. Replace the local gallery generator with the real endpoint.
3. Add WebRTC signaling behind `joinVoice`, with the backend relaying offers/answers and the
   existing session state machine unchanged.
4. Add Playwright once there is a second route worth driving; the in-app smoke can then shrink to a
   startup assertion.
5. Move live events onto Supabase Realtime if more than one backend instance is ever needed
   (the SSE fan-out is process-local by design).
