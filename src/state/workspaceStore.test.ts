import { beforeEach, describe, expect, it } from "vitest";
import { dmChannelId } from "../api/dms";
import { registerGuild, replaceWorkspace, resetLiveWorkspace } from "../api/liveWorkspace";
import type { Channel, Guild } from "../api/workspace";
import { guildMentions, guildUnread, readFor, useWorkspaceStore } from "./workspaceStore";
import { fixtureGuild as studio, fixtureWorkspace } from "../../test/fixtures";

const first = studio.channels.find((channel) => channel.slug === "general") as Channel;
const second = studio.channels.find((channel) => channel.slug === "quiet-harbour") as Channel;

const reset = (): void => {
  resetLiveWorkspace();
  replaceWorkspace(fixtureWorkspace);
  useWorkspaceStore.setState({
    guildId: studio.id,
    channelId: first.id,
    read: {},
    drafts: {},
    typing: {},
    presence: {},
    previousReadAt: {},
    memberListOpen: true,
    home: false,
  });
};

beforeEach(reset);

describe("workspace store", () => {
  it("counts a background message as unread, and a mention separately", () => {
    const store = useWorkspaceStore.getState();

    store.receive(second.id, "2026-10-20T10:00:00.000Z", 0);
    store.receive(second.id, "2026-10-20T10:01:00.000Z", 1);

    const state = useWorkspaceStore.getState();
    expect(readFor(state.read, second.id)).toMatchObject({ unread: 2, mentions: 1 });
    // The old marker must survive: the divider is drawn from it.
    expect(readFor(state.read, second.id).lastReadAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("never counts the channel you are looking at", () => {
    useWorkspaceStore.getState().receive(first.id, "2026-10-20T11:00:00.000Z", 1);

    const state = useWorkspaceStore.getState();
    expect(readFor(state.read, first.id)).toMatchObject({ unread: 0, mentions: 0 });
    expect(readFor(state.read, first.id).lastReadAt).toBe("2026-10-20T11:00:00.000Z");
  });

  it("clears unread on open and remembers where the marker was", () => {
    useWorkspaceStore.setState({
      read: {
        [second.id]: { lastReadAt: "2026-10-19T08:00:00.000Z", unread: 3, mentions: 2 },
      },
    });

    useWorkspaceStore.getState().openChannel(second.id, "2026-10-20T12:00:00.000Z");

    const state = useWorkspaceStore.getState();
    expect(state.channelId).toBe(second.id);
    expect(readFor(state.read, second.id)).toMatchObject({ unread: 0, mentions: 0 });
    expect(state.previousReadAt[second.id]).toBe("2026-10-19T08:00:00.000Z");
  });

  it("refuses to navigate to a channel that does not exist", () => {
    useWorkspaceStore.getState().openChannel("fixture/ghost");
    expect(useWorkspaceStore.getState().channelId).toBe(first.id);
  });

  it("navigates into a server that arrived after mount", () => {
    resetLiveWorkspace();
    const guild: Guild = {
      ...studio,
      id: "late-shift",
      name: "Late Shift",
      channels: studio.channels.map((channel) => ({
        ...channel,
        id: `late-shift/${channel.slug}`,
      })),
      categories: studio.categories.map((category) => ({
        ...category,
        id: `late-shift:${category.id.split(":")[1]}`,
      })),
    };
    // Re-point the moved channels at the renamed categories.
    guild.channels = guild.channels.map((channel, index) => ({
      ...channel,
      categoryId: `late-shift:${studio.channels[index]?.categoryId.split(":")[1] ?? "hall"}`,
    }));

    registerGuild(guild);
    const channelId = guild.channels[0]?.id ?? "";

    useWorkspaceStore.getState().openChannel(channelId);

    const state = useWorkspaceStore.getState();
    expect(state.channelId).toBe(channelId);
    expect(state.guildId).toBe("late-shift");
    expect(readFor(state.read, channelId).unread).toBe(0);
    // No prior entry means "never opened", not "last read in 1970": no divider.
    expect(state.previousReadAt[channelId]).toBeUndefined();
  });

  it("keeps drafts isolated per channel", () => {
    const store = useWorkspaceStore.getState();
    store.setDraft(first.id, "one");
    store.setDraft(second.id, "two");

    const state = useWorkspaceStore.getState();
    expect(state.drafts[first.id]).toBe("one");
    expect(state.drafts[second.id]).toBe("two");
  });

  it("tracks presence and toggles the member list independently of server data", () => {
    useWorkspaceStore.getState().setPresence("kestrel", "dnd");
    expect(useWorkspaceStore.getState().presence["kestrel"]).toBe("dnd");

    useWorkspaceStore.getState().toggleMemberList();
    expect(useWorkspaceStore.getState().memberListOpen).toBe(false);
  });

  it("aggregates unread and mentions across a guild", () => {
    const read = {
      [first.id]: { lastReadAt: "2026-10-20T00:00:00.000Z", unread: 2, mentions: 1 },
      [second.id]: { lastReadAt: "2026-10-20T00:00:00.000Z", unread: 3, mentions: 0 },
    };
    const ids = [first.id, second.id, "fixture/absent"];

    expect(guildUnread(read, ids)).toBe(5);
    expect(guildMentions(read, ids)).toBe(1);
  });

  it("opens a direct message without leaving the server the rail points at", () => {
    useWorkspaceStore.getState().openChannel(dmChannelId("kestrel"));

    const state = useWorkspaceStore.getState();
    expect(state.channelId).toBe(dmChannelId("kestrel"));
    expect(state.home).toBe(true);
    // A DM belongs to no server, so the rail keeps its selection.
    expect(state.guildId).toBe(studio.id);
    expect(readFor(state.read, dmChannelId("kestrel")).unread).toBe(0);
  });

  it("refuses a direct message with somebody who is not on the roster", () => {
    useWorkspaceStore.getState().openChannel(dmChannelId("ghost"));

    const state = useWorkspaceStore.getState();
    expect(state.channelId).toBe(first.id);
    expect(state.home).toBe(false);
  });

  it("returns to the DM space without closing the conversation", () => {
    useWorkspaceStore.getState().openChannel(dmChannelId("mira"));
    useWorkspaceStore.getState().openHome();

    const state = useWorkspaceStore.getState();
    expect(state.home).toBe(true);
    expect(state.channelId).toBe(dmChannelId("mira"));
  });

  it("leaves the DM space when a server channel is opened", () => {
    useWorkspaceStore.getState().openChannel(dmChannelId("mira"));
    useWorkspaceStore.getState().openChannel(second.id);

    const state = useWorkspaceStore.getState();
    expect(state.home).toBe(false);
    expect(state.channelId).toBe(second.id);
    expect(state.guildId).toBe(studio.id);
  });

  it("counts unread direct messages the same way it counts a channel", () => {
    const store = useWorkspaceStore.getState();
    store.receive(dmChannelId("sable"), "2026-10-20T10:00:00.000Z", 1);

    const state = useWorkspaceStore.getState();
    expect(readFor(state.read, dmChannelId("sable"))).toMatchObject({ unread: 1, mentions: 1 });
    // The rail badge reuses the guild aggregator over DM channel ids.
    expect(guildUnread(state.read, [dmChannelId("sable")])).toBe(1);
  });
});
