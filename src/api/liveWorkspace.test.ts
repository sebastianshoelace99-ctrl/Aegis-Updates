import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  liveWorkspace,
  replaceWorkspace,
  resetLiveWorkspace,
  subscribeWorkspace,
  updateGuild,
} from "./liveWorkspace";
import { normalizeGuild, normalizeWorkspace, type Guild } from "./workspace";
import { fixtureGuild as studio, fixtureWorkspace } from "../../test/fixtures";

beforeEach(resetLiveWorkspace);
afterEach(() => {
  vi.unstubAllGlobals();
  resetLiveWorkspace();
});

describe("live workspace", () => {
  it("starts empty and installs a validated graph", () => {
    expect(liveWorkspace()).toEqual({ guilds: [], members: [] });

    replaceWorkspace(fixtureWorkspace);
    expect(liveWorkspace().guilds.map((guild) => guild.id)).toEqual(["fixture"]);
    expect(liveWorkspace().members).toHaveLength(fixtureWorkspace.members.length);
  });

  it("publishes a new identity to subscribers on every write", () => {
    const listener = vi.fn();
    const off = subscribeWorkspace(listener);

    replaceWorkspace(fixtureWorkspace);
    expect(listener).toHaveBeenCalledTimes(1);

    const before = liveWorkspace();
    replaceWorkspace(fixtureWorkspace);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(liveWorkspace()).not.toBe(before);

    off();
    replaceWorkspace(fixtureWorkspace);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects incoherent guilds instead of rendering them", () => {
    expect(normalizeGuild(fixtureWorkspace.guilds[0])?.id).toBe("fixture");
    expect(normalizeGuild(null)).toBeNull();

    const first = studio.channels[0];
    expect(first).toBeDefined();
    if (!first) return;

    expect(normalizeGuild({ ...studio, channels: [{ ...first, categoryId: "missing" }] })).toBeNull();
    expect(normalizeGuild({ ...studio, channels: [first, first] })).toBeNull();
    expect(normalizeGuild({ ...studio, channels: [{ ...first, id: "other/general" }] })).toBeNull();
  });

  it("dedupes guilds and members by id", () => {
    const workspace = normalizeWorkspace({
      guilds: [fixtureWorkspace.guilds[0], fixtureWorkspace.guilds[0]],
      members: [fixtureWorkspace.members[0], fixtureWorkspace.members[0]],
    });

    expect(workspace.guilds).toHaveLength(1);
    expect(workspace.members).toHaveLength(1);
  });

  it("drops assignments to unknown members and roles", () => {
    const normalized = normalizeGuild({
      ...studio,
      memberRoles: {
        nyx: ["founder", "ghost-role"],
        ghost: ["founder"],
      },
    });

    expect(normalized?.memberRoles).toEqual({ nyx: ["founder"] });
  });

  it("applies an edit optimistically and then installs the server's graph", async () => {
    replaceWorkspace(fixtureWorkspace);
    const renamed: Guild = { ...studio, name: "Renamed Studio" };
    const serverWorkspace = {
      guilds: [{ ...studio, name: "Renamed Studio" }],
      members: fixtureWorkspace.members,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ guild: renamed, workspace: serverWorkspace }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(updateGuild(renamed)).resolves.toBe(true);
    expect(liveWorkspace().guilds[0]?.name).toBe("Renamed Studio");
  });

  it("rolls the optimistic edit back when the write fails", async () => {
    replaceWorkspace(fixtureWorkspace);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "no" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const renamed: Guild = { ...studio, name: "Not Saved" };
    await expect(updateGuild(renamed)).resolves.toBe(false);
    expect(liveWorkspace().guilds[0]?.name).toBe("Fixture Studio");
  });

  it("clears every guild and member on reset", () => {
    replaceWorkspace(fixtureWorkspace);
    resetLiveWorkspace();
    expect(liveWorkspace()).toEqual({ guilds: [], members: [] });
  });
});
