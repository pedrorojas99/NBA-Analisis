# NBA Analytics data ingestion status

## Active pipeline (2026-11-15)

- Provider: ESPN public NBA Site API.
- Scoreboard function: `nba-scoreboard-sync` (schedule, game status, final scores).
- Boxscore function: `nba-boxscore-sync` (team and player boxscores).
- Supabase project: `sjzfrrwbirnaoqqgxblv`.
- Both functions are scheduled every 15 minutes with Supabase Cron (`pg_cron`) and `pg_net`.
- Boxscore collection checks in-progress and recently finished games (last 36 hours), limits a run to 30 games, and waits at least one second between ESPN summary requests.
- Completed games are skipped after both team and player boxscore rows exist. In-progress games can generate successive snapshots to preserve live stat changes.
- ESPN athlete IDs are mapped through `player_source_ids`; team IDs use `team_source_ids`.
- Raw scoreboard and boxscore payloads are retained in `raw_source_snapshots` and deduplicated by SHA-256 payload hash.
- Every run is recorded in `source_ingestion_runs`.
- Secrets: project URL and publishable key are stored in Supabase Vault. The server-side secret key is read only inside Edge Functions; no secret key is stored in GitHub or shipped in the Android app.
- Authentication: Edge gateway JWT verification is disabled for these scheduled service-to-service endpoints, but each function checks the exact publishable key in the `apikey` header before doing work. Database writes use the server-only secret key.

## Successful validations

### Scoreboard
Manual invocation through `pg_net` succeeded on 2026-11-15:
- ESPN HTTP 200
- 9 scoreboard events received
- 18 teams upserted
- 9 games saved
- 9 raw game snapshots saved
- No final results were present in that initial batch.

### Boxscores
Manual invocation through `pg_net` succeeded on 2026-11-15:
- ESPN summary endpoint returned a valid boxscore for the in-progress game.
- 1 game checked; 1 game had boxscore data.
- 2 team-stat rows saved.
- 22 player-stat rows saved in the second validation run (the first exploratory run also stored rows for inactive/DNP players; those empty stat rows were marked rejected).
- 1 raw boxscore snapshot saved per distinct payload hash.
- Example player fields include minutes, points, field goals, three-pointers, free throws, rebounds, assists, steals, blocks, turnovers, fouls, and plus/minus.

## Current verified database state (after validation)

- 18 teams
- 9 games
- 25 player records
- 44 accepted player-stat snapshots
- 4 team-stat snapshots
- 2 raw boxscore snapshots
- 2 active cron jobs, each scheduled every 15 minutes

Counts may increase as live games progress. The player/team stat JSON preserves ESPN labels and raw values; a later normalization step will convert numeric strings and shooting splits into typed analytics columns or validated derived views.

## Current limitations and next work

- The pipeline currently covers the current/recent scoreboard and boxscores; historical season backfill is not implemented.
- Player season averages, standings, injuries, lineups, and availability are not yet ingested.
- ESPN is the operational source. NBA.com previously returned HTTP 403 from GitHub Actions, so it is not currently a reliable second source.
- Supabase Free projects may pause after inactivity; scheduled jobs cannot run while the project is paused. No 24/7 guarantee is made.
- Public app read access is not enabled yet. RLS remains enabled with no public policies until we define a narrow read-only interface. No anonymous writes are allowed.
- Predictions, evaluation metrics, and model learning are not yet connected to this live-data pipeline.

## Security

- Never commit Supabase secret keys or database passwords.
- Never put the secret key in the Android APK.
- Only publishable keys may be used by public clients, with explicit read-only access policies.
- Keep raw payloads, ingestion logs, source-ID mappings, and internal model/prediction tables private unless a specific access requirement is designed and reviewed.
