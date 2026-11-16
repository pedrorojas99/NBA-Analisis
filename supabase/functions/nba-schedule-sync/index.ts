import { createClient } from "npm:@supabase/supabase-js@2";

const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const monthKey = (date: Date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
const normalizeAbbr = (value: unknown) => {
  const abbr = String(value ?? "").toUpperCase();
  return abbr === "GS" ? "GSW" : abbr;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  if (!SERVICE_KEY) return json({ ok: false, error: "Server database credentials are not configured" }, 500);

  const supabase = createClient(PROJECT_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const startedAt = new Date();
  const { data: run, error: runError } = await supabase.from("source_ingestion_runs")
    .insert({ source_name: "espn_schedule", started_at: startedAt.toISOString(), ok: false })
    .select("id").single();
  if (runError || !run) return json({ ok: false, error: "Could not start ingestion log", detail: runError?.message }, 500);

  try {
    const teamsResponse = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=1000", {
      headers: { accept: "application/json", "user-agent": "NBA-Analytics/1.0 schedule-ingestion" },
      signal: AbortSignal.timeout(20000),
    });
    if (!teamsResponse.ok) throw new Error(`ESPN teams HTTP ${teamsResponse.status}`);
    const teamsPayload = await teamsResponse.json();
    const sourceTeams = teamsPayload.sports?.[0]?.leagues?.[0]?.teams ?? [];
    let teamsSaved = 0;
    for (const entry of sourceTeams) {
      const team = entry.team;
      if (!team?.id || !team?.abbreviation || team.isActive === false || team.isAllStar === true) continue;
      const { data, error } = await supabase.from("teams").upsert({
        abbreviation: normalizeAbbr(team.abbreviation),
        display_name: String(team.displayName ?? team.name ?? team.abbreviation),
        city: team.location ?? null,
      }, { onConflict: "abbreviation" }).select("id").single();
      if (error || !data) throw new Error(`Team upsert failed: ${error?.message}`);
      const { error: mapError } = await supabase.from("team_source_ids").upsert({
        source_name: "espn", source_team_id: String(team.id), team_id: data.id,
      }, { onConflict: "source_name,source_team_id" });
      if (mapError) throw new Error(`Team mapping failed: ${mapError.message}`);
      teamsSaved++;
    }
    if (teamsSaved !== 30) throw new Error(`Expected 30 active NBA teams, received ${teamsSaved}`);

    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const months = [monthKey(todayUtc), monthKey(new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth() + 1, 1)))];
    const eventsById = new Map<string, any>();
    for (const month of months) {
      const url = new URL(BASE_URL);
      url.searchParams.set("dates", month);
      url.searchParams.set("limit", "500");
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "NBA-Analytics/1.0 schedule-ingestion" },
        signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) throw new Error(`ESPN scoreboard ${month} HTTP ${response.status}`);
      const payload = await response.json();
      for (const event of (Array.isArray(payload.events) ? payload.events : [])) {
        if (event?.id) eventsById.set(String(event.id), { event, season: Number(payload.leagues?.[0]?.season?.year ?? new Date(event.date).getUTCFullYear()) });
      }
    }

    let eventsSeen = 0, upcomingGamesSaved = 0, existingGamesUpdated = 0, skipped = 0;
    for (const [sourceGameId, entry] of eventsById) {
      eventsSeen++;
      const event = entry.event;
      if (!event.date || Date.parse(event.date) < todayUtc.getTime() || event.status?.type?.state !== "pre") { skipped++; continue; }
      const competition = event.competitions?.[0];
      const competitors = competition?.competitors ?? [];
      const home = competitors.find((side: any) => side.homeAway === "home");
      const away = competitors.find((side: any) => side.homeAway === "away");
      if (!home?.team?.abbreviation || !away?.team?.abbreviation) { skipped++; continue; }

      const teamRows: any[] = [];
      for (const side of [home, away]) {
        const sourceTeam = side.team;
        const { data, error } = await supabase.from("teams").upsert({
          abbreviation: normalizeAbbr(sourceTeam.abbreviation),
          display_name: String(sourceTeam.displayName ?? sourceTeam.name ?? sourceTeam.abbreviation),
          city: sourceTeam.location ?? null,
        }, { onConflict: "abbreviation" }).select("id,abbreviation").single();
        if (error || !data) throw new Error(`Event team upsert failed: ${error?.message}`);
        teamRows.push({ ...data, sourceId: String(sourceTeam.id ?? sourceTeam.abbreviation) });
      }
      const homeTeam = teamRows.find((team) => team.abbreviation === normalizeAbbr(home.team.abbreviation));
      const awayTeam = teamRows.find((team) => team.abbreviation === normalizeAbbr(away.team.abbreviation));
      if (!homeTeam || !awayTeam) { skipped++; continue; }
      for (const team of teamRows) {
        const { error } = await supabase.from("team_source_ids").upsert({
          source_name: "espn", source_team_id: team.sourceId, team_id: team.id,
        }, { onConflict: "source_name,source_team_id" });
        if (error) throw new Error(`Event team mapping failed: ${error.message}`);
      }

      const gameRow = {
        season: entry.season,
        scheduled_start: new Date(event.date).toISOString(),
        home_team_id: homeTeam.id,
        away_team_id: awayTeam.id,
        status: "scheduled",
        status_detail: event.status?.type?.detail ?? "Scheduled",
        is_neutral_site: Boolean(competition?.neutralSite),
      };
      const { data: mapping, error: mappingError } = await supabase.from("game_source_ids")
        .select("game_id").eq("source_name", "espn").eq("source_game_id", sourceGameId).maybeSingle();
      if (mappingError) throw new Error(`Game mapping lookup failed: ${mappingError.message}`);

      if (mapping?.game_id) {
        const { error } = await supabase.from("games").update(gameRow).eq("id", mapping.game_id);
        if (error) throw new Error(`Scheduled game update failed: ${error.message}`);
        existingGamesUpdated++;
      } else {
        const { data: game, error } = await supabase.from("games").insert(gameRow).select("id").single();
        if (error || !game) throw new Error(`Scheduled game insert failed: ${error?.message}`);
        const { error: insertMapError } = await supabase.from("game_source_ids").insert({
          source_name: "espn", source_game_id: sourceGameId, game_id: game.id,
        });
        if (insertMapError) throw new Error(`Game source mapping insert failed: ${insertMapError.message}`);
        upcomingGamesSaved++;
      }
    }

    const finishedAt = new Date().toISOString();
    await supabase.from("source_ingestion_runs").update({
      finished_at: finishedAt, ok: true, http_status: 200, records_seen: eventsSeen,
      metadata: { months_requested: months, unique_events_seen: eventsSeen, upcoming_games_inserted: upcomingGamesSaved,
        existing_games_updated: existingGamesUpdated, skipped: skipped, teams_saved: teamsSaved },
    }).eq("id", run.id);
    return json({ ok: true, source: "ESPN", months_requested: months, events_seen: eventsSeen,
      upcoming_games_saved: upcomingGamesSaved, existing_games_updated: existingGamesUpdated, skipped,
      note: "Schedule ingestion only; live scores and boxscores remain handled by their dedicated sync jobs." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from("source_ingestion_runs").update({
      finished_at: new Date().toISOString(), ok: false, error_message: message,
    }).eq("id", run.id);
    return json({ ok: false, error: message }, 502);
  }
});
