import { describe, expect, it } from "vitest";
import { devSkipRequested } from "./devSession";

/**
 * The rule, not the wiring: `devSkipEnabled()` reads the baked flag and `API_BASE` once, at import
 * time, so the two inputs are passed in here instead of being re-read per case.
 */
describe("the dev login skip", () => {
  it("is off unless the build opted in", () => {
    expect(devSkipRequested(undefined, "http://127.0.0.1:8787")).toBe(false);
    expect(devSkipRequested("", "http://127.0.0.1:8787")).toBe(false);
    expect(devSkipRequested("0", "http://127.0.0.1:8787")).toBe(false);
    expect(devSkipRequested("false", "http://127.0.0.1:8787")).toBe(false);
    expect(devSkipRequested("no", "http://127.0.0.1:8787")).toBe(false);
  });

  it("accepts the spellings a .env can hold", () => {
    for (const flag of ["1", "true", "yes", " TRUE "]) {
      expect(devSkipRequested(flag, "http://127.0.0.1:8787")).toBe(true);
    }
  });

  it("only skips against a backend on this machine", () => {
    for (const base of [
      "http://127.0.0.1:8787",
      "http://localhost:5173",
      "http://[::1]:8787",
      "http://0.0.0.0:8787",
    ]) {
      expect(devSkipRequested("1", base)).toBe(true);
    }

    // A flag that leaked into a hosted build must not let it impersonate anyone.
    expect(devSkipRequested("1", "https://aegis.example.com")).toBe(false);
    expect(devSkipRequested("1", "https://127.0.0.1.example.com")).toBe(false);
    expect(devSkipRequested("1", "not a url")).toBe(false);
  });
});
