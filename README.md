# Aegis Shield

Working root for the artist-platform app **and** the static reverse-engineering study that
informs its architecture.

Everything here was produced from a **static, read-only** analysis of an installed
Discord Desktop build. No process was attached to, no debugger was started, no code from
Discord or its dependencies was copied into this project. The architecture document is an
original design that borrows *patterns*, not source.

## Contents

| File | What it is |
| --- | --- |
| [`docs/01-discord-desktop-re-report.md`](docs/01-discord-desktop-re-report.md) | The engineering report: what Discord Desktop 1.0.9263 actually contains, measured. SEEN vs INFERRED. |
| [`docs/02-aegis-shield-architecture.md`](docs/02-aegis-shield-architecture.md) | Original React/TypeScript architecture for this app, derived from the report's findings. |
| [`docs/03-evidence-index.md`](docs/03-evidence-index.md) | Every number in the report, with the exact command that reproduces it. |
| [`docs/04-running-and-packaging.md`](docs/04-running-and-packaging.md) | How to run, test, and rebuild the app, plus the four deliberate deviations from the architecture. |
| [`docs/05-abuse-prevention.md`](docs/05-abuse-prevention.md) | The rate-limit buckets, risk weights and graduated enforcement, with an honest list of what is unproven. |
| [`docs/06-discord-feature-parity.md`](docs/06-discord-feature-parity.md) | What Discord 1.0.9266 has that this app did not, measured from its own cached bundle; what was added, and which Nitro gates are deliberately free here. |

## Status

`docs/` is complete, and the §11 vertical slice from the architecture document is implemented,
tested, and packaged:

| | |
| --- | --- |
| Windows installer | `release/Aegis Shield Setup 1.0.0.exe` - version 1.0.0 |
| Portable EXE | `release/AegisShield-1.0.0-portable.exe` - single file, no installer, no admin rights |
| Source | `electron/` (main, preload, handlers) · `shared/` (contract + domain) · `server/` (backend) · `src/` (React renderer) |
| Run from source | `npm install` once, then `npm run server` in one terminal and `npm start` in another |
| Backend | Node HTTP + SSE, Supabase PostgREST or an in-memory dev store; setup in [`Supabase/README.md`](Supabase/README.md) |
| Rebuild the EXE | `npm run dist` |
| Verify | `npm test` (258 Vitest tests) and `npm run smoke` (the real app, 36 assertions) |

Current portable build (1.0.0): 111,689,979 B, sha256 `4A078C62140DA731214084A8E26127F488BE23BBCC773BAA25DC92D4BE73F796`.

Implemented: frozen `window.aegis` with a strictly typed, validated IPC contract, `sandbox: true` +
`contextIsolation`, strict CSP with no `unsafe-inline`, the `window:focusChanged` push feeding a
Zustand mirror, a virtualised 240-item gallery with three image sizes, and a browser fallback so
the renderer still runs without the shell.

