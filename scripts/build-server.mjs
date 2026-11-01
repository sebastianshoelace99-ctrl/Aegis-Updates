import { mkdirSync } from "node:fs";
import { build } from "esbuild";

/**
 * Bundles the standalone backend to `server-dist/index.js`.
 *
 * Separate from `dist/` on purpose: the packaged desktop app must not ship a server that holds a
 * Supabase service-role key in its asar. `npm run server` runs this bundle with plain Node.
 *
 * No `external` packages: zod is inlined, and there are no other runtime dependencies.
 */

mkdirSync("server-dist", { recursive: true });

await build({
  entryPoints: ["server/index.ts"],
  outfile: "server-dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  logLevel: "warning",
  legalComments: "none",
  minify: false,
  sourcemap: false,
});

console.log("server: server-dist/index.js");
