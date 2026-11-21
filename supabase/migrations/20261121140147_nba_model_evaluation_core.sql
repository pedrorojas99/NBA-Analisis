create unique index if not exists uq_model_evaluations_version_window
on public.model_evaluations(model_version_id,evaluation_window_start,evaluation_window_end);

create or replace function public.record_nba_model_evaluations(p_window_days integer default 30)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_days integer := greatest(1, least(coalesce(p_window_days,30),90));
  v_end date := (now() at time zone 'America/New_York')::date;
  v_start date;
  v_inserted integer := 0;
begin
  v_start := v_end - (v_days - 1);
  with verified as (
    select p.model_version_id,p.prediction_type,p.id as prediction_id,
      (g.scheduled_start at time zone 'America/New_York')::date as game_date,
      e.error_metrics
    from public.predictions p
    join public.games g on g.id=p.game_id
    join public.prediction_evaluations e on e.prediction_id=p.id
    where p.prediction_type in ('game','player')
      and p.created_at < g.scheduled_start
      and p.feature_cutoff_at < g.scheduled_start
      and (g.scheduled_start at time zone 'America/New_York')::date between v_start and v_end
      and 'espn'=any(e.result_source_names)
  ),
  aggregated as (
    select model_version_id,prediction_type,count(*)::integer as sample_size,
      case when prediction_type='game' then jsonb_build_object(
        'prediction_type','game','verified_source','espn',
        'minimum_sample_size',30,'sample_gate_met',count(*)>=30,
        'comparison_status','awaiting_paired_baseline',
        'winner_accuracy',round(avg(case when error_metrics ? 'winner_correct' then case when (error_metrics->>'winner_correct')::boolean then 1.0 else 0.0 end end)::numeric,4),
        'home_score_mae',round(avg(nullif(error_metrics->>'home_score_abs_error','')::numeric),2),
        'away_score_mae',round(avg(nullif(error_metrics->>'away_score_abs_error','')::numeric),2),
        'total_score_mae',round(avg(nullif(error_metrics->>'total_score_abs_error','')::numeric),2),
        'margin_mae',round(avg(nullif(error_metrics->>'margin_abs_error','')::numeric),2),
        'brier_score',round(avg(nullif(error_metrics->>'brier_score','')::numeric),4)
      ) else jsonb_build_object(
        'prediction_type','player','verified_source','espn',
        'minimum_sample_size',30,'sample_gate_met',count(*)>=30,
        'comparison_status','awaiting_paired_baseline',
        'points_mae',round(avg(nullif(error_metrics->>'points_abs_error','')::numeric),2),
        'rebounds_mae',round(avg(nullif(error_metrics->>'rebounds_abs_error','')::numeric),2),
        'assists_mae',round(avg(nullif(error_metrics->>'assists_abs_error','')::numeric),2),
        'threes_mae',round(avg(nullif(error_metrics->>'threes_abs_error','')::numeric),2),
        'minutes_mae',round(avg(nullif(error_metrics->>'minutes_abs_error','')::numeric),2)
      ) end as metrics
    from verified
    group by model_version_id,prediction_type
  )
  insert into public.model_evaluations(
    model_version_id,evaluation_window_start,evaluation_window_end,
    sample_size,metrics,baseline_model_version_id,passed
  )
  select model_version_id,v_start,v_end,sample_size,metrics,null,false
  from aggregated
  on conflict (model_version_id,evaluation_window_start,evaluation_window_end) do nothing;
  get diagnostics v_inserted = row_count;
  return jsonb_build_object(
    'ok',true,'window_start',v_start,'window_end',v_end,
    'window_days',v_days,'evaluations_inserted',v_inserted,
    'promotion_policy','No model passes until a same-window paired baseline comparison is available.'
  );
end;
$function$;

insert into public.model_versions(version_name,feature_set_version,model_description,parameters,validation_metrics,status)
values (
 'player-impact-top2-0.3',
 'player-starter-features-0.2-error-feedback',
 'Blend de últimos 5 y 10 partidos con corrección limitada por sesgo individual calculado solo desde pronósticos anteriores evaluados contra boxscores finales ESPN verificados.',
 jsonb_build_object(
  'method','blend_last5_last10_60_40_with_verified_player_error_feedback',
  'min_games',3,'max_games',10,'team_player_limit',2,
  'ranking','projected_points_rebounds_assists_threes_minutes',
  'availability_gate','exclude_out_doubtful_questionable',
  'roster_source','ESPN boxscore player pool',
  'error_feedback',jsonb_build_object(
    'minimum_samples_per_player_stat',8,'shrinkage',0.35,
    'correction_caps',jsonb_build_object('points',3,'rebounds',1.5,'assists',1.5,'threes',1,'minutes',3),
    'source','prediction_evaluations with ESPN final boxscore'
  )
 ),
 jsonb_build_object('status','not_yet_validated','note','La corrección por errores es experimental; requiere al menos 30 evaluaciones y comparación pareada en la misma ventana antes de promoción.'),
 'experimental'
)
on conflict(version_name) do nothing;

select cron.alter_job(2, schedule := '5,20,35,50 * * * *');
select cron.alter_job(4, schedule := '10,25,40,55 * * * *');
select cron.alter_job(8, schedule := '7-59/10 * * * *');
select cron.schedule('nba-model-evaluation-daily','23 10 * * *',
  'select public.record_nba_model_evaluations(30);');
