/**
 * THE channel names (docs/02 section 3: "shared/channels.ts - shared channel NAME constants").
 *
 * Two rules, both from the report's measured failure modes:
 *  - Every capability is a named constant, never a literal at a call site.
 *  - `Channel` (renderer -> main requests) and `Push` (main -> renderer events) live side by
 *    side, because the reference implementation typed one direction and passed the other as
 *    bare strings. A wrong push name throws nothing and silently never updates the UI.
 */

/** renderer -> main, request/response. One entry per audited method (P1: the list is the surface). */
export const Channel = {
  openImageDialog: "files:openImageDialog",
  revealInFolder: "files:revealInFolder",
  saveExport: "files:saveExport",
  checkForUpdates: "system:checkForUpdates",
  installUpdate: "system:installUpdate",
} as const;

export type ChannelName = (typeof Channel)[keyof typeof Channel];

/** main -> renderer, one-way. Shell-owned state only (P2: the shell pushes, the UI mirrors). */
export const Push = {
  focusChanged: "window:focusChanged",
  themeChanged: "system:themeChanged",
  updaterStatus: "system:updaterStatus",
} as const;

export type PushChannel = (typeof Push)[keyof typeof Push];
