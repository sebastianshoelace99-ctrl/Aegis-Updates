# Abuse prevention, rate limiting and bot detection

Status: implemented and tested on the server. Not yet exercised against a hostile client.

This document describes what the backend actually enforces, what it deliberately refuses to do,
how to operate it, and what remains unproven. Read the limitations section before describing the
platform as "protected".

## 0. What this codebase is, and what it is not

The backend is a framework-free `node:http` server (`server/`) with no runtime dependencies. Before
this change it had:

- no authentication - `x-aegis-user` is a **client-claimed id**, validated only for shape;
- no login, registration, search, friend-request or direct-message endpoints;
- no moderation system. The only "watchdog" in the repository is the Electron startup timer in
  `docs/02-aegis-shield-architecture.md`, which is unrelated;
- no rate limiting of any kind.

So this is not an integration with an existing bot-defence product. It is a server-side control
layer built on the endpoints that exist (`/api/guilds`, `/api/channels/:id/messages`,
`/api/uploads`, `/api/typing`, `/api/presence`, `/api/events`), plus a moderation *seam* that a real
Watchdog service can implement without any change to the detector.

## 1. Request pipeline

Every request goes through the same order (`server/app.ts`):

1. CORS headers (so a browser can read an error).
2. `OPTIONS` preflight answered.
3. `GET /api/health` - unauthenticated, unthrottled on purpose: a health probe must not be able to
   take the service out of a load balancer.
4. Shared secret (`x-aegis-key`), compared in constant time.
5. **Guard** (`server/guard.ts`): rate limit, risk assessment, enforcement.
6. Router, then the handler, which still performs its own ownership/authorization checks.
7. `finally`: concurrency counter released.

The guard runs **before any body is read**, so a refused request costs no parsing and no database
work.

## 2. Rate limiting

`server/rateLimit.ts` implements a **token bucket** per key:

| knob | meaning |
| --- | --- |
| `burst` | requests allowed back-to-back from idle |
| `perMinute` | sustained refill (tokens per millisecond internally) |

A fixed window was rejected because it lets a client spend a full allowance at 00:59 and again at
01:00, and because `Retry-After` then lies.

### Buckets and defaults

| bucket | route | burst | per minute | expensive |
| --- | --- | --- | --- | --- |
| `read:workspace` | `GET /api/workspace` | 20 | 60 | no |
| `read:messages` | `GET /api/channels/:id/messages` | 60 | 120 | no |
| `write:messages` | `POST /api/channels/:id/messages` | 8 | 30 | no |
| `read:uploads` | `GET/HEAD /api/uploads/:id` | 60 | 240 | no |
| `write:uploads` | `POST /api/uploads` | 4 | 10 | **yes** |
| `create:guilds` | `POST /api/guilds` | 3 | 5 | **yes** |
| `write:guilds` | `PATCH /api/guilds/:id` | 10 | 30 | no |
| `write:realtime` | `POST /api/typing`, `/api/presence` | 20 | 120 | no |
| `connect:events` | `GET /api/events` (SSE) | 10 | 60 | no |
| `admin` | `/api/security/*` | 30 | 60 | **yes** |
| `appeal` | `/api/security/appeals` | 2 | 5 | no |
| anonymous | any route without a valid identity | 5 | 10 | - |
| anonymous global | any route, cross-endpoint | 20 | 40 | - |

Tuning is one table: `DEFAULT_RULES` in `server/guard.ts`, overridable per bucket through
`createRequestGuard({ rules })`.

### What a key is

- **Authenticated (claimed):** `acct:<bucket>:<accountId>` **and** `ip:<bucket>:<address>`. Both are
  consumed; the stricter answer wins.
- **Anonymous:** `ip:<bucket>:<address>` with the anonymous rule, plus `ip:*:<address>` so switching
  endpoints does not mint a fresh allowance.
- **New accounts** (first seen by this process less than 10 minutes ago) get half the configured
  burst and rate.

Because the address bucket is always spent too, **changing `x-aegis-user` does not reset anything**
- that is the specific evasion the composite key exists to defeat, and `server/guard.test.ts` proves
it.

### The two ways a limiter silently stops limiting

