import type { z } from "zod";
import type { Contract, PushName, push } from "../../shared/contract";
import { createBrowserFallback } from "./browser-fallback";

/**
 * The typed client (P3). One consequence worth naming: because the fallback is typed as
 * `Bridge`, TypeScript forces it to implement every channel. Adding a native capability
 * cannot silently break the browser build - the compiler fails until the degraded path exists.
 */

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
  interface Window {
    aegis?: Bridge;
  }
}

/** Real bridge when packaged; a working stand-in in a plain browser. */
export const hasShell = typeof window !== "undefined" && Boolean(window.aegis);

export const bridge: Bridge =
  typeof window !== "undefined" && window.aegis ? window.aegis : createBrowserFallback();
