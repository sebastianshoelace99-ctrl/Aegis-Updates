import { z } from "zod";

/**
 * The message wire shape.
 *
 * Shared with the backend for the same reason `shared/domain.ts` is: the row the server writes
 * and the row the feed renders must be one definition, not two that agree by convention.
 */

/**
 * The upload ceiling, in bytes, for one attached file.
 *
 * It lives here rather than in the server so the picker, the uploader and the HTTP handler all
 * quote the same number: a client that let you choose a 140 MB file and only failed after
 * uploading 100 MB would be a worse bug than the limit itself.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** One message may carry a handful of files; more than this is a share, not a message. */
export const MAX_ATTACHMENTS = 10;

/** Characters, not bytes: the composer counts what the user typed. */
export const MAX_MESSAGE_BODY = 4_000;

/**
 * A gallery plate attached to a message.
 *
 * `kind` carries a default so rows written before file uploads existed (which have no `kind`)
 * still parse as artwork instead of disappearing from history.
 */
export const artworkAttachmentSchema = z.object({
  kind: z.literal("artwork").default("artwork"),
  artworkId: z.string().min(1),
  title: z.string().min(1),
  thumb: z.string().min(1),
  display: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/**
 * A file uploaded through `POST /api/uploads`.
 *
 * The server composes this record from its own metadata after resolving `uploadId`, so `name`,
 * `mime` and `size` are facts about the stored blob rather than claims from the sender - a client
 * cannot label a ZIP as `image/png` and get the feed to inline it.
 */
export const fileAttachmentSchema = z.object({
  kind: z.literal("file"),
  uploadId: z.string().min(1),
  name: z.string().min(1).max(260),
  mime: z.string().min(1).max(160),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
});
export type FileAttachment = z.infer<typeof fileAttachmentSchema>;
export type ArtworkAttachment = z.infer<typeof artworkAttachmentSchema>;

/**
 * File first: it is the only branch that requires `kind`, so it can never shadow a legacy
 * artwork row that has no discriminator at all.
 */
export const attachmentSchema = z.union([fileAttachmentSchema, artworkAttachmentSchema]);
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * How many distinct glyphs one message may carry.
 *
 * Discord's own ceiling is in the same neighbourhood. The number matters here because a message's
 * reactions travel inside the message row rather than in a join table, so an unbounded list would
 * be an unbounded row.
 */
export const MAX_REACTION_KINDS = 20;

/**
 * One glyph's reactions on one message.
 *
 * The glyph *is* the identity, exactly as Discord keys them, so two entries for the same emoji can
 * never exist. `userIds` is kept sorted and duplicate-free so two clients that toggled in a
 * different order still render the same list.
 *
 * `burst` is Discord's "super reaction": an animation gated behind Nitro there, a plain flag here.
 * Every account gets it, which is the whole point of this build.
 */
export const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
  userIds: z.array(z.string().min(1)),
  burst: z.boolean().default(false),
});
export type Reaction = z.infer<typeof reactionSchema>;

/**
 * The quick picker, in render order.
 *
 * Glyphs rather than ids because this build has no custom-emoji registry yet, and short on purpose
 * so the popover stays one row in every theme.
 */
export const QUICK_REACTIONS = ["👍", "🔥", "❤️", "😂", "🎨", "👀"] as const;

export const messageSchema = z
  .object({
    id: z.string().min(1),
    channelId: z.string().min(1),
    authorId: z.string().min(1),
    /** May be empty: a message that is only an attachment is still a message. */
    body: z.string().max(MAX_MESSAGE_BODY),
    createdAt: z.string().min(1),
    kind: z.enum(["user", "system"]),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS),
    mentions: z.array(z.string()),
    replyToId: z.string().nullable(),
    editedAt: z.string().nullable(),
    /*
     * Reactions live on the row rather than in a join table. A slice has no migration story for a
     * second table, the set is always read together with its message, and it is small. `.default([])`
     * is what keeps rows written before reactions existed parseable instead of invisible.
     */
    reactions: z.array(reactionSchema).max(MAX_REACTION_KINDS).default([]),
  })
  .refine((message) => message.body.trim().length > 0 || message.attachments.length > 0, {
    message: "A message needs text or an attachment.",
    path: ["body"],
  });
export type Message = z.infer<typeof messageSchema>;

/** `1.4 MB`, `980 KB`, `12 B`. Shared so the composer and the feed never disagree. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${exponent === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** One page of history. The server caps it; the client asks for exactly this many. */
export const PAGE_SIZE = 40;

/** `@handle` tokens. Exported so the composer inserts exactly what the renderer highlights. */
export const MENTION_PATTERN = /@([a-z][a-z0-9-]*)/gi;

export function mentionedHandles(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const handle = match[1];
    if (handle) found.add(handle.toLowerCase());
  }
  return [...found];
}

/** Whether one member is already counted under one glyph. */
export function hasReacted(reaction: Reaction, memberId: string): boolean {
  return reaction.userIds.includes(memberId);
}

/**
 * The whole reaction toggle, as a pure function.
 *
 * This is the interesting half of the feature, so it lives where a test can reach it without a
 * server or a renderer. Three properties it has to hold, and each one is a bug if it does not:
 *
 *  1. Toggling twice returns to where it started, so a double-click is not a double-reaction.
 *  2. The last member leaving removes the glyph entirely; an empty pill is not a pill.
 *  3. A plain reaction from somebody who already burst does not downgrade the animation.
 *
 * Order is preserved on update rather than re-sorted: the pill a reader is aiming at must not jump
 * because somebody else reacted elsewhere in the row.
 */
export function toggleReaction(
  reactions: readonly Reaction[],
  emoji: string,
  memberId: string,
  burst = false,
): Reaction[] {
  const index = reactions.findIndex((entry) => entry.emoji === emoji);

  if (index < 0) return [...reactions, { emoji, userIds: [memberId], burst }];

  const target = reactions[index]!;
  const leaving = target.userIds.includes(memberId);
  const userIds = leaving
    ? target.userIds.filter((id) => id !== memberId)
    : [...target.userIds, memberId].sort();

  const next = reactions.map((entry, position) =>
    // A toggle that *removes* must never set the flag: otherwise shift-clicking your own burst off
    // would leave the glyph permanently animated for everybody else.
    position === index
      ? { emoji, userIds, burst: leaving ? entry.burst : entry.burst || burst }
      : entry,
  );

  return userIds.length === 0 ? next.filter((_, position) => position !== index) : next;
}
