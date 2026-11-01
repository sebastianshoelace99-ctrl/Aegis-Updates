import { z } from "zod";

export const moderationActionSchema = z.enum([
  "timeout",
  "remove_timeout",
  "kick",
  "ban",
  "unban",
]);
export type ModerationAction = z.infer<typeof moderationActionSchema>;

export const moderationAuditEntrySchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  actorId: z.string().min(1),
  targetId: z.string().min(1),
  action: moderationActionSchema,
  reason: z.string().max(500),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ModerationAuditEntry = z.infer<typeof moderationAuditEntrySchema>;

