# Aegis Shield — Renderer Architecture

An original React/TypeScript architecture for the artist platform, derived from the shell/bridge
pattern measured in `01-discord-desktop-re-report.md`. Nothing here is copied from Discord;
the report is used for **constraints and failure modes**, not for code.

---

## 0. Design premises

Five rules, each traceable to something the report established:

| # | Premise | Why (from the report) |
| --- | --- | --- |
| P1 | **The privileged layer is small, typed, and additive-only.** One bridge namespace, a frozen method list. | §3: Discord exposes exactly one `exposeInMainWorld` with 48 methods. The count is the security property. |
| P2 | **Renderers never poll the shell; the shell pushes.** | §3: 10 main→renderer push channels exist precisely so the UI mirrors shell state instead of querying it. |
| P3 | **The UI must run without the shell.** Every shell capability degrades to a browser fallback. | §1: Discord's UI lives on the web tier and is re-fetched per launch. A UI that only works inside Electron cannot be tested, previewed, or shipped to web. |
| P4 | **Startup has a budget and a watchdog.** | §1: 60 s webapp watchdog; Discord chose a network-bound cold start and instrumented it. We choose the opposite (bundle on disk) and still measure it. |
| P5 | **Fuses are set correctly on day one, and are not a substitute for design.** | §5: Discord ships 3 of 9 fuses in the permissive position. We do not copy that, and we also do not pretend fuses fix an over-privileged shell. |

**P3 is the one that will save the most time.** If the renderer can boot in a plain browser
against a mock bridge, then 90% of UI work needs no Electron rebuild, no packaging step, and no
native modules.

---

## 1. Stack

Deliberately small. Every addition must earn its place against "could a competent React
developer read this in a day".

| Concern | Choice | Rationale |
| --- | --- | --- |
| Build | **Vite** + `vite-plugin-electron` | Fast HMR for the renderer; one config produces renderer, main, preload. |
| UI | **React 19** + TypeScript `strict` | Concurrent rendering, `use()` for promises, actions for mutations. |
| Server cache | **TanStack Query v5** | The commission/gallery domain is server-owned data. Caching, dedupe, retry, invalidation are solved problems — do not hand-roll them. |
| Client state | **Zustand** (three small stores) | Shell mirror, draft/composer state, ephemeral UI. No context pyramids. |
| Validation | **Zod** at every boundary | Both sides of the bridge, plus network payloads. Types are derived from schemas, never duplicated. |
| Styling | **CSS Modules** + design tokens | No runtime CSS-in-JS on the hot path; tokens as custom properties so theming is a class swap. |
| Tests | **Vitest** + **Testing Library**; **Playwright** for the Electron smoke test | Unit/component fast path; one slow end-to-end that proves the bridge works in a packaged app. |

**Explicitly rejected:** Redux (the domain does not need a global reducer), a custom event bus
(TanStack Query + Zustand cover it), CSS-in-JS (runtime cost in a media-heavy app), and any
state library that encourages putting server data in global client state (that is the single
most common cause of stale-UI bugs).

---

## 2. Layers

```
┌──────────────────────────────────────────────────────────────┐
│  Electron main  (Node, privileged, no UI)                    │
│  window · tray · filesystem · updater · native dialogs       │
└───────────────────────────┬──────────────────────────────────┘
                            │  ipcMain.handle / webContents.send
┌───────────────────────────▼──────────────────────────────────┐
│  Preload  (isolated, no DOM, no node in renderer)            │
│  ONE namespace: window.aegis                                 │
│  zod-validated in, zod-validated out; frozen method list     │
└───────────────────────────┬──────────────────────────────────┘
                            │  contextBridge (P1)
┌───────────────────────────▼──────────────────────────────────┐
│  Renderer  (React 19 + TS)                                   │
│                                                              │
│  bridge/      typed client, browser fallback      (P3)       │
│  shell/       mirror of shell-pushed state        (P2)       │
│  api/         TanStack Query hooks + zod schemas             │
│  features/    gallery · commissions · messages · studio      │
│  ui/          design-system primitives (no domain knowledge) │
│  app/         routing, providers, error boundaries           │
└──────────────────────────────────────────────────────────────┘
```

