-- Run once in Supabase SQL Editor. Existing screener/analyst tables are untouched.
create table if not exists public.stock_projections (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 ticker text not null, name text, scenario text not null default 'Base',
 assumptions jsonb not null default '{}'::jsonb,
 notes text not null default '', created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (user_id,ticker,scenario)
);
create table if not exists public.stock_holdings (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 ticker text not null, shares numeric not null check(shares >= 0),
 cost_basis numeric not null check(cost_basis >= 0),
 notes text not null default '', updated_at timestamptz not null default now(),
 unique(user_id,ticker)
);
alter table public.stock_projections enable row level security;
alter table public.stock_holdings enable row level security;
revoke all on public.stock_projections from anon;
revoke all on public.stock_holdings from anon;
grant select,insert,update,delete on public.stock_projections to authenticated;
grant select,insert,update,delete on public.stock_holdings to authenticated;
drop policy if exists projection_owner on public.stock_projections;
create policy projection_owner on public.stock_projections for all to authenticated
 using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
drop policy if exists holding_owner on public.stock_holdings;
create policy holding_owner on public.stock_holdings for all to authenticated
 using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create index if not exists projection_user_idx on public.stock_projections(user_id);
create index if not exists holding_user_idx on public.stock_holdings(user_id);
