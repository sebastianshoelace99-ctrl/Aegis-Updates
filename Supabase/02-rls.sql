-- ============================================================================
-- Aegis Shield - row level security
--
-- Run after 01-schema.sql.
--
-- The desktop app does NOT talk to Supabase directly. It calls the Node backend, which uses the
-- service-role key; that role bypasses RLS. The correct default is therefore: deny every direct
-- client, and let the backend be the only reader/writer.
--
-- If you later add Supabase Auth and point a client at the project directly, add per-guild
-- policies here (and grant the matching privileges). Do not start from `using (true)`: that
-- would let any signed-in account read every server.
-- ============================================================================

begin;

alter table public.members              enable row level security;
alter table public.guilds               enable row level security;
alter table public.categories           enable row level security;
alter table public.channels             enable row level security;
alter table public.guild_members        enable row level security;
alter table public.guild_roles          enable row level security;
alter table public.guild_member_roles   enable row level security;
alter table public.messages             enable row level security;

-- Belt and braces: remove the default table privileges as well. No policy exists below, so
-- `anon` and `authenticated` have no path to the data even if a grant is added by accident.
revoke all on all tables in schema public from anon, authenticated;

commit;
