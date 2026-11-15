# NBA Analytics data pipeline

## Current milestone: source verification

The repository contains a source-health probe, not a production ingestion service.
It checks ESPN's public scoreboard endpoint and the NBA.com live scoreboard endpoint,
records HTTP availability, normalizes ESPN game status/score fields, and saves raw JSON
as a GitHub Actions artifact for 14 days.

The probe is non-destructive. It does not bypass upstream access controls, does not
treat missing data as zero, and does not claim an artifact is a permanent database.

## Data-source policy

1. ESPN is the initial operational source for schedule, game IDs, live/final status,
   scores, and event summaries/box scores after endpoint verification.
2. NBA.com is the independent comparison source when its public endpoint is reachable.
3. Every observation carries source name, source ID, capture time, and raw payload hash.
4. Conflicting values are marked for review; do not silently choose or average them.
5. A game is final only when upstream status is final and the final score is valid.
6. Provider IDs map to canonical team/player/game IDs; names alone are not keys.

These public endpoints are unofficial and may change or deny access. Do not evade a
403, CAPTCHA, rate limit, or other access control. Record the failure and keep the
other source's status visible.

## Persistence target

The file database/schema.sql is a portable PostgreSQL schema for persistent storage.
It separates ingestion runs and raw source snapshots; canonical teams, players and
games with provider ID maps; append-only team/player stat observations; confirmed
game results; immutable pre-game predictions; prediction evaluations and model
evaluations.

The schema is designed for Supabase Postgres but uses standard PostgreSQL with pgcrypto.
No database credentials belong in this repository or in the APK.

## Why the first probe is not yet production real-time

GitHub Actions scheduled runs are best-effort and can be delayed. The current probe
runs every 15 minutes and stores short-lived artifacts only. It measures endpoint
reliability and payload shape. Production ingestion needs a persistent database and
a server-side secret. The app must never contain a database secret key.

Supabase Free currently includes a 500 MB database but can pause projects after a week
of low activity. Check current limits before relying on it for continuous operation.
