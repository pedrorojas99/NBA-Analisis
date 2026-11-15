-- Revoke broad default privileges from public client roles.
-- Only the public NBA reference and boxscore tables receive read access.
revoke all privileges on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on table public.teams, public.games, public.game_results, public.players, public.player_game_stats, public.team_game_stats to anon, authenticated;
