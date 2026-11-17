create table if not exists public.team_roster (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id),
  player_id uuid not null references public.players(id),
  source_name text not null default 'espn',
  source_player_id text not null,
  headshot_url text,
  jersey text,
  position text,
  active boolean not null default true,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(team_id, player_id),
  unique(source_name, source_player_id, team_id)
);
create index if not exists idx_team_roster_team_active on public.team_roster(team_id, active);
create index if not exists idx_team_roster_player on public.team_roster(player_id);
alter table public.team_roster enable row level security;
revoke all on public.team_roster from anon, authenticated;

alter table public.team_roster
  add column if not exists career_games integer,
  add column if not exists career_points_avg numeric(6,2),
  add column if not exists career_rebounds_avg numeric(6,2),
  add column if not exists career_threes_avg numeric(6,2),
  add column if not exists career_stats_synced_at timestamptz;