**There are no sample servers.** The app boots empty, fetches `GET /api/workspace`, and shows a
first-run card until a server exists. Creating one is a `POST /api/guilds`; every later rename,
role edit, notification choice and icon upload is a `PATCH /api/guilds/:id`. Server state lives in
Supabase (or the backend's memory store), not in `localStorage`. The packaged EXE talks to the same
backend, so `npm run server` must be running before either `npm start` or the portable build is
useful.

### The shell

The UI is a Discord-shaped workspace rather than a single gallery page: guild rail → channel
list → message feed + composer → member rail.

| Piece | Where | Notes |
| --- | --- | --- |
| Guild rail | `src/features/workspace/GuildRail.tsx` | Unread dot vs. mention count are separate signals; `+` is pinned below the list |
| Create server | `src/features/workspace/CreateServerModal.tsx` | Template → icon/name → "setting up"; creates a real guild, a voice channel and owner/member roles |
| Channel list | `src/features/workspace/ChannelList.tsx` | Collapsible categories; text, media and voice channels; the persistent call strip |
| Feed | `src/features/chat/MessageFeed.tsx` | Author/day grouping, day dividers, anchored "load older", jump-to-present, role-coloured names |
| Composer | `src/features/chat/Composer.tsx` | `Enter` sends, `Shift+Enter` newlines, `@` completion, drag/paste/clip attachments with per-file progress, optimistic rows with retry |
| Reactions | `src/features/chat/MessageFeed.tsx` + `shared/messages.ts` | One pill per glyph, a quick picker, and **super reactions free**: `Shift`-click sends the burst Discord gates behind Nitro. The toggle rules are a pure function |
| Members | `src/features/members/MemberRail.tsx` | Custom hoisted role groups, role colours, live presence, custom status |
| Profile card | `src/features/settings/ProfileCard.tsx` | Banner, picture, display name, pronouns, role chips, bio with links; plus **avatar decoration, profile effect and frame** - Nitro cosmetics, ungated |
| User settings | `src/features/settings/SettingsModal.tsx` | Profile · Status · Appearance · Voice & Video; saved as you type |
| Server settings | `src/features/settings/ServerSettingsModal.tsx` | Name/icon upload, description, notification policy, system channel, roles, member assignment, owner-managed invites and confirmed owner-only server deletion |
| Voice | `src/features/voice/` + `src/state/voiceSession.ts` | Join/leave, mute, deafen, speaking meter, camera preview, screen share, persistent call |
| Gallery | `src/features/gallery/` | Still the 240-item virtualised grid, now the `#gallery` media channel |
| Data | `src/api/{workspace,messages,realtime}.ts` | Shared zod schemas, cursor pagination, SSE event seam |
| Live graph | `src/api/liveWorkspace.ts` | The server's graph, re-validated on arrival; optimistic edits roll back on a failed PATCH |
| Settings model | `src/api/profile.ts` + `src/state/settingsStore.ts` | Versioned, validated profile/status/appearance/voice document |
| State | `src/state/workspaceStore.ts` | Navigation, read markers, drafts, presence (not server data) |

Two deliberate constraints carried into the shell: **no inline styles anywhere** (so the feed
uses `content-visibility: auto` + `contain-intrinsic-size` instead of JS-windowed offsets, and
the mic meter is twelve `data-on` segments rather than a width), and the **preload remains a
strict allowlist**. Profile images are decoded and downscaled with `createImageBitmap` + canvas in
the renderer, so they need no extra IPC. The CSP still bans `'unsafe-inline'`; it allows `data:` and
`blob:` for images, `blob:` for media, and loopback HTTP (`127.0.0.1`, `localhost`) in
`connect-src` for the backend. No remote origin is allowed, so a compromised bundle still cannot
call an attacker's server.

### Automatic updates

Installed Windows NSIS builds check GitHub Releases shortly after launch and every four hours.
Updates download in the background; the app only restarts when the user chooses **Restart and
install**. **Later** keeps the app open, and portable EXEs remain manual-download builds.

Releases are hosted at
[`sebastianshoelace99-ctrl/Aegis-Updates`](https://github.com/sebastianshoelace99-ctrl/Aegis-Updates).
That repository also holds the source code and must remain **public** so installed apps can
retrieve release metadata and assets without embedding a credential in the app. Set this Actions
secret:

| Secret | Value |
| --- | --- |
| `AEGIS_MASTER_SERVER_URL` | Public HTTPS URL of the production API |

The workflow uses GitHub's built-in Actions token to create releases in this same repository; no
GitHub token secret is needed. To publish, update `package.json`'s version, commit and push the
source, then push the matching version tag (for example, `v1.0.1`). The tag must exactly match the
package version. The workflow builds both Windows artifacts and publishes the installer,
`latest.yml`, and blockmap. The first updater-enabled build is version 1.0.1. Existing 1.0.0
installers do not contain the updater; users must install 1.0.1 manually, after which later
releases update automatically.

### Backend

`server/` is a dependency-free Node HTTP service. It shares `shared/domain.ts` with the renderer,
so a guild the client accepts is exactly a guild the server accepts.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Store kind and liveness; no auth |
| `GET /api/workspace` | Members, guilds, categories, channels, roles, assignments |
| `POST /api/guilds` | Create a server; answers with the created guild and the whole workspace |
| `PATCH /api/guilds/:id` | Rename, description, icon, notification policy, system channel, roles |
| `GET /api/guilds/:id/moderation` | Read the latest 100 moderation audit entries; requires moderation permission |
| `POST /api/guilds/:id/moderation` | Timeout, remove timeout, kick, ban, or unban a member |
| `GET /api/guilds/:id/export` | Owner-only JSON export of server metadata and message history |
| `GET /api/search?q=...&guildId=...` | Search messages in channels where the caller can read history |
| `GET /api/channels/:id/messages?before=&limit=` | Ascending page, exclusive timestamp cursor |
| `POST /api/channels/:id/messages` | Insert one message; author comes from the request identity; `attachments: [{ uploadId }]` |
| `POST /api/uploads` | Raw file body, streamed to disk; 100 MB cap; answers with the attachment record |
| `GET | HEAD /api/uploads/:id` | Streams the file with `Range`, `ETag` and a safe `Content-Disposition`; `?download=1` forces a save |
| `POST /api/typing`, `POST /api/presence` | Ephemeral signals, fanned out over SSE |
| `GET /api/events` | Server-sent events: `message`, `typing`, `presence` |
| `POST /api/security/appeals` | Ask a human to review a restriction; `202` with a case id |
| `GET /api/security/summary`, `/events`, `/cases` | Operator views; `404` unless `AEGIS_ADMIN_KEY` is set and presented |
| `POST /api/security/overrides` | Clear, restrict or suspend an account, attributed and reversible |
| `POST /api/auth/register` | Email/password account (scrypt); answers `{ token, user }` |
| `POST /api/auth/login` | Same shape; one generic `401` for a wrong password and an unknown address |
| `GET /api/auth/session` | The bearer token's user; `401` when it is missing, expired or revoked |
| `POST /api/auth/logout` | Revokes the presented session |
| `GET /api/auth/providers` | Which social providers have credentials, and which variables are missing |
| `POST /api/auth/oauth/start` | Starts an attempt; answers a PKCE authorize URL |
| `GET /api/auth/oauth/attempt/:id` | `pending` / `complete` / `error` for the polling window |
| `GET | POST /api/auth/oauth/callback` | Provider redirect (GET for Discord/Google, form_post for Apple); answers HTML |

There are two stores behind one interface: `server/store.ts` is an in-memory dev store (used by
`npm run smoke` and whenever Supabase is unconfigured) and `server/supabaseStore.ts` talks to
PostgREST with the service-role key. The renderer never sees a Supabase credential.

### Accounts and sign-in

`src/features/auth/` is the whole entry surface: a Discord-shaped login card (brand panel, email +
password, OR, provider buttons) and a three-step register wizard. It is styled with the same
tokens as the workspace, so the theme, accent and density chosen in Settings apply before the
first message is loaded.

The backend (`server/auth.ts`, `server/oauth.ts`) has no OAuth dependency:

- **Passwords** are scrypt (`N=16384, r=8, p=1`) with a per-user salt. The hash string carries its
  parameters so they can be raised later. A wrong password and an unknown address both verify
  against a decoy hash, which keeps the reply time from enumerating accounts.
- **Sessions** are random 256-bit bearer tokens. Only the SHA-256 digest is written to
  `data/auth.json`, so reading that file does not let anyone sign in. Sessions last 30 days and are
  revoked on logout.
- **Identity precedence.** A verified bearer token wins over `x-aegis-user`; a token that does not
  resolve is refused rather than downgraded. Set `AEGIS_REQUIRE_AUTH=1` to make a session mandatory
  for every route except health and `/api/auth/*`.
- **Provider linking** happens only on `provider + provider id`, or on an email the provider
  *asserts* is verified. A password account created here is never adopted by an OAuth identity,
  because that would let whoever registered an address first inherit its real owner's sign-in.
- **OAuth** is the authorization-code flow with PKCE. Apple's `client_secret` is minted per exchange
  as a five-minute ES256 JWT, its `id_token` is verified against Apple's JWKS, and the callback
  answers a small HTML page - the app polls `/api/auth/oauth/attempt/:id`, so no token ever travels
  through a URL.

While the app is still pre-production, `VITE_AEGIS_SKIP_AUTH=1` in `.env` adds a "continue as the
local dev account" link to the login screen: the renderer enters the workspace as a local
`dev` account and rides the same `x-aegis-user` claim a fresh checkout already uses, so no new
trust path is added on the server. It is a build-time opt-in, the link is hidden (and the action
refuses) when `VITE_API_BASE_URL` is not loopback, and `AEGIS_REQUIRE_AUTH=1` still rejects the
claim. A link rather than an automatic sign-in keeps the real session path - and the login screen
itself - exercised by `npm run smoke` (`src/state/devSession.ts`).

To enable the buttons, create an OAuth app with each provider, register
`<AEGIS_PUBLIC_URL>/api/auth/oauth/callback` as the redirect URI, put the client id/secret in
`.env` (see the block in `.env.example`), and restart the backend. Until then the buttons render as
`setup` and name the variables that are still empty, while email sign-in works normally.

Email delivery is not part of this build, which is why there is no "verify your address" step and
no self-service password reset. Both are `TODO`s in the honest sense: the schema has
`emailVerified`, and the reset route needs a mail sender before it can exist.

### Abuse prevention

Every request passes a guard before it reaches a handler (`server/guard.ts`): a token-bucket rate
limit keyed on **both** the claimed account and the client address, a behavioural risk score
(`server/abuse.ts`), and graduated enforcement - `429`, then a cooldown challenge, then a temporary
restriction of writes, then a temporary suspension. Nothing is ever permanently banned automatically,
every decision is written to a bounded, redacted security log (`server/securityLog.ts`), and every
enforcement is reversible from an operator route.

Reading is cheap; creating servers and uploading are priced lowest, because that is what an abuser
wants. `docs/05-abuse-prevention.md` has the bucket table, the signal weights, the configuration, and
an honest list of what is still unproven - including the fact that an unsigned `x-aegis-user` remains
a claim. The account layer now issues real bearer sessions and the handler prefers them over that
header (`AEGIS_REQUIRE_AUTH=1` removes the fallback entirely), but the limiter still treats the
header as a claim so it keeps working for a fresh checkout with no accounts.

### Attachments

Files up to **100 MB each** (ten per message) are uploaded before the message is sent, so a retry
never re-uploads a large file and the composer can show honest per-file progress.

- **Bytes live on disk, not in Postgres.** `server/uploads.ts` writes a blob named by its SHA-256
  plus a small JSON sidecar holding the id, name, type, size and uploader. Identical content is
  stored once; each upload keeps its own record. The default directory is `data/uploads`
  (git-ignored), overridable with `AEGIS_UPLOAD_DIR`.
- **The server decides what an attachment is.** The message POST carries ids only; name, MIME and
  size are read back from the sidecar, so a client cannot relabel a ZIP as `image/png` and get the
  feed to inline it.
- **Inline only for renderable types.** Images, audio, video, PDF and plain text are served
  `inline`; everything else is `Content-Disposition: attachment` with `X-Content-Type-Options:
  nosniff`. The feed previews media, and renders every other file as a download card.
- **Ranges are real.** A 100 MB video is seekable because the endpoint answers `206` with
  `Content-Range` instead of forcing the whole file through memory.

The upload request is the only one that bypasses the JSON body reader: a `Transform` meters the
stream, so a client that lies about `Content-Length` is cut off at the cap rather than trusted.


`npm run server` builds and starts it. Backend configuration (Supabase URL and service-role key,
bind address, `AEGIS_API_KEY`, store kind) is read from the process environment first and only then
from `.env`; on Windows `npm run env:to-user` copies it into the User environment once, after which
`.env` holds only the `VITE_*` values Vite bakes into the renderer. Every key is documented in
[`.env.example`](.env.example). The first request the app makes is `GET /api/workspace`; if the
backend is down the window shows a retry screen rather than an empty rail, because those two
states would otherwise look identical.

Two limits are stated rather than hidden: events use an in-process fan-out (a second backend
instance would not see the first one's events), and identity is a header plus a shared key, which
is appropriate for a local install and is not a substitute for real authentication.

### Visual language

The interface is skinned as a Borderlands item card without changing a route, a control or a layout
box. It is all visual layer, driven by `src/styles/tokens.css`:

- **Flat, never soft.** Every radius is zero; cards and dialogs use `--clip-card`, tabs and badges
  use `--clip-tab`, and shadows are disabled globally. Outlines are one-pixel gold (`#e8a020`).
- **Orange angled tabs.** Panel headers, the selected channel, active settings sections and primary
  actions use solid `--tab` with dark `--tab-ink`. The light theme keeps the same orange tabs while
  darkening `--accent` for gold text that still clears AA.
- **Type.** Barlow Condensed Italic (600/700) is bundled in `src/styles/fonts` for headings,
  usernames and tabs; Barlow 400/600 carries message copy and controls. Both are OFL and loaded via
  `@font-face`, so `font-src 'self'` and offline launch still hold.
- **Item cards.** Attachments and gallery plates get an orange header tab and a gold glyph-led
  metadata row; they are flat cards, never gradients.
- **Signals.** Usernames use the five rarity hues (white, green, blue, purple, orange) through the
  `role-color-*` utilities. Mentions and warnings are coral, timestamps are gold, and unread/mention
  badges are segmented green-on-dark counter tabs.
- **Texture.** A faint 48px gold grid and a low-opacity shield watermark sit on the charcoal
  (`#1c1c20`) surfaces over the muted purple-gray shell. New rows get one short `steps()` static
  flicker; hover and focus snap in ~60ms. Both the texture and the motion are settings, so the
  decoration can be turned off without touching the layout.

Creating a server is a real write, not a toast. `createServer` validates the name, derives a
readable id (`Late Shift` → `late-shift`, suffixed on collision), POSTs it to `/api/guilds` and
installs the workspace the backend returns, so the dialog can route into `#general` in the same
tick. A server created a second ago has **no** history: the welcome banner is the empty state,
because inventing sixty rows for a server the reader just made would be a lie. Owners can create
unlimited-use invite links that expire after seven days and revoke them in server settings.
Recipients can join from the app's Join Server flow by pasting a code or opening an `aegis://`
invite link. Server icons and profile pictures use the same renderer-only pipeline: the file is
cropped and downscaled with `createImageBitmap` + canvas, so no new IPC is needed. A server icon
is stored as a bounded data URL, never a remote reference.

### Customization, roles and voice

**Settings persist.** `src/api/profile.ts` defines a versioned document with bounded fields and a
per-section `.catch()` fallback, so a hand-edited or corrupt `localStorage` entry degrades to that
section's defaults instead of wiping the app. It covers display name, pronouns, bio (http(s) links
render as links, never as HTML), avatar and banner data URLs, accent colours, presence choice,
custom status emoji/text and voice preferences. Servers, roles and server settings are **not**
local: they live in the backend and every change is a `PATCH`. A guild whose channel points outside
its category is dropped by the shared normaliser on arrival, not rendered.

**Appearance is eight independent controls**, all applied by `data-*` attributes on `<html>` (plus
seven measured custom properties for the accent) and resolved entirely in the stylesheets - no inline
style attributes, no user-supplied CSS:

| Control | Values | Effect |
| --- | --- | --- |
| Theme | dark, light, system | `system` follows the OS and keeps following it |
| Accent | theme, six named hues, or any `#rrggbb` | one base hue derives tabs, links, hovers - in every theme |
| Message display | cozy, compact | spacing and avatar size |
| Message text size | small, normal, large | 13 / 14.5 / 16 px copy, independent of density |
| Display typeface | condensed, classic, mono | headings, labels and composer chrome |
| Motion | full, reduced | reduced turns decoration into instant state changes |
| Background texture | grid, plain | the gold grid and shield watermark, or a flat panel |
| Timestamps | system, 12-hour, 24-hour | message times, applied immediately |

The settings document stores names and one validated hex, never a stylesheet fragment: a hand-edited
file cannot inject CSS, and a malformed colour degrades to the theme's own accent. The two readable
shades are computed in `src/theme/accent.ts` rather than in CSS, because contrast is a measurement
and `color-mix()` cannot make one.


Server settings also carry an uploaded 128px icon, a bounded description, a notification policy and
a system channel. The policy is real, not decorative: `mentions` hides plain unread dots and keeps
name pings, while `none` hides every badge for that server and shows a gold muted marker on the
rail. A system channel must be a text or media channel in the same guild; a stale or voice-channel
id is cleared on read instead of dangling in front of the UI.

**Roles are per guild.** `GuildRole` has an id, name, palette index, explicit position and a
`hoist` flag. The member rail groups by the highest hoisted role; names and chips are coloured by
the highest role overall; server settings can create, rename, recolour, hoist, delete and assign
roles. Deleting a role removes every assignment, so the record cannot point at a ghost.

**Permissions and moderation are enforced by the backend.** Roles carry explicit permissions,
channel overrides can allow or deny them, and timed-out members cannot send, react, or join/speak
in voice. Moderators can timeout a member for 1 minute to 28 days, remove a timeout, kick, ban, or
unban. The latest 100 actions are visible in server settings; audit records cannot be edited or
deleted while their server exists.

**Voice calls use peer-to-peer WebRTC.** The backend authorizes voice membership and relays
bounded SDP/ICE signaling only; audio, camera and screen media are sent directly between up to
six participants. Joining requests microphone access, the speaking meter reads local audio, and
the call survives navigation. Mute disables the local audio track; deafen also mutes remote audio.
Camera and screen sharing can be added or stopped during a call. Leaving closes peer connections
and stops every capture track. The backend uses a public STUN server by default; configure
`AEGIS_ICE_SERVERS` with deployment-owned STUN/TURN JSON in the backend environment for reliable
connections through restrictive NATs. TURN credentials are delivered only after an authorized
member joins a voice channel. A TURN service is not bundled or operated by Aegis Shield.

**Search, notifications, and export.** Message search is limited to readable text/media channels
and returns up to 50 matches; selecting a result opens its channel and loads older pages until that
message is in view. Desktop notifications are opt-in, require OS notification permission, and
respect focus, Do Not Disturb, mention-only preferences, and the server's notification policy.
The owner-only JSON export includes server configuration, member metadata, message history, and
attachment metadata; it does not include uploaded file bytes, and there is no restore/import flow.
Back up the backend upload directory separately.


## Analysis target

```
Discord Desktop 1.0.9263  (Win32 x64, Electron 42.7.1)
%LOCALAPPDATA%\Discord\app-1.0.9263\
  Discord.exe   219,698,104 B  sha256 7a84bc6f48118ed4716a7f7bec637e7e5c5208a94edc4600d72f544a0adab2cb
  resources\app.asar   3,635,916 B   bootstrapper      (pkg name: "discord")
  resources\build_info.json           releaseChannel: stable
  modules\                           17 native module packages
    discord_desktop_core-1\discord_desktop_core\
      core.asar        1,832,667 B   desktop core      (pkg name: "discord_desktop_core")
      index.js                42 B    module.exports = require('./core.asar')
      app\images\...                  tray / thumbar / badge assets
```

Total JavaScript on disk: ~4.7 MB
(3,076,973 bootstrapper + 439,665 core + 1,116,629 bridge + 21,149 frame preload + 12,516 splash
driver). None of it is the UI.

## Themes

Nine themes, each in a light and a dark edition. Theme and mode are separate choices (picking
Synthwave while in dark mode gives Synthwave Dark) and both persist; a first visit gets the
Default theme in System mode, which follows the OS live. Changing either plays a white scanline
wipe that reveals the new edition from the top down, and the change is announced to screen
readers.

Tokens are scoped by `data-theme` + `data-mode`; components read the same short names they always
did. `npm run check:contrast` verifies all 322 text/surface pairings across the eighteen editions.
See `docs/themes.md` for the file layout, the token contract and how to add a tenth theme.

Any edition can also be recoloured: the accent field in Settings takes one of the six named hues or
any colour from a picker, and the shades it needs are measured against the current page so text stays
above 4.5:1. See "Accent colour" in `docs/themes.md`.
