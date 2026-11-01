import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_NAME_MAX,
  SERVER_TEMPLATES,
  buildGuild,
  createServer,
  serverInitials,
  slugifyServerName,
  templateById,
  uniqueGuildId,
} from "./createServer";
import { liveWorkspace, resetLiveWorkspace } from "./liveWorkspace";
import { channelsByCategory, findChannelById } from "./workspace";
import { fixtureWorkspace } from "../../test/fixtures";

const base = { name: "Test Server", accent: 2, templateId: "artists", ownerId: "nyx" } as const;

beforeEach(resetLiveWorkspace);
afterEach(() => {
  vi.unstubAllGlobals();
  resetLiveWorkspace();
});

describe("server factory", () => {
  it("builds a guild the rail, router and roster can resolve", () => {
    const guild = buildGuild(base, []);

    expect(guild.id).toBe("test-server");
    expect(guild.name).toBe("Test Server");
    expect(guild.initial).toBe("TS");
    expect(guild.accent).toBe(2);

    expect(findChannelById({ guilds: [guild], members: [] }, "test-server/general")?.name).toBe(
      "general",
    );
  });

  it("gives the server a text category with #general and a voice category", () => {
    const guild = buildGuild(base, []);
    const groups = channelsByCategory(guild);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.category.name).toBe("TEXT CHANNELS");
    expect(groups[0]?.channels.map((channel) => channel.slug)).toEqual(["general"]);

    expect(groups[1]?.category.name).toBe("VOICE CHANNELS");
    expect(groups[1]?.channels.map((channel) => channel.slug)).toEqual(["voice"]);
    expect(groups[1]?.channels[0]?.kind).toBe("voice");

    // The channel has to belong to this guild: a borrowed category id is how ids collide.
    expect(guild.channels[0]?.categoryId).toBe(groups[0]?.category.id);
    expect(guild.channels[0]?.id.startsWith(`${guild.id}/`)).toBe(true);
  });

  it("carries the chosen template into the channel topic", () => {
    expect(buildGuild({ ...base, templateId: "study" }, []).channels[0]?.topic).toMatch(/goal/i);
    expect(buildGuild({ ...base, name: "Custom", templateId: "custom" }, []).channels[0]?.topic).toMatch(
      /start of the server/i,
    );
  });

  it("suffixes ids instead of colliding", () => {
    expect(buildGuild(base, []).id).toBe("test-server");
    expect(buildGuild(base, ["test-server"]).id).toBe("test-server-2");
    expect(buildGuild(base, ["test-server", "test-server-2"]).id).toBe("test-server-3");
  });

  it("slugifies names into readable ids and initials", () => {
    expect(slugifyServerName("Artists & creators")).toBe("artists-creators");
    expect(slugifyServerName("  Café   Íris  ")).toBe("cafe-iris");
    expect(slugifyServerName("***")).toBe("server");
    expect(slugifyServerName("x".repeat(80))).toHaveLength(32);
    expect(uniqueGuildId("studio", ["studio", "studio-2"])).toBe("studio-3");

    expect(serverInitials("Test Server")).toBe("TS");
    expect(serverInitials("Solo")).toBe("S");
  });

  it("rejects names and colours the UI would have to apologise for", () => {
    expect(() => buildGuild({ ...base, name: "a" }, [])).toThrow();
    expect(() => buildGuild({ ...base, name: "   " }, [])).toThrow();
    expect(() => buildGuild({ ...base, name: "x".repeat(SERVER_NAME_MAX + 1) }, [])).toThrow();
    expect(() => buildGuild({ ...base, accent: 8 }, [])).toThrow();
  });

  it("trims the name it stores", () => {
    expect(buildGuild({ ...base, name: "  Padded  " }, []).name).toBe("Padded");
  });

  it("offers six templates with distinct ids and in-palette accents", () => {
    expect(SERVER_TEMPLATES).toHaveLength(6);
    expect(new Set(SERVER_TEMPLATES.map((template) => template.id)).size).toBe(6);

    for (const template of SERVER_TEMPLATES) {
      expect(template.accent).toBeGreaterThanOrEqual(0);
      expect(template.accent).toBeLessThanOrEqual(7);
      expect(template.topic.length).toBeGreaterThan(0);
    }

    expect(templateById("custom")).toBeNull();
    expect(templateById("gaming")?.label).toBe("Gaming");
  });
});

describe("createServer against the backend", () => {
  it("posts the input and installs the returned workspace", async () => {
    const guild = buildGuild(base, []);
    const workspace = {
      guilds: [...fixtureWorkspace.guilds, guild],
      members: fixtureWorkspace.members,
    };

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ guild, workspace }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const created = await createServer(base);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(created.id).toBe("test-server");
    expect(liveWorkspace().guilds.some((entry) => entry.id === "test-server")).toBe(true);
    expect(liveWorkspace().guilds).toHaveLength(2);
  });

  it("does not touch the live graph when the backend refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "nope" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(createServer(base)).rejects.toThrow(/nope/);
    expect(liveWorkspace().guilds).toHaveLength(0);
  });
});
