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
  | { type: "voice-peer"; channelId: string; memberId: string; joined: boolean }
  | {
      type: "voice-signal";
      channelId: string;
      fromMemberId: string;
      toMemberId: string;
      signal:
        | { type: "description"; sdpType: "offer" | "answer"; sdp: string }
        | {
            type: "candidate";
            candidate: string;
            sdpMid?: string | null;
            sdpMLineIndex?: number | null;
            usernameFragment?: string | null;
          };
    }
  | { type: "presence"; memberId: string; presence: Presence };

export const voiceSignalSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("description"),
    sdpType: z.enum(["offer", "answer"]),
    sdp: z.string().min(1).max(100_000),
  }),
  z.object({
    type: z.literal("candidate"),
    candidate: z.string().max(4096),
    sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(65535).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  }),
]);
export type VoiceSignal = z.infer<typeof voiceSignalSchema>;

export const backendEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: messageSchema }),
  z.object({ type: z.literal("reaction"), message: messageSchema }),
  z.object({ type: z.literal("typing"), channelId: z.string().min(1), memberId: z.string().min(1) }),
  z.object({
    type: z.literal("voice-peer"),
    channelId: z.string().min(1),
    memberId: z.string().min(1),
    joined: z.boolean(),
  }),
  z.object({
    type: z.literal("voice-signal"),
    channelId: z.string().min(1),
    fromMemberId: z.string().min(1),
    toMemberId: z.string().min(1),
    signal: voiceSignalSchema,
  }),
  z.object({
    type: z.literal("presence"),
    memberId: z.string().min(1),
    presence: z.enum(["online", "idle", "dnd", "offline"]),
  }),
]);