1. **Evicting a live bucket.** With a bounded map, minting a key per request would evict real
   buckets and hand out a fresh burst each time. When `maxKeys` is reached, new keys share one
   overflow bucket instead: the limit degrades to a global one, it never resets.
2. **Trusting a client-supplied address.** `x-forwarded-for` is ignored unless
   `AEGIS_TRUST_PROXY=1`. Otherwise a caller invents a new address per request.

### Responses

`429` with `Retry-After: <seconds>` and:

```json
{ "error": "Too many requests. Try again in 7 seconds.", "code": "rate_limited", "retryAfterSeconds": 7 }
```

No bucket name, no limit, no score. `retry-after` is added to
`Access-Control-Expose-Headers` so the renderer can pace itself.

## 3. Detection

`server/abuse.ts` scores behaviour in a 10-minute rolling window. Signals, weights and caps:

| signal | fires when | weight | ip-only |
| --- | --- | --- | --- |
| `rate_limit_hits` | 3+ rejections in the window | `min(36, hits × 6)` | no |
| `repeated_messages` | 5+ identical bodies in one channel | `min(65, 15 + (n − 5) × 10)` | no |
| `auth_failures` | 3+ bad shared-secret attempts | `min(30, n × 10)` | no |
| `guild_churn` | more than 4 server creations | 14 | no |
| `concurrency` | more than 12 in-flight requests | 12 (once per window) | no |
| `new_account` | account younger than 10 minutes | 8 | no |
| `prior_strikes` | a restriction in the last hour | `min(30, strikes × 15)` | no |
| `identity_rotation` | more than 3 claimed ids from one address | 25 | **yes** |

Identical bodies are compared by a truncated SHA-256, never by storing the text.

### The rule that keeps shared networks safe

`identity_rotation` is derived from the address, so it is tagged `ipOnly`. If **every** signal for a
request is `ipOnly`, the level is forced to `allow`, and the assessment is still logged as a
`risk_flag` so it is auditable. Concretely:

- five students behind one campus NAT: rotation fires, score 25, **no action**;
- two people sharing a home address: nothing fires;
- rotation **plus** one rate-limit rejection: `challenge` (`server/abuse.test.ts` covers all three).

Address, user agent and VPN use are not inputs at all. Nothing in this module reads a `User-Agent`.

## 4. Graduated enforcement

`assess()` returns a score and a level; `escalate()` is the only thing that writes a restriction, and
it can only ever write a **restriction** - never an action. The handler still owns authorization, so
a bug in the detector cannot become a privilege escalation.

| score | level | what the user experiences |
| --- | --- | --- |
| < 40 | `allow` | nothing |
| 40-64 | `challenge` | `428` with a one-time challenge; a 3-second cooldown before it can be redeemed |
| 65-84 | `restrict` | `403` on `write:messages`, `write:uploads`, `create:guilds`, `write:guilds` for 15 minutes; reading unaffected |
| ≥ 85 | `suspend` | `403` on every action for 60 minutes |

Notes:

- The `throttle` rung of the ladder is the `429` itself; it has no separate stored state.
- `GET /api/events` is rate limited but **never escalated**: the renderer reconnects a long-lived
  stream, and a `428` there has nowhere to be solved, so challenging it would silently kill live
  updates. The renderer also honours `Retry-After` when it is refused (capped at 30 s).
- A restriction is **never permanent**: `until` is always finite, and `restrictionFor` deletes it on
  read once it has expired.
- Escalation is idempotent - a second call returns the existing `until` rather than extending it.
- Repetition alone is capped below `restrictAt + 8`, so a single noisy signal can reach a
  restriction but never a suspension. Suspension needs corroboration.

### The challenge is a cooldown, not a CAPTCHA

`POST` responses may carry `428` plus `x-aegis-challenge: <uuid>`. The token becomes redeemable after
3 seconds and is single-use. This raises the cost of a naive loop without asking a person to solve a
puzzle, and it is **not** a human-verification test. To add a real provider, replace `verify()` in
`createChallengeLedger` with a server-side hCaptcha/Turnstile call; nothing else changes.

## 5. Moderation seam

There is no existing Watchdog moderation system to integrate with, so this is a contract rather than
an integration:

