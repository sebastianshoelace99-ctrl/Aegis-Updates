import { useEffect, useRef, useState } from "react";
import {
  createGuildInvite,
  listGuildInvites,
  revokeGuildInvite,
  type InviteSummary,
} from "../../api/backend";
import {
  SERVER_NAME_MAX,
  SERVER_NAME_MIN,
  serverInitials,
  serverNameSchema,
} from "../../api/createServer";
import { deleteGuild as deleteLiveGuild, updateGuild } from "../../api/liveWorkspace";
import {
  NOTIFICATION_COPY,
  NOTIFICATION_LEVELS,
  SERVER_DESCRIPTION_MAX,
  applyServerSettings,
  guildDescription,
  guildNotificationLevel,
  isSystemChannelCandidate,
  systemChannelOf,
  type ServerSettingsPatch,
} from "../../api/serverSettings";
import {
  guildMembers,
  roleById,
  withMemberRole,
  withoutMemberRole,
  withoutRole,
  type Guild,
  type GuildRole,
  type Member,
  type Workspace,
} from "../../api/workspace";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { getSelfId } from "../../state/identity";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { Avatar } from "../../ui/Avatar";
import {
  BellGlyph,
  CheckGlyph,
  CloseGlyph,
  CrownGlyph,
  HashGlyph,
  PlusGlyph,
  SettingsGlyph,
} from "../../ui/Glyphs";
import { readImageFile } from "../../ui/imageFile";
import { useDialog } from "../../ui/useDialog";
import shell from "./SettingsModal.module.css";
import styles from "./ServerSettings.module.css";

/**
 * Server settings: identity, notification policy, the system channel, and roles.
 *
 * Every write goes through `updateGuild`, which applies the edit optimistically, PATCHes the guild
 * to the backend, and republishes the authoritative graph. Nothing here mutates a guild in place,
 * so the rail badge, the channel list and the member rail all update through the same subscription
 * as a new server.
 */

const ROLE_COLORS = Array.from({ length: 16 }, (_, index) => index);

export function ServerSettingsModal(): React.JSX.Element | null {
  const open = useUiStore((state) => state.serverSettingsOpen);
  const close = useUiStore((state) => state.closeServerSettings);
  const guildId = useWorkspaceStore((state) => state.guildId);
  const live = useLiveWorkspace();

  if (!open) return null;

  const guild = live.guilds.find((entry) => entry.id === guildId) ?? live.guilds[0];
  if (!guild) return null;

  return <ServerSettingsDialog key={guild.id} guild={guild} live={live} onClose={close} />;
}

type DialogProps = { guild: Guild; live: Workspace; onClose: () => void };

