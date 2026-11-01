import { dmChannel, dmPartner } from "../../api/dms";
import { findChannelById, guildMembers, guildOfChannel } from "../../api/workspace";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { useMemberIdentity } from "../../state/useIdentity";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { Avatar } from "../../ui/Avatar";
import { HashGlyph, MediaGlyph, MembersGlyph, SpeakerGlyph } from "../../ui/Glyphs";
import styles from "./ChannelHeader.module.css";

/**
 * The conversation header: where you are, what it is for, and how many people are in the guild.
 *
 * The topic is a sibling of the name rather than a second line, because a long topic should
 * truncate on one axis instead of wrapping the header to two rows.
 *
 * A DM is the same header with a person instead of a channel: avatar and presence where the
 * `#` glyph sits, and no member counter, because the audience is exactly one other person.
 */
export function ChannelHeader(): React.JSX.Element {
  const channelId = useWorkspaceStore((state) => state.channelId);
  const memberListOpen = useWorkspaceStore((state) => state.memberListOpen);
  const toggleMemberList = useWorkspaceStore((state) => state.toggleMemberList);
  const live = useLiveWorkspace();

  const partner = dmPartner(live, channelId);
  const identity = useMemberIdentity(partner);
  const presence =
    useWorkspaceStore((state) => (partner ? state.presence[partner.id] : undefined)) ??
    identity.presence;

  const channel = partner ? dmChannel(partner) : findChannelById(live, channelId);
  const guild = guildOfChannel(live, channelId);
  const count = guild ? guildMembers(live, guild).length : 0;
  const Glyph =
    channel?.kind === "voice" ? SpeakerGlyph : channel?.kind === "media" ? MediaGlyph : HashGlyph;

  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        {partner ? (
          <Avatar
            name={identity.name}
            accent={identity.accent}
            size="sm"
            showPresence
            presence={presence}
          />
        ) : (
          <Glyph className={styles.glyph} />
        )}
        <h1 className={styles.name} data-testid="channel-name">
          {channel?.name ?? "channel"}
        </h1>
        {channel?.topic ? <span className={styles.divider} aria-hidden="true" /> : null}
        <p className={styles.topic}>{channel?.topic ?? ""}</p>
      </div>

      {guild ? (
        <button
          type="button"
          className={styles.members}
          onClick={toggleMemberList}
          aria-pressed={memberListOpen}
          aria-label={`${memberListOpen ? "Hide" : "Show"} member list, ${count} members`}
          title="Member list"
        >
          <MembersGlyph />
          <span>{count}</span>
        </button>
      ) : null}
    </header>
  );
}
