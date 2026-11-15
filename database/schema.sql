-- NBA Analytics canonical Postgres schema (portable; intended for Supabase/Postgres).
-- Raw provider payloads and snapshots are append-only so corrections remain auditable.
create extension if not exists pgcrypto;
create table if not exists source_ingestion_runs (
 id uuid primary key default gen_random_uuid(), source_name text not null,
 started_at timestamptz not null default now(), finished_at timestamptz,
 ok boolean not null default false, http_status integer,
 records_seen integer not null default 0, error_message text,
 metadata jsonb not null default '{}'::jsonb
);
create table if not exists teams (
 id uuid primary key default gen_random_uuid(), abbreviation text not null unique,
 display_name text not null, city text, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists team_source_ids (
 source_name text not null, source_team_id text not null,
 team_id uuid not null references teams(id),
 primary key(source_name,source_team_id), unique(source_name,team_id)
);
create table if not exists players (
 id uuid primary key default gen_random_uuid(), display_name text not null,
 position text, active boolean, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists player_source_ids (
 source_name text not null, source_player_id text not null,
 player_id uuid not null references players(id),
 primary key(source_name,source_player_id), unique(source_name,player_id)
);
create table if not exists games (
 id uuid primary key default gen_random_uuid(), season integer not null,
 scheduled_start timestamptz not null,
 home_team_id uuid not null references teams(id),
 away_team_id uuid not null references teams(id),
 status text not null default 'scheduled', status_detail text,
 is_neutral_site boolean not null default false,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(home_team_id <> away_team_id)
);
create index if not exists idx_games_scheduled_start on games(scheduled_start);
create index if not exists idx_games_status_start on games(status,scheduled_start);
create table if not exists game_source_ids (
 source_name text not null, source_game_id text not null,
 game_id uuid not null references games(id),
 primary key(source_name,source_game_id), unique(source_name,game_id)
);
create table if not exists raw_source_snapshots (
 id uuid primary key default gen_random_uuid(), run_id uuid references source_ingestion_runs(id),
 source_name text not null, entity_type text not null, source_entity_id text,
 captured_at timestamptz not null default now(), payload_sha256 text not null,
 payload jsonb not null,
 unique(source_name,entity_type,source_entity_id,payload_sha256)
);
create index if not exists idx_raw_snapshots_entity_time
 on raw_source_snapshots(source_name,entity_type,source_entity_id,captured_at desc);
create table if not exists team_game_stats (
 id uuid primary key default gen_random_uuid(), game_id uuid not null references games(id),
 team_id uuid not null references teams(id), source_name text not null,
 captured_at timestamptz not null default now(), stats jsonb not null,
 validation_status text not null default 'pending',
 unique(game_id,team_id,source_name,captured_at)
);
create table if not exists player_game_stats (
 id uuid primary key default gen_random_uuid(), game_id uuid not null references games(id),
 player_id uuid not null references players(id), team_id uuid not null references teams(id),
 source_name text not null, captured_at timestamptz not null default now(),
 stats jsonb not null, validation_status text not null default 'pending',
 unique(game_id,player_id,source_name,captured_at)
);
create table if not exists game_results (
 game_id uuid primary key references games(id), home_score integer not null,
 away_score integer not null, confirmed_at timestamptz not null default now(),
 confirmation_sources text[] not null, is_final boolean not null default false,
 check(home_score >= 0 and away_score >= 0)
);
create table if not exists model_versions (
 id uuid primary key default gen_random_uuid(), version_name text not null unique,
 created_at timestamptz not null default now(), feature_set_version text not null,
 model_description text, parameters jsonb not null default '{}'::jsonb,
 validation_metrics jsonb not null default '{}'::jsonb,
 status text not null default 'experimental'
);
create table if not exists predictions (
 id uuid primary key default gen_random_uuid(), game_id uuid not null references games(id),
 model_version_id uuid not null references model_versions(id),
 created_at timestamptz not null default now(), feature_cutoff_at timestamptz not null,
 prediction_type text not null, target_key text not null, forecast jsonb not null,
 input_snapshot_sha256 text not null,
 unique(game_id,model_version_id,prediction_type,target_key)
);
create index if not exists idx_predictions_game on predictions(game_id,created_at);
create index if not exists idx_predictions_model on predictions(model_version_id,created_at);
create table if not exists prediction_evaluations (
 id uuid primary key default gen_random_uuid(), prediction_id uuid not null references predictions(id),
 evaluated_at timestamptz not null default now(), actual jsonb not null,
 error_metrics jsonb not null, result_source_names text[] not null,
 unique(prediction_id,evaluated_at)
);
create table if not exists model_evaluations (
 id uuid primary key default gen_random_uuid(), model_version_id uuid not null references model_versions(id),
 evaluated_at timestamptz not null default now(), evaluation_window_start date not null,
 evaluation_window_end date not null, sample_size integer not null, metrics jsonb not null,
 baseline_model_version_id uuid references model_versions(id), passed boolean not null,
 check(evaluation_window_end >= evaluation_window_start), check(sample_size >= 0)
);
create or replace function prevent_prediction_mutation()
returns trigger language plpgsql as $$
begin
 raise exception 'Prediction snapshots are immutable; insert a new prediction instead.';
end;
$$;
drop trigger if exists predictions_immutable_update on predictions;
create trigger predictions_immutable_update
before update or delete on predictions
for each row execute function prevent_prediction_mutation();
