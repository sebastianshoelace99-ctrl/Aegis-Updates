# Discord → Aegis Shield feature parity

**Target** Discord Desktop `1.0.9266`, `stable`, Win32 x64 (also present: `1.0.9265`)
**Method** Static, read-only. No process attached, no debugger, no network interception, no code
copied. Shell facts are cited from `01-discord-desktop-re-report.md`.
**Date** 2026-10-29

Every claim is tagged **[SEEN]** (observed in an artifact) or **[INFERRED]** (reasoned from what was
seen, or product behaviour this build does not ship).

---

## 1. Where Discord's features actually live

`01-discord-desktop-re-report.md` §1 established, and `1.0.9266` still holds, that **the chat UI is
not in the install**. The client is a shell: `core.asar` (1,850,985 B) issues one `loadURL` to
`https://stable.discord.com` and the renderer arrives over HTTPS at launch. **[SEEN]**

So a feature diff cannot come from `Discord.exe`. It comes from the one place the renderer exists on
disk: the Chromium HTTP cache.

| Artifact | Observation |
| --- | --- |
| `%APPDATA%\discord\Cache\Cache_Data` | 895 entries, 341.8 MB **[SEEN]** |
| `f_000c8b` | 12,638,758 B, sha256 `5b2afcf1dea50e7e6e98e460cf8dba00101ff37c4610363f7002719de4f7bb1c` — a cached web-app bundle, readable as text **[SEEN]** |

**Coverage limit.** That is one cached chunk which happens to be stored uncompressed. It is a *lower
bound* on Discord's surface, not an inventory: other chunks are compressed and were not decoded, and
nothing here observes Discord's HTTP API or its runtime behaviour. Absence of a token below is not
evidence that Discord lacks the feature.

---

## 2. Measuring the surface

Occurrence counts in `f_000c8b` **[SEEN]**:

| Token | Count | Reads as |
| --- | --- | --- |
| `premiumType` | 117 | the account's Nitro tier, consulted by feature gates |
| `GUILD_BOOST` | 131 | server boosts / levels |
| `Nitro` | 259 | the subscription itself |
| `sticker` / `STICKERS` | 378 / 124 | sticker picker, sticker messages |
| `SOUNDBOARD` | 301 | soundboard (voice) |
| `avatarDecoration` | 109 | avatar decorations |
| `CUSTOM_THEME` | 49 | client themes |
| `profileEffect` | 39 | profile effects |
| `PROFILE_BADGE` | 24 | profile badges |
| `customStatus` | 22 | custom status |
| `SUPER_REACTIONS` | 18 | super reactions |
| `ANIMATED_AVATAR` | 16 | animated avatar |
| `ANIMATED_EMOJI` | 12 | animated emoji |
| `VIDEO_QUALITY` | 8 | stream quality |
| `EMOJI_EVERYWHERE` | 3 | emoji usable outside Nitro guilds |
| `HD_VIDEO` | 1 | HD streaming |

The clearest single observation is a feature-set literal in the bundle **[SEEN]**:

```js
"memberPricing", T="specialStickers", m="superReactions", g="tenureBadge", S="videoBackgrounds"
```

and the profile-customisation field list **[SEEN]**:

```js
banner; bio; pronouns; accentColor; themeColors; profileEffect; profileFrame;
popoutAnimationParticleType; fetch…
```

Nitro upsell surfaces named in the bundle **[SEEN]**: `PREMIUM_UPSELL_ANIMATED_EMOJI`,
`PREMIUM_UPSELL_EMOJI_EVERYWHERE`, `PREMIUM_UPSELL_SOUNDBOARD_EVERYWHERE`,
`PREMIUM_UPSELL_APP_ICONS`, `PREMIUM_UPSELL_MODAL_HD_STREAMING`, `Client Themes`. That set is the
shape of the paywall.

**Not found in this chunk**, and therefore unresolved rather than absent: an explicit `LARGER_UPLOAD`
token, and any decimal upload ceiling (`10485760` / `52428800` / `524288000` do not appear). Upload
limits are **[INFERRED]** to arrive from the API, not the bundle.

---

## 3. The diff against Aegis Shield

Measured by reading this repository, not by assumption.

