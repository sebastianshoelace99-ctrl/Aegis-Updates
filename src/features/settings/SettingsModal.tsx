import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_BIO,
  MAX_DISPLAY_NAME,
  MAX_PRONOUNS,
  MAX_STATUS_TEXT,
  imageDataUrlSchema,
  type VoicePreferences,
} from "../../api/profile";
import { LEVEL_SEGMENTS, audioConstraints, levelBucket, rmsOf } from "../../api/voice";
import { useSettingsStore } from "../../state/settingsStore";
import { useUiStore, type SettingsTab } from "../../state/uiStore";
import { applyVoicePreferences, joinVoice, leaveVoice } from "../../state/voiceSession";
import { useVoice } from "../../state/useVoice";
import { normaliseHex } from "../../theme/accent";
import { ThemePicker } from "../../theme/ThemePicker";
import { Avatar } from "../../ui/Avatar";
import {
  CheckGlyph,
  CloseGlyph,
  HeadphonesGlyph,
  ImageGlyph,
  MicGlyph,
  SparkleGlyph,
  VideoGlyph,
} from "../../ui/Glyphs";
import { AVATAR_TARGET, BANNER_TARGET, readImageFile } from "../../ui/imageFile";
import { useDialog } from "../../ui/useDialog";
import styles from "./SettingsModal.module.css";

/**
 * User settings, modelled on the sections people actually use: profile, status, appearance and
 * voice. Everything here is free - the avatar, banner, bio, custom status and HD screen share are
 * the features another client puts behind a subscription.
 *
 * The dialog edits the persisted store directly. There is no Save button because there is nothing
 * to cancel: every change is already in the store and on disk. That is also why the file input
 * reports its own errors instead of a global form error.
 */

const TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "profile", label: "My Profile" },
  { id: "status", label: "Status" },
  { id: "appearance", label: "Appearance" },
  { id: "voice", label: "Voice & Video" },
];

const ACCENTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

const PRESENCE_OPTIONS = [
  { id: "online", label: "Online", caption: "Available to talk", dot: "online" },
  { id: "idle", label: "Idle", caption: "Away from the keyboard", dot: "idle" },
  { id: "dnd", label: "Do Not Disturb", caption: "Mute notifications", dot: "dnd" },
  { id: "invisible", label: "Invisible", caption: "Appear offline", dot: "offline" },
] as const;

const STATUS_EMOJI = [
  "",
  "🎧",
  "🎨",
  "🖌️",
  "💬",
  "🌙",
  "☕",
  "🔥",
  "✨",
  "💤",
  "🚀",
  "📚",
  "🎮",
  "🎬",
  "❤️",
  "🌿",
] as const;

const ACCENT_OPTIONS = [
  { id: "theme", label: "Theme" },
  { id: "gold", label: "Gold" },
  { id: "crimson", label: "Crimson" },
  { id: "emerald", label: "Emerald" },
  { id: "cyan", label: "Cyan" },
  { id: "violet", label: "Violet" },
  { id: "rose", label: "Rose" },
] as const;

/** Seeds the native colour dialog when no custom colour has been chosen yet. */
const FALLBACK_TINT = "#e8a020";

const DENSITY_OPTIONS = [
  { id: "cozy", label: "Cozy", caption: "Avatars, comfortable spacing, hover times" },
  { id: "compact", label: "Compact", caption: "Smaller avatars, tighter rows, more on screen" },
] as const;

const SIZE_OPTIONS = [
  { id: "small", label: "Small", caption: "13 px message copy" },
  { id: "normal", label: "Normal", caption: "The default 14.5 px" },
  { id: "large", label: "Large", caption: "16 px, easier at a distance" },
] as const;

const FONT_OPTIONS = [
  { id: "condensed", label: "Condensed", caption: "Barlow Condensed headings" },
  { id: "classic", label: "Classic", caption: "Barlow throughout" },
  { id: "mono", label: "Mono", caption: "Terminal labels and headings" },
] as const;

const MOTION_OPTIONS = [
  { id: "full", label: "Full", caption: "Flicker, fades and transitions" },
  { id: "reduced", label: "Reduced", caption: "Disable decoration, keep state changes" },
] as const;

