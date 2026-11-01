import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_COPY,
  SERVER_DESCRIPTION_MAX,
  applyServerSettings,
  guildDescription,
  guildNotificationLevel,
  isSystemChannel,
  systemChannelOf,
} from "./serverSettings";
import { normalizeGuild, type Guild } from "./workspace";
import { fixtureGuild as studio } from "../../test/fixtures";

describe("server settings", () => {
  it("defaults a guild that predates server settings", () => {
    expect(guildNotificationLevel(studio)).toBe("all");
    expect(guildDescription(studio)).toBe("");
    expect(systemChannelOf(studio)).toBeNull();
    expect(NOTIFICATION_COPY.none.label).toBe("Nothing");
  });

  it("trims and caps the description without mutating the input", () => {
    const next = applyServerSettings(studio, { description: `  ${"x".repeat(400)}  ` });

    expect(next).not.toBe(studio);
    expect(next.description).toBe("x".repeat(SERVER_DESCRIPTION_MAX));
    expect(studio.description).toBeUndefined();
  });

  it("stores a notification policy and falls back to all for a bad value", () => {
    expect(applyServerSettings(studio, { notificationLevel: "mentions" }).notificationLevel).toBe(
      "mentions",
    );

    const broken = applyServerSettings(studio, {
      notificationLevel: "loud" as unknown as "all",
    });
    expect(broken.notificationLevel).toBe("all");
  });

  it("accepts only a text channel in this guild as the system channel", () => {
    const accepted = applyServerSettings(studio, { systemChannelId: "fixture/general" });
    expect(systemChannelOf(accepted)?.id).toBe("fixture/general");
    expect(isSystemChannel(accepted, "fixture/general")).toBe(true);
    expect(isSystemChannel(accepted, "fixture/lounge")).toBe(false);

    // A voice channel is not eligible, and a channel from another guild is not either.
    expect(
      applyServerSettings(studio, { systemChannelId: "fixture/lounge" }).systemChannelId,
    ).toBeNull();
    expect(
      applyServerSettings(studio, { systemChannelId: "other/general" }).systemChannelId,
    ).toBeNull();
  });

  it("treats a removed system channel as unset", () => {
    const stale: Guild = { ...studio, systemChannelId: "fixture/removed" };
    expect(systemChannelOf(stale)).toBeNull();

    const normalized = normalizeGuild(stale);
    expect(normalized?.systemChannelId).toBeNull();
  });

  it("keeps a valid system channel through the normaliser", () => {
    const saved: Guild = { ...studio, systemChannelId: "fixture/general" };
    expect(normalizeGuild(saved)?.systemChannelId).toBe("fixture/general");
  });

  it("accepts only a bounded image data URL as the server icon", () => {
    const icon = "data:image/webp;base64,AAAA";
    expect(applyServerSettings(studio, { icon }).icon).toBe(icon);

    expect(applyServerSettings(studio, { icon: "https://example.com/icon.png" }).icon).toBeNull();
    expect(applyServerSettings(studio, { icon: "javascript:alert(1)" }).icon).toBeNull();
    expect(applyServerSettings(studio, { icon: "data:text/html;base64,AAAA" }).icon).toBeNull();
  });

  it("drops a corrupt icon without dropping the guild", () => {
    const corrupt = { ...studio, icon: "data:image/svg+xml;base64,AAAA" };
    const normalized = normalizeGuild(corrupt);
    expect(normalized?.id).toBe(studio.id);
    expect(normalized?.icon).toBeNull();

    const valid = { ...studio, icon: "data:image/png;base64,AAAA" };
    expect(normalizeGuild(valid)?.icon).toBe("data:image/png;base64,AAAA");
  });
});
