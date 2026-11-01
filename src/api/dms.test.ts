import { describe, expect, it } from "vitest";
import { workspaceSchema } from "../../shared/domain";
import { fixtureGuild, fixtureMembers, fixtureWorkspace } from "../../test/fixtures";
import {
  DM_PREFIX,
  dmChannel,
  dmChannelId,
  dmContacts,
  dmPartner,
  dmPartnerId,
  isDmChannelId,
  resolveChannel,
} from "./dms";

const kestrel = fixtureMembers.find((member) => member.id === "kestrel");
if (!kestrel) throw new Error("fixture member missing");

describe("direct message identity", () => {
  it("round-trips a member through the id", () => {
    expect(dmChannelId("kestrel")).toBe(`${DM_PREFIX}kestrel`);
    expect(isDmChannelId(dmChannelId("kestrel"))).toBe(true);
    expect(dmPartnerId(dmChannelId("kestrel"))).toBe("kestrel");
  });

  it("does not claim a guild channel or a bare prefix", () => {
    expect(isDmChannelId("fixture/general")).toBe(false);
    expect(isDmChannelId("")).toBe(false);
    // A prefix with nobody behind it is not a conversation.
    expect(isDmChannelId(DM_PREFIX)).toBe(false);
    expect(dmPartnerId("fixture/general")).toBeNull();
  });

  it("presents a conversation as a channel the header and feed can render", () => {
    const channel = dmChannel(kestrel);
    expect(channel.id).toBe(dmChannelId("kestrel"));
    expect(channel.name).toBe("Kestrel");
    expect(channel.topic).toBe("@kestrel");
    expect(channel.kind).toBe("text");
  });

  it("resolves the partner against the roster, and nobody else", () => {
    expect(dmPartner(fixtureWorkspace, dmChannelId("kestrel"))?.id).toBe("kestrel");
    expect(dmPartner(fixtureWorkspace, dmChannelId("ghost"))).toBeUndefined();
    expect(dmPartner(fixtureWorkspace, "fixture/general")).toBeUndefined();
  });

  it("prefers the graph and falls back to the DM space", () => {
    expect(resolveChannel(fixtureWorkspace, "fixture/general")?.slug).toBe("general");
    expect(resolveChannel(fixtureWorkspace, dmChannelId("mira"))?.name).toBe("Mira");
    expect(resolveChannel(fixtureWorkspace, dmChannelId("ghost"))).toBeUndefined();
  });
});

describe("direct message contacts", () => {
  it("lists everyone in a shared server except yourself, in a stable order", () => {
    const contacts = dmContacts(fixtureWorkspace, "nyx").map((member) => member.name);

    expect(contacts).not.toContain("Nyx");
    expect(contacts).toEqual(["Kestrel", "Mira", "Rowan Pike", "Sable"]);
  });

  it("collapses a member who is in two servers into one row", () => {
    const workspace = workspaceSchema.parse({
      guilds: [
        fixtureGuild,
        { ...fixtureGuild, id: "second", name: "Second", memberIds: ["nyx", "kestrel"] },
      ],
      members: fixtureMembers,
    });

    const ids = dmContacts(workspace, "nyx").map((member) => member.id);
    expect(ids.filter((id) => id === "kestrel")).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back to the whole roster when the account is in no server", () => {
    const workspace = workspaceSchema.parse({ guilds: [], members: fixtureMembers });

    expect(dmContacts(workspace, "nyx")).toHaveLength(fixtureMembers.length - 1);
  });

  it("does not offer people from a server the account is not in", () => {
    const workspace = workspaceSchema.parse({
      guilds: [
        { ...fixtureGuild, id: "mine", memberIds: ["nyx", "kestrel"] },
        { ...fixtureGuild, id: "theirs", memberIds: ["mira", "sable"] },
      ],
      members: fixtureMembers,
    });

    expect(dmContacts(workspace, "nyx").map((member) => member.id)).toEqual(["kestrel"]);
  });
});
