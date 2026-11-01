import { guildSchema, workspaceSchema, type Guild, type Member, type Workspace } from "../shared/domain";

/**
 * A workspace for tests that is not shipped with the app.
 *
 * The production boot value is empty (see `src/api/workspace.ts`), so anything asserting on a
 * populated graph has to bring its own. Keeping it here - rather than minting a "demo" guild in
 * the app - is what stops test-only data from reappearing in the rail.
 */

const members: Member[] = [
  { id: "nyx", name: "Nyx", handle: "nyx", role: "artist", presence: "online", accent: 0 },
  { id: "kestrel", name: "Kestrel", handle: "kestrel", role: "artist", presence: "online", accent: 1 },
  { id: "mira", name: "Mira", handle: "mira", role: "artist", presence: "idle", accent: 3 },
  { id: "sable", name: "Sable", handle: "sable", role: "reviewer", presence: "online", accent: 7 },
  { id: "rowan", name: "Rowan Pike", handle: "rowan", role: "client", presence: "online", accent: 2 },
];

const guild: Guild = guildSchema.parse({
  id: "fixture",
  name: "Fixture Studio",
  initial: "FS",
  accent: 0,
  categories: [
    { id: "fixture:commissions", name: "COMMISSIONS" },
    { id: "fixture:hall", name: "STUDIO" },
  ],
  channels: [
    {
      id: "fixture/quiet-harbour",
      slug: "quiet-harbour",
      name: "quiet-harbour",
      topic: "Quiet Harbour 001 · in review",
      kind: "text",
      categoryId: "fixture:commissions",
      commissionId: "art_001",
    },
    {
      id: "fixture/general",
      slug: "general",
      name: "general",
      topic: "Off-topic.",
      kind: "text",
      categoryId: "fixture:hall",
      commissionId: null,
    },
    {
      id: "fixture/gallery",
      slug: "gallery",
      name: "gallery",
      topic: "Finished plates.",
      kind: "media",
      categoryId: "fixture:hall",
      commissionId: null,
    },
    {
      id: "fixture/lounge",
      slug: "lounge",
      name: "lounge",
      topic: "Voice lounge.",
      kind: "voice",
      categoryId: "fixture:hall",
      commissionId: null,
    },
  ],
  memberIds: ["nyx", "kestrel", "mira", "sable", "rowan"],
  roles: [
    { id: "founder", name: "Founder", color: 3, hoist: true, position: 4 },
    { id: "artist", name: "Artist", color: 0, hoist: true, position: 3 },
    { id: "reviewer", name: "Reviewer", color: 5, hoist: true, position: 2 },
    { id: "client", name: "Client", color: 7, hoist: true, position: 1 },
  ],
  memberRoles: {
    nyx: ["founder", "artist"],
    kestrel: ["artist"],
    mira: ["artist"],
    sable: ["reviewer"],
    rowan: ["client"],
  },
});

export const fixtureGuild: Guild = guild;
export const fixtureMembers: Member[] = members;
export const fixtureWorkspace: Workspace = workspaceSchema.parse({
  guilds: [guild],
  members,
});