```ts
type ModerationSink = { report(incident: ModerationIncident): void | Promise<void> };
```

An incident carries: case id, timestamp, account id, **keyed** address, level, score, bucket and the
signal ids with their weights. It carries **no message content and no command**, so forwarding it
cannot leak conversation data and cannot execute anything.

Implementations shipped:

- `createModerationQueue()` - bounded in-process review queue behind the admin routes (default);
- `createWebhookModerationSink(url)` - fire-and-forget POST, 2 s timeout, failures swallowed so a
  down moderation service cannot break a user's request. Enabled by `AEGIS_MODERATION_WEBHOOK`.

Operator actions are all reversible and attributed (`server/abuse.ts`):

- `POST /api/security/overrides` with `{ accountId, decision: "clear" | "restrict" | "suspend", minutes, reviewer }`;
- `GET /api/security/cases` - incidents plus appeals, newest first;
- every override is written to the security log as `kind: "override"` with the reviewer.

Users can request a human with `POST /api/security/appeals` (`{ message }`), which requires a claimed
identity and returns `202` with a case id.

## 6. Logging

`server/securityLog.ts` keeps a bounded ring buffer (5,000 events, 7-day retention by default) of:

`kind`, `at`, `bucket`, `accountId`, `ipHash`, `count`, `threshold`, `reason`, `action`, `detail`.

What it refuses to store:

- message bodies, file names, appeal text (appeal text lives only on the case, not in the log);
- tokens, passwords, API keys, `authorization`, cookies, sessions - filtered by key name **and**
  restricted to scalar values, so a nested object cannot smuggle a secret past the filter;
- the raw client address. `ipHash` is an HMAC-SHA256 with `AEGIS_LOG_SALT`, or a random per-process
  key when unset. A plain SHA-256 of an IPv4 address is a 4.3-billion-row lookup table.

Admin views (`x-aegis-admin`, and only when `AEGIS_ADMIN_KEY` is set):

| route | returns |
| --- | --- |
| `GET /api/security/summary` | tracked accounts/addresses, active restrictions, pending cases, event count, 20 recent events |
| `GET /api/security/events?limit=&kind=&accountId=` | paged events, newest first, clamped to 200 |
| `GET /api/security/cases` | incidents and appeals, up to 100 |

A missing or wrong admin key answers **404**, not 401: an endpoint that confirms it exists is an
endpoint worth probing. No route returns a threshold, a score or the policy.


## 7. Configuration

All optional; the defaults are the safe ones.

| variable | default | effect |
| --- | --- | --- |
| `AEGIS_RATE_LIMIT` | on | `off` disables limiting and enforcement (logs a warning at boot) |
| `AEGIS_RATE_LIMIT_STORE` | `memory` | `postgres` shares bucket state between instances (needs `03-abuse-prevention.sql`) |
| `AEGIS_RATE_LIMIT_FAIL_MODE` | `closed` | `open` allows expensive work when the store is unreachable |
| `AEGIS_TRUST_PROXY` | off | `1` honours `x-forwarded-for`; only set behind a proxy you control |
| `AEGIS_ADMIN_KEY` | empty | enables `/api/security/*`; empty keeps it at 404 |
| `AEGIS_MODERATION_WEBHOOK` | empty | forwards incidents to an external moderator |
| `AEGIS_LOG_SALT` | random per process | keeps `ipHash` linkable across restarts |

### Fail-safe behaviour

If the limit store throws (Supabase down, timeout, 5xx):

- **expensive buckets** (`create:guilds`, `write:uploads`, `admin`) answer `503` with
  `code: "unavailable"` and `Retry-After: 5`;
- **cheap buckets** (reads, message writes) fail **open**, because taking chat read-only during a
  Supabase blip is worse than briefly weakened limits;
- either way a `degraded` event is written to the security log, so the decision is auditable.

## 8. Isolation guarantees

- **Idempotency:** `Idempotency-Key` on `POST /api/channels/:id/messages`. Same key + same effective
  request (`author`, `channel`, `body`, attachments) replays the stored message; same key + different
  content is `422`; same key while the first is in flight is `409`; a failed send releases the key.
