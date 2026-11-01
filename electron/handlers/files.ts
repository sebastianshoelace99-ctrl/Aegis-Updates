import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { BrowserWindow, dialog, shell } from "electron";
import type { OpenDialogOptions, SaveDialogOptions } from "electron";
import type { z } from "zod";
import type { Contract } from "../../shared/contract";

type Req<K extends keyof Contract> = z.output<Contract[K]["request"]>;
type Res<K extends keyof Contract> = z.output<Contract[K]["response"]>;

/**
 * File handlers. Domain-free: they open dialogs and move bytes. Anything that needs to know
 * what the bytes *mean* belongs in the renderer, not here.
 */

export async function openImageDialog(
  req: Req<"files:openImageDialog">,
): Promise<Res<"files:openImageDialog">> {
  const properties: OpenDialogOptions["properties"] = ["openFile"];
  if (req.multiple) properties.push("multiSelections");

  const options: OpenDialogOptions = {
    title: "Add artwork",
    buttonLabel: "Add",
    properties,
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "avif", "gif"] },
      { name: "All files", extensions: ["*"] },
    ],
  };

  const parent = BrowserWindow.getFocusedWindow();
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return [];

  return result.filePaths.map((path) => ({ path, name: basename(path) }));
}

export async function revealInFolder(req: Req<"files:revealInFolder">): Promise<Res<"files:revealInFolder">> {
  // Nothing to reveal is not an error: the UI may hold a recorded path from another machine.
  if (!existsSync(req.path)) return;
  shell.showItemInFolder(req.path);
}

export async function saveExport(req: Req<"files:saveExport">): Promise<Res<"files:saveExport">> {
  const options: SaveDialogOptions = {
    title: "Export",
    defaultPath: req.suggestedName,
    filters: [
      { name: "JSON", extensions: ["json"] },
      { name: "All files", extensions: ["*"] },
    ],
  };

  const parent = BrowserWindow.getFocusedWindow();
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;

  await writeFile(result.filePath, req.bytes);
  return { path: result.filePath };
}