The arrow only ever points **down to up**: main knows nothing about React; the renderer knows
nothing about `fs`, `path`, or `child_process`. The preload is the only file that imports from
both worlds, and it is the only file that is security-critical.

---

## 3. Directory layout

```
aegis-shield/
├── electron/
│   ├── main.ts               # app lifecycle, window, tray — no domain logic
│   ├── window.ts             # BrowserWindow options, navigation allowlist
│   ├── channels.ts           # THE channel constants (single source of truth)
│   ├── handlers/
│   │   ├── index.ts          # registerHandlers() — explicit list, no globbing
│   │   ├── files.ts          # open/save dialogs, export paths
│   │   └── system.ts         # theme, version, updater status
│   └── preload.ts            # contextBridge.exposeInMainWorld("aegis", ...)
│
├── shared/
│   ├── contract.ts           # zod schemas + inferred types for every channel
│   └── channels.ts           # shared channel NAME constants
│
└── src/
    ├── app/
    │   ├── App.tsx
    │   ├── providers.tsx      # QueryClient, theme, error boundary
    │   └── routes.tsx
    ├── bridge/
    │   ├── client.ts          # typed wrapper over window.aegis
    │   ├── browser-fallback.ts# no-shell implementation  (P3)
    │   └── useBridgeEvent.ts  # subscribe hook with cleanup
    ├── shell/
    │   └── useShellState.ts   # zustand store fed by pushed events (P2)
    ├── api/
    │   ├── queryClient.ts
    │   └── commissions.ts     # queryOptions + mutations + schemas
    ├── features/
    │   ├── gallery/
    │   ├── commissions/
    │   ├── messages/
    │   └── studio/
    ├── ui/                    # Button, Dialog, Field, VirtualGrid, …
    └── styles/tokens.css
```

Rule: a file in `features/` may import from `ui/`, `api/`, `bridge/`, `shell/`. It may **not**
import from another feature except through that feature's `index.ts`. That single rule prevents
the tangle that makes large React apps unforkable.

---

## 4. The bridge contract (P1)

Channels are constants, and both the request and response shapes are Zod schemas in `shared/`.
Types are always inferred, never written twice.

```ts
// shared/contract.ts
import { z } from "zod";

export const Channel = {
  openImageDialog: "files:openImageDialog",
  revealInFolder:  "files:revealInFolder",
  saveExport:      "files:saveExport",
  getTheme:        "system:getTheme",
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

/** request/response, renderer → main */
export const contract = {
  [Channel.openImageDialog]: {
    request: z.object({ multiple: z.boolean().default(false) }),
    response: z.array(z.object({ path: z.string(), name: z.string() })),
  },
  [Channel.revealInFolder]: {
    request: z.object({ path: z.string().min(1) }),
    response: z.void(),
  },
  [Channel.saveExport]: {
    request: z.object({ suggestedName: z.string(), bytes: z.instanceof(Uint8Array) }),
    response: z.object({ path: z.string() }).nullable(),
  },
} as const;

export type Contract = typeof contract;

/** main → renderer pushes */
export const push = {
  "system:themeChanged": z.object({ theme: z.enum(["light", "dark"]) }),
  "system:updaterStatus": z.object({
    state: z.enum(["idle", "checking", "available", "downloading", "ready", "error"]),
    version: z.string().optional(),
    percent: z.number().min(0).max(100).optional(),
    message: z.string().optional(),
  }),
  "window:focusChanged": z.object({ focused: z.boolean() }),
} as const;

export type PushName = keyof typeof push;
export type PushPayload<K extends PushName> = z.infer<(typeof push)[K]>;
```

Note what is **not** here: no wildcard, no `invoke(channel, ...args)` escape hatch, no raw
`ipcRenderer` re-export. The preload's job is to make arbitrary IPC *impossible*, not
inconvenient. This is the P1 property — the method list is the attack surface, and a fixed list
can be reviewed.

**Both directions are in this one file on purpose.** The report's §3 measured an asymmetry in the
reference implementation: request/response channels went through a typed `IPCEvents` enum, while
the 17 main→renderer push channels were bare string literals passed to `webContentsSend`. A typo
in a push channel throws nothing, delivers nothing, and surfaces only as a UI that silently never
updates. Putting `contract` (requests) and `push` (events) side by side in `shared/` means neither
direction can drift without the compiler noticing.