- **Body limits:** 1.2 MB JSON cap (`readJson`), 100 MB upload cap enforced by a metering transform
  that does not trust `Content-Length`.
- **Bounded everything:** ring buffers, moderation queue (500), idempotency ledger (1,000, 10 min),
  detector maps (10,000 keys, oldest-quarter eviction), challenge ledger (5,000).
- **Pagination:** messages clamp `limit` to 1..100; security events clamp to 1..200.

## 9. Tests

`npm test` (Vitest, `environment: "node"`), 63 new tests across four files:

| file | covers |
| --- | --- |
| `server/rateLimit.test.ts` (11) | burst/sustained arithmetic, refill, idle cap, backwards clock, shared store, overflow instead of eviction, Postgres RPC mapping, RPC failure |
| `server/securityLog.test.ts` (8) | secret/payload/nested-value redaction, keyed address, newest-first filters, ring cap, retention, timestamp validation |
| `server/abuse.test.ts` (25) | every signal, window expiry, strike decay, IP-only never punishes, shared address safe, rotation + corroboration, all four levels, idempotent escalation, expiry, anonymous cannot be restricted, appeals, overrides, challenge cooldown/one-shot |
| `server/guard.test.ts` (19) | 200 then 429 with `Retry-After`, health exempt, identity rotation ineffective, anonymous rule, shared store across two handlers, guild-churn budget, restriction blocks writes not reads, `428` challenge shape, stream limited but never challenged, suspension, admin 404/200, appeals, idempotent send, in-flight retry, fail-closed/fail-open |

Not automated yet: a multi-process test that starts two real servers against one Postgres database.
The Postgres store is unit-tested against a stubbed RPC, and shared-state behaviour is proven at the
store interface, but the network path needs a staging database.

## 10. Deployment requirements

1. **Run `Supabase/01-schema.sql`, then `02-rls.sql`.** Without them every store call 404s; that is a
   pre-existing gap, not something this change introduces.
2. **Run `03-abuse-prevention.sql` only if** you set `AEGIS_RATE_LIMIT_STORE=postgres`.
3. **Set `AEGIS_ADMIN_KEY`** to a long random value, or leave it empty and read the log from the
   process. Do not reuse `AEGIS_API_KEY`; they authorize different things.
4. **Set `AEGIS_LOG_SALT`** if you need `ipHash` correlation across restarts.
5. **Rotate `SUPABASE_SERVICE_ROLE_KEY`** if it has ever been pasted into a chat, a log or a commit.
6. **Set `AEGIS_TRUST_PROXY=1` only** when a proxy you control overwrites `x-forwarded-for`.
7. If `03` was applied, schedule `select aegis_rate_limit_sweep();` daily.


## 11. Limitations - read before claiming this is secure

1. **Identity is still a claim.** `x-aegis-user` is not authenticated. Rate limits hold because they
   also key on the address, but *attribution* is not trustworthy: an attacker can wear any id. Real
   per-account enforcement needs Supabase Auth in front (see `Supabase/README.md`); at that point
   `claimedAccountId` reads a verified subject instead of a header.
2. **Restrictions and cases are process-local.** They are not persisted, so a restart clears them.
   That is fail-safe (it cannot lock anyone out permanently) but it is not durable. Persisting them
   means a `restrictions` table plus a read-through cache; the interface is already shaped for it.
3. **The in-memory limit store is per process.** With more than one instance, use `postgres`.
4. **The challenge is not a CAPTCHA.** It proves patience, not humanity.
5. **`repeated_messages` is per-channel and in memory.** A spammer who rotates channels, or restarts
   the server between bursts, is only caught by the rate limiter.
6. **Account age resets with the process** (`firstSeen` is in memory), so a restart re-applies the
   new-account penalty to everyone. That errs stricter, never looser.
7. **No defence against a botnet with one request per address.** That is what the challenge and the
   moderation queue are for; it is not something a per-address limiter can see.
8. **False positives are possible**, especially for a client that retries hard on a flaky connection.
   They are recoverable: restrictions expire, every decision is logged, and an operator can clear one
   immediately with an override.

None of this has been validated against a real hostile client. The controls are implemented and
tested against simulated abuse; treat "secure" as unproven until a red-team run and the deployment
items above are complete.

