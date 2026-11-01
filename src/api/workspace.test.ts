import { describe, expect, it } from "vitest";
import {
  channelsByCategory,
  defaultRoute,
  findChannel,
  findChannelById,
  findGuild,
  guildMembers,
  guildOfChannel,
  memberById,
  normalizeWorkspace,
  workspace,
  type Category,
  type Guild,
} from "./workspace";
import { fixtureGuild as studio, fixtureWorkspace } from "../../test/fixtures";

describe("workspace graph", () => {
  it("ships an empty boot workspace, not a demo server", () => {
    expect(workspace.guilds).toEqual([]);
    expect(workspace.members).toEqual([]);
    expect(defaultRoute(workspace)).toEqual({ guildId: "", slug: "" });
  });

  it("gives every channel a globally unique id", () => {
    const ids = new Set<string>();

    for (const guild of fixtureWorkspace.guilds) {
      for (const channel of guild.channels) {
        expect(ids.has(channel.id)).toBe(false);
        ids.add(channel.id);
      }
    }

    expect(ids.size).toBe(studio.channels.length);
    expect(findChannelById(fixtureWorkspace, "fixture/gallery")?.kind).toBe("media");
    expect(findChannelById(fixtureWorkspace, "nope/galley")).toBeUndefined();
  });

  it("points every channel at a category that exists in its own guild", () => {
    for (const guild of fixtureWorkspace.guilds) {
      const categoryIds = new Set(guild.categories.map((category: Category) => category.id));

      for (const channel of guild.channels) {
        expect(categoryIds.has(channel.categoryId)).toBe(true);
        // A channel must belong to its guild, not borrow another one's category.
        expect(channel.id.startsWith(`${guild.id}/`)).toBe(true);
      }
    }
  });

  it("resolves every membership to a real member and keeps handles unique", () => {
    const handles = new Set(fixtureWorkspace.members.map((member) => member.handle));
    expect(handles.size).toBe(fixtureWorkspace.members.length);

    const members = guildMembers(fixtureWorkspace, studio);
    expect(members).toHaveLength(studio.memberIds.length);
    expect(members.map((member) => member.id)).toEqual(studio.memberIds);
  });

  it("keeps category order as declared and omits empty categories", () => {
    const groups = channelsByCategory(studio);
    expect(groups.map((group) => group.category.id)).toEqual(
      studio.categories.map((category) => category.id),
    );

    const sparse: Guild = {
      ...studio,
      categories: [
        { id: "fixture:empty", name: "EMPTY" },
        { id: "fixture:hall", name: "STUDIO" },
      ],
      channels: studio.channels.filter((channel) => channel.categoryId === "fixture:hall"),
    };

    expect(channelsByCategory(sparse).map((group) => group.category.id)).toEqual(["fixture:hall"]);
  });

  it("finds by id and slug, and defaults to a channel that exists", () => {
    expect(findGuild(fixtureWorkspace, "fixture")?.name).toBe("Fixture Studio");
    expect(findGuild(fixtureWorkspace, "nope")).toBeUndefined();

    const gallery = findChannel(studio, "gallery");
    expect(gallery?.kind).toBe("media");
    expect(findChannel(studio, "nope")).toBeUndefined();

    // Ownership is resolved from the graph, not by splitting the id on "/".
    expect(guildOfChannel(fixtureWorkspace, gallery?.id ?? "")?.id).toBe("fixture");
    expect(guildOfChannel(fixtureWorkspace, "fixture/ghost")).toBeUndefined();

    const route = defaultRoute(fixtureWorkspace);
    expect(findChannel(findGuild(fixtureWorkspace, route.guildId) as Guild, route.slug)).toBeDefined();

    expect(memberById(fixtureWorkspace, "sable")?.role).toBe("reviewer");
    expect(memberById(fixtureWorkspace, "nobody")).toBeUndefined();
  });

  it("drops a guild whose channel points at a missing category", () => {
    const broken = {
      ...studio,
      channels: [{ ...studio.channels[0], categoryId: "missing" }],
    };

    const normalized = normalizeWorkspace({ guilds: [broken], members: fixtureWorkspace.members });
    expect(normalized.guilds).toEqual([]);
    expect(normalized.members).toHaveLength(fixtureWorkspace.members.length);
  });
});
