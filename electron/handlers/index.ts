import type { IpcMain } from "electron";
import { contract } from "../../shared/contract";
import { Channel } from "../../shared/channels";
import { checkForUpdates, installUpdate } from "../updater";
import { openImageDialog, revealInFolder, saveExport } from "./files";

/**
 * The handler table. Explicit, ordered, no globbing and no filesystem discovery: what is
 * registered is what is written here, and the contract test asserts the table's keys equal
 * `contract`'s keys. Adding a channel without a handler fails CI; adding a handler without a
 * channel fails CI. That is the whole point (docs/02 section 10).
 */
export const handlers = {
  [Channel.openImageDialog]: openImageDialog,
  [Channel.revealInFolder]: revealInFolder,
  [Channel.saveExport]: saveExport,
  [Channel.checkForUpdates]: checkForUpdates,
  [Channel.installUpdate]: installUpdate,
} as const;

export type Handlers = typeof handlers;

type LooseHandler = (req: unknown) => Promise<unknown>;

export function registerHandlers(ipc: Pick<IpcMain, "handle">): void {
  for (const channel of Object.keys(contract)) {
    // The table is heterogeneous; the cast is confined to this one line so every other call
    // site keeps its precise request/response types.
    const handler = handlers[channel as keyof Handlers] as LooseHandler;
    ipc.handle(channel, async (_event, req: unknown) => handler(req));
  }
}
