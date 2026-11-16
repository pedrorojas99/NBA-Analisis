-- Chronological stability check for NBA score-model candidates.
-- Read-only walk-forward backtest. Each game's features use only earlier games.
-- Results are split into three chronological blocks (not random folds).

with final_games as (
  select g.id, g.scheduled_start, g.home_team_id, g.away_team_id,
         gr.home_score::numeric as home_score,
         gr.away_score::numeric as away_score,
         g.is_neutral_site
  from public.games g
  join public.game_results gr on gr.game_id = g.id
  where gr.is_final = true and gr.home_score <> gr.away_score
),
team_games as (
  select id as game_id, scheduled_start, home_team_id as team_id,
         home_score as points_for, away_score as points_against
  from final_games
  union all
  select id, scheduled_start, away_team_id,
         away_score, home_score
  from final_games
),
rolling as (
  select *,
    count(*) over w_all as prior_games,
    avg(points_for) over w_all as hist_for,
    avg(points_against) over w_all as hist_against,
    count(*) over w10 as recent_games,
    avg(points_for) over w10 as recent_for,
    avg(points_against) over w10 as recent_against
  from team_games
  window
    w_all as (partition by team_id order by scheduled_start, game_id
              rows between unbounded preceding and 1 preceding),
    w10 as (partition by team_id order by scheduled_start, game_id
            rows between 10 preceding and 1 preceding)
),
eligible as (
  select g.*,
    h.prior_games as home_prior, a.prior_games as away_prior,
    h.recent_games as home_recent, a.recent_games as away_recent,
    h.hist_for as home_hist_for, h.hist_against as home_hist_against,
    a.hist_for as away_hist_for, a.hist_against as away_hist_against,
    h.recent_for as home_recent_for, h.recent_against as home_recent_against,
    a.recent_for as away_recent_for, a.recent_against as away_recent_against
  from final_games g
  join rolling h on h.game_id = g.id and h.team_id = g.home_team_id
  join rolling a on a.game_id = g.id and a.team_id = g.away_team_id
  where h.prior_games >= 5 and a.prior_games >= 5
    and h.recent_games >= 5 and a.recent_games >= 5
),
segmented as (
  select *, ntile(3) over (order by scheduled_start, id) as time_block
  from eligible
),
variants as (
  select 'last10'::text as model, time_block,
    (home_recent_for + away_recent_against) / 2
      + case when is_neutral_site then 0 else 2 end as predicted_home,
    (away_recent_for + home_recent_against) / 2 as predicted_away,
    home_score, away_score
  from segmented
  union all
  select 'blend_50_50', time_block,
    ((home_recent_for + home_hist_for) / 2
      + (away_recent_against + away_hist_against) / 2) / 2
      + case when is_neutral_site then 0 else 2 end,
    ((away_recent_for + away_hist_for) / 2
      + (home_recent_against + home_hist_against) / 2) / 2,
    home_score, away_score
  from segmented
  union all
  select 'historical_only', time_block,
    (home_hist_for + away_hist_against) / 2
      + case when is_neutral_site then 0 else 2 end,
    (away_hist_for + home_hist_against) / 2,
    home_score, away_score
  from segmented
),
scored as (
  select *, 1.0 / (1.0 + exp(-((predicted_home - predicted_away) / 7.5))) as p_home
  from variants
)
select
  model,
  time_block,
  min(case time_block when 1 then 'earliest third' when 2 then 'middle third' else 'latest third' end) as period,
  count(*) as test_games,
  round(100.0 * avg(case when (p_home >= 0.5) = (home_score > away_score) then 1 else 0 end), 2) as winner_accuracy_pct,
  round(avg(abs(predicted_home - home_score)), 2) as home_score_mae,
  round(avg(abs(predicted_away - away_score)), 2) as away_score_mae,
  round(avg(abs((predicted_home + predicted_away) - (home_score + away_score))), 2) as total_score_mae,
  round(avg(abs((predicted_home - predicted_away) - (home_score - away_score))), 2) as margin_mae,
  round(avg(power(p_home - case when home_score > away_score then 1 else 0 end, 2)), 4) as brier_score
from scored
group by model, time_block
order by time_block, model;
