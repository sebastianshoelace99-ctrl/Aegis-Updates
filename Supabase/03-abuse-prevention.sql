-- ============================================================================
-- Aegis Shield - abuse prevention
--
-- Run after 01-schema.sql and 02-rls.sql.
--
-- Only needed when the backend runs as more than one instance
-- (AEGIS_RATE_LIMIT_STORE=postgres). With a single process the in-memory store is
-- exact; with two processes behind a load balancer, two in-memory stores are two
-- independent budgets, and a client gets one per instance.
--
-- Why the refill lives here and not in Node: read-modify-write across two
-- instances is a race. `insert ... on conflict do update ... returning` is one
-- statement, so the row lock serialises checkers instead of letting them
-- interleave. The arithmetic is the same token bucket as server/rateLimit.ts.
--
-- The table holds no identity: keys are `acct:<bucket>:<id>` or `ip:<bucket>:<addr>`
-- and nothing else is stored, so this is not a profile of anyone.
-- ============================================================================

begin;

create table if not exists public.rate_limit_buckets (
  key         text primary key check (char_length(key) between 1 and 200),
  tokens      double precision not null check (tokens >= 0),
  updated_at  timestamptz not null
);

-- The sweep below deletes by age, so the index is on age.
create index if not exists rate_limit_buckets_age_idx
  on public.rate_limit_buckets (updated_at);

-- ---------------------------------------------------------------------------
-- One atomic check. Returns exactly one row.
--
--   p_capacity        bucket size (the burst)
--   p_refill_per_ms   tokens per millisecond (perMinute / 60000)
--   p_cost            tokens this request spends
--   p_now             caller's clock, so a skewed node cannot mint tokens
-- ---------------------------------------------------------------------------
create or replace function public.aegis_rate_limit_consume(
  p_key text,
  p_capacity double precision,
  p_refill_per_ms double precision,
  p_cost double precision,
  p_now timestamptz
)
returns table (allowed boolean, remaining double precision, retry_after_ms double precision)
language plpgsql
as $$
declare
  v_capacity double precision := greatest(coalesce(p_capacity, 1), 1);
  -- Floored: a zero rate would divide by zero when computing the wait.
  v_rate     double precision := greatest(coalesce(p_refill_per_ms, 0.0001), 0.000001);
  v_cost     double precision := greatest(coalesce(p_cost, 1), 0);
  v_tokens   double precision;
begin
  if p_key is null or char_length(p_key) = 0 then
    raise exception 'p_key is required';
  end if;

  insert into public.rate_limit_buckets as b (key, tokens, updated_at)
  values (p_key, v_capacity, p_now)
  on conflict (key) do update
    set tokens = least(
          v_capacity,
          -- `greatest(0, ...)` so a clock that moves backwards cannot mint tokens.
          b.tokens
            + greatest(0, extract(epoch from (p_now - b.updated_at))) * 1000 * v_rate
        ),
        updated_at = p_now
  returning b.tokens into v_tokens;

  if v_tokens >= v_cost then
    update public.rate_limit_buckets set tokens = v_tokens - v_cost where key = p_key;
    return query select true, floor(v_tokens - v_cost), 0::double precision;
  else
    return query
      select false,
             0::double precision,
             -- At least 1 ms: a Retry-After of zero invites an immediate retry storm.
             greatest(1::double precision, ceil((v_cost - v_tokens) / v_rate));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Housekeeping. Call from a scheduled job (pg_cron) or by hand; a stale bucket
-- is harmless (it is full after any real idle period), so this is about table
-- size, not correctness.
-- ---------------------------------------------------------------------------
create or replace function public.aegis_rate_limit_sweep(p_idle interval default interval '1 day')
returns integer
language plpgsql
as $$
declare
  v_deleted integer;
begin
  delete from public.rate_limit_buckets where updated_at < now() - p_idle;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: only the backend's service role may touch these, and RLS is on as
-- a second lock so a stray grant cannot expose the table.
-- ---------------------------------------------------------------------------
alter table public.rate_limit_buckets enable row level security;

revoke all on table public.rate_limit_buckets from anon, authenticated;
revoke all on function public.aegis_rate_limit_consume(
  text, double precision, double precision, double precision, timestamptz
) from public, anon, authenticated;
revoke all on function public.aegis_rate_limit_sweep(interval) from public, anon, authenticated;

-- PostgREST calls these as the service role, which owns them in a default project.
-- If execution fails with 42501, grant explicitly to that role:
--   grant execute on function public.aegis_rate_limit_consume(
--     text, double precision, double precision, double precision, timestamptz
--   ) to service_role;

commit;
