-- Expose only public NBA reference and boxscore data as read-only.
-- Raw snapshots, ingestion logs, source mappings, predictions and model tables stay private.
grant usage on schema public to anon, authenticated;
grant select on table public.teams, public.games, public.game_results, public.players, public.player_game_stats, public.team_game_stats to anon, authenticated;

create policy "Public read teams" on public.teams for select to anon, authenticated using (true);
create policy "Public read games" on public.games for select to anon, authenticated using (true);
create policy "Public read game results" on public.game_results for select to anon, authenticated using (true);
create policy "Public read players" on public.players for select to anon, authenticated using (true);
create policy "Public read player game stats" on public.player_game_stats for select to anon, authenticated using (true);
create policy "Public read team game stats" on public.team_game_stats for select to anon, authenticated using (true);
