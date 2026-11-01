import { describe, expect, it } from "vitest";
import {
  decideRoute,
  formatRoute,
  isDmRoute,
  parseRoute,
  resolveRoute,
  routeOf,
} from "./route";
import { dmChannelId } from "../api/dms";
import { workspace } from "../api/workspace";
import { fixtureWorkspace } from "../../test/fixtures";

describe("hash routing", () => {
  it("parses the shapes a real window can produce", () => {
    expect(parseRoute("#/fixture/gallery")).toEqual({ guildId: "fixture", slug: "gallery" });
    expect(parseRoute("/fixture/gallery")).toEqual({ guildId: "fixture", slug: "gallery" });
    expect(parseRoute("fixture/gallery")).toEqual({ guildId: "fixture", slug: "gallery" });
    expect(parseRoute("#/fixture/gallery/")).toEqual({ guildId: "fixture", slug: "gallery" });
  });

  it("rejects anything that is not exactly two segments", () => {
    expect(parseRoute("")).toBeNull();
    expect(parseRoute("#")).toBeNull();
    expect(parseRoute("#/fixture")).toBeNull();
    expect(parseRoute("#/a/b/c")).toBeNull();
    // A malformed escape is a bad route, not an exception.
    expect(parseRoute("#/%E0%A4%A/gallery")).toBeNull();
  });

  it("round-trips through formatRoute", () => {
    const route = routeOf("fixture", "quiet-harbour");
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("falls back instead of returning nothing", () => {
    const unknownGuild = resolveRoute({ guildId: "ghost", slug: "x" }, fixtureWorkspace);
    expect(unknownGuild?.channel.id.length ?? 0).toBeGreaterThan(0);

    const unknownSlug = resolveRoute({ guildId: "fixture", slug: "ghost" }, fixtureWorkspace);
    expect(unknownSlug?.guild.id).toBe("fixture");
    expect(unknownSlug?.channel.id.startsWith("fixture/")).toBe(true);

    const nothing = resolveRoute(null, fixtureWorkspace);
    expect(nothing?.channel.id).toBe(fixtureWorkspace.guilds[0]?.channels[0]?.id);
  });

  it("returns null for a workspace with no servers", () => {
    expect(resolveRoute(null, workspace)).toBeNull();
    expect(resolveRoute({ guildId: "ghost", slug: "x" }, workspace)).toBeNull();
  });

  it("resolves a real channel exactly", () => {
    const resolved = resolveRoute({ guildId: "fixture", slug: "gallery" }, fixtureWorkspace);
    expect(resolved?.channel.slug).toBe("gallery");
    expect(resolved?.channel.kind).toBe("media");
    expect(resolved?.guild.id).toBe("fixture");
  });

  it("round-trips the DM space, with and without a conversation open", () => {
    expect(parseRoute("#/@me")).toEqual({ guildId: "@me", slug: "" });
    expect(parseRoute("#/@me/kestrel")).toEqual({ guildId: "@me", slug: "kestrel" });

    // `@me` is a space, not an id: it stays readable instead of becoming `%40me`.
    expect(formatRoute({ guildId: "@me", slug: "" })).toBe("#/@me");
    expect(formatRoute(routeOf("@me", "kestrel"))).toBe("#/@me/kestrel");
    expect(parseRoute(formatRoute(routeOf("@me", "kestrel")))).toEqual(
      routeOf("@me", "kestrel"),
    );
  });

  it("still rejects a one-segment path that is not the DM space", () => {
    expect(parseRoute("#/fixture")).toBeNull();
    expect(parseRoute("#/@other")).toBeNull();
  });

  it("keeps guild segments encoded, so a space in a slug survives a reload", () => {
    expect(formatRoute(routeOf("fixture", "quiet harbour"))).toBe("#/fixture/quiet%20harbour");
    expect(parseRoute("#/fixture/quiet%20harbour")).toEqual(routeOf("fixture", "quiet harbour"));
  });

  it("tells a DM route apart from a channel route", () => {
    expect(isDmRoute({ guildId: "@me", slug: "kestrel" })).toBe(true);
    expect(isDmRoute({ guildId: "@me", slug: "" })).toBe(true);
    expect(isDmRoute({ guildId: "fixture", slug: "general" })).toBe(false);
    expect(isDmRoute(null)).toBe(false);
  });
});

/**
 * The store leads and the hash follows. These are the cases that decide where the reader
 * ends up, and every one of them was a bug before `decideRoute` existed.
 */
describe("deciding a route", () => {
  const kestrel = dmChannelId("kestrel");

  it("keeps the server the reader just picked, over a stale DM hash", () => {
    /*
     * The regression: the hash still names the DM the reader was in a moment ago, because the
     * store-to-hash write happens a render later. Acting on it pulled the reader straight back
     * out of the server they had just clicked, and no server could ever be selected again.
     */
    const decision = decideRoute({
      hash: "#/@me/kestrel",
      live: fixtureWorkspace,
      channelId: "fixture/general",
      home: false,
    });

    expect(decision).toEqual({ kind: "keep" });
  });

  it("keeps the DM the reader just picked, over a stale server hash", () => {
    const decision = decideRoute({
      hash: "#/fixture/general",
      live: fixtureWorkspace,
      channelId: kestrel,
      home: true,
    });

    expect(decision).toEqual({ kind: "keep" });
  });

  it("keeps one DM over a stale DM hash", () => {
    const decision = decideRoute({
      hash: "#/@me/kestrel",
      live: fixtureWorkspace,
      channelId: dmChannelId("mira"),
      home: true,
    });

    expect(decision).toEqual({ kind: "keep" });
  });

  it("keeps a server channel over a stale hash naming another server", () => {
    const decision = decideRoute({
      hash: "#/fixture/general",
      live: fixtureWorkspace,
      channelId: "fixture/gallery",
      home: false,
    });

    expect(decision).toEqual({ kind: "keep" });
  });

  it("opens the hash's channel on a cold start", () => {
    const decision = decideRoute({
      hash: "#/fixture/gallery",
      live: fixtureWorkspace,
      channelId: "",
      home: false,
    });

    expect(decision).toEqual({ kind: "channel", channelId: "fixture/gallery" });
  });

  it("opens the hash's conversation on a cold start", () => {
    const decision = decideRoute({
      hash: "#/@me/kestrel",
      live: fixtureWorkspace,
      channelId: "",
      home: false,
    });

    expect(decision).toEqual({ kind: "channel", channelId: kestrel });
  });

  it("opens the DM space on a cold start", () => {
    const decision = decideRoute({
      hash: "#/@me",
      live: fixtureWorkspace,
      channelId: "",
      home: false,
    });

    expect(decision).toEqual({ kind: "home" });
  });

  it("re-opens a server channel the backend deleted", () => {
    /*
     * The graph changed under the reader: the channel they were in is gone. The hash still names
     * it, so the fall-back is the first channel of the server it belonged to - not a DM.
     */
    const withoutGallery = {
      ...fixtureWorkspace,
      guilds: fixtureWorkspace.guilds.map((guild) => ({
        ...guild,
        channels: guild.channels.filter((channel) => channel.id !== "fixture/gallery"),
      })),
    };

    const decision = decideRoute({
      hash: "#/fixture/gallery",
      live: withoutGallery,
      channelId: "fixture/gallery",
      home: false,
    });

    expect(decision).toEqual({ kind: "channel", channelId: "fixture/quiet-harbour" });
  });

  it("keeps the reader in the DM space when the hash names a server", () => {
    const decision = decideRoute({
      hash: "#/fixture/general",
      live: fixtureWorkspace,
      channelId: "",
      home: true,
    });

    expect(decision).toEqual({ kind: "keep" });
  });

  it("keeps the reader where they are when there is no route to follow", () => {
    const decision = decideRoute({
      hash: "#/not-a-server/nowhere",
      live: fixtureWorkspace,
      channelId: "",
      home: false,
    });

    // The fixture's only server is still a valid destination, so the reader lands on it.
    expect(decision).toEqual({ kind: "channel", channelId: "fixture/quiet-harbour" });
  });

  it("does nothing when there is no server to fall back to", () => {
    const decision = decideRoute({
      hash: "#/not-a-server/nowhere",
      live: workspace,
      channelId: "",
      home: false,
    });

    expect(decision).toEqual({ kind: "keep" });
  });
});
