import {
  buildGuild,
  createServerInputSchema,
  ownerMember,
  slugifyServerName,
  type CreateServerInput,
} from "../shared/guildFactory";
import {
  normalizeGuild,
  type ChannelKind,
  type Guild,
  type Member,
  type Presence,
  type Role,
  type Workspace,
} from "../shared/domain";
import {
  attachmentSchema,
  mentionedHandles,
  reactionSchema,
  toggleReaction as applyReaction,
  type Attachment,
  type FileAttachment,
  type Message,
  type Reaction,
} from "../shared/messages";
import { HttpError } from "./errors";
import type { InviteSummary, Store } from "./store";

/**
 * Supabase persistence through PostgREST.
 *
 * Deliberately no `@supabase/supabase-js`: the server only needs a handful of reads and writes,
 * and a dependency-free backend is one that runs on a clean checkout. The service-role key stays
 * in this process; the renderer never sees a Supabase credential.
 *
 * PostgREST is not a transaction manager. Writes are ordered so a failure cannot leave a channel
 * pointing at a missing category, and guild creation cleans up after itself on error.
 */

type MemberRow = {
  id: string;
  name: string;
  handle: string;
  role: Role;
  presence: Presence;
  accent: number;
  activity: string | null;
};

type GuildRow = {
  id: string;
  owner_id: string;
  name: string;
  initial: string;
  accent: number;
  description: string | null;
  notification_level: string | null;
  system_channel_id: string | null;
  icon: string | null;
  created_at: string;
};

type CategoryRow = { id: string; guild_id: string; name: string; position: number };

type ChannelRow = {
  id: string;
  guild_id: string;
  category_id: string;
  slug: string;
  name: string;
  topic: string;
  kind: ChannelKind;
  commission_id: string | null;
  position: number;
};

type MembershipRow = { guild_id: string; member_id: string; joined_at: string };

type RoleRow = {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
};

type AssignmentRow = { guild_id: string; member_id: string; role_id: string };
type InviteRow = {
  id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  use_count: number;
};

type MessageRow = {
  id: string;
  channel_id: string;
  author_id: string;
  body: string;
  kind: "user" | "system";
  attachments: Attachment[] | null;
  mentions: string[] | null;
  reply_to_id: string | null;
  created_at: string;
  edited_at: string | null;
  /**
   * jsonb, and nullable in practice: rows written before the reactions migration has run have no
   * value at all. Optional so a row from that database still type-checks against this reader.
   */
  reactions?: unknown;
};

export type SupabaseConfig = { url: string; key: string };

const enc = encodeURIComponent;

function memberOf(row: MemberRow): Member {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    role: row.role,
    presence: row.presence,
    accent: row.accent,
    ...(row.activity ? { activity: row.activity } : {}),
  };
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

/**
 * jsonb is untyped: a row written by an older build has no `kind` on its attachments. Parsing here
 * is what lets the feed trust the union instead of defending against every field at render time.
 */
