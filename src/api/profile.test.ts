import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  clearSettings,
  displayNameSchema,
  effectivePresence,
  hasCosmetics,
  imageDataUrlSchema,
  loadSettings,
  parseSettings,
  saveSettings,
} from "./profile";

type FakeStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  read: () => string | null;
};

function fakeStorage(initial: string | null = null): FakeStorage {
  let value = initial;

  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
    read: () => value,
  };
}

describe("profile settings", () => {
  it("fills every section when the stored document is empty", () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("replaces an invalid section without discarding the rest", () => {
    const parsed = parseSettings({
      version: 99,
      profile: { ...DEFAULT_PROFILE, displayName: "Ada" },
      appearance: { density: "enormous" },
      voice: { ...DEFAULT_SETTINGS.voice, sensitivity: 900 },
    });

    expect(parsed.version).toBe(SETTINGS_VERSION);
    expect(parsed.profile.displayName).toBe("Ada");
    // One bad field costs its section, not the whole document.
    expect(parsed.appearance.density).toBe("cozy");
    expect(parsed.voice.sensitivity).toBe(55);
  });

  it("bounds display names and image data URLs", () => {
    expect(displayNameSchema.safeParse("  Ada  ").data).toBe("Ada");
    expect(displayNameSchema.safeParse("   ").success).toBe(false);
    expect(displayNameSchema.safeParse("x".repeat(33)).success).toBe(false);

    expect(imageDataUrlSchema.safeParse("data:image/webp;base64,AAAA").success).toBe(true);
    expect(imageDataUrlSchema.safeParse("data:image/jpeg;base64,AAAA").success).toBe(true);
    expect(imageDataUrlSchema.safeParse("data:image/svg+xml;base64,AAAA").success).toBe(false);
    expect(imageDataUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("round-trips through storage and survives malformed JSON", () => {
    const storage = fakeStorage();
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);

    const custom = {
      ...DEFAULT_SETTINGS,
      profile: { ...DEFAULT_PROFILE, displayName: "Ada", bio: "See https://example.test" },
    };
    expect(saveSettings(storage, custom)).toBe(true);
    expect(storage.read()).toContain("Ada");
    expect(loadSettings(storage)).toEqual(custom);

    expect(loadSettings(fakeStorage("{not json"))).toEqual(DEFAULT_SETTINGS);
    clearSettings(storage);
    expect(storage.read()).toBeNull();
  });

  it("reports a failed write instead of throwing", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };

    expect(saveSettings(storage, DEFAULT_SETTINGS)).toBe(false);
  });

  it("maps invisible to offline and leaves the other choices alone", () => {
    expect(effectivePresence("invisible")).toBe("offline");
    expect(effectivePresence("dnd")).toBe("dnd");
    expect(effectivePresence("idle")).toBe("idle");
  });

  it("fills the newer appearance controls when upgrading a version-1 document", () => {
    // What a document written before this release actually looks like: version 1, one real choice.
    const legacy = {
      version: 1,
      appearance: { density: "compact" },
    };

    const parsed = parseSettings(legacy);
    expect(parsed.version).toBe(SETTINGS_VERSION);
    expect(parsed.appearance).toEqual({
      density: "compact",
      accent: "theme",
      tint: "",
      messageSize: "normal",
      font: "condensed",
      motion: "full",
      texture: "grid",
      clock: "auto",
    });
  });

  it("rejects an appearance value that has no token block", () => {
    const current = { version: SETTINGS_VERSION };

    expect(parseSettings({ ...current, appearance: { accent: "neon" } }).appearance.accent).toBe(
      "theme",
    );
    expect(
      parseSettings({ ...current, appearance: { density: "spacious" } }).appearance.density,
    ).toBe("cozy");
    expect(parseSettings({ ...current, appearance: { clock: "24h" } }).appearance.clock).toBe("24h");
  });

  it("keeps a valid custom accent and only costs the colour when the hex is malformed", () => {
    const current = { version: SETTINGS_VERSION };

    expect(
      parseSettings({ ...current, appearance: { accent: "custom", tint: "#1A2B3C" } }).appearance,
    ).toMatchObject({ accent: "custom", tint: "#1A2B3C" });

    // A truncated or hand-edited hex costs the colour, not the rest of the section.
    expect(
      parseSettings({
        ...current,
        appearance: { accent: "custom", tint: "#12345", density: "compact" },
      }).appearance,
    ).toMatchObject({ accent: "custom", tint: "", density: "compact" });
  });

  it("retires the version-2 accent so an untouched default cannot recolour every theme", () => {
    const upgraded = parseSettings({
      version: 2,
      appearance: { accent: "crimson", density: "compact" },
    });

    expect(upgraded.version).toBe(SETTINGS_VERSION);
    expect(upgraded.appearance.accent).toBe("theme");
    expect(upgraded.appearance.tint).toBe("");
    expect(upgraded.appearance.density).toBe("compact");
  });
});

/*
 * Cosmetics. Discord gates these behind a subscription; this document has no tier field at all, so
 * the only thing worth testing is that a choice round-trips and that a bad value cannot take the
 * profile down with it.
 */
describe("profile cosmetics", () => {
  it("defaults every cosmetic to none", () => {
    const settings = parseSettings({});

    expect(settings.profile.decoration).toBe(0);
    expect(settings.profile.effect).toBe(0);
    expect(settings.profile.frame).toBe(0);
    expect(hasCosmetics(settings.profile)).toBe(false);
  });

  it("keeps a chosen decoration, effect and frame across a save and reload", () => {
    const storage = fakeStorage();
    const chosen = {
      ...DEFAULT_SETTINGS,
      profile: { ...DEFAULT_PROFILE, decoration: 3, effect: 5, frame: 2 },
    };

    saveSettings(storage, chosen);
    const reloaded = loadSettings(storage);

    expect(reloaded.profile.decoration).toBe(3);
    expect(reloaded.profile.effect).toBe(5);
    expect(reloaded.profile.frame).toBe(2);
    expect(hasCosmetics(reloaded.profile)).toBe(true);
  });

  it("falls back to the default profile rather than rendering a value no stylesheet has", () => {
    // 99 is not a ring the stylesheet defines. The section `.catch()` costs the profile, not the app.
    const settings = parseSettings({
      version: SETTINGS_VERSION,
      profile: { ...DEFAULT_PROFILE, decoration: 99 },
    });

    expect(settings.profile).toEqual(DEFAULT_PROFILE);
  });

  it("reports cosmetics only when at least one is set", () => {
    expect(hasCosmetics({ ...DEFAULT_PROFILE, effect: 1 })).toBe(true);
    expect(hasCosmetics({ ...DEFAULT_PROFILE, decoration: 6 })).toBe(true);
    expect(hasCosmetics(DEFAULT_PROFILE)).toBe(false);
  });
});

