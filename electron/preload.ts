import { contextBridge, ipcRenderer } from "electron";
import type { z } from "zod";
import { contract, push, type Contract, type PushName } from "../shared/contract";

/**
 * The only file that imports from both worlds (docs/02 section 4.1).
 *
 * Four properties, each easy to lose:
 *  1. Object.freeze          - the renderer cannot monkey-patch the bridge.
 *  2. Bidirectional zod      - bad input never reaches main; a malformed reply never reaches the UI.
 *  3. subscribe -> off()     - every subscriber can detach, or listeners leak across routes.
 *  4. Imports: electron + shared + zod only. No fs, no path, no business logic.
 */

type Api = {
  [K in keyof Contract]: (
    req: z.input<Contract[K]["request"]>,
  ) => Promise<z.output<Contract[K]["response"]>>;
};

const invoke =
  <K extends keyof Contract>(channel: K) =>
  async (raw: unknown): Promise<z.output<Contract[K]["response"]>> => {
    // The contract table is heterogeneous, so the generic lookup has to be narrowed once
    // here. Confining the cast to this line keeps every call site precisely typed.
    const schemas = contract[channel] as unknown as {
      request: z.ZodType<unknown>;
      response: z.ZodType<z.output<Contract[K]["response"]>>;
    };

    const parsed = schemas.request.parse(raw); // fail closed on bad input
    const result: unknown = await ipcRenderer.invoke(channel, parsed);
    return schemas.response.parse(result); // never trust main's reply either
  };

const api = Object.fromEntries(
  (Object.keys(contract) as Array<keyof Contract>).map((key) => [key, invoke(key)]),
) as Api;

const subscribe = <K extends PushName>(name: K, cb: (payload: z.infer<(typeof push)[K]>) => void) => {
  const schema = push[name] as unknown as z.ZodType<z.infer<(typeof push)[K]>>;

  const listener = (_event: unknown, payload: unknown): void => {
    // A push that fails validation is a main-process bug. Drop it rather than throw inside a
    // listener: throwing here would take out the whole renderer for one bad event.
    const parsed = schema.safeParse(payload);
    if (parsed.success) cb(parsed.data);
  };
  ipcRenderer.on(name, listener);
  return (): void => {
    ipcRenderer.removeListener(name, listener);
  };
};

contextBridge.exposeInMainWorld("aegis", Object.freeze({ ...api, subscribe }));
