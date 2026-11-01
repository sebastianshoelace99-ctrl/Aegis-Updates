-- ============================================================================
-- Aegis Shield - owner-authorized server deletion
--
-- The backend calls this function with the identity from the verified session.
-- Direct client roles cannot execute it; the function also verifies ownership
-- in the same transaction that deletes the server and its cascading data.
-- ============================================================================

begin;

create or replace function public.aegis_delete_guild(
  p_guild_id text,
  p_member_id text
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  server_owner_id text;
begin
  select guild.owner_id
    into server_owner_id
    from public.guilds as guild
   where guild.id = p_guild_id
   for update;

  if not found then
    return 'not_found';
  end if;

  if server_owner_id is distinct from p_member_id then
    return 'forbidden';
  end if;

  delete from public.guilds
   where id = p_guild_id
     and owner_id = p_member_id;

  if not found then
    return 'forbidden';
  end if;

  return 'deleted';
end;
$$;

revoke all on function public.aegis_delete_guild(text, text)
  from public, anon, authenticated;
grant execute on function public.aegis_delete_guild(text, text) to service_role;

commit;