const TEXTURE_OPTIONS = [
  { id: "grid", label: "Grid", caption: "Faint grid and shield watermark" },
  { id: "plain", label: "Plain", caption: "Flat background, no pattern" },
] as const;

const CLOCK_OPTIONS = [
  { id: "auto", label: "System", caption: "Use this machine's clock format" },
  { id: "12h", label: "12-hour", caption: "3:42 PM" },
  { id: "24h", label: "24-hour", caption: "15:42" },
] as const;

/**
 * One segmented setting. Options are literals so a typo in a stored value is a type error here
 * rather than a silently ignored control at runtime.
 */
function ChoiceGroup<T extends string>({
  label,
  hint,
  value,
  options,
  testid,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string; caption: string }>;
  testid: string;
  onChange: (id: T) => void;
}): React.JSX.Element {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {hint ? <p className={styles.fieldHint}>{hint}</p> : null}
      <div className={styles.optionGrid} role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            className={styles.presenceOption}
            data-selected={value === option.id}
            data-testid={`${testid}-${option.id}`}
            onClick={() => onChange(option.id)}
          >
            <span className={styles.presenceText}>
              <strong>{option.label}</strong>
              <span>{option.caption}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsModal(): React.JSX.Element | null {
  const open = useUiStore((state) => state.settingsOpen);
  if (!open) return null;
  return <SettingsDialog />;
}

function SettingsDialog(): React.JSX.Element {
  const close = useUiStore((state) => state.closeSettings);
  const tab = useUiStore((state) => state.settingsTab);
  const setTab = useUiStore((state) => state.setSettingsTab);
  const saveFailed = useSettingsStore((state) => state.saveFailed);
  const { ref, onBackdrop } = useDialog(close);

  return (
    <div className={styles.overlay} onMouseDown={onBackdrop}>
      <div
        ref={ref}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        data-testid="settings-modal"
      >
        <header className={styles.head}>
          <div>
            <h2 id="settings-title" className={styles.title}>
              User Settings
            </h2>
            <p className={styles.subtitle}>Stored on this device. No account required.</p>
          </div>
          <button type="button" className={styles.close} onClick={close} aria-label="Close settings">
            <CloseGlyph />
          </button>
        </header>

        <div className={styles.layout}>
          <nav className={styles.nav} aria-label="Settings sections">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={styles.navButton}
                data-active={entry.id === tab}
                aria-current={entry.id === tab ? "page" : undefined}
                data-testid={`settings-tab-${entry.id}`}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          <div className={styles.content} role="region" aria-label={tab}>
            {tab === "profile" ? <ProfileSection /> : null}
            {tab === "status" ? <StatusSection /> : null}
            {tab === "appearance" ? <AppearanceSection /> : null}
            {tab === "voice" ? <VoiceSection /> : null}

            <p className={styles.saved} data-failed={saveFailed}>
              {saveFailed
                ? "Local storage is full. Changes stay for this session but will not survive a restart."
                : "Changes save immediately on this device."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileSection(): React.JSX.Element {
  const profile = useSettingsStore((state) => state.profile);
  const status = useSettingsStore((state) => state.status);
  const setProfile = useSettingsStore((state) => state.setProfile);
  const [busy, setBusy] = useState<"avatar" | "banner" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(profile.displayName);

  const upload = async (file: File | undefined, kind: "avatar" | "banner"): Promise<void> => {
    if (!file) return;

    setBusy(kind);
    setError(null);
    try {
      const dataUrl = await readImageFile(file, kind === "avatar" ? AVATAR_TARGET : BANNER_TARGET);
      // Downscaling can still produce something the schema rejects; fail here, not on next launch.
      if (!imageDataUrlSchema.safeParse(dataUrl).success) {
        throw new Error("That image could not be stored. Try a smaller one.");
      }
      setProfile(kind === "avatar" ? { avatar: dataUrl } : { banner: dataUrl });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That image could not be used.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="settings-profile-heading">
      <h3 id="settings-profile-heading" className={styles.sectionTitle}>
        My Profile
      </h3>
      <p className={styles.sectionBody}>
        Your name, picture, banner and bio are shown to everyone in this workspace. All of it is
        free - profile customization is not paywalled here.
      </p>

      <div className={styles.preview} data-testid="profile-preview">
        <div className={styles.banner} data-accent={profile.bannerAccent}>
          {profile.banner ? <img className={styles.bannerImage} src={profile.banner} alt="" /> : null}
        </div>
        <div className={styles.previewBody}>
          <span className={styles.previewAvatar}>
            <Avatar
              name={profile.displayName}
              accent={profile.accent}
              size="xl"
              showPresence
              presence={status.presence === "invisible" ? "offline" : status.presence}
              image={profile.avatar}
            />
          </span>
          <span className={styles.previewText}>
            <strong className={styles.previewName}>{profile.displayName}</strong>
            <span className={styles.previewHandle}>
              @nyx{profile.pronouns ? ` · ${profile.pronouns}` : ""}
            </span>
            {status.emoji || status.text ? (
              <span className={styles.previewStatus}>
                {status.emoji ? `${status.emoji} ` : ""}
                {status.text}
              </span>
            ) : null}
          </span>
        </div>
      </div>

      <div className={styles.imageRows}>
        <div className={styles.uploadRow}>
          <span className={styles.fieldLabel}>Profile picture</span>
          <div className={styles.rowEnd}>
            <label className={styles.fileButton} data-busy={busy === "avatar"}>
              <ImageGlyph />
              {busy === "avatar" ? "Reading…" : profile.avatar ? "Change" : "Upload"}
              <input
                className={styles.fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                data-testid="avatar-upload"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  void upload(file, "avatar");
                  event.target.value = "";
                }}
              />
            </label>
            {profile.avatar ? (
              <button
                type="button"
                className={styles.ghost}
                onClick={() => setProfile({ avatar: null })}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.uploadRow}>
          <span className={styles.fieldLabel}>Profile banner</span>
          <div className={styles.rowEnd}>
            <label className={styles.fileButton} data-busy={busy === "banner"}>
              <ImageGlyph />
              {busy === "banner" ? "Reading…" : profile.banner ? "Change" : "Upload"}
              <input
                className={styles.fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                data-testid="banner-upload"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  void upload(file, "banner");
                  event.target.value = "";
                }}
              />
            </label>
            {profile.banner ? (
              <button
                type="button"
                className={styles.ghost}
                onClick={() => setProfile({ banner: null })}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.swatchFields}>
        <fieldset className={styles.swatchField}>
          <legend className={styles.fieldLabel}>Avatar colour</legend>
          <div className={styles.swatchRow}>
            {ACCENTS.map((value) => (
              <button
                key={value}
                type="button"
                className={styles.swatch}
                data-accent={value}
                data-selected={value === profile.accent}
                onClick={() => setProfile({ accent: value })}
                aria-label={`Avatar colour ${value + 1}`}
                aria-pressed={value === profile.accent}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.swatchField}>
          <legend className={styles.fieldLabel}>Banner colour</legend>
          <div className={styles.swatchRow}>
            {ACCENTS.map((value) => (
              <button
                key={value}
                type="button"
                className={styles.swatch}
                data-accent={value}
                data-selected={value === profile.bannerAccent}
                onClick={() => setProfile({ bannerAccent: value })}
                aria-label={`Banner colour ${value + 1}`}
                aria-pressed={value === profile.bannerAccent}
              />
            ))}
          </div>
        </fieldset>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Display name</span>
        <input
          className={styles.input}
          value={nameDraft}
          maxLength={MAX_DISPLAY_NAME}
          data-testid="display-name-input"
          onChange={(event) => {
            const next = event.target.value;
            setNameDraft(next);
            // Store every non-empty edit, but let the field go empty while it is being retyped.
            if (next.trim().length > 0) setProfile({ displayName: next });
          }}
          onBlur={() => {
            const trimmed = nameDraft.trim();
            if (trimmed.length === 0) {
              setNameDraft(profile.displayName);
              return;
            }
            setProfile({ displayName: trimmed });
            setNameDraft(trimmed);
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <span className={styles.hint}>
          {nameDraft.length}/{MAX_DISPLAY_NAME}
        </span>
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Pronouns</span>
        <input
          className={styles.input}
          value={profile.pronouns}
          maxLength={MAX_PRONOUNS}
          placeholder="Optional"
          onChange={(event) => setProfile({ pronouns: event.target.value })}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Bio</span>
        <textarea
          className={styles.textarea}
          value={profile.bio}
          maxLength={MAX_BIO}
          rows={4}
          placeholder="Tell people what you make. Links starting with https:// become clickable."
          data-testid="bio-input"
          onChange={(event) => setProfile({ bio: event.target.value })}
        />
        <span className={styles.hint}>
          {profile.bio.length}/{MAX_BIO} · <span className={styles.inlineGlyph}><CheckGlyph /></span>{" "}
          http(s) links render as links, never as HTML.
        </span>
      </label>
    </section>
  );
}

function StatusSection(): React.JSX.Element {
  const profile = useSettingsStore((state) => state.profile);
  const status = useSettingsStore((state) => state.status);
  const setStatus = useSettingsStore((state) => state.setStatus);
  const resetStatus = useSettingsStore((state) => state.resetStatus);

  return (
    <section className={styles.section} aria-labelledby="settings-status-heading">
      <h3 id="settings-status-heading" className={styles.sectionTitle}>
        Status
      </h3>
      <p className={styles.sectionBody}>
        Presence tells people whether to expect an answer. A custom status is an emoji and a line
        of text, visible in the member list and on your profile card.
      </p>

      <div className={styles.optionGrid} role="radiogroup" aria-label="Online status">
        {PRESENCE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={status.presence === option.id}
            className={styles.presenceOption}
            data-selected={status.presence === option.id}
            onClick={() => setStatus({ presence: option.id })}
          >
            <span className={styles.presenceDot} data-presence={option.dot} aria-hidden="true" />
            <span className={styles.presenceText}>
              <strong>{option.label}</strong>
              <span>{option.caption}</span>
            </span>
          </button>
        ))}
      </div>

      <div className={styles.statusPreview} data-testid="status-preview">
        <Avatar
          name={profile.displayName}
          accent={profile.accent}
          size="md"
          showPresence
          presence={status.presence === "invisible" ? "offline" : status.presence}
          image={profile.avatar}
        />
        <span className={styles.previewText}>
          <strong className={styles.previewName}>{profile.displayName}</strong>
          <span className={styles.previewStatus} data-empty={status.emoji === "" && status.text === ""}>
            {status.emoji ? `${status.emoji} ` : ""}
            {status.text || "No custom status set"}
          </span>
        </span>
        {status.emoji || status.text ? (
          <button type="button" className={styles.ghost} onClick={resetStatus}>
            Clear status
          </button>
        ) : null}
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>What are you up to?</span>
        <input
          className={styles.input}
          value={status.text}
          maxLength={MAX_STATUS_TEXT}
          placeholder="Sketching, heads down until 4"
          data-testid="status-input"
          onChange={(event) => setStatus({ text: event.target.value })}
        />
        <span className={styles.hint}>
          {status.text.length}/{MAX_STATUS_TEXT}
        </span>
      </label>

      <fieldset className={styles.swatchField}>
        <legend className={styles.fieldLabel}>Status emoji</legend>
        <div className={styles.emojiGrid}>
          {STATUS_EMOJI.map((emoji) => (
            <button
              key={emoji || "none"}
              type="button"
              className={styles.emoji}
              data-selected={status.emoji === emoji}
              onClick={() => setStatus({ emoji })}
              aria-label={emoji ? `Use ${emoji}` : "No emoji"}
              aria-pressed={status.emoji === emoji}
            >
              {emoji || "None"}
            </button>
          ))}
        </div>
      </fieldset>
    </section>
  );
}

/**
 * The accent control.
 *
 * Two ways in, one outcome: seven chips (the edition's own palette plus the six named hues) or any
 * colour at all. Picking a chip clears the custom value, so the row and the picker can never
 * disagree about which one is in charge.
 *
 * The hex field is the only place that keeps a local draft: a half-typed `#1a2` must not reach the
 * store. It commits the moment the string is a complete colour, and falls back to the saved value on
 * blur, which is also how an abandoned edit is cancelled.
 */
function AccentField(): React.JSX.Element {
  const appearance = useSettingsStore((state) => state.appearance);
  const setAppearance = useSettingsStore((state) => state.setAppearance);
  const picker = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(appearance.tint);

  useEffect(() => setDraft(appearance.tint), [appearance.tint]);

  const custom = appearance.accent === "custom" && appearance.tint.length > 0;

  return (
    <div className={styles.field} data-testid="appearance-accent">
      <span className={styles.fieldLabel}>Accent colour</span>
      <p className={styles.fieldHint}>
        Recolours tabs, links, focus rings and highlights in every theme. Text shades are pushed
        until they measure at least 4.5:1 against the edition you are using, so any hue stays
        readable.
      </p>

      <div className={styles.accentGrid} role="radiogroup" aria-label="Accent hue">
        {ACCENT_OPTIONS.map((option) => {
          const selected = appearance.accent === option.id;

          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={styles.accentOption}
              data-selected={selected}
              data-accent={option.id}
              data-testid={`appearance-accent-${option.id}`}
              aria-label={option.id === "theme" ? "Theme default" : option.label}
              onClick={() => setAppearance({ accent: option.id, tint: "" })}
            >
              <span className={styles.accentSwatch} aria-hidden="true" />
              <span className={styles.accentLabel}>{option.label}</span>
            </button>
          );
        })}
      </div>

      <div className={styles.accentCustom}>
        <button
          type="button"
          className={`${styles.accentOption} ${styles.accentPick}`}
          data-selected={custom}
          data-accent="custom"
          data-testid="appearance-accent-custom"
          aria-label="Pick a custom accent colour"
          onClick={() => picker.current?.click()}
        >
          <span className={styles.accentSwatch} aria-hidden="true" />
          <span className={styles.accentLabel}>Custom…</span>
        </button>

        {/* The dialog's real control: hidden from the tab order and the a11y tree, driven by the
            button above, which is the thing a keyboard or screen reader actually meets. */}
        <input
          ref={picker}
          type="color"
          className={styles.accentPicker}
          value={custom ? appearance.tint : FALLBACK_TINT}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => setAppearance({ accent: "custom", tint: event.target.value })}
        />

        <input
          className={styles.accentHex}
          value={draft}
          placeholder={FALLBACK_TINT}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-label="Custom accent hex value"
          data-testid="appearance-accent-hex"
          onChange={(event) => {
            setDraft(event.target.value);
            const hex = normaliseHex(event.target.value);
            if (hex) setAppearance({ accent: "custom", tint: hex });
          }}
          onBlur={() => setDraft(appearance.tint)}
        />
      </div>
    </div>
  );
}

/**
 * Cosmetics, as string ids because `ChoiceGroup` speaks strings; the schema speaks numbers and the
 * stylesheet speaks `data-*` indexes. The conversion happens here and nowhere else.
 *
 * Discord sells every one of these. There is no entitlement to check: the profile schema has no
 * tier field at all, and `0` means "none" rather than "locked".
 */
const DECORATION_OPTIONS: ReadonlyArray<{ id: string; label: string; caption: string }> = [
  { id: "0", label: "None", caption: "No ring" },
  { id: "1", label: "Inset", caption: "Ring inside the picture" },
  { id: "2", label: "Outline", caption: "Crisp ring outside" },
  { id: "3", label: "Dashed", caption: "Broken ring" },
  { id: "4", label: "Double", caption: "Twin hairline" },
  { id: "5", label: "Glow", caption: "Outline and halo" },
  { id: "6", label: "Twin band", caption: "Two inset bands" },
];

const EFFECT_OPTIONS: ReadonlyArray<{ id: string; label: string; caption: string }> = [
  { id: "0", label: "None", caption: "Flat card" },
  { id: "1", label: "Aurora", caption: "Wash from the top" },
  { id: "2", label: "Diagonal", caption: "Corner to corner" },
  { id: "3", label: "Vignette", caption: "Darkened edge" },
  { id: "4", label: "Scan", caption: "Fine diagonal lines" },
  { id: "5", label: "Halo", caption: "Light from below" },
];

const FRAME_OPTIONS: ReadonlyArray<{ id: string; label: string; caption: string }> = [
  { id: "0", label: "None", caption: "Plain border" },
  { id: "1", label: "Hairline", caption: "Single accent line" },
  { id: "2", label: "Glow", caption: "Line and bloom" },
  { id: "3", label: "Double", caption: "Thick double rule" },
  { id: "4", label: "Weave", caption: "Inset soft band" },
  { id: "5", label: "Dashed", caption: "Dashed outer rule" },
];

function AppearanceSection(): React.JSX.Element {
  const appearance = useSettingsStore((state) => state.appearance);
  const setAppearance = useSettingsStore((state) => state.setAppearance);
  const profile = useSettingsStore((state) => state.profile);
  const setProfile = useSettingsStore((state) => state.setProfile);

  return (
    <section className={styles.section} aria-labelledby="settings-appearance-heading">
      <h3 id="settings-appearance-heading" className={styles.sectionTitle}>
        Appearance
      </h3>
      <p className={styles.sectionBody}>
        Every control applies immediately and is remembered next launch. Colour, type, spacing and
        motion are all local choices - none of them is behind a subscription.
      </p>

      {/*
        * Theme and mode are one picker because they are one decision: each theme ships a light and
        * a dark edition, and the mode carries over when the theme changes.
        */}
      <div className={styles.field} data-testid="appearance-theme-picker" data-scanline-exempt>
        <ThemePicker />
      </div>

      <AccentField />

      {/* Discord sells all three of these. Nothing gates them here: the profile schema has no tier
          field, so this picker is the entire mechanism. */}
      <ChoiceGroup
        label="Avatar decoration"
        hint="A ring around your picture on your profile card."
        value={String(profile.decoration)}
        options={DECORATION_OPTIONS}
        testid="appearance-decoration"
        onChange={(value) => setProfile({ decoration: Number(value) })}
      />

      <ChoiceGroup
        label="Profile effect"
        hint="A wash of colour behind your profile card."
        value={String(profile.effect)}
        options={EFFECT_OPTIONS}
        testid="appearance-effect"
        onChange={(value) => setProfile({ effect: Number(value) })}
      />

      <ChoiceGroup
        label="Profile frame"
        hint="The border treatment on your profile card."
        value={String(profile.frame)}
        options={FRAME_OPTIONS}
        testid="appearance-frame"
        onChange={(value) => setProfile({ frame: Number(value) })}
      />

      <ChoiceGroup
        label="Message display"
        value={appearance.density}
        options={DENSITY_OPTIONS}
        testid="appearance-density"
        onChange={(density) => setAppearance({ density })}
      />

      <ChoiceGroup
        label="Message text size"
        hint="Independent of density: a tight list can still have readable copy."
        value={appearance.messageSize}
        options={SIZE_OPTIONS}
        testid="appearance-size"
        onChange={(messageSize) => setAppearance({ messageSize })}
      />

      <ChoiceGroup
        label="Display typeface"
        hint="Applies to headings, labels and the composer chrome."
        value={appearance.font}
        options={FONT_OPTIONS}
        testid="appearance-font"
        onChange={(font) => setAppearance({ font })}
      />

      <ChoiceGroup
        label="Motion"
        hint="Reduced keeps state changes but removes flicker, fades and sliding."
        value={appearance.motion}
        options={MOTION_OPTIONS}
        testid="appearance-motion"
        onChange={(motion) => setAppearance({ motion })}
      />

      <ChoiceGroup
        label="Background texture"
        value={appearance.texture}
        options={TEXTURE_OPTIONS}
        testid="appearance-texture"
        onChange={(texture) => setAppearance({ texture })}
      />

      <ChoiceGroup
        label="Timestamps"
        hint="Applies to message times immediately."
        value={appearance.clock}
        options={CLOCK_OPTIONS}
        testid="appearance-clock"
        onChange={(clock) => setAppearance({ clock })}
      />

      <div className={styles.note}>
        <SparkleGlyph />
        <p>
          Profile customization is free here: pictures, banners, bio links and custom statuses are
          included rather than sold separately.
        </p>
      </div>
    </section>
  );
}

function VoiceSection(): React.JSX.Element {
  const voice = useSettingsStore((state) => state.voice);
  const setVoice = useSettingsStore((state) => state.setVoice);
  const call = useVoice();

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;

    const refresh = async (): Promise<void> => {
      if (!media?.enumerateDevices) {
        setDeviceError("Device listing is not available in this environment.");
        return;
      }

      try {
        const all = await media.enumerateDevices();
        if (!cancelled) {
          setDevices(all.filter((device) => device.kind === "audioinput"));
          setDeviceError(null);
        }
      } catch {
        if (!cancelled) setDeviceError("Devices could not be listed.");
      }
    };

    void refresh();
    media?.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      media?.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  // Applied to the store *and* the live session, so a call in progress follows a new sensitivity
  // or screen quality without needing a reconnect. A different microphone or processing flag
  // needs a rejoin, because those are capture constraints rather than analyser settings.
  const update = (patch: Partial<VoicePreferences>): void => {
    const next = { ...voice, ...patch };
    setVoice(patch);
    applyVoicePreferences(next);
  };

  const knownDevice =
    voice.inputDeviceId === "default" ||
    devices.some((device) => device.deviceId === voice.inputDeviceId);

  return (
    <section className={styles.section} aria-labelledby="settings-voice-heading">
      <h3 id="settings-voice-heading" className={styles.sectionTitle}>
        Voice &amp; Video
      </h3>
      <p className={styles.sectionBody}>
        Calls use your microphone, camera and screen directly. Until a signaling server exists,
        capture stays on this machine - the controls and state machine are the real ones.
      </p>

      {call.status === "connected" && call.channelId ? (
        <div className={styles.callRow} data-testid="settings-call-state">
          <span className={styles.callDot} aria-hidden="true" />
          <span className={styles.presenceText}>
            <strong>In a call</strong>
            <span>{call.channelId}</span>
          </span>
          <button type="button" className={styles.ghost} onClick={leaveVoice}>
            Leave call
          </button>
        </div>
      ) : null}

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Input device</span>
        <select
          className={styles.select}
          value={voice.inputDeviceId}
          data-testid="input-device"
          onChange={(event) => update({ inputDeviceId: event.target.value })}
        >
          <option value="default">System default</option>
          {devices.map((device, index) => (
            <option key={device.deviceId || `device-${index}`} value={device.deviceId}>
              {device.label.trim() || `Microphone ${index + 1}`}
            </option>
          ))}
          {!knownDevice ? (
            <option value={voice.inputDeviceId}>Saved microphone (unavailable)</option>
          ) : null}
        </select>
        {deviceError ? (
          <span className={styles.hint} data-error="true">
            {deviceError}
          </span>
        ) : null}
        {devices.every((device) => device.label.length === 0) ? (
          <span className={styles.hint}>Allow microphone access once to see device names.</span>
        ) : null}
      </label>

      <fieldset className={styles.toggleGroup}>
        <legend className={styles.fieldLabel}>Processing</legend>
        <label className={styles.switchRow}>
          <span className={styles.presenceText}>
            <strong>Noise suppression</strong>
            <span>Filter fans and keyboard noise</span>
          </span>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={voice.noiseSuppression}
            onChange={(event) => update({ noiseSuppression: event.target.checked })}
          />
        </label>
        <label className={styles.switchRow}>
          <span className={styles.presenceText}>
            <strong>Echo cancellation</strong>
            <span>Stop speakers feeding back into the mic</span>
          </span>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={voice.echoCancellation}
            onChange={(event) => update({ echoCancellation: event.target.checked })}
          />
        </label>
        <label className={styles.switchRow}>
          <span className={styles.presenceText}>
            <strong>Automatic gain</strong>
            <span>Keep quieter voices audible</span>
          </span>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={voice.autoGainControl}
            onChange={(event) => update({ autoGainControl: event.target.checked })}
          />
        </label>
      </fieldset>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Input sensitivity — {voice.sensitivity}%</span>
        <input
          className={styles.range}
          type="range"
          min={0}
          max={100}
          step={1}
          value={voice.sensitivity}
          aria-label="Input sensitivity"
          onChange={(event) => update({ sensitivity: Number(event.target.value) })}
        />
        <span className={styles.hint}>
          Higher values make the speaking ring react to a quieter voice.
        </span>
      </label>

      <MicTest
        key={`${voice.inputDeviceId}:${voice.noiseSuppression}:${voice.echoCancellation}:${voice.autoGainControl}`}
        preferences={voice}
      />

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Screen share quality</span>
        <select
          className={styles.select}
          value={voice.screenQuality}
          onChange={(event) =>
            update({ screenQuality: event.target.value as VoicePreferences["screenQuality"] })
          }
        >
          <option value="720p">720p — lighter on CPU</option>
          <option value="1080p">1080p — default</option>
          <option value="source">Source — no downscale</option>
        </select>
      </label>

      <div className={styles.note}>
        <span className={styles.noteIcons} aria-hidden="true">
          <MicGlyph />
          <HeadphonesGlyph />
          <VideoGlyph />
        </span>
        <p>
          Mute, deafen, camera and screen share are available in any voice channel. HD screen
          sharing is not an upgrade here.
        </p>
      </div>
    </section>
  );
}

type MicTestProps = { preferences: VoicePreferences };

function MicTest({ preferences }: MicTestProps): React.JSX.Element {
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const frameRef = useRef(0);
  const runRef = useRef(0);

  const stop = useCallback(() => {
    runRef.current += 1;

    if (frameRef.current !== 0) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    analyserRef.current = null;

    if (contextRef.current) {
      void contextRef.current.close().catch(() => undefined);
      contextRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    setActive(false);
    setLevel(0);
  }, []);

  useEffect(() => stop, [stop]);

  const start = async (): Promise<void> => {
    stop();
    const run = runRef.current;
    setError(null);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Microphone capture is not available in this environment.");
      return;
    }
    if (typeof window === "undefined" || typeof window.AudioContext !== "function") {
      setError("Audio analysis is not available in this environment.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(preferences),
      });
      if (run !== runRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const context = new window.AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      void context.resume().catch(() => undefined);

      streamRef.current = stream;
      contextRef.current = context;
      sourceRef.current = source;
      analyserRef.current = analyser;
      setActive(true);

      const data = new Uint8Array(analyser.fftSize);
      let previous = -1;

      const tick = (): void => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(data);
        const next = levelBucket(rmsOf(data));
        if (next !== previous) {
          previous = next;
          setLevel(next);
        }
        frameRef.current = requestAnimationFrame(tick);
      };

      frameRef.current = requestAnimationFrame(tick);
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "Microphone access failed.";
      setError(message);
      stop();
    }
  };

  return (
    <div className={styles.micTest}>
      <div className={styles.meterRow}>
        <div
          className={styles.meter}
          role="img"
          aria-label={`Microphone level ${level} of ${LEVEL_SEGMENTS}`}
          data-active={active}
        >
          {Array.from({ length: LEVEL_SEGMENTS }, (_, index) => (
            <span key={index} data-on={index < level} data-hot={index >= LEVEL_SEGMENTS - 2} />
          ))}
        </div>
        <button
          type="button"
          className={active ? styles.ghost : styles.primary}
          data-testid="mic-test"
          onClick={active ? stop : () => void start()}
        >
          {active ? "Stop test" : "Test microphone"}
        </button>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : (
        <p className={styles.hint}>
          {active
            ? "Speak normally — the meter uses the same sensitivity as the speaking ring."
            : "The test stops when you leave this section."}
        </p>
      )}
    </div>
  );
}





