import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Renderer-only build. `electron/` is bundled by scripts/build-electron.mjs (esbuild),
 * so this config has one job: produce dist/renderer.
 *
 * `base: "./"` keeps every asset reference relative, which is what the app:// protocol
 * handler in electron/main.ts serves.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiBase = process.env.VITE_API_BASE_URL || env.VITE_API_BASE_URL || "http://127.0.0.1:8787";

  let apiOrigin: string;
  try {
    apiOrigin = new URL(apiBase).origin;
  } catch {
    throw new Error("VITE_API_BASE_URL must be an absolute URL.");
  }

  return {
    base: "./",
    plugins: [
      react(),
      {
        name: "aegis-api-csp-origin",
        transformIndexHtml(html) {
          return html.replaceAll("__AEGIS_API_ORIGIN__", apiOrigin);
        },
      },
    ],
    build: {
      outDir: "dist/renderer",
      emptyOutDir: true,
      target: "chrome120",
      sourcemap: false,
      assetsInlineLimit: 0,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});
