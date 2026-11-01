import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The store reads the flag and the API base when it is imported, so each case stubs the
 * environment and then imports a fresh copy - `vi.resetModules` is what makes that read happen
 * again. `import.meta.env` is the same object Vite hands the app at build time.
 */
async function loadStore(flag: string): Promise<typeof import("./authStore")> {
  vi.resetModules();
  vi.stubEnv("VITE_AEGIS_SKIP_AUTH", flag);
  return import("./authStore");
}

describe("the dev sign-in action", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does nothing in a build that did not opt in", async () => {
    const { useAuthStore } = await loadStore("");

    useAuthStore.getState().devSignIn?.();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("enters as the local dev account when the build opted in", async () => {
    const { useAuthStore } = await loadStore("1");

    useAuthStore.getState().devSignIn?.();

    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(useAuthStore.getState().user?.id).toBe("dev");
    expect(useAuthStore.getState().user?.handle).toBe("dev");
  });

  it("drops a stale token, so the backend sees the claim rather than the old session", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_AEGIS_SKIP_AUTH", "1");

    const session = await import("./session");
    const { useAuthStore } = await import("./authStore");
    session.setToken("stale-token-that-is-long-enough");

    useAuthStore.getState().devSignIn?.();

    expect(session.getToken()).toBeNull();
  });
});