function ServerSettingsDialog({ guild, live, onClose }: DialogProps): React.JSX.Element {
  const [tab, setTab] = useState<"overview" | "notifications" | "roles">("overview");
  const { ref, onBackdrop } = useDialog(onClose);
  const members = guildMembers(live, guild);
  const openChannel = useWorkspaceStore((state) => state.openChannel);
  const openHome = useWorkspaceStore((state) => state.openHome);

  const onDeleted = (next: Workspace): void => {
    const firstChannel = next.guilds[0]?.channels[0];
    if (firstChannel) openChannel(firstChannel.id);
    else openHome();
    onClose();
  };

  return (
    <div className={shell.overlay} onMouseDown={onBackdrop}>
      <div
        ref={ref}
        className={`${shell.dialog} ${styles.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-settings-title"
        tabIndex={-1}
        data-testid="server-settings-modal"
      >
        <header className={shell.head}>
          <div>
            <h2 id="server-settings-title" className={shell.title}>
              Server Settings
            </h2>
            <p className={shell.subtitle}>{guild.name}</p>
          </div>
          <button
            type="button"
            className={shell.close}
            onClick={onClose}
            aria-label="Close server settings"
          >
            <CloseGlyph />
          </button>
        </header>

        <div className={styles.layout}>
          <nav className={styles.nav} aria-label="Server settings sections">
            <button
              type="button"
              className={styles.navButton}
              data-active={tab === "overview"}
              data-testid="server-tab-overview"
              onClick={() => setTab("overview")}
            >
              Overview
            </button>
            <button
              type="button"
              className={styles.navButton}
              data-active={tab === "notifications"}
              data-testid="server-tab-notifications"
              onClick={() => setTab("notifications")}
            >
              Notifications
            </button>
            <button
              type="button"
              className={styles.navButton}
              data-active={tab === "roles"}
              data-testid="server-tab-roles"
              onClick={() => setTab("roles")}
            >
              Roles
            </button>
          </nav>

          <div className={styles.content}>
            {tab === "overview" ? (
              <Overview guild={guild} members={members} onDeleted={onDeleted} />
            ) : null}
            {tab === "notifications" ? <Notifications guild={guild} /> : null}
            {tab === "roles" ? <Roles guild={guild} members={members} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Overview({
  guild,
  members,
  onDeleted,
}: {
  guild: Guild;
  members: Member[];
  onDeleted: (workspace: Workspace) => void;
}): React.JSX.Element {
  const [name, setName] = useState(guild.name);
  const [description, setDescription] = useState(guildDescription(guild));
  const [accent, setAccent] = useState(guild.accent);
  const [icon, setIcon] = useState<string | null>(guild.icon ?? null);
  const [iconBusy, setIconBusy] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const chooseIcon = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    // Reset first, so choosing the same file twice still fires a change event.
    event.target.value = "";
    if (!file) return;

    setIconBusy(true);
    setIconError(null);

    try {
      const dataUrl = await readImageFile(file, { width: 128, height: 128, quality: 0.86 });
      setIcon(dataUrl);
      setSaved(false);
    } catch (failure) {
      setIconError(failure instanceof Error ? failure.message : "That image could not be read.");
    } finally {
      setIconBusy(false);
    }
  };

  const save = (): void => {
    const parsed = serverNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "That name is not valid.");
      setSaved(false);
      return;
    }

    const next = applyServerSettings(
      { ...guild, name: parsed.data, initial: serverInitials(parsed.data), accent },
      { description, icon },
    );

    setName(parsed.data);
    setDescription(description.trim());
    setError(null);
    setSaved(false);

    void updateGuild(next).then((ok) => {
      setSaved(ok);
      if (!ok) setError("The server did not accept that change. Check the backend and try again.");
    });
  };

  return (
    <section className={styles.section} aria-labelledby="server-overview-heading">
      <h3 id="server-overview-heading" className={styles.sectionTitle}>
        Overview
      </h3>
      <p className={shell.sectionBody}>
        How this server appears in the rail and at the top of the channel list.
      </p>

      <div className={styles.overviewPreview}>
        <Avatar
          name={name.trim() || guild.name}
          accent={accent}
          label={serverInitials(name.trim() || guild.name)}
          image={icon}
          size="xl"
          shape="square"
        />
        <span className={styles.overviewText}>
          <strong>{name.trim() || guild.name}</strong>
          <span>
            {members.length} members · {guild.channels.length} channels
          </span>
        </span>
      </div>

      <p className={styles.overviewDescription} data-empty={description.trim().length === 0}>
        {description.trim() || "No description yet. Add one so the server explains itself."}
      </p>

      <label className={shell.field}>
        <span className={shell.fieldLabel}>Server name</span>
        <input
          className={shell.input}
          value={name}
          maxLength={SERVER_NAME_MAX}
          data-testid="server-name"
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
            setSaved(false);
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <span className={shell.hint} data-error={error !== null}>
          {error ?? `${SERVER_NAME_MIN}–${SERVER_NAME_MAX} characters.`}
        </span>
      </label>

      <label className={shell.field}>
        <span className={shell.fieldLabel}>Description</span>
        <textarea
          className={shell.textarea}
          value={description}
          maxLength={SERVER_DESCRIPTION_MAX}
          rows={3}
          data-testid="server-description"
          onChange={(event) => {
            setDescription(event.target.value);
            setSaved(false);
          }}
          placeholder="What this server is for, who it is for, and what belongs here."
        />
        <span className={shell.hint}>
          {description.trim().length}/{SERVER_DESCRIPTION_MAX} characters. Shown in server settings
          and on the rail tooltip.
        </span>
      </label>

      <fieldset className={styles.swatchField}>
        <legend className={shell.fieldLabel}>Icon colour</legend>
        <div className={styles.swatchRow}>
          {Array.from({ length: 8 }, (_, value) => (
            <button
              key={value}
              type="button"
              className={`${shell.swatch} ${styles.swatch}`}
              data-accent={value}
              data-selected={value === accent}
              onClick={() => {
                setAccent(value);
                setSaved(false);
              }}
              aria-label={`Icon colour ${value + 1}`}
              aria-pressed={value === accent}
            />
          ))}
        </div>
      </fieldset>

      <div className={styles.iconField}>
        <span className={shell.fieldLabel}>Server icon</span>
        <div className={styles.iconRow}>
          <label className={shell.fileButton} data-busy={iconBusy}>
            {iconBusy ? "Processing…" : icon ? "Replace icon" : "Upload icon"}
            <input
              className={shell.fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              data-testid="server-icon-upload"
              disabled={iconBusy}
              onChange={(event) => void chooseIcon(event)}
            />
          </label>
          {icon ? (
            <button
              type="button"
              className={shell.ghost}
              data-testid="server-icon-remove"
              onClick={() => {
                setIcon(null);
                setIconError(null);
                setSaved(false);
              }}
            >
              Remove
            </button>
          ) : null}
        </div>
        <span className={shell.hint} data-error={iconError !== null}>
          {iconError ?? "PNG, JPEG or WebP. Cropped and downscaled to 128px in the renderer."}
        </span>
      </div>

      <div className={styles.footer}>
        <button type="button" className={shell.primary} onClick={save} data-testid="save-server">
          Save changes
        </button>
        {saved ? (
          <span className={styles.saved} role="status">
            <CheckGlyph /> Saved
          </span>
        ) : null}
      </div>

      <div className={shell.note}>
        <SettingsGlyph />
        <p>
          Changes are written to your server. Role edits, the description, the icon and the
          notification policy all survive a restart and appear in every window.
        </p>
      </div>
      {guild.ownerId === getSelfId() ? (
        <>
          <InviteLinks guildId={guild.id} />
          <DeleteServer guild={guild} onDeleted={onDeleted} />
        </>
      ) : null}
    </section>
  );
}

function DeleteServer({
  guild,
  onDeleted,
}: {
  guild: Guild;
  onDeleted: (workspace: Workspace) => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async (): Promise<void> => {
    if (name !== guild.name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const workspace = await deleteLiveGuild(guild.id);
      onDeleted(workspace);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The server could not be deleted.");
      setBusy(false);
    }
  };

  return (
    <section className={styles.deleteServer} aria-labelledby="delete-server-heading">
      <h3 id="delete-server-heading" className={styles.sectionTitle}>
        Delete server
      </h3>
      <p className={shell.sectionBody}>
        Permanently delete this server and its channels, messages, memberships, roles, and invites.
        This cannot be undone.
      </p>
      {!confirming ? (
        <button
          type="button"
          className={styles.danger}
          onClick={() => setConfirming(true)}
          data-testid="delete-server"
        >
          Delete server
        </button>
      ) : (
        <div className={styles.deleteConfirm}>
          <label className={shell.fieldLabel} htmlFor="delete-server-name">
            Type <strong>{guild.name}</strong> to confirm
          </label>
          <input
            id="delete-server-name"
            className={shell.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            disabled={busy}
            data-testid="delete-server-confirm-name"
          />
          <div className={styles.footer}>
            <button
              type="button"
              className={styles.danger}
              onClick={() => void remove()}
              disabled={name !== guild.name || busy}
              data-testid="confirm-delete-server"
            >
              {busy ? "Deleting..." : "Permanently delete"}
            </button>
            <button
              type="button"
              className={shell.ghost}
              onClick={() => {
                setConfirming(false);
                setName("");
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
          {error ? (
            <p className={shell.hint} data-error="true" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function InviteLinks({ guildId }: { guildId: string }): React.JSX.Element {
  const inviteInput = useRef<HTMLInputElement>(null);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [createdLink, setCreatedLink] = useState("");
  const [createdInviteId, setCreatedInviteId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listGuildInvites(guildId)
      .then((result) => {
        if (active) setInvites(result);
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "Could not load invites.");
      });
    return () => {
      active = false;
    };
  }, [guildId]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await createGuildInvite(guildId);
      setInvites((current) => [result.invite, ...current]);
      setCreatedLink(result.link);
      setCreatedInviteId(result.invite.id);
      setCopied(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not create an invite.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(createdLink);
      setError(null);
      setCopied(true);
      return;
    } catch {
      // Clipboard permissions may be unavailable in the renderer; try the legacy user-gesture API.
    }

    const temporary = document.createElement("textarea");
    temporary.value = createdLink;
    temporary.setAttribute("readonly", "");
    temporary.className = styles.copyFallback;
    let copied = false;
    try {
      document.body.append(temporary);
      temporary.select();
      copied = document.execCommand("copy");
    } catch {
      // Unsupported legacy clipboard APIs fall through to the manual-copy instruction below.
    } finally {
      temporary.remove();
    }

    if (copied) {
      setError(null);
      setCopied(true);
      return;
    }

    inviteInput.current?.focus();
    inviteInput.current?.select();
    setCopied(false);
    setError("Clipboard access was denied. The invite link is selected; press Ctrl+C to copy it.");
  };

  const revoke = async (inviteId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await revokeGuildInvite(guildId, inviteId);
      setInvites((current) =>
        current.map((invite) =>
          invite.id === inviteId ? { ...invite, revokedAt: new Date().toISOString() } : invite,
        ),
      );
      if (createdInviteId === inviteId) {
        setCreatedLink("");
        setCreatedInviteId(null);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not revoke the invite.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.invites} aria-labelledby="server-invites-heading">
      <div>
        <h3 id="server-invites-heading" className={styles.sectionTitle}>
          Invite links
        </h3>
        <p className={shell.sectionBody}>
          Create a reusable link that expires in 7 days. Only you, as the server owner, can manage
          invites.
        </p>
      </div>
      {createdLink ? (
        <div className={styles.inviteCreated}>
          <label className={shell.field}>
            <span className={shell.fieldLabel}>New invite link</span>
            <input
              ref={inviteInput}
              className={shell.input}
              value={createdLink}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <button type="button" className={shell.ghost} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}
      <button type="button" className={shell.primary} onClick={() => void create()} disabled={busy}>
        {busy ? "Working…" : "Create invite link"}
      </button>
      {error ? (
        <p className={shell.hint} data-error="true" role="alert">
          {error}
        </p>
      ) : null}
      {invites.length > 0 ? (
        <ul className={styles.inviteList}>
          {invites.map((invite) => {
            const expired = Date.parse(invite.expiresAt) <= Date.now();
            const revoked = invite.revokedAt !== null;
            return (
              <li key={invite.id} className={styles.inviteRow}>
                <span>
                  <strong>{revoked ? "Revoked" : expired ? "Expired" : "Active"}</strong>
                  <small>
                    Expires {new Date(invite.expiresAt).toLocaleString()} · {invite.useCount} uses
                  </small>
                </span>
                {!revoked && !expired ? (
                  <button
                    type="button"
                    className={shell.ghost}
                    onClick={() => void revoke(invite.id)}
                    disabled={busy}
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function Notifications({ guild }: { guild: Guild }): React.JSX.Element {
  const level = guildNotificationLevel(guild);
  const system = systemChannelOf(guild);
  const textChannels = guild.channels.filter(isSystemChannelCandidate);

  const patch = (change: ServerSettingsPatch): void => {
    updateGuild(applyServerSettings(guild, change));
  };

  return (
    <section className={styles.section} aria-labelledby="server-notifications-heading">
      <h3 id="server-notifications-heading" className={styles.sectionTitle}>
        Notifications
      </h3>
      <p className={shell.sectionBody}>
        How this server reports activity on the rail and in the channel list. Every choice is saved
        the moment you make it.
      </p>

      <fieldset
        className={styles.optionGrid}
        data-testid="server-notify-options"
        aria-labelledby="server-notify-legend"
      >
        <legend id="server-notify-legend" className={shell.fieldLabel}>
          Notify me about
        </legend>
        {NOTIFICATION_LEVELS.map((value) => {
          const copy = NOTIFICATION_COPY[value];

          return (
            <button
              key={value}
              type="button"
              aria-pressed={level === value}
              className={styles.notifyOption}
              data-selected={level === value}
              data-testid={`server-notify-${value}`}
              onClick={() => patch({ notificationLevel: value })}
            >
              <BellGlyph />
              <span className={styles.notifyText}>
                <strong>{copy.label}</strong>
                <small>{copy.caption}</small>
              </span>
            </button>
          );
        })}
      </fieldset>

      <label className={shell.field}>
        <span className={shell.fieldLabel}>System messages channel</span>
        <select
          className={shell.select}
          value={system?.id ?? ""}
          data-testid="server-system-channel"
          onChange={(event) => patch({ systemChannelId: event.target.value || null })}
        >
          <option value="">No system channel</option>
          {textChannels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              #{channel.name}
            </option>
          ))}
        </select>
        <span className={shell.hint}>
          Join notices and server-wide announcements are posted here. Voice channels are not
          eligible.
        </span>
      </label>

      <div className={styles.settingsSummary}>
        <BellGlyph />
        <span>
          {level === "none"
            ? "Unread badges for this server are hidden."
            : level === "mentions"
              ? "Only @mentions are counted."
              : "Every unread channel is counted."}{" "}
          {system ? `System messages go to #${system.name}.` : "No system channel is set."}
        </span>
      </div>

      <div className={shell.note}>
        <HashGlyph />
        <p>
          These settings apply to every channel in {guild.name} and are saved to the server.
        </p>
      </div>
    </section>
  );
}

function Roles({ guild, members }: { guild: Guild; members: Member[] }): React.JSX.Element {
  const ordered = [...guild.roles].sort(
    (a, b) => b.position - a.position || a.name.localeCompare(b.name),
  );
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(ordered[0]?.id ?? null);
  const [nameDraft, setNameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const selected = selectedRoleId ? (roleById(guild, selectedRoleId) ?? null) : null;

  const patch = (id: string, change: Partial<GuildRole>): void => {
    updateGuild({
      ...guild,
      roles: guild.roles.map((role) => (role.id === id ? { ...role, ...change } : role)),
    });
  };

  const create = (event: React.FormEvent): void => {
    event.preventDefault();
    const name = nameDraft.trim();
    if (name.length === 0 || name.length > 32) {
      setError("Role names need 1–32 characters.");
      return;
    }

    let id = `role-${Date.now().toString(36)}`;
    let suffix = 2;
    while (guild.roles.some((role) => role.id === id)) {
      id = `role-${Date.now().toString(36)}-${suffix}`;
      suffix += 1;
    }

    const position = guild.roles.reduce((max, role) => Math.max(max, role.position), 0) + 1;
    updateGuild({
      ...guild,
      roles: [...guild.roles, { id, name, color: 0, hoist: true, position }],
    });
    setSelectedRoleId(id);
    setNameDraft("");
    setError(null);
  };

  const remove = (): void => {
    if (!selected) return;
    const next = ordered.find((role) => role.id !== selected.id);
    updateGuild(withoutRole(guild, selected.id));
    setSelectedRoleId(next?.id ?? null);
  };

  const countFor = (role: GuildRole): number =>
    guild.memberIds.filter((memberId) =>
      (guild.memberRoles[memberId] ?? []).includes(role.id),
    ).length;

  return (
    <section className={styles.section} aria-labelledby="server-roles-heading">
      <h3 id="server-roles-heading" className={styles.sectionTitle}>
        Roles
      </h3>
      <p className={shell.sectionBody}>
        Roles colour names, group the member list when hoisted, and are free to create. Every
        member can hold more than one.
      </p>

      <div className={styles.roleLayout}>
        <div className={styles.roleColumn}>
          <ul className={styles.roleList} aria-label="Roles">
            {ordered.map((role) => (
              <li key={role.id}>
                <button
                  type="button"
                  className={styles.roleRow}
                  data-active={role.id === selected?.id}
                  data-testid="role-row"
                  onClick={() => {
                    setSelectedRoleId(role.id);
                    setError(null);
                  }}
                >
                  <span className={styles.roleDot} data-color={role.color} aria-hidden="true" />
                  <span className={styles.roleName}>{role.name}</span>
                  <span className={styles.roleCount}>{countFor(role)}</span>
                </button>
              </li>
            ))}
            {ordered.length === 0 ? <li className={styles.empty}>No roles yet.</li> : null}
          </ul>

          <form className={styles.createForm} onSubmit={create}>
            <input
              className={shell.input}
              value={nameDraft}
              maxLength={32}
              placeholder="New role name"
              aria-label="New role name"
              data-testid="new-role-name"
              onChange={(event) => {
                setNameDraft(event.target.value);
                setError(null);
              }}
            />
            <button
              type="submit"
              className={shell.primary}
              disabled={nameDraft.trim().length === 0}
              data-testid="create-role"
            >
              <PlusGlyph />
              Create
            </button>
          </form>
          {error ? (
            <p className={shell.error} role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className={styles.roleColumn}>
          {selected ? (
            <RoleEditor
              key={selected.id}
              role={selected}
              count={countFor(selected)}
              onPatch={(change) => patch(selected.id, change)}
              onDelete={remove}
            />
          ) : (
            <p className={styles.empty}>Select a role to edit it, or create one.</p>
          )}
        </div>
      </div>

      {selected ? (
        <MemberAssignments guild={guild} role={selected} members={members} />
      ) : null}
    </section>
  );
}

type RoleEditorProps = {
  role: GuildRole;
  count: number;
  onPatch: (change: Partial<GuildRole>) => void;
  onDelete: () => void;
};

function RoleEditor({ role, count, onPatch, onDelete }: RoleEditorProps): React.JSX.Element {
  const [name, setName] = useState(role.name);
  const [error, setError] = useState<string | null>(null);

  const saveName = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 32) {
      setError("Role names need 1–32 characters.");
      return;
    }
    onPatch({ name: trimmed });
    setName(trimmed);
    setError(null);
  };

  return (
    <div className={styles.editor} data-testid="role-editor">
      <label className={shell.field}>
        <span className={shell.fieldLabel}>Role name</span>
        <input
          className={shell.input}
          value={name}
          maxLength={32}
          data-testid="role-name"
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveName();
            }
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <span className={shell.hint} data-error={error !== null}>
          {error ?? "Press Enter or Save to apply."}
        </span>
      </label>

      <button type="button" className={shell.ghost} onClick={saveName} data-testid="save-role-name">
        Save name
      </button>

      <fieldset className={styles.colorField}>
        <legend className={shell.fieldLabel}>Colour</legend>
        <div className={styles.colorGrid}>
          {ROLE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={styles.colorButton}
              data-color={color}
              data-selected={role.color === color}
              onClick={() => onPatch({ color })}
              aria-label={`Role colour ${color + 1}`}
              aria-pressed={role.color === color}
            />
          ))}
        </div>
      </fieldset>

      <label className={styles.checkRow}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={role.hoist}
          onChange={(event) => onPatch({ hoist: event.target.checked })}
        />
        <span>
          <strong>Display separately</strong>
          <small>Give this role its own member-list section.</small>
        </span>
      </label>

      <div className={styles.editorFooter}>
        <span className={styles.countBadge}>
          <CrownGlyph /> {count} {count === 1 ? "member" : "members"}
        </span>
        <button type="button" className={styles.danger} onClick={onDelete} data-testid="delete-role">
          Delete role
        </button>
      </div>
    </div>
  );
}

function MemberAssignments({
  guild,
  role,
  members,
}: {
  guild: Guild;
  role: GuildRole;
  members: Member[];
}): React.JSX.Element {
  return (
    <div className={styles.members}>
      <h4 className={styles.membersTitle}>
        <CrownGlyph /> Members with {role.name}
      </h4>
      <p className={styles.membersHint}>Toggle a member to grant or remove this role.</p>

      <div className={styles.memberGrid}>
        {members.map((member) => {
          const assigned = (guild.memberRoles[member.id] ?? []).includes(role.id);

          return (
            <label key={member.id} className={styles.memberRow} data-assigned={assigned}>
              <Avatar name={member.name} accent={member.accent} size="sm" />
              <span className={styles.memberName}>{member.name}</span>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={assigned}
                aria-label={`${assigned ? "Remove" : "Add"} ${role.name} for ${member.name}`}
                onChange={(event) =>
                  updateGuild(
                    event.target.checked
                      ? withMemberRole(guild, member.id, role.id)
                      : withoutMemberRole(guild, member.id, role.id),
                  )
                }
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
