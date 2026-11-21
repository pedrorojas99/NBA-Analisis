-- Classify NBA teams and keep special-event records out of NBA app calculations.
alter table public.teams add column if not exists team_type text not null default 'nba';
do $$
begin
  if not exists (select 1 from pg_constraint where conname='teams_team_type_check' and conrelid='public.teams'::regclass) then
    alter table public.teams add constraint teams_team_type_check check (team_type in ('nba','special'));
  end if;
end $$;
update public.teams set team_type=case when abbreviation in ('LON','STARS','STRIPES','WORLD','TBD') then 'special' else 'nba' end;
update public.teams set abbreviation=case abbreviation when 'NY' then 'NYK' when 'NO' then 'NOP' when 'SA' then 'SAS' when 'UTAH' then 'UTA' when 'WSH' then 'WAS' else abbreviation end
where abbreviation in ('NY','NO','SA','UTAH','WSH');
alter table public.games add column if not exists is_special_event boolean not null default false;
update public.games g set is_special_event=(
 exists(select 1 from public.teams t where t.id=g.home_team_id and t.team_type='special')
 or exists(select 1 from public.teams t where t.id=g.away_team_id and t.team_type='special')
);
create index if not exists idx_teams_team_type_abbreviation on public.teams(team_type,abbreviation);
create index if not exists idx_games_regular_schedule on public.games(scheduled_start) where is_special_event=false;
update public.historical_backfill_jobs
set end_date=date '2025-06-30', next_date=date '2024-10-22', days_per_run=2,
    status='queued', last_error=null, completed_at=null, updated_at=now(),
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('coverage_extension',
      jsonb_build_object('reason','Restart complete 2024-25 normalization because no normalized games remain before 2025-07-01','resumed_from','2024-10-22','target_end','2025-06-30','special_event_records_preserved',true))
where id='7892813f-9ad2-4e7a-aed1-2013f3e7084e' and start_date=date '2024-10-22';
