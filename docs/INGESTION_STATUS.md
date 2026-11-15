# NBA Analytics data ingestion status

## Active pipeline (2026-11-15)

- Provider: ESPN public NBA Site API.
- Scoreboard function: `nba-scoreboard-sync` (schedule, game status, final scores).
- Boxscore function: `nba-boxscore-sync` (team and player boxscores).
- Historical backfill function: `nba-historical-backfill` (resumable daily scoreboard, final results, compact raw boxscore snapshots, team stats, and player stats for completed games).
- Mobile read API: `nba-public-data` (allowlisted read-only response for games, teams, live scores, and final results).
- Supabase project: `sjzfrrwbirnaoqqgxblv`.
- Live scoreboard and boxscore functions are scheduled every 15 minutes with Supabase Cron (`pg_cron`) and `pg_net`.
- Historical backfill uses a private cursor table (`historical_backfill_jobs`) and a separate 15-minute cron worker. It processes up to 7 dates per run, resumes from `next_date`, and recovers jobs left `running` for more than 20 minutes.
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

## Current verified database state (2026-11-15, during historical backfill)

- 30 canonical NBA teams (duplicate ESPN alias `GS` normalized to canonical `GSW`)
- 61 games currently stored
- 53 final game results currently stored
- 368 player records
- 447 player-game stat rows currently stored (repair pass is still running)
- 110 team-game stat rows
- 3 active cron jobs: live scoreboard, live boxscores, and historical backfill

Counts may increase as the historical job advances. Current live data and historical data are stored in the same normalized tables, with ESPN IDs mapped separately.

## Historical backfill progress

- Target window: 2024-10-22 through 2026-06-30 (2024-25 and 2025-26 seasons).
- The first 7-day batch successfully processed 52 completed games: 52 final results, 52 boxscore snapshots, and 104 team-stat rows; no ESPN summary issues were reported.
- The first pass exposed a player filter bug: ESPN's `reason` field can be populated even when the player participated. The filter was corrected in backfill function version 6.
- A repair pass is reprocessing the first 7 dates to fill missing player-game stats. It has already raised the table count from 70 to 447 across 368 player records; completion is still being verified.
- The main historical job is paused at 2024-10-29 until the repair pass finishes, then the 2024-25 / 2025-26 main backfill will resume automatically.
- Each boxscore snapshot stores the compact game header and boxscore rather than full play-by-play, limiting storage growth on the Supabase Free tier.

## Current limitations and next work

- Historical backfill is implemented and underway for the 2024-25 and 2025-26 seasons; remaining dates continue through the resumable cron job.
- Player season averages, standings, injuries, lineups, and availability are not yet ingested.
- ESPN is the operational source. NBA.com previously returned HTTP 403 from GitHub Actions, so it is not currently a reliable second source.
- Supabase Free projects may pause after inactivity; scheduled jobs cannot run while the project is paused. No 24/7 guarantee is made.
- Public app read access is limited to SELECT policies on teams, games, game_results, players, player_game_stats, and team_game_stats. No anonymous writes are allowed. Raw snapshots, ingestion logs, source mappings, predictions, and model evaluation tables remain private.
- The Android app calls the `nba-public-data` Edge Function using only the publishable key. The function uses the server-side secret internally and returns only an allowlisted set of fields.
- Predictions, evaluation metrics, and model learning are not yet connected to this live-data pipeline.
- The Android app now has a cloud scoreboard screen wired to `nba-public-data`; the APK build is being validated by GitHub Actions.

## Security

- Never commit Supabase secret keys or database passwords.
- Never put the secret key in the Android APK.
- Only publishable keys may be used by public clients, with explicit read-only access policies.
- Keep raw payloads, ingestion logs, source-ID mappings, and internal model/prediction tables private unless a specific access requirement is designed and reviewed.
