# NBA Analytics data ingestion status

## Active pipeline (2026-11-15)

- Provider: ESPN public NBA scoreboard endpoint.
- Supabase Edge Function: `nba-scoreboard-sync`.
- Supabase project: `sjzfrrwbirnaoqqgxblv`.
- Schedule: every 15 minutes using Supabase Cron (`pg_cron`) and `pg_net`.
- Secrets: project URL and publishable key are stored in Supabase Vault. The function reads the server-side secret key from the Edge Function environment; no secret key is stored in GitHub or shipped in the Android app.
- Authentication: Edge gateway JWT verification is disabled for this scheduled service-to-service endpoint, but the function checks the exact publishable key in the `apikey` header before doing work. Database writes use the server-only secret key.
- Idempotency: ESPN game IDs are mapped in `game_source_ids`; raw event snapshots are deduplicated by SHA-256 payload hash.
- Audit: every run is recorded in `source_ingestion_runs`.

## First successful validation

Manual invocation through `pg_net` succeeded on 2026-11-15:
- ESPN HTTP 200
- 9 scoreboard events received
- 18 teams upserted
- 9 games saved
- 9 raw source snapshots saved
- 0 final results at that moment (the returned games were not final)

## Current limitations

- This stage ingests schedule/status and final game scores only.
- Player boxscore statistics, team boxscore statistics, injuries, lineups, and historical backfill are not implemented yet.
- ESPN is the operational source. NBA.com previously returned HTTP 403 from GitHub Actions, so it is not currently a reliable second source.
- Cron runs every 15 minutes while the Supabase project is active. Supabase Free projects may pause after inactivity; scheduled jobs cannot run while the project is paused.
- Predictions and model learning are not yet connected to this pipeline.

## Security

- Never commit Supabase secret keys or database passwords.
- Never put the secret key in the Android APK.
- Only publishable keys may be used by public clients, with RLS and explicit policies.
