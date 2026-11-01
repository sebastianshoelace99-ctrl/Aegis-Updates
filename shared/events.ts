import { z } from "zod";
import type { Presence } from "./domain";
import { messageSchema, type Message } from "./messages";

/**
 * The live-event envelope.
 *
 * Shared so the server cannot publish a shape the renderer's parser rejects without both sides
 * failing to compile.
 */

export type BackendEvent =
  | { type: "message"; message: Message }
  /*
   * A reaction toggle. It carries the whole updated row so the renderer has exactly one reducer
   * for "a message changed" - a bespoke reaction delta would be a second code path to keep in
   * step with the first.
   */
  | { type: "reaction"; message: Message }
  | { type: "typing"; channelId: string; memberId: string }
  | { type: "presence"; memberId: string; presence: Presence };

export const backendEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: messageSchema }),
  z.object({ type: z.literal("reaction"), message: messageSchema }),
  z.object({ type: z.literal("typing"), channelId: z.string().min(1), memberId: z.string().min(1) }),
  z.object({
    type: z.literal("presence"),
    memberId: z.string().min(1),
    presence: z.enum(["online", "idle", "dnd", "offline"]),
  }),
]);
