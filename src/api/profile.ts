import { z } from "zod";
import type { Presence } from "./workspace";

/**
 * Local customization settings.
 *
 * There is no account service yet, so this document is the account: display name, profile
 * picture, banner, bio, custom status, appearance and voice preferences. It is deliberately a
 * *validated* document rather than loose JSON - every field has a bounded shape, and a corrupt
 * or hand-edited entry degrades to its default instead of blanking the app.
 *
 * Persistence lives in `src/state/settingsStore.ts`; this module stays pure so it can run under
 * Vitest's node environment without a DOM.
 */

export const SETTINGS_KEY = "aegis.settings.v1";
/**
 * 3: the accent became a hue that applies to every edition, and `tint` arrived. See `parseSettings`
 * for why a v2 document's stored accent is retired rather than trusted.
 */
export const SETTINGS_VERSION = 3;

export const MAX_DISPLAY_NAME = 32;
export const MAX_PRONOUNS = 40;
export const MAX_BIO = 190;
export const MAX_STATUS_TEXT = 128;
export const MAX_STATUS_EMOJI = 8;
/** ~900 kB of base64. A downscaled avatar is ~15 kB and a banner ~40 kB, so this is generous. */
export const MAX_IMAGE_DATA_URL = 900_000;

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Data URLs only: the renderer can read a file without extending the frozen preload contract. */
export const imageDataUrlSchema = z
  .string()
  .max(MAX_IMAGE_DATA_URL, "That image is too large.")
  .regex(IMAGE_DATA_URL, "Use a PNG, JPEG or WebP image.");

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "A display name is required.")
  .max(MAX_DISPLAY_NAME, `Use at most ${MAX_DISPLAY_NAME} characters.`);

export const profileSchema = z.object({
  displayName: displayNameSchema.default("Nyx"),
  pronouns: z.string().trim().max(MAX_PRONOUNS).default(""),
  bio: z.string().max(MAX_BIO).default(""),
  /** Index into `--palette-0..7`; used for the avatar fallback and the banner gradient. */
  accent: z.number().int().min(0).max(7).default(0),
  avatar: imageDataUrlSchema.nullable().default(null),
  banner: imageDataUrlSchema.nullable().default(null),
  bannerAccent: z.number().int().min(0).max(7).default(0),
  /*
   * Cosmetics. Every one is an *index* into a palette defined in CSS, never a colour, a filter or a
   * gradient string, for the same reason `accent` is a number: `style-src 'self'` forbids inline
   * styles, and a hand-edited settings file must not be able to inject CSS.
   *
   * All three are the kind of thing Discord charges a subscription for. There is no entitlement
   * check anywhere in this app: `0` means "none", and every other value is available to everyone.
   */
  /** Ring around the avatar picture. 0 = none, 1..6 = a style. */
  decoration: z.number().int().min(0).max(6).default(0),
  /** Flourish behind the profile card. 0 = none, 1..5 = a style. */
  effect: z.number().int().min(0).max(5).default(0),
  /** Border treatment on the profile card. 0 = none, 1..5 = a style. */
  frame: z.number().int().min(0).max(5).default(0),
});
export type Profile = z.infer<typeof profileSchema>;

export const presenceChoiceSchema = z.enum(["online", "idle", "dnd", "invisible"]);
export type PresenceChoice = z.infer<typeof presenceChoiceSchema>;

export const customStatusSchema = z.object({
  presence: presenceChoiceSchema.default("online"),
  /** Usually one emoji, but the schema allows a short grapheme cluster rather than a code point. */
  emoji: z.string().max(MAX_STATUS_EMOJI).default(""),
  text: z.string().trim().max(MAX_STATUS_TEXT).default(""),
});
export type CustomStatus = z.infer<typeof customStatusSchema>;

/**
 * Appearance is the whole customization surface, and every field is an *index or a name*, never a
 * colour string or a CSS snippet. That is deliberate: `style-src 'self'` forbids inline styles, so
 * the document chooses which token block applies (`data-accent="crimson"`) and the stylesheet owns
 * the actual values. It also means a hand-edited settings file cannot inject CSS.
 *
 * The theme id and the light/dark/system mode are NOT here: they are app-level appearance, shared
 * by every account on this install, and they live in `src/theme/storage.ts` under their own keys.
 */
/**
 * The accent is now a choice about *hue*, not a token block: it applies to every edition. `theme`
 * keeps whatever palette the edition shipped (the default), the six named hues are the family
 * ECHO-net introduced, and `custom` defers to `tint`.
 */
export const accentChoiceSchema = z.enum([
  "theme",
  "gold",
  "crimson",
  "emerald",
  "cyan",
  "violet",
  "rose",
  "custom",
]);
export type AccentChoice = z.infer<typeof accentChoiceSchema>;

/**
 * An arbitrary accent colour, `#rrggbb`, or "" for "no custom colour".
 *
 * `.catch("")` rather than a hard failure: a hand-edited or truncated hex costs the colour, not the
 * whole appearance section, and the value can never reach CSS unvalidated.
 */
export const tintSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .catch("")
  .default("");
export type Tint = z.infer<typeof tintSchema>;

export const densitySchema = z.enum(["cozy", "compact"]);
export type Density = z.infer<typeof densitySchema>;

export const messageSizeSchema = z.enum(["small", "normal", "large"]);
export type MessageSize = z.infer<typeof messageSizeSchema>;

export const displayFontSchema = z.enum(["condensed", "classic", "mono"]);
export type DisplayFont = z.infer<typeof displayFontSchema>;

export const motionChoiceSchema = z.enum(["full", "reduced"]);
export type MotionChoice = z.infer<typeof motionChoiceSchema>;