| Discord feature | Aegis Shield before this pass | Now |
| --- | --- | --- |
| Emoji reactions | **absent** — `reaction` did not appear anywhere in `src/`, `server/`, `shared/` | **implemented** |
| Super reactions (Nitro) | absent | **implemented, ungated** |
| Replies / quote | `replyToId` existed in schema, store and Supabase mapping, but every writer wrote `null` | still modelled, not wired |
| Message edit | `editedAt` existed; the feed already renders "(edited)"; nothing ever set it | still modelled, not wired |
| Custom emoji, stickers | absent | queued |
| Threads | absent | queued |
| Pinned messages | absent | queued |
| Search | absent | queued |
| Soundboard | absent | queued |
| Avatar decoration, profile effect/frame | absent | **implemented, ungated** (local profile) |
| Animated avatar / banner | absent | queued: the canvas pipeline re-encodes to a single WebP frame, so animated input would be silently flattened |
| Server boosts / levels | absent | queued |
| Client themes | **already has 9 themes × light/dark** (`themes.md`) | **out of scope by request** |
| HD streaming | voice exists, no quality selector | queued |

The two most misleading rows are the middle ones. `replyToId` and `editedAt` *look* implemented in the
schema, the store and the Supabase row mapping — and they are dead: `server/store.ts` and
`ChatRoute.tsx` both write `null` into them. A field nothing sets is worse than a missing one,
because it reads as done.

---

## 4. What this pass added

**Reactions, end to end** — the vertical slice, in the order `handoff.md` §2.3 prescribes:

1. `shared/messages.ts` — `reactionSchema`, `MAX_REACTION_KINDS`, `QUICK_REACTIONS`, and
   `toggleReaction()` as a **pure function**. `messageSchema.reactions` uses `.default([])`, so rows
   written before this change still parse.
2. `server/store.ts` + `server/supabaseStore.ts` — `toggleReaction` on the `Store` contract, both
   implementations, answering with the whole updated message.
3. `server/app.ts` — `POST /api/channels/:channelId/messages/:messageId/reactions`.
4. `shared/events.ts` + `src/api/realtime.ts` — a `reaction` event carrying the whole row.
5. `src/api/backend.ts` + `src/api/messages.ts` — the transport.
6. `src/features/chat/MessageFeed.tsx` + `.module.css` — pills, the quick picker, shift-click burst.
7. `Supabase/04-reactions.sql` — the migration.

Two decisions worth keeping:

- **The reply is the whole message, not a delta.** A toggle is not idempotent, so a retrying caller
  cannot know which way its toggle landed unless the server answers with the resulting row. It also
  means the acting window and the SSE echo apply *the same* reducer.
- **The pure function holds the rules.** Double-toggle is a round trip, the last member leaving
  removes the pill, and a removal never sets the burst flag. That last one was a real bug caught in
  this pass: `entry.burst || burst` is true on the way out as well as the way in, so shift-clicking
  your own reaction off turned the glyph into a permanent super reaction. The test was verified red
  against the buggy version before the fix went back in.

---

## 5. Nitro features, free

Policy for this build: **a paywall is a product decision, not a technical one, and this app does not
have one.** Each gated capability maps to "on, permanently, for everyone".

| Discord gate **[SEEN token]** | Here |
| --- | --- |
| `superReactions` | `burst` flag on every reaction, no tier check. Shift-click. |
| `ANIMATED_EMOJI`, `EMOJI_EVERYWHERE` | no restriction exists to lift: the picker is the set |
| `sticker`, `STICKERS` | queued, no gate planned |
| `SOUNDBOARD` | queued, no gate planned |
| `avatarDecoration`, `profileEffect`, `PROFILE_BADGE` | **decoration, effect and frame implemented, ungated**; badges need tenure data the graph does not carry |
| `ANIMATED_AVATAR` | queued: needs the image pipeline reworked first (see §9) |
| `HD_VIDEO`, `VIDEO_QUALITY` | will default to the highest the encoder allows |
| `GUILD_BOOST` / `premiumTier` | deliberately **not** implemented: boosts monetise a server, and there is nothing to monetise |
| `CUSTOM_THEME` | **out of scope by request** — the 9-theme system is untouched |

There is no `premiumType` anywhere in this codebase, and this pass adds none. That is the enforcement
mechanism.

---

## 6. Remaining backlog, by seam

Ordered by cost, each stated as a slice someone can point at:

1. **Replies** — schema and DB already exist. Needs `createMessage(…, replyToId)`, the POST accepting
   it, and a quote line in `Row`. *The cheapest real feature in the list.*
2. **Edit / delete** — `editedAt` already renders. Needs `PATCH`/`DELETE` on a message id, an
   author-only check, and a confirm step.
