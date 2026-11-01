import { describe, expect, it } from "vitest";
import {
  guildMembers,
  highestRole,
  roleGroups,
  rolesOfMember,
  withMemberRole,
  withoutMemberRole,
  withoutRole,
  type Guild,
} from "./workspace";
import { fixtureGuild as studio, fixtureWorkspace } from "../../test/fixtures";

describe("roles", () => {
  it("resolves a member's roles highest first and ignores unknown ids", () => {
    expect(rolesOfMember(studio, "nyx").map((role) => role.id)).toEqual(["founder", "artist"]);
    expect(rolesOfMember(studio, "sable").map((role) => role.id)).toEqual(["reviewer"]);
    expect(rolesOfMember(studio, "nobody")).toEqual([]);

    const withGhost: Guild = {
      ...studio,
      memberRoles: { ...studio.memberRoles, nyx: ["founder", "deleted-role"] },
    };
    expect(rolesOfMember(withGhost, "nyx").map((role) => role.id)).toEqual(["founder"]);
  });

  it("colours a name with the highest positioned role", () => {
    expect(highestRole(studio, "nyx")?.id).toBe("founder");
    expect(highestRole(studio, "rowan")?.id).toBe("client");
    expect(highestRole(studio, "nobody")).toBeUndefined();
  });

  it("groups the roster by hoisted role, in position order", () => {
    const groups = roleGroups(studio, guildMembers(fixtureWorkspace, studio));

    expect(groups.map((group) => group.role?.id ?? null)).toEqual([
      "founder",
      "artist",
      "reviewer",
      "client",
    ]);
    expect(groups[0]?.members.map((member) => member.id)).toEqual(["nyx"]);
    expect(groups[2]?.members.map((member) => member.id)).toEqual(["sable"]);
  });

  it("keeps everyone when no role is hoisted", () => {
    const flat: Guild = {
      ...studio,
      roles: studio.roles.map((role) => ({ ...role, hoist: false })),
    };

    const groups = roleGroups(flat, guildMembers(fixtureWorkspace, flat));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.role).toBeNull();
    expect(groups[0]?.members).toHaveLength(flat.memberIds.length);
  });

  it("assigns and removes roles without mutating the input", () => {
    const added = withMemberRole(studio, "kestrel", "reviewer");
    expect(added).not.toBe(studio);
    expect(added.memberRoles["kestrel"]).toEqual(["artist", "reviewer"]);
    expect(studio.memberRoles["kestrel"]).toEqual(["artist"]);

    // Unknown roles and non-members are no-ops, not corrupt records.
    expect(withMemberRole(studio, "kestrel", "ghost")).toBe(studio);
    expect(withMemberRole(studio, "outsider", "artist")).toBe(studio);

    const removed = withoutMemberRole(added, "kestrel", "reviewer");
    expect(removed.memberRoles["kestrel"]).toEqual(["artist"]);

    const emptied = withoutMemberRole(studio, "kestrel", "artist");
    expect(emptied.memberRoles["kestrel"]).toBeUndefined();
  });

  it("deletes a role and every assignment that pointed at it", () => {
    const next = withoutRole(studio, "client");

    expect(next.roles.some((role) => role.id === "client")).toBe(false);
    expect(Object.values(next.memberRoles).some((ids) => ids.includes("client"))).toBe(false);
    // Sable keeps the reviewer role; deleting client does not empty the whole record.
    expect(next.memberRoles["sable"]).toEqual(["reviewer"]);
    expect(next.memberIds).toEqual(studio.memberIds);
  });
});
