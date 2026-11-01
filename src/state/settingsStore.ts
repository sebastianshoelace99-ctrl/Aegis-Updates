import { create } from "zustand";
import {
  DEFAULT_SETTINGS,
  clearSettings,
  loadSettings,
  saveSettings,
  type Appearance,
  type CustomStatus,
  type Profile,
  type Settings,
  type VoicePreferences,
} from "../api/profile";

/**
 * The settings document plus the only writers it has.
 *
 * A Zustand store rather than `useSyncExternalStore`: every control in the settings dialog edits
 * a nested section, and Zustand's `set` is the smallest correct way to publish those changes.
 * Persistence is written through on every edit (not debounced) because a settings change is a
 * deliberate, low-frequency action; losing one because the window closed would be worse than a
 * synchronous 2 kB `setItem`.
 */

function local(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export type SettingsState = Settings & {
  /** True when the last write failed (full quota, locked storage). The UI surfaces it. */
  saveFailed: boolean;
  setProfile: (patch: Partial<Profile>) => void;
  setStatus: (patch: Partial<CustomStatus>) => void;
  resetStatus: () => void;
  setAppearance: (patch: Partial<Appearance>) => void;
  setVoice: (patch: Partial<VoicePreferences>) => void;
  resetAll: () => void;
};

const initial = loadSettings(local());

export const useSettingsStore = create<SettingsState>((set, get) => {
  const commit = (next: Settings): void => {
    const storage = local();
    const saved = saveSettings(storage, next);
    set({ ...next, saveFailed: storage !== null && !saved });
  };

  return {
    ...initial,
    saveFailed: false,

    setProfile: (patch) => {
      const state = get();
      commit({
        version: state.version,
        profile: { ...state.profile, ...patch },
        status: state.status,
        appearance: state.appearance,
        voice: state.voice,
      });
    },

    setStatus: (patch) => {
      const state = get();
      commit({
        version: state.version,
        profile: state.profile,
        status: { ...state.status, ...patch },
        appearance: state.appearance,
        voice: state.voice,
      });
    },

    resetStatus: () => {
      const state = get();
      commit({
        version: state.version,
        profile: state.profile,
        status: { ...state.status, emoji: "", text: "" },
        appearance: state.appearance,
        voice: state.voice,
      });
    },

    setAppearance: (patch) => {
      const state = get();
      commit({
        version: state.version,
        profile: state.profile,
        status: state.status,
        appearance: { ...state.appearance, ...patch },
        voice: state.voice,
      });
    },

    setVoice: (patch) => {
      const state = get();
      commit({
        version: state.version,
        profile: state.profile,
        status: state.status,
        appearance: state.appearance,
        voice: { ...state.voice, ...patch },
      });
    },

    resetAll: () => {
      clearSettings(local());
      set({ ...DEFAULT_SETTINGS, saveFailed: false });
    },
  };
});
