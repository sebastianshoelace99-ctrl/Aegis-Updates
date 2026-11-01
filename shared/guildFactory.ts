import { z } from "zod";
import { guildSchema, type Guild, type Member } from "./domain";
import { DEFAULT_MEMBER_PERMISSIONS, OWNER_PERMISSIONS } from "./permissions";

/**
 * Server creation, shared by the dialog's validation and the backend's insert.
 *
 * The id, slug, initials and first channels are derived here rather than at the call site: a
 * second caller would assemble them differently, and then a guild posted by the server would not
 * match the one the rail expects.
 */

export const SERVER_NAME_MIN = 2;
export const SERVER_NAME_MAX = 100;

/** Trimmed before it is measured, so "  " is not a two-character name. */
export const serverNameSchema = z
  .string()
  .trim()
  .min(SERVER_NAME_MIN, `Use at least ${SERVER_NAME_MIN} characters.`)
  .max(SERVER_NAME_MAX, `Use at most ${SERVER_NAME_MAX} characters.`);

export const TEMPLATE_IDS = [
  "friends",
  "gaming",
  "school",
  "study",
  "artists",
  "community",
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];
/** `custom` is "Skip this question": nothing beyond a #general channel. */
export type TemplateChoice = TemplateId | "custom";

export type ServerTemplate = {
  id: TemplateId;
  label: string;
  caption: string;
  /** Becomes #general's topic, so the empty channel explains itself. */
  topic: string;
  /** Suggested icon colour. A number, because the palette is indexed in CSS (no inline styles). */
  accent: number;
};

const TEMPLATES: Record<TemplateId, ServerTemplate> = {
  friends: {
    id: "friends",
    label: "Friends",
    caption: "Hang out and share",
    topic: "Hang out, share things, and keep up with everyone.",
    accent: 3,
  },
  gaming: {
    id: "gaming",
    label: "Gaming",
    caption: "Queue up together",
    topic: "Find people to play with, share clips, and plan sessions.",
    accent: 5,
  },
  school: {
    id: "school",
    label: "School club",
    caption: "Notes and deadlines",
    topic: "Notes, deadlines, and everything for this term.",
    accent: 0,
  },
  study: {
    id: "study",
    label: "Study group",
    caption: "Work alongside",
    topic: "Set a goal, share progress, and keep each other honest.",
    accent: 2,
  },
  artists: {
    id: "artists",
    label: "Artists & creators",
    caption: "Work in progress",
    topic: "Share work in progress and get feedback that helps.",
    accent: 1,
  },
  community: {
    id: "community",
    label: "Community",
    caption: "Welcome people in",
    topic: "Welcome people in, set the tone, and keep everyone in the loop.",
    accent: 6,
  },
};

/** Tile order, declared separately from the record so the grid is not `Object.keys` order. */
export const SERVER_TEMPLATES: readonly ServerTemplate[] = TEMPLATE_IDS.map((id) => TEMPLATES[id]);

export function templateById(choice: TemplateChoice): ServerTemplate | null {
  return choice === "custom" ? null : TEMPLATES[choice];
}

export const templateChoiceSchema = z.union([z.enum(TEMPLATE_IDS), z.literal("custom")]);

export const createServerInputSchema = z.object({
  name: serverNameSchema,
  accent: z.number().int().min(0).max(7),
  templateId: templateChoiceSchema,
  /** Whoever pressed Create becomes the first member, as Discord does. */
  ownerId: z.string().min(1),
  /**
   * Optional profile facts for the owner row. The local settings document is the only place a
   * display name exists before the account has ever written to the server.
   */
  ownerName: z.string().trim().min(1).max(80).optional(),
  ownerHandle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .optional(),
});

/**
 * "Artists & creators" becomes `artists-creators`. Diacritics are folded rather than dropped, so
 * "Cafe" written with an accent and without one cannot produce two ids that look identical.
 */
export function slugifyServerName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");

  return slug.length > 0 ? slug : "server";
}

/** Readable ids mean a collision resolves as a suffix, not as a random snowflake. */
export function uniqueGuildId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** First letters of up to two words, filtered to letters so an emoji cannot break the schema. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1] ?? "") : "";

  const picked = [first, last]
    .map((word) => [...word].find((char) => LETTER_OR_DIGIT.test(char)) ?? "")
    .join("");

  const initials = [...picked].slice(0, 2).join("");
  return initials.length > 0 ? initials.toUpperCase() : "S";
}

/** Server settings renames a guild; the icon initials must follow the same rule as creation. */
export function serverInitials(name: string): string {
  return initialsOf(name);
}

/** The owner's global member record, derived from whatever profile facts the client sent. */
export function ownerMember(input: CreateServerInput): Member {
  const name = input.ownerName?.trim() || input.ownerId;
  const handle = input.ownerHandle?.trim() || slugifyServerName(name);

  return {
    id: input.ownerId,
    name,
    handle,
    role: "artist",
    presence: "online",
    accent: input.accent,
    activity: undefined,
  };
}

/**
 * Build, validate. Registration is the caller's job, because the client posts this to the
 * backend and the server inserts it; neither wants this function to touch a registry.
 */
export function buildGuild(input: CreateServerInput, taken: Iterable<string>): Guild {
  const parsed = createServerInputSchema.parse(input);
  const template = templateById(parsed.templateId);

  const id = uniqueGuildId(slugifyServerName(parsed.name), taken);
  const categoryId = `${id}:channels`;
  const voiceCategoryId = `${id}:voice`;

  return guildSchema.parse({
    id,
    name: parsed.name,
    initial: initialsOf(parsed.name),
    accent: parsed.accent,
    categories: [
      { id: categoryId, name: "TEXT CHANNELS" },
      { id: voiceCategoryId, name: "VOICE CHANNELS" },
    ],
    channels: [
      {
        id: `${id}/general`,
        slug: "general",
        name: "general",
        topic: template?.topic ?? "This is the start of the server. Say something.",
        kind: "text",
        categoryId,
        commissionId: null,
      },
      {
        id: `${id}/voice`,
        slug: "voice",
        name: "voice",
        topic: "The server's voice channel. Join to talk, turn on a camera, or share a screen.",
        kind: "voice",
        categoryId: voiceCategoryId,
        commissionId: null,
      },
    ],
    memberIds: [parsed.ownerId],
    roles: [
      {
        id: "owner",
        name: "Owner",
        color: parsed.accent,
        hoist: true,
        position: 2,
        permissions: OWNER_PERMISSIONS,
      },
      {
        id: "member",
        name: "Member",
        color: 7,
        hoist: true,
        position: 1,
        permissions: DEFAULT_MEMBER_PERMISSIONS,
      },
    ],
    memberRoles: { [parsed.ownerId]: ["owner"] },
  });
}

export type CreateServerInput = z.infer<typeof createServerInputSchema>;
