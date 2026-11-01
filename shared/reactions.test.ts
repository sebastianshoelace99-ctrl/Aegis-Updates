import { describe, expect, it } from "vitest";
import {
  MAX_REACTION_KINDS,
  hasReacted,
  messageSchema,
  toggleReaction,
  type Reaction,
} from "./messages";

/**
 * Reactions, at the level where the rules actually live.
 *
 * The store and the HTTP route are thin wrappers over `toggleReaction`, so this is where a mistake
 * would be caught: a double-click that counts twice, a pill that survives its last member, or a
 * burst that gets silently downgraded are all one-line bugs that no screenshot would show.
 */

const plain = (emoji: string, ...userIds: string[]): Reaction => ({ emoji, userIds, burst: false });

describe("toggleReaction", () => {
  it("adds a reaction from a member who has not reacted yet", () => {
    expect(toggleReaction([], "🔥", "nyx")).toEqual([plain("🔥", "nyx")]);
  });

  it("returns to where it started when the same member toggles twice", () => {
    const once = toggleReaction([], "🔥", "nyx");
    expect(toggleReaction(once, "🔥", "nyx")).toEqual([]);
  });

  it("keeps the glyph when one of two members leaves", () => {
    const both = toggleReaction(toggleReaction([], "🔥", "nyx"), "🔥", "kai");
    expect(toggleReaction(both, "🔥", "nyx")).toEqual([plain("🔥", "kai")]);
  });

  it("drops the glyph entirely when its last member leaves", () => {
    const one = toggleReaction([], "🔥", "nyx");
    expect(toggleReaction(one, "🔥", "nyx")).toHaveLength(0);
  });

  it("adds a member to an existing glyph without moving the strip", () => {
    // Two glyphs, second member reacts to the *first* one: order must not be rewritten, because a
    // reader aiming at a pill should not have it slide sideways underneath the pointer.
    const start = toggleReaction(toggleReaction([], "🔥", "nyx"), "👀", "nyx");
    const after = toggleReaction(start, "🔥", "kai");

    expect(after.map((entry) => entry.emoji)).toEqual(["🔥", "👀"]);
    expect(after[0]?.userIds).toEqual(["kai", "nyx"]);
  });

  it("keeps the burst flag when its author leaves and somebody else remains", () => {
    const burst = toggleReaction([], "🔥", "nyx", true);
    const joined = toggleReaction(burst, "🔥", "kai");
    const left = toggleReaction(joined, "🔥", "nyx");

    expect(left).toEqual([{ emoji: "🔥", userIds: ["kai"], burst: true }]);
  });

  it("does not set the burst flag when a plain toggle removes a reaction", () => {
    /*
     * The real regression: `entry.burst || burst` was true on the way out as well as the way in, so
     * shift-clicking your own plain reaction off a glyph that somebody else still held turned that
     * glyph into a permanent super reaction for everybody.
     */
    const shared = toggleReaction(toggleReaction([], "🔥", "nyx"), "🔥", "kai");
    const removed = toggleReaction(shared, "🔥", "nyx", true);

    expect(removed).toEqual([{ emoji: "🔥", userIds: ["kai"], burst: false }]);
  });

  it("counts a member once even if they react through two different code paths", () => {
    const once = toggleReaction([], "🔥", "nyx");
    const twice = toggleReaction([], "🔥", "nyx");
    const merged = toggleReaction(once, "🔥", "nyx");

    expect(hasReacted(once[0]!, "nyx")).toBe(true);
    expect(twice).toEqual(once);
    expect(merged).toHaveLength(0);
  });

  it("refuses a message carrying more glyphs than the row is allowed", () => {
    const glyphs = Array.from({ length: MAX_REACTION_KINDS + 1 }, (_, index) =>
      plain(`g${index}`, "nyx"),
    );

    const parsed = messageSchema.safeParse({
      id: "m",
      channelId: "c",
      authorId: "a",
      body: "hi",
      createdAt: new Date().toISOString(),
      kind: "user",
      attachments: [],
      mentions: [],
      replyToId: null,
      editedAt: null,
      reactions: glyphs,
    });

    expect(parsed.success).toBe(false);
  });
});

describe("messageSchema reactions", () => {
  it("reads a row written before reactions existed as having none", () => {
    // This is the migration story: `.default([])` is what stops old history from becoming invisible.
    const parsed = messageSchema.parse({
      id: "m",
      channelId: "c",
      authorId: "a",
      body: "hi",
      createdAt: new Date().toISOString(),
      kind: "user",
      attachments: [],
      mentions: [],
      replyToId: null,
      editedAt: null,
    });

    expect(parsed.reactions).toEqual([]);
  });

  it("defaults a burst-less reaction row to a plain one", () => {
    const parsed = messageSchema.parse({
      id: "m",
      channelId: "c",
      authorId: "a",
      body: "hi",
      createdAt: new Date().toISOString(),
      kind: "user",
      attachments: [],
      mentions: [],
      replyToId: null,
      editedAt: null,
      reactions: [{ emoji: "🔥", userIds: ["nyx"] }],
    });

    expect(parsed.reactions[0]?.burst).toBe(false);
  });
});
