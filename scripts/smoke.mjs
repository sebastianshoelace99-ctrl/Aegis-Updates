import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/**
 * Runs the built app with AEGIS_SMOKE=1 so electron/smoke.ts can assert the bridge end to end
 * and exit with 0/1. Inherits stdio, so the report is visible in the terminal.
 */

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const child = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: { ...process.env, AEGIS_SMOKE: "1" },
});

child.on("error", (error) => {
  console.error(`smoke: failed to launch electron: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`smoke: electron terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
