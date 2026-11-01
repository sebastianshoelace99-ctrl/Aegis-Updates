-- Guild permissions and append-only moderation audit history.
begin;

alter table public.guild_roles
  add column if not exists permissions text[] not null
  default array[
    'view_channel', 'read_history', 'send_messages', 'add_reactions',
    'connect_voice', 'speak', 'share_video', 'share_screen'
  ]::text[];

update public.guild_roles
set permissions = array[
  'view_channel', 'read_history', 'send_messages', 'add_reactions',
  'connect_voice', 'speak', 'share_video', 'share_screen',
  'manage_channels', 'manage_roles', 'manage_invites', 'moderate_members',
  'manage_guild', 'export_data'
]::text[]
where id = 'owner';

insert into public.guild_roles (guild_id, id, name, color, hoist, position, permissions)
select guild.id, 'member', 'Member', 7, true, 1, array[
  'view_channel', 'read_history', 'send_messages', 'add_reactions',
  'connect_voice', 'speak', 'share_video', 'share_screen'
]::text[]
from public.guilds as guild
on conflict (guild_id, id) do nothing;

insert into public.guild_member_roles (guild_id, member_id, role_id)
select membership.guild_id, membership.member_id, 'member'
from public.guild_members as membership
where not exists (
  select 1
  from public.guild_member_roles as assignment
  where assignment.guild_id = membership.guild_id
    and assignment.member_id = membership.member_id
)
on conflict (guild_id, member_id, role_id) do nothing;

alter table public.channels
  add column if not exists permission_overwrites jsonb not null default '{}'::jsonb;

alter table public.channels
  drop constraint if exists channels_permission_overwrites_object;
alter table public.channels
  add constraint channels_permission_overwrites_object
  check (jsonb_typeof(permission_overwrites) = 'object');

create table if not exists public.guild_moderation_audit (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null references public.guilds (id) on delete cascade,
  actor_id text not null references public.members (id) on delete restrict,
  target_id text not null references public.members (id) on delete restrict,
  action text not null check (action in ('timeout', 'remove_timeout', 'kick', 'ban', 'unban')),
  reason text not null default '' check (char_length(reason) <= 500),
  expires_at timestamptz,
  message_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists guild_moderation_audit_guild_created_idx
  on public.guild_moderation_audit (guild_id, created_at desc);

create table if not exists public.guild_member_restrictions (
  guild_id text not null references public.guilds (id) on delete cascade,
  member_id text not null references public.members (id) on delete cascade,
  kind text not null check (kind in ('timeout', 'ban')),
  expires_at timestamptz,
  reason text not null default '' check (char_length(reason) <= 500),
  created_by text not null references public.members (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (guild_id, member_id, kind)
);

alter table public.guild_moderation_audit enable row level security;
alter table public.guild_member_restrictions enable row level security;
revoke all on public.guild_moderation_audit from anon, authenticated;
revoke all on public.guild_member_restrictions from anon, authenticated;
grant select, insert on public.guild_moderation_audit to service_role;
grant select, insert, update, delete on public.guild_member_restrictions to service_role;

create or replace function public.aegis_prevent_moderation_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1
    from public.guilds as guild
    where guild.id = old.guild_id
  ) then
    return old;
  end if;

  raise exception 'Moderation audit records are immutable.'
    using errcode = '23514';
end;
$$;

drop trigger if exists aegis_moderation_audit_immutable on public.guild_moderation_audit;
create trigger aegis_moderation_audit_immutable
before update or delete on public.guild_moderation_audit
for each row
execute function public.aegis_prevent_moderation_audit_mutation();

create or replace function public.aegis_redeem_guild_invite(
  p_code_hash text,
  p_member_id text
)
returns table (guild_id text)
language plpgsql
security invoker
as $$
declare
  v_guild_id text;
begin
  select invite.guild_id
    into v_guild_id
    from public.guild_invites as invite
   where invite.code_hash = p_code_hash
     and invite.revoked_at is null
     and invite.expires_at > now()
   for update;

  if v_guild_id is null then
    return;
  end if;

  if exists (
    select 1
      from public.guild_member_restrictions as restriction
     where restriction.guild_id = v_guild_id
       and restriction.member_id = p_member_id
       and restriction.kind = 'ban'
  ) then
    return;
  end if;

  insert into public.guild_members (guild_id, member_id)
  values (v_guild_id, p_member_id)
  on conflict (guild_id, member_id) do nothing;

  insert into public.guild_member_roles (guild_id, member_id, role_id)
  values (v_guild_id, p_member_id, 'member')
  on conflict (guild_id, member_id, role_id) do nothing;

  update public.guild_invites
     set use_count = use_count + 1
   where code_hash = p_code_hash;

  return query select v_guild_id;
end;
$$;

revoke all on function public.aegis_redeem_guild_invite(text, text)
  from public, anon, authenticated;
grant execute on function public.aegis_redeem_guild_invite(text, text) to service_role;

create or replace function public.aegis_search_messages(
  p_channel_ids text[],
  p_query text,
  p_limit integer default 50
)
returns setof public.messages
language sql
stable
security invoker
as $$
  select message.*
    from public.messages as message
   where message.channel_id = any(p_channel_ids)
     and char_length(p_query) between 2 and 100
     and strpos(lower(message.body), lower(p_query)) > 0
   order by message.created_at desc, message.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 50);
$$;

revoke all on function public.aegis_search_messages(text[], text, integer)
  from public, anon, authenticated;
grant execute on function public.aegis_search_messages(text[], text, integer) to service_role;

commit;
