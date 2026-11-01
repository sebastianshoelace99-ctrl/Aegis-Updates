-- ============================================================================
-- Aegis Shield · schema
--
-- Run this first, then 02-rls.sql, in the Supabase SQL editor.
-- There is no seed file: the app starts with no servers and creates its first one.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Global identities. A message author and a member-rail row are the same row.
-- ---------------------------------------------------------------------------
create table if not exists public.members (
  id          text primary key check (id ~ '^[A-Za-z0-9._-]{1,64}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  handle      text not null unique check (handle ~ '^[a-z][a-z0-9-]{0,31}$'),
  role        text not null default 'artist' check (role in ('artist', 'client', 'reviewer')),
  presence    text not null default 'offline' check (presence in ('online', 'idle', 'dnd', 'offline')),
  accent      smallint not null default 0 check (accent between 0 and 7),
  activity    text check (activity is null or char_length(activity) <= 120),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Servers
-- ---------------------------------------------------------------------------
create table if not exists public.guilds (
  id                  text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name                text not null check (char_length(btrim(name)) between 1 and 100),
  initial             text not null check (char_length(initial) between 1 and 2),
  accent              smallint not null default 0 check (accent between 0 and 7),
  description         text check (description is null or char_length(description) <= 160),
  notification_level  text not null default 'all' check (notification_level in ('all', 'mentions', 'none')),
  system_channel_id   text,
  icon                text check (
                        icon is null
                        or (
                          char_length(icon) <= 400000
                          and icon ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
                        )
                      ),
  owner_id            text not null references public.members (id) on delete restrict,
  created_at          timestamptz not null default now()
);

create index if not exists guilds_owner_idx on public.guilds (owner_id);

-- ---------------------------------------------------------------------------
-- Categories and channels
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id         text primary key,
  guild_id   text not null references public.guilds (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 64),
  position   integer not null default 0,
  unique (guild_id, id)
);

create index if not exists categories_guild_idx on public.categories (guild_id, position);

create table if not exists public.channels (
  id             text primary key,
  guild_id       text not null references public.guilds (id) on delete cascade,
  category_id    text not null,
  slug           text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  name           text not null check (char_length(btrim(name)) between 1 and 64),
  topic          text not null default '',
  kind           text not null default 'text' check (kind in ('text', 'media', 'voice')),
  commission_id  text,
  position       integer not null default 0,
  unique (guild_id, slug),
  constraint channels_category_fk
    foreign key (guild_id, category_id)
    references public.categories (guild_id, id)
    on delete cascade
);

create index if not exists channels_guild_idx on public.channels (guild_id, position);

-- The system channel is set after channels exist, so the FK is added here.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'guilds_system_channel_fk'
      and conrelid = 'public.guilds'::regclass
  ) then
    alter table public.guilds
      add constraint guilds_system_channel_fk
      foreign key (system_channel_id)
      references public.channels (id)
      on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Membership and roles
-- ---------------------------------------------------------------------------
create table if not exists public.guild_members (
  guild_id   text not null references public.guilds (id) on delete cascade,
  member_id  text not null references public.members (id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (guild_id, member_id)
);

create index if not exists guild_members_member_idx on public.guild_members (member_id);

create table if not exists public.guild_roles (
  id        text not null,
  guild_id  text not null references public.guilds (id) on delete cascade,
  name      text not null check (char_length(btrim(name)) between 1 and 32),
  color     smallint not null default 0 check (color between 0 and 15),
  hoist     boolean not null default true,
  position  integer not null default 0,
  primary key (guild_id, id)
);

create table if not exists public.guild_member_roles (
  guild_id   text not null,
  member_id  text not null,
  role_id    text not null,
  primary key (guild_id, member_id, role_id),
  foreign key (guild_id, member_id)
    references public.guild_members (guild_id, member_id) on delete cascade,
  foreign key (guild_id, role_id)
    references public.guild_roles (guild_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  channel_id   text not null references public.channels (id) on delete cascade,
  author_id    text not null references public.members (id) on delete cascade,
  body         text not null check (char_length(btrim(body)) between 1 and 4000),
  kind         text not null default 'user' check (kind in ('user', 'system')),
  attachments  jsonb not null default '[]'::jsonb,
  mentions     text[] not null default '{}',
  reply_to_id  uuid references public.messages (id) on delete set null,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz
);

-- The feed reads newest-first with a `(created_at, id)` cursor.
create index if not exists messages_channel_created_idx
  on public.messages (channel_id, created_at desc, id desc);

commit;