function attachmentsOf(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const kept: Attachment[] = [];
  for (const entry of raw) {
    const parsed = attachmentSchema.safeParse(entry);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

/**
 * Reactions arrive as untyped jsonb, exactly like attachments. A row written before the reactions
 * migration ran has no value at all, so anything unparseable collapses to "no reactions" rather
 * than failing the whole page: one bad row must not blank the history.
 */
function reactionsOf(raw: unknown): Reaction[] {
  if (!Array.isArray(raw)) return [];
  const kept: Reaction[] = [];
  for (const entry of raw) {
    const parsed = reactionSchema.safeParse(entry);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

function messageOf(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    body: row.body,
    // PostgREST returns timestamptz as `...+00:00`; the rest of the app (and the feed's divider)
    // compares ISO strings, so normalise to the same `Z` form the client writes.
    createdAt: iso(row.created_at),
    kind: row.kind,
    attachments: attachmentsOf(row.attachments),
    mentions: row.mentions ?? [],
    replyToId: row.reply_to_id,
    editedAt: row.edited_at ? iso(row.edited_at) : null,
    reactions: reactionsOf(row.reactions),
  };
}

function mapWorkspace(
  memberRows: MemberRow[],
  guildRows: GuildRow[],
  categoryRows: CategoryRow[],
  channelRows: ChannelRow[],
  membershipRows: MembershipRow[],
  roleRows: RoleRow[],
  assignmentRows: AssignmentRow[],
): Workspace {
  const members = memberRows.map(memberOf);

  const guilds: Guild[] = guildRows.map((row) => {
    const categories = categoryRows
      .filter((entry) => entry.guild_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map((entry) => ({ id: entry.id, name: entry.name }));

    const channels = channelRows
      .filter((entry) => entry.guild_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map((entry) => ({
        id: entry.id,
        slug: entry.slug,
        name: entry.name,
        topic: entry.topic,
        kind: entry.kind,
        categoryId: entry.category_id,
        commissionId: entry.commission_id,
      }));

    const memberIds = membershipRows
      .filter((entry) => entry.guild_id === row.id)
      .sort((a, b) => a.joined_at.localeCompare(b.joined_at))
      .map((entry) => entry.member_id);

    const roles = roleRows
      .filter((entry) => entry.guild_id === row.id)
      .sort((a, b) => b.position - a.position)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        color: entry.color,
        hoist: entry.hoist,
        position: entry.position,
      }));

    const memberRoles: Record<string, string[]> = {};
    for (const entry of assignmentRows) {
      if (entry.guild_id !== row.id) continue;
      memberRoles[entry.member_id] = [...(memberRoles[entry.member_id] ?? []), entry.role_id];
    }

    return {
      id: row.id,
      ownerId: row.owner_id,
      name: row.name,
      initial: row.initial,
      accent: row.accent,
      categories,
      channels,
      memberIds,
      roles,
      memberRoles,
      ...(row.description ? { description: row.description } : {}),
      ...(row.notification_level
        ? { notificationLevel: row.notification_level as "all" | "mentions" | "none" }
        : {}),
      systemChannelId: row.system_channel_id,
      ...(row.icon ? { icon: row.icon } : {}),
    };
  });

  return { guilds, members };
}

/** Cloudflare's origin-failure range. Every `*.supabase.co` project sits behind it. */
const ORIGIN_DOWN = new Set([520, 521, 522, 523, 524, 525, 526]);

/**
 * Turn a failed PostgREST response into something an operator can act on.
 *
 * This used to pipe 400 characters of whatever came back straight into the UI, so an origin outage
 * surfaced as a page of Cloudflare HTML under the words "Supabase rejected the request". That names
 * a status and a cloud provider, not a cause. The cases below are the ones worth telling apart,
 * because they have three different fixes.
 */
function describeFailure(host: string, status: number, detail: string): string {
  const html = /^\s*<(?:!doctype|html)/i.test(detail);

  if (ORIGIN_DOWN.has(status)) {
    return (
      `Supabase (${host}) is not serving this project: the edge answered ${status}, which means its ` +
      "origin is down. A paused or over-quota project does exactly this. Restore it in the Supabase " +
      "dashboard, or run against the local store with AEGIS_STORE=memory."
    );
  }

  if (html) {
    return (
      `Supabase (${host}) answered ${status} with an HTML page instead of JSON. That is an edge or ` +
      "proxy failure, not a database error. Check the project is running, or run locally with " +
      "AEGIS_STORE=memory."
    );
  }

  // A genuine PostgREST error already carries the useful message; keep it, but name the host.
  return `Supabase (${host}) rejected the request (${status}): ${detail.slice(0, 300)}`;
}

export function createSupabaseStore(config: SupabaseConfig): Store {
  const base = `${config.url.replace(/\/+$/, "")}/rest/v1`;
  /** For the message only: "the edge answered 521" is useless without saying *which* project. */
  const host = (() => {
    try {
      return new URL(config.url).host;
    } catch {
      return config.url;
    }
  })();

  async function sb<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("apikey", config.key);
    headers.set("authorization", `Bearer ${config.key}`);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    let response: Response;
    try {
      response = await fetch(`${base}/${path}`, { ...init, headers });
    } catch {
      // A DNS or TCP failure: there is no HTTP status to interpret, and the host is the only clue.
      throw new HttpError(
        502,
        `Supabase (${host}) could not be reached. Check SUPABASE_URL and your network.`,
      );
    }

    if (!response.ok) {
      const detail = await response.text();
      const status =
        response.status === 400
          ? 400
          : response.status === 404
            ? 404
            : response.status === 409
              ? 409
              : 502;
      throw new HttpError(status, describeFailure(host, response.status, detail));
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  const all = <T>(table: string, query = "select=*"): Promise<T[]> => sb<T[]>(`${table}?${query}`);

  async function readWorkspace(memberId?: string): Promise<Workspace> {
    const [members, guilds, categories, channels, memberships, roles, assignments] =
      await Promise.all([
        all<MemberRow>("members", "select=*&order=created_at.asc"),
        all<GuildRow>("guilds", "select=*&order=created_at.asc"),
        all<CategoryRow>("categories", "select=*&order=position.asc"),
        all<ChannelRow>("channels", "select=*&order=position.asc"),
        all<MembershipRow>("guild_members", "select=*&order=joined_at.asc"),
        all<RoleRow>("guild_roles", "select=*&order=position.desc"),
        all<AssignmentRow>("guild_member_roles", "select=*"),
      ]);

    const workspace = mapWorkspace(members, guilds, categories, channels, memberships, roles, assignments);
    if (!memberId) return workspace;

    const visibleGuilds = workspace.guilds.filter((guild) => guild.memberIds.includes(memberId));
    return {
      guilds: visibleGuilds,
      members: workspace.members,
    };
  }

  async function requireGuildOwner(guildId: string, memberId: string): Promise<void> {
    const rows = await all<{ owner_id: string }>(
      "guilds",
      `select=owner_id&id=eq.${enc(guildId)}&limit=1`,
    );
    if (!rows[0]) throw new HttpError(404, "Unknown server.");
    if (rows[0].owner_id !== memberId) {
      throw new HttpError(403, "Only the server owner can manage invite links.");
    }
  }

  function inviteSummary(row: InviteRow): InviteSummary {
    return {
      id: row.id,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
      useCount: row.use_count,
    };
  }

  /**
   * Insert the signed-in member if the account has never written before, and reuse their existing
   * handle if it does not collide. `handle` is unique in the schema; inventing a second "nyx"
   * would make mentions ambiguous.
   */
  async function ensureMember(member: Member): Promise<Member> {
    const existing = await all<MemberRow>("members", `select=*&id=eq.${enc(member.id)}`);
    const row = existing[0];

    if (row) {
      const [updated] = await sb<MemberRow[]>(`members?id=eq.${enc(member.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: member.name, accent: member.accent }),
        headers: { prefer: "return=representation" },
      });
      return updated ? memberOf(updated) : memberOf(row);
    }

    let handle = member.handle || slugifyServerName(member.name);
    const collision = await all<MemberRow>("members", `select=id&handle=eq.${enc(handle)}`);
    if (collision.length > 0) {
      let suffix = 2;
      for (;;) {
        const candidate = `${handle}-${suffix}`;
        const rows = await all<MemberRow>("members", `select=id&handle=eq.${enc(candidate)}`);
        if (rows.length === 0) {
          handle = candidate;
          break;
        }
        suffix += 1;
      }
    }

    const [inserted] = await sb<MemberRow[]>("members", {
      method: "POST",
      body: JSON.stringify({
        id: member.id,
        name: member.name,
        handle,
        role: member.role,
        presence: member.presence,
        accent: member.accent,
        activity: member.activity ?? null,
      }),
      headers: { prefer: "return=representation" },
    });

    if (!inserted) throw new HttpError(502, "Supabase did not return the created member.");
    return memberOf(inserted);
  }

  /** Rows the client knows about that the members table does not. */
  async function ensureMembers(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await all<MemberRow>("members", "select=id,handle");
    const known = new Set(rows.map((row) => row.id));
    const taken = new Set(rows.map((row) => row.handle));

    for (const id of ids) {
      if (known.has(id)) continue;

      const base = id.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "member";
      let handle = base;
      let suffix = 2;
      while (taken.has(handle)) {
        handle = `${base}-${suffix}`;
        suffix += 1;
      }

      taken.add(handle);
      await sb("members", {
        method: "POST",
        body: JSON.stringify({
          id,
          name: id,
          handle,
          role: "artist",
          presence: "offline",
          accent: 0,
        }),
      });
    }
  }


  return {
    kind: "supabase",
    readWorkspace,
    ensureMember,

    async createGuild(raw: CreateServerInput) {
      const input = createServerInputSchema.parse(raw);
      const owner = await ensureMember(ownerMember(input));
      const existing = (await all<{ id: string }>("guilds", "select=id")).map((row) => row.id);
      const guild = { ...buildGuild(input, existing), ownerId: owner.id };

      let created = false;
      try {
        await sb("guilds", {
          method: "POST",
          body: JSON.stringify({
            id: guild.id,
            name: guild.name,
            initial: guild.initial,
            accent: guild.accent,
            description: null,
            notification_level: "all",
            icon: null,
            owner_id: owner.id,
            system_channel_id: null,
          }),
        });
        created = true;

        await sb("categories", {
          method: "POST",
          body: JSON.stringify(
            guild.categories.map((category, index) => ({
              id: category.id,
              guild_id: guild.id,
              name: category.name,
              position: index,
            })),
          ),
        });

        await sb("channels", {
          method: "POST",
          body: JSON.stringify(
            guild.channels.map((channel, index) => ({
              id: channel.id,
              guild_id: guild.id,
              category_id: channel.categoryId,
              slug: channel.slug,
              name: channel.name,
              topic: channel.topic,
              kind: channel.kind,
              commission_id: channel.commissionId,
              position: index,
            })),
          ),
        });

        await sb("guild_roles", {
          method: "POST",
          body: JSON.stringify(
            guild.roles.map((role) => ({
              id: role.id,
              guild_id: guild.id,
              name: role.name,
              color: role.color,
              hoist: role.hoist,
              position: role.position,
            })),
          ),
        });

        await sb("guild_members", {
          method: "POST",
          body: JSON.stringify(
            guild.memberIds.map((memberId) => ({ guild_id: guild.id, member_id: memberId })),
          ),
        });

        const assignments = Object.entries(guild.memberRoles).flatMap(([memberId, roleIds]) =>
          roleIds.map((roleId) => ({ guild_id: guild.id, member_id: memberId, role_id: roleId })),
        );
        if (assignments.length > 0) {
          await sb("guild_member_roles", { method: "POST", body: JSON.stringify(assignments) });
        }
      } catch (error) {
        // PostgREST has no cross-request transaction; deleting the guild cascades the rest. Only
        // clean up an insert this request actually made - a 409 means someone else owns that id.
        if (created) {
          await sb(`guilds?id=eq.${enc(guild.id)}`, { method: "DELETE" }).catch(() => undefined);
        }
        throw error;
      }

      return { guild, workspace: await readWorkspace() };
    },

    async deleteGuild(guildId, memberId) {
      const result = await sb<string>("rpc/aegis_delete_guild", {
        method: "POST",
        body: JSON.stringify({ p_guild_id: guildId, p_member_id: memberId }),
      });
      if (result === "not_found") throw new HttpError(404, "Unknown server.");
      if (result === "forbidden") {
        throw new HttpError(403, "Only the server owner can delete this server.");
      }
      if (result !== "deleted") {
        throw new HttpError(502, "Supabase did not confirm server deletion.");
      }
    },

    async saveGuild(raw) {
      const guild = normalizeGuild(raw);
      if (!guild) throw new HttpError(400, "That guild is not a valid workspace record.");

      const exists = await all<{ id: string }>("guilds", `select=id&id=eq.${enc(guild.id)}`);
      if (exists.length === 0) throw new HttpError(404, `Unknown guild: ${guild.id}`);

      await ensureMembers(guild.memberIds);

      await sb(`guilds?id=eq.${enc(guild.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: guild.name,
          initial: guild.initial,
          accent: guild.accent,
          description: guild.description ?? null,
          notification_level: guild.notificationLevel ?? "all",
          icon: guild.icon ?? null,
        }),
      });

      await sb("categories?on_conflict=id", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(
          guild.categories.map((category, index) => ({
            id: category.id,
            guild_id: guild.id,
            name: category.name,
            position: index,
          })),
        ),
      });

      await sb("channels?on_conflict=id", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(
          guild.channels.map((channel, index) => ({
            id: channel.id,
            guild_id: guild.id,
            category_id: channel.categoryId,
            slug: channel.slug,
            name: channel.name,
            topic: channel.topic,
            kind: channel.kind,
            commission_id: channel.commissionId,
            position: index,
          })),
        ),
      });

      await sb("guild_roles?on_conflict=guild_id,id", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(
          guild.roles.map((role) => ({
            id: role.id,
            guild_id: guild.id,
            name: role.name,
            color: role.color,
            hoist: role.hoist,
            position: role.position,
          })),
        ),
      });

      const keptChannels = new Set(guild.channels.map((channel) => channel.id));
      for (const row of await all<{ id: string }>(
        "channels",
        `select=id&guild_id=eq.${enc(guild.id)}`,
      )) {
        if (!keptChannels.has(row.id)) {
          await sb(`channels?id=eq.${enc(row.id)}`, { method: "DELETE" });
        }
      }

      const keptCategories = new Set(guild.categories.map((category) => category.id));
      for (const row of await all<{ id: string }>(
        "categories",
        `select=id&guild_id=eq.${enc(guild.id)}`,
      )) {
        if (!keptCategories.has(row.id)) {
          await sb(`categories?id=eq.${enc(row.id)}`, { method: "DELETE" });
        }
      }

      const keptRoles = new Set(guild.roles.map((role) => role.id));
      for (const row of await all<{ id: string }>(
        "guild_roles",
        `select=id&guild_id=eq.${enc(guild.id)}`,
      )) {
        if (!keptRoles.has(row.id)) {
          await sb(`guild_roles?guild_id=eq.${enc(guild.id)}&id=eq.${enc(row.id)}`, {
            method: "DELETE",
          });
        }
      }

      await sb(`guild_member_roles?guild_id=eq.${enc(guild.id)}`, { method: "DELETE" });
      await sb(`guild_members?guild_id=eq.${enc(guild.id)}`, { method: "DELETE" });

      await sb("guild_members", {
        method: "POST",
        body: JSON.stringify(
          guild.memberIds.map((memberId) => ({ guild_id: guild.id, member_id: memberId })),
        ),
      });

      const assignments = Object.entries(guild.memberRoles).flatMap(([memberId, roleIds]) =>
        roleIds.map((roleId) => ({ guild_id: guild.id, member_id: memberId, role_id: roleId })),
      );
      if (assignments.length > 0) {
        await sb("guild_member_roles", { method: "POST", body: JSON.stringify(assignments) });
      }

      // Channels exist now, so the optional FK is safe to set (or clear).
      await sb(`guilds?id=eq.${enc(guild.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ system_channel_id: guild.systemChannelId ?? null }),
      });

      return { guild, workspace: await readWorkspace() };
    },

    async isGuildOwner(guildId, memberId) {
      const rows = await all<{ owner_id: string }>(
        "guilds",
        `select=owner_id&id=eq.${enc(guildId)}&limit=1`,
      );
      return rows[0]?.owner_id === memberId;
    },

    async createInvite(guildId, memberId, codeHash, expiresAt) {
      await requireGuildOwner(guildId, memberId);
      const [row] = await sb<InviteRow[]>("guild_invites", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({
          guild_id: guildId,
          created_by: memberId,
          code_hash: codeHash,
          expires_at: expiresAt,
        }),
      });
      if (!row) throw new HttpError(502, "Supabase did not return the created invite.");
      return inviteSummary(row);
    },

    async listInvites(guildId, memberId) {
      await requireGuildOwner(guildId, memberId);
      const rows = await all<InviteRow>(
        "guild_invites",
        `select=id,created_at,expires_at,revoked_at,use_count&guild_id=eq.${enc(guildId)}&order=created_at.desc`,
      );
      return rows.map(inviteSummary);
    },

    async revokeInvite(guildId, inviteId, memberId) {
      await requireGuildOwner(guildId, memberId);
      const existing = await all<{ id: string }>(
        "guild_invites",
        `select=id&id=eq.${enc(inviteId)}&guild_id=eq.${enc(guildId)}&limit=1`,
      );
      if (!existing[0]) throw new HttpError(404, "Unknown invite.");
      await sb(
        `guild_invites?id=eq.${enc(inviteId)}&guild_id=eq.${enc(guildId)}&revoked_at=is.null`,
        {
          method: "PATCH",
          body: JSON.stringify({ revoked_at: new Date().toISOString() }),
        },
      );
    },

    async redeemInvite(codeHash, member) {
      await ensureMember(member);
      const rows = await sb<Array<{ guild_id: string }>>("rpc/aegis_redeem_guild_invite", {
        method: "POST",
        body: JSON.stringify({ p_code_hash: codeHash, p_member_id: member.id }),
      });
      if (!rows[0]) throw new HttpError(404, "That invite is invalid, expired or revoked.");
      return rows[0].guild_id;
    },


    async listMessages(channelId, before, limit) {
      const query =
        `select=*&channel_id=eq.${enc(channelId)}&order=created_at.desc,id.desc&limit=${limit}` +
        (before ? `&created_at=lt.${enc(before)}` : "");
      const rows = await all<MessageRow>("messages", query);
      return rows.map(messageOf).reverse();
    },

    async createMessage(channelId, authorId, body, attachments = []) {
      const channels = await all<{ kind: ChannelKind }>(
        "channels",
        `select=kind&id=eq.${enc(channelId)}`,
      );
      const channel = channels[0];
      if (!channel) throw new HttpError(404, `Unknown channel: ${channelId}`);
      if (channel.kind === "voice") {
        throw new HttpError(400, "A voice channel cannot hold messages.");
      }

      const authors = await all<{ id: string }>("members", `select=id&id=eq.${enc(authorId)}`);
      if (authors.length === 0) throw new HttpError(403, "That member is not in this workspace.");

      const stored: FileAttachment[] = attachments.map((item) => ({
        kind: "file",
        uploadId: item.uploadId,
        name: item.name,
        mime: item.mime,
        size: item.size,
      }));

      const [row] = await sb<MessageRow[]>("messages", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({
          channel_id: channelId,
          author_id: authorId,
          body,
          kind: "user",
          attachments: stored,
          mentions: mentionedHandles(body),
          // Explicit rather than relying on the column default, so the reply below already carries
          // an empty set and the client never has to treat `undefined` as a state.
          reactions: [],
        }),
      });

      if (!row) throw new HttpError(502, "Supabase did not return the created message.");
      return messageOf(row);
    },

    async toggleReaction(channelId, messageId, memberId, emoji, burst) {
      /*
       * Scoped by channel as well as id. A message id alone would let a caller react to a row in a
       * channel it cannot see, and "not yours" and "not there" answer the same 404 on purpose.
       */
      const rows = await all<MessageRow>(
        "messages",
        `select=*&id=eq.${enc(messageId)}&channel_id=eq.${enc(channelId)}&limit=1`,
      );
      const row = rows[0];
      if (!row) throw new HttpError(404, `Unknown message: ${messageId}`);

      const current = messageOf(row);
      const reactions = applyReaction(current.reactions, emoji, memberId, burst);

      const [updated] = await sb<MessageRow[]>(`messages?id=eq.${enc(messageId)}`, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({ reactions }),
      });

      if (!updated) throw new HttpError(502, "Supabase did not return the updated message.");
      return messageOf(updated);
    },

    async setPresence(memberId, presence) {
      await sb(`members?id=eq.${enc(memberId)}`, {
        method: "PATCH",
        body: JSON.stringify({ presence }),
      });
    },

    async hasChannel(channelId, memberId) {
      const rows = await all<{ id: string; guild_id: string }>(
        "channels",
        `select=id,guild_id&id=eq.${enc(channelId)}&limit=1`,
      );
      if (!rows[0]) return false;
      if (!memberId) return true;
      const memberships = await all<{ member_id: string }>(
        "guild_members",
        `select=member_id&guild_id=eq.${enc(rows[0].guild_id)}&member_id=eq.${enc(memberId)}&limit=1`,
      );
      return memberships.length > 0;
    },
  };
}
