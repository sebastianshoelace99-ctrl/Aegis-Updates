import { useEffect, useRef } from "react";
import type { z } from "zod";
import type { PushName, push } from "../../shared/contract";
import { bridge } from "./client";

/**
 * Subscribe for the lifetime of a component, with cleanup. For anything global prefer
 * initShellSync() in src/shell/useShellState.ts - one subscription set beats N component
 * subscriptions, and focus changes then do not re-render unrelated trees.
 */
export function useBridgeEvent<K extends PushName>(
  name: K,
  cb: (payload: z.infer<(typeof push)[K]>) => void,
): void {
  const latest = useRef(cb);
  latest.current = cb;

  useEffect(() => bridge.subscribe(name, (payload) => latest.current(payload)), [name]);
}
