create table if not exists public.historical_backfill_jobs (
  id uuid primary key default gen_random_uuid(),
  source_name text not null default 'espn',
  start_date date not null,
  end_date date not null,
  next_date date not null,
  days_per_run integer not null default 3 check (days_per_run between 1 and 7),
  status text not null default 'queued' check (status in ('queued','running','completed','failed','paused')),
  metadata jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (end_date >= start_date),
  check (next_date >= start_date and next_date <= end_date + 1)
);
create index if not exists idx_historical_backfill_jobs_status
  on public.historical_backfill_jobs(status, updated_at);
alter table public.historical_backfill_jobs enable row level security;
revoke all on public.historical_backfill_jobs from anon, authenticated;
