-- ============================================================================
-- Aegis Shield - reactions
--
-- Run after 01-schema.sql. Additive and re-runnable: an existing database gains the
-- column without touching a row, and running it twice is a no-op.
--
-- Why the set lives on the message row instead of a `message_reactions` table:
-- the feed already reads a whole message and renders it whole, the set is small
-- and bounded, and a second table would need its own index, its own policy and a
-- second round trip on every page. The cost is that a toggle rewrites the row -
-- but that is one UPDATE by primary key, so a single-row lock, not a scan. If
-- reactions ever need to be queried per member ("everything I reacted to"), the
-- join table becomes the right shape and this column becomes a projection.
--
-- `burst` is Discord's Nitro-only "super reaction". Nothing in this schema, and
-- nothing in server/app.ts, gates it: every account gets it.
-- ============================================================================

begin;

alter table public.messages
  add column if not exists reactions jsonb not null default '[]'::jsonb;

-- The backend validates the array before it writes, but the database should not
-- accept a scalar or a runaway list from anything that is not the backend.
alter table public.messages
  drop constraint if exists messages_reactions_shape;

alter table public.messages
  add constraint messages_reactions_shape
  check (jsonb_typeof(reactions) = 'array' and jsonb_array_length(reactions) <= 20);

commit;
