-- ======================================================================
-- Aegis Shield - server invites
--
-- Run after 01-schema.sql through 04-reactions.sql.
-- ======================================================================

begin;

create table if not exists public.guild_invites (
  id          uuid primary key default gen_random_uuid(),
  guild_id    text not null references public.guilds (id) on delete cascade,
  created_by  text not null references public.members (id) on delete cascade,
  code_hash   text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  use_count   bigint not null default 0 check (use_count >= 0)
);

create index if not exists guild_invites_guild_created_idx
  on public.guild_invites (guild_id, created_at desc);

alter table public.guild_invites enable row level security;
revoke all on table public.guild_invites from anon, authenticated;

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
  select i.guild_id
    into v_guild_id
    from public.guild_invites as i
   where i.code_hash = p_code_hash
     and i.revoked_at is null
     and i.expires_at > now()
   for update;

  if v_guild_id is null then
    return;
  end if;

  insert into public.guild_members (guild_id, member_id)
  values (v_guild_id, p_member_id)
  on conflict (guild_id, member_id) do nothing;

  update public.guild_invites
     set use_count = use_count + 1
   where code_hash = p_code_hash;

  return query select v_guild_id;
end;
$$;

revoke all on function public.aegis_redeem_guild_invite(text, text)
  from public, anon, authenticated;
grant execute on function public.aegis_redeem_guild_invite(text, text) to service_role;

commit;
