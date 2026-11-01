import { mkdirSync } from "node:fs";
import { build } from "esbuild";

/**
 * Bundles the two privileged entry points. esbuild rather than vite-plugin-electron:
 * the renderer is built by Vite, and main/preload being one explicit esbuild pass keeps the
 * packaging path single-command and debuggable.
 *
 * The Electron runtime and updater stay external so their runtime dependencies are packaged as
 * production modules; zod and shared/ are inlined.
 */

mkdirSync("dist", { recursive: true });

/** @type {import("esbuild").BuildOptions} */
const base = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron", "electron-updater"],
  logLevel: "warning",
  legalComments: "none",
  minify: true,
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
};

await Promise.all([
  build({ ...base, entryPoints: ["electron/main.ts"], outfile: "dist/main.js" }),
  build({ ...base, entryPoints: ["electron/preload.ts"], outfile: "dist/preload.js" }),
]);

console.log("electron: dist/main.js + dist/preload.js");
