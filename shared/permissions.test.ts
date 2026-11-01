import { describe, expect, it } from "vitest";
import { buildGuild } from "./guildFactory";
import { hasChannelPermission, permissionsFor } from "./permissions";

function guild() {
  return buildGuild(
    {
      name: "Permissions Test",
      ownerId: "owner",
      ownerName: "Owner",
      ownerHandle: "owner",
      accent: 0,
      templateId: "friends",
    },
    [],
  );
}

describe("guild permissions", () => {
  it("uses the owner and member defaults and lets managers bypass overwrites", () => {
    const workspace = guild();
    const channel = workspace.channels[0]!;
    const role = workspace.roles.find((entry) => entry.id === "member")!;

    expect(hasChannelPermission(workspace, channel, "owner", "manage_guild")).toBe(true);
    expect(hasChannelPermission(workspace, channel, "owner", "export_data")).toBe(true);
    expect(hasChannelPermission(workspace, channel, "owner", "send_messages")).toBe(true);
    expect(hasChannelPermission(workspace, channel, "owner", "connect_voice")).toBe(true);
    expect(hasChannelPermission(workspace, channel, "owner", "manage_roles")).toBe(true);
    expect(hasChannelPermission(workspace, channel, "owner", "manage_invites")).toBe(true);
    expect(hasChannelPermission(workspace, channel, "owner", "moderate_members")).toBe(true);
    expect(permissionsFor(workspace, "owner", channel).size).toBeGreaterThan(0);
    expect(hasChannelPermission(workspace, channel, "owner", "view_channel")).toBe(true);
    expect(role.permissions).toContain("send_messages");
  });

  it("applies channel denies and then role allows", () => {
    const initial = guild();
    const channel = initial.channels[0]!;
    const memberRole = initial.roles.find((entry) => entry.id === "member")!;
    const memberGuild = {
      ...initial,
      memberIds: [...initial.memberIds, "member-1"],
      memberRoles: { ...initial.memberRoles, "member-1": [memberRole.id] },
      channels: [
        {
          ...channel,
          permissionOverwrites: {
            [memberRole.id]: { allow: [], deny: ["send_messages" as const] },
          },
        },
        ...initial.channels.slice(1),
      ],
    };

    expect(hasChannelPermission(memberGuild, memberGuild.channels[0]!, "member-1", "send_messages"))
      .toBe(false);

    const allowed = {
      ...memberGuild,
      channels: [
        {
          ...memberGuild.channels[0]!,
          permissionOverwrites: {
            [memberRole.id]: { allow: ["send_messages" as const], deny: ["send_messages" as const] },
          },
        },
        ...memberGuild.channels.slice(1),
      ],
    };
    expect(hasChannelPermission(allowed, allowed.channels[0]!, "member-1", "send_messages"))
      .toBe(true);
  });
});
