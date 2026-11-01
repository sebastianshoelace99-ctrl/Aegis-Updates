# Supabase setup

Eight SQL files, run once, in this order. There is deliberately **no seed file**: the app starts
with zero servers, and the first one you create is the first row in `guilds`.

## 1. Create the project

1. Open [supabase.com/dashboard](https://supabase.com/dashboard) and create a project.
2. Wait for the database to finish provisioning.

## 2. Run the SQL

Open **SQL Editor → New query** and run each file in full:

| Order | File | What it does |
| --- | --- | --- |
| 1 | [`01-schema.sql`](./01-schema.sql) | Tables, constraints, indexes, the system-channel FK |
| 2 | [`02-rls.sql`](./02-rls.sql) | Enables RLS with no client policies: direct access is denied; the backend's service role is the only reader/writer |
| 3 | [`03-abuse-prevention.sql`](./03-abuse-prevention.sql) | Optional. The rate-limit table, needed only when the backend runs as more than one instance (`AEGIS_RATE_LIMIT_STORE=postgres`) |
| 4 | [`04-reactions.sql`](./04-reactions.sql) | Adds `messages.reactions` (jsonb). Required once, before the first reaction. A row without it still reads as "no reactions", so the app does not break if you skip it - reacting does |
| 5 | [`05-invites.sql`](./05-invites.sql) | Adds expiring, reusable server invites and atomic invite redemption |
| 6 | [`06-guild-ownership.sql`](./06-guild-ownership.sql) | Repairs owner memberships/roles from `guilds.owner_id`, prevents ownership changes, and blocks assigning the reserved owner role to anyone else |
| 7 | [`07-guild-deletion.sql`](./07-guild-deletion.sql) | Adds an atomic server-deletion function that only deletes when the verified caller matches `guilds.owner_id` |
| 8 | [`08-permissions-and-audit.sql`](./08-permissions-and-audit.sql) | Adds role permissions and channel overrides, assigns the default role to existing unassigned members, and creates moderation/search support |

All eight are idempotent (`if not exists` / `drop ... if exists`), so re-running them after an
update is safe.

The desktop app never receives database credentials. Its authenticated backend calls
`aegis_delete_guild` with the signed-in session identity; the function checks that identity against
`guilds.owner_id` before deleting. PostgreSQL cascades the server's channels, messages, memberships,
roles, and invites. The function is executable by `service_role` only, not by `anon` or
`authenticated` clients.

To inspect the recorded creator and creation time for every server, run:

```sql
select
  guild.id as server_id,
  guild.name as server_name,
  guild.owner_id as creator_id,
  member.name as creator_name,
  member.handle as creator_handle,
  guild.created_at
from public.guilds as guild
left join public.members as member on member.id = guild.owner_id
order by guild.created_at;
```

`owner_id` is the backend-verified creator recorded when the server is created. The migration
locks that value against later changes and ensures only that member receives the reserved `owner`
role. If ownership had already been changed before this migration, the database has no audit trail
to recover the original creator; the query shows the currently recorded creator.

## 3. Collect two values

**Project Settings → API:**

- `Project URL` → `SUPABASE_URL`
- `service_role` secret → `SUPABASE_SERVICE_ROLE_KEY`

Paste them into `.env` in the project root and uncomment both lines:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

> The service-role key bypasses RLS and can read/write every row. It belongs to the backend
> process only. Never put it in `VITE_*`, never ship it in the Electron renderer, and never commit
> `.env` (it is git-ignored).

## 4. Prepare a production backend

The desktop client is public software: a value compiled into `VITE_API_KEY` is not a secret.
Production clients authenticate with verified account sessions instead. Set the backend
environment to `NODE_ENV=production` and configure:

```dotenv
AEGIS_REQUIRE_AUTH=1
AEGIS_PUBLIC_URL=https://api.yourdomain.com
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only secret>
AEGIS_AUTH_FILE=/var/lib/aegis/auth.json
AEGIS_UPLOAD_DIR=/var/lib/aegis/uploads
```

Keep the auth file and uploads directory on persistent storage. Run one backend instance for this
deployment: accounts and live-event fan-out are local to the backend process. Terminate TLS at a
reverse proxy you control, proxy requests to the backend, and only set `AEGIS_TRUST_PROXY=1` if
that proxy overwrites `x-forwarded-for`. Never set `VITE_API_KEY` to a database/service key.
Production startup refuses to run with auth disabled, an API shared secret, in-memory workspace
storage, non-HTTPS public URL, or non-absolute auth/upload paths.

## 5. Build clients for the master server

After the backend is deployed and reachable, set the same master API URL for every client build:

```powershell
$env:AEGIS_MASTER_SERVER_URL = "https://api.yourdomain.com"
npm run dist
```

The production build requires public HTTPS, embeds that exact API origin in the renderer CSP,
clears `VITE_API_KEY`, and disables the local dev sign-in bypass. Do not distribute a development
build from `npm run dist:dev`.

## 6. Start the local development backend

```bash
npm run server
```

The first line it prints is the store it selected:

```
[aegis] store: supabase
```

In development, `memory` means at least one Supabase value is missing and the backend has fallen
back to its in-memory store. With `NODE_ENV=production`, the backend refuses to start without
durable Supabase storage.

## 7. Start the local development app

```bash
npm start
```

`npm start` rebuilds the renderer using local `.env` values. Editing `.env` while the app is open
has no effect until the next build.

## What lives where

| Table | Purpose |
| --- | --- |
| `members` | Global identities; one row per person, referenced by messages and memberships |
| `guilds` | Server identity, description, notification policy, icon data URL, system channel |
| `categories` | Ordered channel groups |
| `channels` | `text` / `media` / `voice`, unique slug per guild, FK to its category |
| `guild_members` | Roster order (`joined_at`) |
| `guild_roles` | Per-guild roles with palette index, hoist flag and permission list |
| `guild_moderation_audit` | Immutable moderation action history (removed only when its server is deleted) |
| `guild_member_restrictions` | Active member timeout/ban restrictions |
| `guild_member_roles` | Assignments; composite FKs make a ghost role impossible |
| `messages` | Cursor-ordered history; `(channel_id, created_at desc, id desc)` index |
| `guild_invites` | Hashed invite codes with expiry, revocation and use count |

## Notes and limits

- **Attachment bytes are not in Postgres.** `messages.attachments` is a small JSON array of
  `{ kind: "file", uploadId, name, mime, size }`. The bytes live on the backend host in
  `AEGIS_UPLOAD_DIR` (default `data/uploads`), content-addressed by SHA-256 with one JSON sidecar
  per upload. Back that directory up with the database: a restored database without the files
  renders attachment cards that 404. Supabase Storage is the natural upgrade if you ever need the
  backend to be stateless, and the wire shape would not change - only the URL in
  `src/api/uploads.ts`.
- **One backend process.** Live events use an in-process fan-out over SSE. A second backend
  instance will not see the first one's events. Supabase Realtime is the upgrade path; the event
  envelope in `shared/events.ts` would not change.
- **Trust model.** Local development may use `x-aegis-user` claims without a verified session.
  Production mode requires a verified session for every non-health, non-auth API route and rejects
  the client-shared `AEGIS_API_KEY` pattern.
- **Account identity.** Production API requests require a verified account session; the backend
  uses the identity from that session. The shared `dev` identity is limited to local development
  builds with the sign-in skip explicitly enabled.
- **Deleting a channel deletes its messages** (`on delete cascade`). That is intentional: a
  channel that no longer exists cannot own history.
- **Icons are data URLs**, capped at ~400 kB and restricted to PNG/JPEG/WebP by a check constraint.
  The backend downscales to 128 px WebP before storing, so a real icon is ~10–20 kB.
