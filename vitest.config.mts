import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * `electron` cannot be imported outside an Electron process, so it is aliased to a
 * stub. That is what lets the handler module - the thing the contract test asserts on -
 * be imported in plain Node.
 */
export default defineConfig({
  resolve: {
    alias: {
      electron: fileURLToPath(new URL("./test/electron-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["electron/**/*.test.ts", "server/**/*.test.ts", "src/**/*.test.ts", "shared/**/*.test.ts"],
  },
});
