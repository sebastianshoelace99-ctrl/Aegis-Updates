import { describe, expect, it } from "vitest";
import { Channel, Push } from "./channels";
import { contract, push } from "./contract";

/**
 * Schema-level proofs. These are the cheap ones that catch the drift a type system cannot:
 * a default that changed, a push constant with no schema, a channel constant no longer
 * present in the contract.
 */
describe("contract schemas", () => {
  it("has one contract entry per channel constant", () => {
    expect(Object.values(Channel).sort()).toEqual(Object.keys(contract).sort());
  });

  it("has one schema per push constant", () => {
    expect(Object.values(Push).sort()).toEqual(Object.keys(push).sort());
  });

  it("applies request defaults", () => {
    expect(contract[Channel.openImageDialog].request.parse({})).toEqual({ multiple: false });
  });

  it("rejects malformed requests", () => {
    expect(
      contract[Channel.saveExport].request.safeParse({ suggestedName: "a.json", bytes: "nope" })
        .success,
    ).toBe(false);
    expect(contract[Channel.revealInFolder].request.safeParse({ path: "" }).success).toBe(false);
  });

  it("round-trips a void response", () => {
    expect(contract[Channel.revealInFolder].response.parse(undefined)).toBeUndefined();
    expect(contract[Channel.checkForUpdates].response.parse(undefined)).toBeUndefined();
    expect(contract[Channel.installUpdate].response.parse(undefined)).toBeUndefined();
  });

  it("rejects malformed push payloads", () => {
    expect(push[Push.focusChanged].safeParse({ focused: "yes" }).success).toBe(false);
    expect(push[Push.themeChanged].safeParse({ theme: "dark" }).success).toBe(true);
    expect(
      push[Push.updaterStatus].safeParse({ state: "downloading", version: "1.0.0" }).success,
    ).toBe(true);
    expect(
      push[Push.updaterStatus].safeParse({ state: "downloading", percent: 45 }).success,
    ).toBe(true);
    expect(push[Push.updaterStatus].safeParse({ state: "downloading", percent: 101 }).success).toBe(
      false,
    );
    expect(
      push[Push.updaterStatus].safeParse({ state: "error", message: "Try again" }).success,
    ).toBe(true);
  });
});
