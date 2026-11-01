import { memberById, rolesOfMember } from "../../api/workspace";
import { useAuthStore } from "../../state/authStore";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { useMemberIdentity } from "../../state/useIdentity";
import { useSettingsStore } from "../../state/settingsStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { Avatar } from "../../ui/Avatar";
import { CloseGlyph, PencilGlyph, SendGlyph } from "../../ui/Glyphs";
import { RichText } from "../../ui/RichText";
import { useDialog } from "../../ui/useDialog";
import styles from "./SettingsModal.module.css";
import card from "./ProfileCard.module.css";

/**
 * The profile card: banner, picture, name, roles, status and bio.
 *
 * It reads the same live graph as the member rail, so a role change made in server settings is
 * visible the next time the card opens. The self card edits the profile document; everyone else
 * gets a jump to the first text channel rather than a dead "Message" button with no DM backend.
 */

export function ProfileCard(): React.JSX.Element | null {
  const memberId = useUiStore((state) => state.profileMemberId);
  if (!memberId) return null;
  return <ProfileCardDialog memberId={memberId} />;
}

function ProfileCardDialog({ memberId }: { memberId: string }): React.JSX.Element | null {
  const close = useUiStore((state) => state.closeProfile);
  const openSettings = useUiStore((state) => state.openSettings);
  const guildId = useWorkspaceStore((state) => state.guildId);
  const openChannel = useWorkspaceStore((state) => state.openChannel);
  const live = useLiveWorkspace();
  const profile = useSettingsStore((state) => state.profile);
  const signOut = useAuthStore((state) => state.signOut);

  const { ref, onBackdrop } = useDialog(close);
  const member = memberById(live, memberId);
  const identity = useMemberIdentity(member);

  if (!member) return null;

  const guild = live.guilds.find((entry) => entry.id === guildId) ?? live.guilds[0];
  const roles = guild ? rolesOfMember(guild, member.id) : [];
  const banner = identity.isSelf ? profile.banner : null;
  const bannerAccent = identity.isSelf ? profile.bannerAccent : member.accent;

  const message = (): void => {
    const target = guild?.channels.find((channel) => channel.kind === "text");
    const first = target ?? guild?.channels[0];
    if (first) openChannel(first.id);
    close();
  };

  return (
    <div className={styles.overlay} onMouseDown={onBackdrop}>
      <div
        ref={ref}
        className={card.card}
        role="dialog"
        /* Frame and effect are profile cosmetics, and only the local profile carries them: the
           workspace graph has no field for another member's decoration yet. */
        data-frame={identity.isSelf ? profile.frame : 0}
        data-effect={identity.isSelf ? profile.effect : 0}
        aria-modal="true"
        aria-labelledby="profile-card-name"
        tabIndex={-1}
        data-testid="profile-card"
      >
        <div className={styles.banner} data-accent={bannerAccent}>
          {banner ? <img className={styles.bannerImage} src={banner} alt="" /> : null}
        </div>

        <button type="button" className={card.close} onClick={close} aria-label="Close profile">
          <CloseGlyph />
        </button>

        <div className={card.body}>
          <span className={card.avatar}>
            <Avatar
              name={identity.name}
              accent={identity.accent}
              size="xl"
              showPresence
              presence={identity.presence}
              image={identity.avatar}
              decoration={identity.isSelf ? profile.decoration : 0}
            />
          </span>

          <div className={card.names}>
            <h2 id="profile-card-name" className={card.name}>
              {identity.name}
            </h2>
            <span className={card.handle}>
              @{identity.handle}
              {identity.isSelf && profile.pronouns ? ` · ${profile.pronouns}` : ""}
            </span>
            {identity.statusEmoji || identity.statusText ? (
              <span className={card.status}>
                {identity.statusEmoji ? `${identity.statusEmoji} ` : ""}
                {identity.statusText}
              </span>
            ) : null}
          </div>

          {roles.length > 0 ? (
            <div className={card.roles} aria-label="Roles">
              {roles.map((role) => (
                <span key={role.id} className={`${card.chip} role-color-${role.color}`}>
                  {role.name}
                </span>
              ))}
            </div>
          ) : null}

          {identity.isSelf && profile.bio ? (
            <div className={card.about}>
              <h3 className={card.aboutTitle}>About me</h3>
              <RichText className={card.bio} text={profile.bio} />
            </div>
          ) : !identity.isSelf && member.activity ? (
            <div className={card.about}>
              <h3 className={card.aboutTitle}>Activity</h3>
              <p className={card.bio}>{member.activity}</p>
            </div>
          ) : (
            <p className={card.empty}>
              {identity.isSelf ? "Add a bio in User Settings." : "No bio yet."}
            </p>
          )}

          <div className={card.actions}>
            {identity.isSelf ? (
              <>
                <button
                  type="button"
                  className={card.secondary}
                  onClick={() => void signOut()}
                  title="Sign out of this device"
                >
                  Sign out
                </button>
                <button
                  type="button"
                  className={card.primary}
                  onClick={() => {
                    close();
                    openSettings("profile");
                  }}
                >
                  <PencilGlyph />
                  Edit Profile
                </button>
              </>
            ) : (
              <button type="button" className={card.primary} onClick={message}>
                <SendGlyph />
                Message
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