3. **Pinned messages** — a `pinned` boolean plus a header popover. No new table.
4. **Custom emoji registry** — a guild-scoped table, `:name:` in `renderBody`, and reactions accepting
   an id where they now accept a glyph.
5. **Threads** — the first change needing a genuinely new container (a thread is a channel with a
   parent), so it touches `shared/domain.ts` and the channel list.
6. **Search** — needs a server-side index; the current cursor pagination cannot answer it.
7. **Soundboard, decorations, animated assets** — asset pipelines, no new domain concepts.

---

## 7. Verification

```powershell
npm run typecheck                 # the contract holds on both sides
npm test                          # 258 tests: 239 existing, 11 + 4 reaction cases, 4 cosmetics
npm run build                     # renderer + electron + server
npm run server                    # then, from another shell:
# POST /api/channels/<id>/messages/<id>/reactions  {"emoji":"🔥","burst":true}
```

The new cases are in `shared/reactions.test.ts` (the toggle rules) and `server/reactions.test.ts`
(the real HTTP route). Each names a behaviour a reader would notice, per `handoff.md` §5.2, and the
burst case was confirmed to fail against the pre-fix code per §5.3.

---

## 8. Reproducing the evidence

```powershell
$c = "$env:APPDATA\discord\Cache\Cache_Data\f_000c8b"
$b = [IO.File]::ReadAllBytes($c)
# [Text.Encoding]::Latin1 does not exist on Windows PowerShell 5.1; use the code page.
$s = [Text.Encoding]::GetEncoding(28591).GetString($b)
foreach ($t in @('SUPER_REACTIONS','avatarDecoration','SOUNDBOARD','ANIMATED_AVATAR')) {
  "$t : $(([regex]::Matches($s,$t)).Count)"
}
```

`findstr /S /M /C:"superReaction" "$env:APPDATA\discord\Cache\Cache_Data\*"` locates the chunk
without loading 12 MB into a string first.

---

## 9. Second pass: profile cosmetics

`avatarDecoration` (109 occurrences) and `profileEffect` (39) are the most recognisable Nitro perks
after super reactions, and they fit this codebase unusually well, because the app already refuses
inline styles.

**What shipped**

| Cosmetic | States | Where |
| --- | --- | --- |
| `profile.decoration` | `0` none, `1`–`6` rings | `Avatar` takes a `decoration` prop → `data-decoration` → `Avatar.module.css` |
| `profile.effect` | `0` none, `1`–`5` washes | `ProfileCard` → `data-effect` → `background-image` on the card |
| `profile.frame` | `0` none, `1`–`5` borders | `ProfileCard` → `data-frame` → border and inset shadow |

Three fields on `profileSchema` in `src/api/profile.ts`, three `ChoiceGroup`s in the Appearance panel,
and `hasCosmetics()` for the card to skip empty wrappers.

**Two decisions**

- **Indexes, not values.** Every cosmetic is a small integer, like `accent` before it. The stylesheet
  owns what a ring *looks* like; the settings document only picks a number. That is the same
  constraint that makes a hand-edited settings file unable to inject CSS, and it is why the whole
  feature costs tokens instead of a style attribute.
- **Effects are a card background, not a pseudo-element.** The first attempt used an absolutely
  positioned `::before`; it needs `position: relative` on the card it is inside, and it paints *over*
  the text unless a stacking context is threaded through the dialog. `background-image` on the card
  paints behind every child for free.

**Known limit, stated plainly:** cosmetics are read from the *local* profile document, so only your
own card shows them. Another member's decoration would have to travel on the workspace graph, which
has no such field. That is the same limitation the pre-existing avatar and banner already had; this
pass did not widen it and did not pretend to.

**Deliberately not shipped**

- **Animated avatars** — `readImageFile()` draws the picture onto a canvas and calls
  `toDataURL("image/webp")`, which keeps one frame. Accepting a GIF or animated WebP today would
  flatten it silently, which is worse than refusing it. The fix is to pass animated sources through
  untouched under a size cap, and that is a real change to `src/ui/imageFile.ts`.
- **Soundboard and HD streaming** — both need a media pipeline this app does not have; the voice
  layer joins and meters, it does not carry an encoder. There is no honest UI-only version.
- **Custom emoji and stickers** — the biggest remaining paywall feature. It needs a guild-owned emoji
  registry, `:name:` in `renderBody`, and reactions keyed by emoji id rather than glyph. It is the
  next slice, and it is queued rather than declared done.