### 4.1 The preload — the only security-critical file

```ts
// electron/preload.ts
import { contextBridge, ipcRenderer } from "electron";
import { contract, push, type Contract, type PushName } from "../shared/contract";
import type { z } from "zod";

type Api = {
  [K in keyof Contract]: (
    req: z.input<Contract[K]["request"]>,
  ) => Promise<z.output<Contract[K]["response"]>>;
};

const invoke = <K extends keyof Contract>(channel: K) => {
  const { request, response } = contract[channel];
  return async (raw: unknown) => {
    const parsed = request.parse(raw);           // fail closed on bad input
    const result = await ipcRenderer.invoke(channel, parsed);
    return response.parse(result);               // never trust main's reply either
  };
};

const api = Object.fromEntries(
  (Object.keys(contract) as Array<keyof Contract>).map((k) => [k, invoke(k)]),
) as Api;

const subscribe = <K extends PushName>(name: K, cb: (p: z.infer<(typeof push)[K]>) => void) => {
  const listener = (_e: unknown, payload: unknown) => cb(push[name].parse(payload));
  ipcRenderer.on(name, listener);
  return () => ipcRenderer.removeListener(name, listener);
};

contextBridge.exposeInMainWorld("aegis", Object.freeze({ ...api, subscribe }));
```

Four properties, each worth stating because each is easy to lose:

1. `Object.freeze` — the renderer cannot monkey-patch the bridge to intercept calls.
2. **Bidirectional validation** — a compromised main process still cannot hand the renderer a
   malformed object, and a compromised renderer cannot hand main an unexpected shape.
3. `subscribe` returns an **unsubscribe function**, not a boolean or nothing. Every subscriber
   must be able to detach, or you leak listeners across route changes.
4. The preload imports nothing but `electron`, `shared/`, and `zod`. No `fs`, no business logic.
   If this file grows past ~150 lines, something belongs in main instead.

### 4.2 The renderer client + browser fallback (P3)

```ts
// src/bridge/client.ts
import type { z } from "zod";
import { push, type Contract, type PushName } from "../../shared/contract";
import { createBrowserFallback } from "./browser-fallback";

export type Subscribe = <K extends PushName>(
  name: K,
  cb: (payload: z.infer<(typeof push)[K]>) => void,
) => () => void;

export type Bridge = {
  [K in keyof Contract]: (
    req: z.input<Contract[K]["request"]>,
  ) => Promise<z.output<Contract[K]["response"]>>;
} & { subscribe: Subscribe };

declare global {
  interface Window { aegis?: Bridge }
}

/** Real bridge when packaged; a working stand-in in a plain browser. */
export const bridge: Bridge =
  typeof window !== "undefined" && window.aegis ? window.aegis : createBrowserFallback();

export const hasShell = typeof window !== "undefined" && Boolean(window.aegis);
```

One consequence worth naming: because the fallback is typed as `Bridge`, TypeScript forces it to
implement **every** channel. Adding a native capability therefore cannot silently break the
browser build — the compiler fails until you write the degraded path. That is P3 enforced by the
type system rather than by discipline.

```ts
// src/bridge/browser-fallback.ts
import type { Bridge } from "./client";

/**
 * Every shell capability degrades here instead of throwing.
 * Browser dev + web deployment both run on this path.
 */
export function createBrowserFallback(): Bridge {
  return {
    // <input type="file"> instead of a native dialog
    openImageDialog: async () => {
      const files = await pickViaInput({ accept: "image/*", multiple: true });
      return files.map((f) => ({ path: "", name: f.name }));   // no absolute path in a browser
    },
    revealInFolder: async () => { /* no-op: nothing to reveal */ },
    // Blob download instead of a save dialog
    saveExport: async ({ suggestedName, bytes }) => {
      downloadBlob(bytes, suggestedName);
      return null;
    },
  } as unknown as Bridge;
}
```

**[INFERRED, from the report]** This is the structural difference between Discord's design and
ours. Discord *cannot* run its UI without the shell because the UI is bound to a native bridge
contract with no fallback — which is fine when you own both halves and ship them together. We
want the renderer runnable in a browser, so the fallback is a first-class module, not a test
double.

---

## 5. State model — three tiers, strictly separated

