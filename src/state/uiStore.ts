import { create } from "zustand";

/**
 * Overlay ownership. The settings dialog, server settings and a member's profile card all open
 * from more than one place (the user dock, a member row, a message author), so their visibility
 * cannot live in whichever component happened to render the trigger.
 */

export type SettingsTab = "profile" | "status" | "appearance" | "voice";

export type UiState = {
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  serverSettingsOpen: boolean;
  createServerOpen: boolean;
  joinServerOpen: boolean;
  joinServerCode: string;
  /** A member id, or null when no profile card is open. */
  profileMemberId: string | null;

  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  openServerSettings: () => void;
  closeServerSettings: () => void;
  openCreateServer: () => void;
  closeCreateServer: () => void;
  openJoinServer: (code?: string) => void;
  closeJoinServer: () => void;
  openProfile: (memberId: string) => void;
  closeProfile: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  settingsOpen: false,
  settingsTab: "profile",
  serverSettingsOpen: false,
  createServerOpen: false,
  joinServerOpen: false,
  joinServerCode: "",
  profileMemberId: null,

  openSettings: (tab = "profile") => set({ settingsOpen: true, settingsTab: tab }),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  openServerSettings: () => set({ serverSettingsOpen: true }),
  closeServerSettings: () => set({ serverSettingsOpen: false }),
  openCreateServer: () => set({ createServerOpen: true }),
  closeCreateServer: () => set({ createServerOpen: false }),
  openJoinServer: (code = "") => set({ joinServerOpen: true, joinServerCode: code }),
  closeJoinServer: () => set({ joinServerOpen: false, joinServerCode: "" }),
  openProfile: (memberId) => set({ profileMemberId: memberId }),
  closeProfile: () => set({ profileMemberId: null }),
}));
