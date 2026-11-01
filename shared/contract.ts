import { z } from "zod";
import { Channel, Push } from "./channels";

/**
 * The bridge contract (docs/02 section 4).
 *
 * Both directions are declared here on purpose. Types are inferred from the schemas and never
 * written twice, so a schema change is a compile error at every call site instead of a runtime
 * surprise. There is deliberately no `invoke(channel, ...args)` escape hatch: the preload's job
 * is to make arbitrary IPC impossible, not merely inconvenient.
 */

/** request/response, renderer -> main */
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
    request: z.object({
      suggestedName: z.string().min(1),
      bytes: z.instanceof(Uint8Array),
    }),
    response: z.object({ path: z.string() }).nullable(),
  },
  [Channel.checkForUpdates]: {
    request: z.object({}),
    response: z.void(),
  },
  [Channel.installUpdate]: {
    request: z.object({}),
    response: z.void(),
  },
} as const;

export type Contract = typeof contract;
export type ContractChannel = keyof Contract;

/** main -> renderer pushes */
export const push = {
  [Push.themeChanged]: z.object({ theme: z.enum(["light", "dark"]) }),
  [Push.updaterStatus]: z.object({
    state: z.enum(["idle", "checking", "available", "downloading", "ready", "error"]),
    version: z.string().optional(),
    percent: z.number().min(0).max(100).optional(),
    message: z.string().optional(),
  }),
  [Push.focusChanged]: z.object({ focused: z.boolean() }),
} as const;

export type PushName = keyof typeof push;
export type PushPayload<K extends PushName> = z.infer<(typeof push)[K]>;

/* Channel name parity (that every `Push` constant has a schema) is asserted by
 * shared/contract.test.ts, because that is also where the handler parity is asserted. */