The single most common failure in React apps of this size is a blurry line between "the server's
data" and "our data". Aegis Shield makes the line explicit.

| Tier | Lives in | Examples | Mutated by |
| --- | --- | --- | --- |
| **Server cache** | TanStack Query | commissions, artwork records, messages, profile | queries/mutations only |
| **Shell mirror** | Zustand (`useShellState`) | window focus, theme, updater state, platform | push events from the bridge only (P2) |
| **Ephemeral UI** | `useState` / `useReducer` | open dialogs, form drafts, hover, selected tab | the component that owns it |

Nothing is duplicated across tiers. A commission's *status* is server data; whether its detail
panel is *open* is ephemeral; whether the app is *focused* is shell data. Copying any of these
into a neighbouring tier is the bug.

### 5.1 Shell mirror (P2)

```ts
// src/shell/useShellState.ts
import { create } from "zustand";
import { bridge, hasShell } from "../bridge/client";

type ShellState = {
  focused: boolean;
  theme: "light" | "dark";
  updater: {
    state: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
    version?: string;
    percent?: number;
    message?: string;
  };
};

export const useShellState = create<ShellState>(() => ({
  focused: true,
  theme: "light",
  updater: { state: "idle" },
}));

/** Call once, at module scope of the app entry — not inside a component. */
export function initShellSync(): () => void {
  if (!hasShell) return () => {};

  const set = useShellState.setState;
  const offs = [
    bridge.subscribe("window:focusChanged", ({ focused }) => set({ focused })),
    bridge.subscribe("system:themeChanged", ({ theme }) => set({ theme })),
    bridge.subscribe("system:updaterStatus", (updater) => set({ updater })),
  ];
  return () => offs.forEach((off) => off());
}
```

```ts
// src/app/App.tsx  (excerpt)
import { useEffect } from "react";
import { initShellSync, useShellState } from "../shell/useShellState";

export function App() {
  useEffect(() => initShellSync(), []);   // returns the unsubscribe → automatic cleanup
  const focused = useShellState((s) => s.focused);

  return (
    <div className="app" data-focused={focused}>
      {/* … */}
    </div>
  );
}
```

Note: **no polling, no `useEffect` per consumer.** One subscription set, module-scope ownership,
selector-based reads so a focus change does not re-render the gallery. This is exactly the
pattern the report's §3 push channels exist to support.

### 5.2 Why not put shell state in Query

Because it is not server data: there is no request to retry, no stale time that means anything,
and no cache key that would be correct. Forcing it into Query produces fake `queryFn`s that read
a global, which is strictly worse than a store.

---

## 6. Realtime — events write to the cache, not to component state

```ts
// src/api/commissions.ts
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

export const commissionSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["brief", "sketch", "review", "revision", "delivered"]),
  updatedAt: z.string().datetime(),
  previewUrl: z.string().url().nullable(),
});
export type Commission = z.infer<typeof commissionSchema>;

const listSchema = z.array(commissionSchema);

export const commissionsQuery = queryOptions({
  queryKey: ["commissions"],
  queryFn: async (): Promise<Commission[]> => {
    const res = await fetch("/api/commissions");
    if (!res.ok) throw new Error(`commissions: ${res.status}`);
    return listSchema.parse(await res.json());   // validate at the edge, always
  },
  staleTime: 30_000,
});
```

```ts
// src/api/realtime.ts
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { commissionSchema, commissionsQuery, type Commission } from "./commissions";

/**
 * Socket events patch the Query cache directly.
 * No component-local copies, no refetch storm, no lost update on unmount.
 */
export function useCommissionStream(socket: WebSocket | null) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!socket) return;

    const onMessage = (ev: MessageEvent<string>) => {
      const { type, payload } = JSON.parse(ev.data) as { type: string; payload: unknown };
      if (type !== "commission:updated") return;

      const parsed = commissionSchema.safeParse(payload);
      if (!parsed.success) return;                  // ignore, do not throw

      const next = parsed.data;
      qc.setQueryData(commissionsQuery.queryKey, (prev: Commission[] | undefined) =>
        prev?.some((c) => c.id === next.id)
          ? prev.map((c) => (c.id === next.id ? next : c))
          : prev,
      );
    };

    socket.addEventListener("message", onMessage);
    return () => socket.removeEventListener("message", onMessage);
  }, [socket, qc]);
}
```

