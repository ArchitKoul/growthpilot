-- Optional persistence for GrowthPilot investigation results.
-- Raw event data is never stored here.
create table if not exists public.investigations (
  id text primary key,
  question text not null,
  mode text not null check (mode in ('demo', 'live')),
  model text,
  dataset_id text not null,
  dataset_name text not null,
  answer_status text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists investigations_created_at_idx on public.investigations (created_at desc);

-- Only the server (service role) reads/writes. No anon access.
alter table public.investigations enable row level security;