export const textureChoiceSchema = z.enum(["grid", "plain"]);
export type TextureChoice = z.infer<typeof textureChoiceSchema>;

export const clockChoiceSchema = z.enum(["auto", "12h", "24h"]);
export type ClockChoice = z.infer<typeof clockChoiceSchema>;

export const appearanceSchema = z.object({
  /** Cozy is Discord's default; compact removes the gutter padding and shrinks avatars. */
  density: densitySchema.default("cozy"),
  /** Which hue drives the accent family. Applies to every edition; `theme` keeps its own. */
  accent: accentChoiceSchema.default("theme"),
  /** The custom accent, when `accent` is `custom`. Empty means "no colour picked yet". */
  tint: tintSchema,
  /** Message copy size. Independent of density: a tight list can still have readable text. */
  messageSize: messageSizeSchema.default("normal"),
  /** Display face for headings, labels and the composer chrome. */
  font: displayFontSchema.default("condensed"),
  motion: motionChoiceSchema.default("full"),
  /** The faint gold grid and shield watermark behind the conversation. */
  texture: textureChoiceSchema.default("grid"),
  clock: clockChoiceSchema.default("auto"),
});
export type Appearance = z.infer<typeof appearanceSchema>;

export const screenQualitySchema = z.enum(["720p", "1080p", "source"]);
export type ScreenQuality = z.infer<typeof screenQualitySchema>;

export const voicePreferencesSchema = z.object({
  /** `default` follows the OS, which is what most people actually want. */
  inputDeviceId: z.string().max(200).default("default"),
  noiseSuppression: z.boolean().default(true),
  echoCancellation: z.boolean().default(true),
  autoGainControl: z.boolean().default(true),
  /** 0..100. Higher means the speaking ring reacts to a quieter voice. */
  sensitivity: z.number().int().min(0).max(100).default(55),
  screenQuality: screenQualitySchema.default("1080p"),
});
export type VoicePreferences = z.infer<typeof voicePreferencesSchema>;

export const DEFAULT_PROFILE: Profile = {
  displayName: "Nyx",
  pronouns: "",
  bio: "",
  accent: 0,
  avatar: null,
  banner: null,
  bannerAccent: 0,
  decoration: 0,
  effect: 0,
  frame: 0,
};

export const DEFAULT_STATUS: CustomStatus = {
  presence: "online",
  emoji: "",
  text: "",
};

export const DEFAULT_APPEARANCE: Appearance = appearanceSchema.parse({});

export const DEFAULT_VOICE: VoicePreferences = {
  inputDeviceId: "default",
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  sensitivity: 55,
  screenQuality: "1080p",
};

/**
 * `.default()` fills a missing section; `.catch()` replaces an invalid one. A single bad field
 * therefore costs that section, not the whole document - and a version bump can add a section
 * without wiping the others.
 */
export const settingsSchema = z.object({
  version: z.literal(SETTINGS_VERSION).catch(SETTINGS_VERSION),
  profile: profileSchema.default(DEFAULT_PROFILE).catch(DEFAULT_PROFILE),
  status: customStatusSchema.default(DEFAULT_STATUS).catch(DEFAULT_STATUS),
  appearance: appearanceSchema.default(DEFAULT_APPEARANCE).catch(DEFAULT_APPEARANCE),
  voice: voicePreferencesSchema.default(DEFAULT_VOICE).catch(DEFAULT_VOICE),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  profile: DEFAULT_PROFILE,
  status: DEFAULT_STATUS,
  appearance: DEFAULT_APPEARANCE,
  voice: DEFAULT_VOICE,
};

export function parseSettings(raw: unknown): Settings {
  const parsed = settingsSchema.safeParse(raw ?? {});
  if (!parsed.success) return DEFAULT_SETTINGS;

  /*
   * v2 stored an accent for everyone, because the field had to hold *something* - and it only ever
   * applied to ECHO-net. Now that a saved hue repaints every edition, carrying that default forward
   * would silently recolour Synthwave, Retro and the rest for people who never chose a colour. So the
   * field is reset once on upgrade; ECHO-net's own accent is gold, which is what they already had.
   */
  const source = (raw ?? {}) as { version?: unknown };
  const version = typeof source.version === "number" ? source.version : 0;

  if (version < SETTINGS_VERSION) {
    return {
      ...parsed.data,
      appearance: { ...parsed.data.appearance, accent: "theme", tint: "" },
    };
  }

  return parsed.data;
}

type SettingsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Never throws: a locked-down or full storage area must not stop the app from starting. */
export function loadSettings(storage: SettingsStorage | null): Settings {
  if (!storage) return DEFAULT_SETTINGS;

  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return parseSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(storage: SettingsStorage | null, settings: Settings): boolean {
  if (!storage) return false;

  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function clearSettings(storage: SettingsStorage | null): void {
  try {
    storage?.removeItem(SETTINGS_KEY);
  } catch {
    /* nothing to do: clearing is best-effort */
  }
}

/** Invisible is a choice, not a presence value: everyone else sees `offline`. */
export function effectivePresence(choice: PresenceChoice): Presence {
  return choice === "invisible" ? "offline" : choice;
}

export function hasCustomStatus(status: CustomStatus): boolean {
  return status.emoji.length > 0 || status.text.length > 0;
}

/**
 * Whether the profile carries any cosmetic at all.
 *
 * The card uses this to skip rendering empty wrappers: three nested spans that always exist but are
 * always invisible would still cost a layer each, and `content-visibility` cannot skip them.
 */
export function hasCosmetics(profile: Profile): boolean {
  return profile.decoration > 0 || profile.effect > 0 || profile.frame > 0;
}

