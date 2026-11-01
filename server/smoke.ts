import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createRequestHandler } from "./app";
import { createAuthStore } from "./auth";
import { EventBus } from "./bus";
import { createMemoryStore } from "./store";
import { createUploadStore } from "./uploads";

/**
 * The smoke test's backend.
 *
 * It runs inside the Electron main process only when `AEGIS_SMOKE=1`, so a packaged self-test is
 * the same experiment as the dev run: the real renderer talks to the real HTTP handlers over the
 * real port. The store is memory-only, so a smoke run can never write to the user's Supabase.
 *
 * The port must match the renderer's baked `VITE_API_BASE_URL` (8787 by default). Refusing to
 * start is deliberate: silently reusing whatever is already on that port could point the smoke
 * run at a real database.
 */
export async function startSmokeBackend(
  port = 8787,
): Promise<{ stop: () => Promise<void>; port: number; token: string }> {
  const store = createMemoryStore();
  // A smoke run must never write into the packaged app directory, which is read-only inside the
  // portable EXE's temporary unpack folder.
  const uploadDir = join(tmpdir(), `aegis-smoke-uploads-${process.pid}`);
  const uploads = createUploadStore(uploadDir);

  /*
   * The app now opens on a login screen, so the packaged self-test needs an account of its own.
   * It is created in memory, and the token is handed to the renderer before the run starts - the
   * smoke test then exercises the same signed-in path a person would.
   */
  const auth = createAuthStore({ file: null });
  const session = await auth.register({
    email: "smoke@aegis.local",
    password: `smoke-${randomUUID()}`,
    displayName: "Nyx",
    handle: "nyx",
  });

  const server = createServer(
    createRequestHandler({ store, bus: new EventBus(), apiKey: "", uploads, auth }),
  );

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Stop any running "npm run server" before a smoke run.`,
          ),
        );
        return;
      }
      reject(error);
    };

    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const actual = (server.address() as AddressInfo).port;
  console.log(`[aegis-smoke] backend on http://127.0.0.1:${actual} (memory store)`);

  return {
    port: actual,
    token: session.token,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          void rm(uploadDir, { recursive: true, force: true }).finally(resolve);
        });
      }),
  };
}