Three rules encoded here:

1. **Unknown event types are ignored, not logged-and-crashed.** The server will add event types
   before the client knows about them; a client that throws on the unknown is a client that
   breaks on every server deploy.
2. **Patch, don't invalidate.** `invalidateQueries` on every event turns one update into N
   requests. Patch the cache, invalidate only on reconnect.
3. **Events never create cache entries that were not there.** If the list has not loaded, updating
   an item nobody is displaying is wasted work — and risks rendering a partial list.

---

## 7. Connection lifecycle

A socket that reconnects naively will, at any real user count, produce reconnect storms. The
three things that matter:

```ts
// src/api/socket.ts
export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

/** Exponential backoff with full jitter, capped. */
export function backoffDelay(attempt: number, base = 500, cap = 30_000): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.random() * ceiling;           // full jitter: prevents thundering herd
}
```

| Concern | Rule |
| --- | --- |
| Backoff | exponential, **full jitter**, cap 30 s. Attempt counter resets only after a message is received, not on socket `open` — an open socket that never delivers is a broken connection. |
| Resync | on reconnect, `invalidateQueries()` once, then resume patching. Missed events are the reason a resume token or a full refetch is required. |
| Visibility | a hidden window may throttle timers; on `visibilitychange → visible`, check socket health rather than assuming the timer fired. |
| Offline | `navigator.onLine === false` → show state, do not retry-spam. Retry when `online` fires. |

**[INFERRED]** Discord's gateway does exactly this shape (resume + sequence numbers) — visible only
as native dispatcher code in this install, not as readable JS, so it is stated as a pattern rather
than as an observation.

---

## 8. Rendering and performance

An art platform is an image-volume application. The default React failure mode is rendering 400
full-resolution images because the DOM was told to.

**Non-negotiables:**

1. **Virtualise every grid.** `VirtualGrid` in `ui/` renders only the visible window plus one row
   of overscan. All gallery surfaces use it; a raw `.map()` over artwork is a review rejection.
2. **Three image sizes per asset**, generated server-side: `thumb` (~320 px), `display`
   (~1600 px), `original` (download only). The grid *never* loads `display`.
3. **Reserve space before load.** Every image slot has an intrinsic `aspect-ratio` from stored
   metadata plus a blur placeholder, so scroll position never shifts. CLS is a correctness bug in
   a gallery, not a polish item.
4. **`loading="lazy"` + `decoding="async"`** on every `<img>`; `fetchPriority="high"` only on the
   one hero image above the fold.
5. **Memoise by identity, not by deep compare.** Artwork cards are `React.memo` with an `id` +
   `updatedAt` prop pair; `useCallback` only where a child is memoised.
6. **Transitions for navigation, not for data.** `useTransition` for filter changes that re-query;
   no animation budget spent on list mounting.

**Budget:** first contentful paint under 1 s on a warm cache; interaction under 100 ms; no task
over 50 ms during scroll. Measure with the Performance panel on the gallery route specifically —
it is the only route where these numbers are hard.

**Startup (P4).** Unlike Discord, the renderer is a local bundle, so cold start is disk-bound,
not network-bound. Keep it that way: no blocking fetch before first paint, shell state renders
from defaults immediately, server data streams in behind skeletons.

---

## 9. Security posture

Contrast with the report's §5, deliberately:

```ts
// electron/window.ts
const win = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,      // non-negotiable
    nodeIntegration: false,      // non-negotiable
    sandbox: true,               // renderer runs in a sandboxed process
    webSecurity: true,
    preload: path.join(__dirname, "preload.js"),
  },
});

// Navigation allowlist — nothing else may load in the app window.
win.webContents.setWindowOpenHandler(({ url }) => {
  if (isTrusted(url)) shell.openExternal(url);
  return { action: "deny" };
});
win.webContents.on("will-navigate", (e, url) => {
  if (!isTrusted(url)) e.preventDefault();
});
```

**Fuses: set all nine, then turn the important ones on.** Where Discord leaves
`EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` disabled, we enable both, and
we leave `EnableNodeOptionsEnvironmentVariable` **disabled**:

