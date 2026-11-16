import { createClient } from "npm:@supabase/supabase-js@2";
const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const monthKey = (date: Date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
const normalizeAbbr = (value: unknown) => { const abbr = String(value ?? "").toUpperCase(); return abbr === "GS" ? "GSW" : abbr; };
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!SERVICE_KEY) return json({ ok: false, error: "Server database credentials are not configured" }, 500);
  const supabase = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const startedAt = new Date();
  const { data: run, error: runError } = await supabase.from("source_ingestion_runs")
    .insert({ source_name: "espn_schedule", started_at: startedAt.toISOString(), ok: false }).select("id").single();
  if (runError || !run) return json({ ok: false, error: "Could not start ingestion log", detail: runError?.message }, 500);

  try {
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const months = [...new Set([monthKey(todayUtc), monthKey(horizon)])];
    const teamsResponse = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=1000", {
      headers: { accept: "application/json", "user-agent": "NBA-Analytics/1.0 schedule-ingestion" }, signal: AbortSignal.timeout(20000),
    });
    if (!teamsResponse.ok) throw new Error(`ESPN teams HTTP ${teamsResponse.status}`);
    const teamsPayload = await teamsResponse.json();
    const sourceTeams = (teamsPayload.sports?.[0]?.leagues?.[0]?.teams ?? [])
      .map((entry: any) => entry.team)
      .filter((team: any) => team?.id && team?.abbreviation && team.isActive !== false && team.isAllStar !== true);
    if (sourceTeams.length !== 30) throw new Error(`Expected 30 active NBA teams, received ${sourceTeams.length}`);

    const savedTeams = await Promise.all(sourceTeams.map(async (team: any) => {
      const { data, error } = await supabase.from("teams").upsert({
        abbreviation: normalizeAbbr(team.abbreviation),
        display_name: String(team.displayName ?? team.name ?? team.abbreviation),
        city: team.location ?? null,
      }, { onConflict: "abbreviation" }).select("id,abbreviation").single();
      if (error || !data) throw new Error(`Team upsert failed: ${error?.message}`);
      return { ...data, sourceId: String(team.id) };
    }));
    const teamByAbbr = new Map(savedTeams.map((team: any) => [team.abbreviation, team]));

    const eventsById = new Map<string, any>();
    for (const month of months) {
      const url = new URL(BASE_URL);
      url.searchParams.set("dates", month);
      url.searchParams.set("limit", "500");
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "NBA-Analytics/1.0 schedule-ingestion" }, signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) throw new Error(`ESPN scoreboard ${month} HTTP ${response.status}`);
      const payload = await response.json();
      for (const event of (Array.isArray(payload.events) ? payload.events : [])) {
        if (event?.id) eventsById.set(String(event.id), { event, season: Number(payload.leagues?.[0]?.season?.year ?? new Date(event.date).getUTCFullYear()) });
      }
    }

    const candidates: any[] = [];
    let skipped = 0;
    for (const [sourceGameId, entry] of eventsById) {
      const event = entry.event;
      const start = Date.parse(event.date ?? "");
      if (!Number.isFinite(start) || start < todayUtc.getTime() || start > horizon.getTime() || event.status?.type?.state !== "pre") { skipped++; continue; }
      const competitors = event.competitions?.[0]?.competitors ?? [];
      const home = competitors.find((side: any) => side.homeAway === "home");
      const away = competitors.find((side: any) => side.homeAway === "away");
      if (!home?.team?.abbreviation || !away?.team?.abbreviation) { skipped++; continue; }
      const homeTeam = teamByAbbr.get(normalizeAbbr(home.team.abbreviation)) as any;
      const awayTeam = teamByAbbr.get(normalizeAbbr(away.team.abbreviation)) as any;
      if (!homeTeam || !awayTeam) { skipped++; continue; }
      candidates.push({
        sourceGameId, row: {
          season: entry.season, scheduled_start: new Date(start).toISOString(),
          home_team_id: homeTeam.id, away_team_id: awayTeam.id, status: "scheduled",
          status_detail: event.status?.type?.detail ?? "Scheduled",
          is_neutral_site: Boolean(event.competitions?.[0]?.neutralSite),
        },
      });
    }

    const existingIds = new Set<string>();
    for (const batch of chunks(candidates.map((item) => item.sourceGameId), 100)) {
      if (!batch.length) continue;
      const { data, error } = await supabase.from("game_source_ids").select("source_game_id")
        .eq("source_name", "espn").in("source_game_id", batch);
      if (error) throw new Error(`Existing schedule lookup failed: ${error.message}`);
      for (const row of data ?? []) existingIds.add(String(row.source_game_id));
    }
    const newCandidates = candidates.filter((item) => !existingIds.has(item.sourceGameId));
    let gamesSaved = 0;
    for (const batch of chunks(newCandidates, 100)) {
      if (!batch.length) continue;
      const { data: inserted, error } = await supabase.from("games")
        .insert(batch.map((item) => item.row))
        .select("id,scheduled_start,home_team_id,away_team_id");
      if (error || !inserted) throw new Error(`Bulk schedule insert failed: ${error?.message}`);
      const key = (row: any) => [row.scheduled_start, row.home_team_id, row.away_team_id].join("|");
      const sourceByKey = new Map(batch.map((item) => [key(item.row), item.sourceGameId]));
      const mappings = inserted.map((game: any) => ({
        source_name: "espn", source_game_id: sourceByKey.get(key(game)), game_id: game.id,
      })).filter((mapping: any) => mapping.source_game_id);
      const { error: mappingError } = await supabase.from("game_source_ids").insert(mappings);
      if (mappingError) throw new Error(`Bulk game mapping insert failed: ${mappingError.message}`);
      gamesSaved += inserted.length;
    }

    const finishedAt = new Date().toISOString();
    const metadata = { months_requested: months, events_seen: eventsById.size, candidates_in_horizon: candidates.length,
      upcoming_games_inserted: gamesSaved, existing_games_skipped: candidates.length - gamesSaved, skipped };
    const { error: finishError } = await supabase.from("source_ingestion_runs").update({
      finished_at: finishedAt, ok: true, http_status: 200, records_seen: eventsById.size, metadata,
    }).eq("id", run.id);
    if (finishError) throw new Error(`Ingestion completion log failed: ${finishError.message}`);
    return json({ ok: true, source: "ESPN", ...metadata, horizon_days: 14,
      note: "Only upcoming pre-game fixtures are inserted; live and final game states are never overwritten." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from("source_ingestion_runs").update({ finished_at: new Date().toISOString(), ok: false, error_message: message }).eq("id", run.id);
    return json({ ok: false, error: message }, 502);
  }
});
