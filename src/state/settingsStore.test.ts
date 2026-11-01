import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../api/profile";
import { useSettingsStore } from "./settingsStore";

/** The store is process-wide on purpose; reset it so one test cannot leak into the next. */
beforeEach(() => {
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, saveFailed: false });
});

describe("settings store", () => {
  it("merges a profile patch and keeps the other sections", () => {
    useSettingsStore.getState().setProfile({ displayName: "Ada", bio: "Plates and books." });

    const state = useSettingsStore.getState();
    expect(state.profile.displayName).toBe("Ada");
    expect(state.profile.bio).toBe("Plates and books.");
    expect(state.profile.accent).toBe(DEFAULT_SETTINGS.profile.accent);
    expect(state.voice).toEqual(DEFAULT_SETTINGS.voice);
  });

  it("merges appearance options and keeps the rest of the section", () => {
    useSettingsStore.getState().setAppearance({ density: "compact" });

    expect(useSettingsStore.getState().appearance.density).toBe("compact");
    expect(useSettingsStore.getState().appearance.messageSize).toBe(
      DEFAULT_SETTINGS.appearance.messageSize,
    );
  });

  it("clears a custom status without touching presence", () => {
    useSettingsStore.getState().setStatus({ presence: "dnd", emoji: "🎧", text: "Heads down" });
    useSettingsStore.getState().resetStatus();

    const status = useSettingsStore.getState().status;
    expect(status).toEqual({ presence: "dnd", emoji: "", text: "" });
  });

  it("merges voice preferences", () => {
    useSettingsStore.getState().setVoice({ sensitivity: 80, noiseSuppression: false });

    const voice = useSettingsStore.getState().voice;
    expect(voice.sensitivity).toBe(80);
    expect(voice.noiseSuppression).toBe(false);
    expect(voice.echoCancellation).toBe(true);
  });

  it("resets everything to the defaults", () => {
    useSettingsStore.getState().setProfile({ displayName: "Ada" });
    useSettingsStore.getState().setAppearance({ density: "compact" });
    useSettingsStore.getState().resetAll();

    const state = useSettingsStore.getState();
    expect(state.profile).toEqual(DEFAULT_SETTINGS.profile);
    expect(state.appearance).toEqual(DEFAULT_SETTINGS.appearance);
    expect(state.saveFailed).toBe(false);
  });
});
