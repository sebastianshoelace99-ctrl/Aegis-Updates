import { useSyncExternalStore } from "react";
import { liveWorkspace, subscribeWorkspace } from "../api/liveWorkspace";
import type { Workspace } from "../api/workspace";

/**
 * The workspace as the UI must see it, including servers created in this window.
 *
 * `useSyncExternalStore` rather than a Zustand slice: the registry outlives every component and
 * `messages.ts` reads the same value outside React, so the store cannot be the source of truth.
 */
export function useLiveWorkspace(): Workspace {
  return useSyncExternalStore(subscribeWorkspace, liveWorkspace);
}
