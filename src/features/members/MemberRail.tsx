import {
  guildMembers,
  highestRole,
  roleGroups,
  type Guild,
  type Member,
  type Presence,
} from "../../api/workspace";
import { getSelfId } from "../../state/identity";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { useMemberIdentity, useSelfIdentity } from "../../state/useIdentity";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { Avatar } from "../../ui/Avatar";
import styles from "./MemberRail.module.css";

/**
 * The member rail, grouped by hoisted role.
 *
 * Offline members are kept, greyed - a roster that hides people makes "who is on this
 * commission" unanswerable. Presence comes from the store, so the socket can move a dot
 * without the roster being re-derived; the signed-in member's presence comes from their saved
 * status choice instead.
 *
 * Every row is a button: the profile card is the only place that shows a banner, a bio and the
 * full role set, and it should be reachable from the roster as well as from a message.
 */
export function MemberRail(): React.JSX.Element | null {
  const guildId = useWorkspaceStore((state) => state.guildId);
  const overrides = useWorkspaceStore((state) => state.presence);
  const live = useLiveWorkspace();
  const selfIdentity = useSelfIdentity();

  const guild = live.guilds.find((entry) => entry.id === guildId) ?? live.guilds[0];
  const roster = guild ? guildMembers(live, guild) : [];

  if (!guild) return null;

  const groups = roleGroups(guild, roster);

  const presenceOf = (member: Member): Presence =>
    overrides[member.id] ?? (member.id === getSelfId() ? selfIdentity.presence : member.presence);

  const online = roster.filter((member) => presenceOf(member) !== "offline").length;

  return (
    <aside className={styles.rail} aria-label="Members" data-testid="member-rail">
      <h2 className={styles.heading}>
        Members — {online} of {roster.length}
      </h2>

      <div className={styles.scroll}>
        {groups.map((group) => (
          <section key={group.role?.id ?? "unassigned"} className={styles.group}>
            <h3 className={styles.groupLabel}>
              <span className={group.role ? `role-color-${group.role.color}` : undefined}>
                {group.role?.name ?? "Members"}
              </span>{" "}
              — {group.members.length}
            </h3>

            {group.members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                guild={guild}
                presence={presenceOf(member)}
              />
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

function MemberRow({
  member,
  guild,
  presence,
}: {
  member: Member;
  guild: Guild | undefined;
  presence: Presence;
}): React.JSX.Element {
  const identity = useMemberIdentity(member);
  const openProfile = useUiStore((state) => state.openProfile);
  const role = guild ? highestRole(guild, member.id) : undefined;

  return (
    <button
      type="button"
      className={styles.member}
      data-offline={presence === "offline"}
      data-testid="member-row"
      title={identity.statusText || member.activity || identity.name}
      onClick={() => openProfile(member.id)}
    >
      <Avatar
        name={identity.name}
        accent={identity.accent}
        image={identity.avatar}
        size="md"
        showPresence
        presence={presence}
      />
      <span className={styles.text}>
        <span className={`${styles.name} ${role ? `role-color-${role.color}` : ""}`}>
          {identity.name}
        </span>
        {identity.statusEmoji || identity.statusText ? (
          <span className={styles.status}>
            {identity.statusEmoji ? `${identity.statusEmoji} ` : ""}
            {identity.statusText}
          </span>
        ) : member.activity ? (
          <span className={styles.activity}>{member.activity}</span>
        ) : null}
      </span>
    </button>
  );
}