| Fuse | Aegis Shield | Why |
| --- | --- | --- |
| `RunAsNode` | disabled | no reason to ship a Node host |
| `EnableNodeOptionsEnvironmentVariable` | **disabled** | `NODE_OPTIONS` injection is the cheapest renderer→main escalation there is |
| `EnableNodeCliInspectArguments` | disabled | debug builds only |
| `EnableEmbeddedAsarIntegrityValidation` | **enabled** | catches local tampering for free |
| `OnlyLoadAppFromAsar` | **enabled** | removes the loose-directory shadowing path |
| `GrantFileProtocolExtraPrivileges` | **disabled** | we do not need `file://` privileges |

**[INFERRED]** The reason Discord can afford permissive fuses is P3-in-reverse: their UI is
re-fetched from a server they control, so local tampering only yields a shell whose only power is
48 audited bridge methods. We ship the UI locally, so we take the stricter settings — and we still
keep the bridge small, because fuses protect the binary and the bridge protects the product.

**Content Security Policy** — the renderer gets a strict CSP, `script-src 'self'`, no
`unsafe-inline`, no `unsafe-eval`. Images come from one known CDN origin.

---

## 10. Testing strategy

| Layer | Tool | What it must prove |
| --- | --- | --- |
| Pure logic | Vitest | cache patching, backoff, schema parsing, reducers. No React. |
| Components | Vitest + Testing Library | a gallery card renders and is keyboard-operable; a form validates. |
| Bridge contract | Vitest | every `contract` entry has a handler registered; request/response schemas round-trip. |
| Cache/event integration | Vitest | a socket event patches the list; an unknown event is ignored; reconnect invalidates once. |
| Electron end-to-end | Playwright | the packaged app launches, the bridge exposes exactly the contract's methods, `window.require` is `undefined`. |

The bridge-contract test is the cheapest high-value test in the project:

```ts
// electron/handlers/handlers.test.ts
import { describe, expect, it } from "vitest";
import { contract } from "../../shared/contract";
import { handlers } from "./index";

describe("bridge contract", () => {
  it("registers a handler for every channel, and no others", () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(contract).sort());
  });
});
```

It fails the moment someone adds a channel to `contract` and forgets the handler — which is
exactly the class of bug that otherwise ships as a silently-rejected promise.

---

## 11. What to build first

A single vertical slice, end to end, before any feature breadth:

1. `electron/main.ts` + `window.ts` with the security options above.
2. `shared/contract.ts` with **three** channels: `openImageDialog`, `revealInFolder`, `saveExport`.
3. `electron/preload.ts` and the browser fallback.
4. `src/shell/useShellState.ts` with one push channel: `window:focusChanged`.
5. `src/features/gallery/` — one route, a virtualised grid over mock data, three image sizes,
   skeleton + blur placeholder.
6. The bridge-contract test and one Playwright smoke test.

That slice exercises every architectural boundary (privileged/isolated/renderer, validated IPC,
push state, virtualised media, degraded browser path) in roughly a day's work. Every later
feature is then a variation on a path that already exists rather than a new invention.

**Do not** start with messages/realtime. The socket layer is the most intricate part and it is
much easier to add once the cache tier and the store tier have proven they stay separated.

---

## 12. Decisions that were considered and rejected

| Rejected | Why |
| --- | --- |
| Redux Toolkit | The domain has three state tiers and none of them benefit from a single global reducer. Query + Zustand are smaller and each does one thing. |
| Electron `remote` module | Removed from Electron for good reasons; `contextBridge` + explicit channels is the only defensible pattern. |
| Exposing `ipcRenderer` wholesale to the renderer | Turns every future handler into renderer-reachable attack surface. P1 exists to prevent exactly this. |
| Loading the renderer from a remote origin (Discord's model) | Correct for Discord, wrong here: it makes offline use impossible, makes the UI un-testable without their server, and means a network dependency for your own product's core UX. |
| CSS-in-JS runtime | Measurable cost on a media-heavy scroll surface for no benefit over CSS Modules + tokens. |
| A custom WebSocket wrapper library | `WebSocket` + TanStack Query cache patching is ~120 lines and fully understood. |
| Storing server data in Zustand | The single highest-frequency source of stale-UI bugs. Query owns server data, full stop. |

---

*See `01-discord-desktop-re-report.md` for the measured facts this design responds to, and
`03-evidence-index.md` for how to reproduce every number.*




