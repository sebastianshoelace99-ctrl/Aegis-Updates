import { Channel } from "../../shared/channels";
import type { Bridge } from "./client";

/**
 * Every shell capability degraded instead of thrown (P3). Browser dev and any future web
 * deployment run on this path, so it is a real module - not a test double.
 */

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", () => resolve(Array.from(input.files ?? [])), { once: true });
    input.click();
  });
}

function download(bytes: Uint8Array, filename: string): void {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const url = URL.createObjectURL(new Blob([buffer], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function createBrowserFallback(): Bridge {
  return {
    // <input type="file"> instead of a native dialog; a browser has no absolute path to give.
    [Channel.openImageDialog]: async ({ multiple }) => {
      const files = await pickFiles("image/*", multiple ?? false);
      return files.map((file) => ({ path: "", name: file.name }));
    },
    // Nothing to reveal outside a filesystem shell.
    [Channel.revealInFolder]: async () => undefined,
    // Blob download instead of a save dialog.
    [Channel.saveExport]: async ({ suggestedName, bytes }) => {
      download(bytes, suggestedName);
      return null;
    },
    [Channel.checkForUpdates]: async () => undefined,
    [Channel.installUpdate]: async () => undefined,
    // No shell, no pushes: the UI keeps its defaults (focused, light) and stays usable.
    subscribe: () => () => {},
  };
}
