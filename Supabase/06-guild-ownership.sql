-- ============================================================================
-- Aegis Shield - immutable server ownership
--
-- guilds.owner_id records the member who created the server. Repair the owner
-- membership/role from that recorded identity, then prevent owner transfers and
-- assignments of the reserved owner role to anyone else.
-- ============================================================================

begin;

insert into public.guild_members (guild_id, member_id)
select g.id, g.owner_id
from public.guilds as g
on conflict (guild_id, member_id) do nothing;

insert into public.guild_roles (guild_id, id, name, color, hoist, position)
select g.id, 'owner', 'Owner', g.accent, true, 2
from public.guilds as g
on conflict (guild_id, id) do nothing;

delete from public.guild_member_roles as assignment
using public.guilds as guild
where assignment.guild_id = guild.id
  and assignment.role_id = 'owner'
  and assignment.member_id <> guild.owner_id;

insert into public.guild_member_roles (guild_id, member_id, role_id)
select guild.id, guild.owner_id, 'owner'
from public.guilds as guild
on conflict (guild_id, member_id, role_id) do nothing;

create or replace function public.aegis_prevent_guild_owner_change()
returns trigger
language plpgsql
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'Server ownership is assigned to its creator and cannot be transferred.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists aegis_guild_owner_immutable on public.guilds;
create trigger aegis_guild_owner_immutable
before update of owner_id on public.guilds
for each row
execute function public.aegis_prevent_guild_owner_change();

create or replace function public.aegis_guard_owner_role_assignment()
returns trigger
language plpgsql
as $$
declare
  server_owner_id text;
begin
  if new.role_id <> 'owner' then
    return new;
  end if;

  select guild.owner_id
    into server_owner_id
    from public.guilds as guild
   where guild.id = new.guild_id;

  if not found then
    raise exception 'Cannot assign a role for an unknown server.'
      using errcode = '23503';
  end if;

  if new.member_id is distinct from server_owner_id then
    raise exception 'Only the server creator can be assigned the owner role.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists aegis_owner_role_assignment_guard on public.guild_member_roles;
create trigger aegis_owner_role_assignment_guard
before insert or update on public.guild_member_roles
for each row
execute function public.aegis_guard_owner_role_assignment();

commit;
