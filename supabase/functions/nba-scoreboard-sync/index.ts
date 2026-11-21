import { createClient } from "npm:@supabase/supabase-js@2";
const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";
const ESPN_TEAMS_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=1000";
const NBA_TEAM_ABBREVIATIONS = new Set(["ATL","BKN","BOS","CHA","CHI","CLE","DAL","DEN","DET","GSW","HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK","OKC","ORL","PHI","PHX","POR","SAC","SAS","TOR","UTA","WAS"]);
function normalizeTeamAbbr(value: unknown) {
  const abbr = String(value ?? "").toUpperCase();
  const aliases: Record<string, string> = { GS: "GSW", NY: "NYK", NO: "NOP", SA: "SAS", UTAH: "UTA", WSH: "WAS" };
  return aliases[abbr] ?? abbr;
}
function isNbaTeamAbbr(value: unknown) { return NBA_TEAM_ABBREVIATIONS.has(normalizeTeamAbbr(value)); }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) return json({ error: "Unauthorized" }, 401);
  if (!SERVICE_KEY) return json({ error: "Server database credentials are not configured" }, 500);
  const supabase = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const startedAt = new Date().toISOString();
  const { data: run, error: runError } = await supabase.from("source_ingestion_runs")
    .insert({ source_name: "espn_scoreboard", started_at: startedAt, ok: false }).select("id").single();
  if (runError || !run) return json({ error: "Could not start ingestion log", detail: runError?.message }, 500);
  try {
    const teamsResponse = await fetch(ESPN_TEAMS_URL, { headers: { "accept": "application/json", "user-agent": "NBA-Analytics/1.0 data-ingestion" }, signal: AbortSignal.timeout(20000) });
    if (!teamsResponse.ok) throw new Error(`ESPN teams HTTP ${teamsResponse.status}`);
    const teamsPayload = await teamsResponse.json();
    const sourceTeams = teamsPayload.sports?.[0]?.leagues?.[0]?.teams ?? [];
    let leagueTeamsSaved = 0;
    for (const entry of sourceTeams) {
      const team = entry.team;
      if (!team?.id || !team?.abbreviation || team.isActive === false || team.isAllStar === true) continue;
      const row = { abbreviation: normalizeTeamAbbr(team.abbreviation), display_name: String(team.displayName ?? team.name ?? team.abbreviation), city: team.location ?? null, team_type: "nba" };
      const { data, error } = await supabase.from("teams").upsert(row, { onConflict: "abbreviation" }).select("id,abbreviation").single();
      if (error || !data) throw new Error(`League team upsert failed: ${error?.message}`);
      const { error: sourceError } = await supabase.from("team_source_ids").upsert({ source_name: "espn", source_team_id: String(team.id), team_id: data.id }, { onConflict: "source_name,source_team_id" });
      if (sourceError) throw new Error(`League team mapping failed: ${sourceError.message}`);
      leagueTeamsSaved++;
    }
    if (leagueTeamsSaved !== 30) throw new Error(`Expected 30 active NBA teams from ESPN, received ${leagueTeamsSaved}`);
    const response = await fetch(ESPN_URL, { headers: { "accept": "application/json", "user-agent": "NBA-Analytics/1.0 data-ingestion" }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`ESPN HTTP ${response.status}`);
    const payload = await response.json();
    const events = Array.isArray(payload.events) ? payload.events : [];
    let gamesSaved = 0, resultsSaved = 0, snapshotsSaved = 0;
    for (const event of events) {
      const competitors = event.competitions?.[0]?.competitors ?? [];
      const home = competitors.find((c: any) => c.homeAway === "home");
      const away = competitors.find((c: any) => c.homeAway === "away");
      if (!home?.team?.abbreviation || !away?.team?.abbreviation || !event.id || !event.date) continue;
      const teamRows = [];
      for (const item of [home, away]) {
        const team = item.team;
        const row = { abbreviation: normalizeTeamAbbr(team.abbreviation), display_name: String(team.displayName ?? team.name ?? team.abbreviation), city: team.location ?? null, team_type: isNbaTeamAbbr(team.abbreviation) ? "nba" : "special" };
        const { data, error } = await supabase.from("teams").upsert(row, { onConflict: "abbreviation" }).select("id,abbreviation").single();
        if (error || !data) throw new Error(`Team upsert failed: ${error?.message}`);
        teamRows.push({ ...data, source_id: String(team.id ?? team.abbreviation) });
      }
      const homeTeam = teamRows.find((t) => t.abbreviation === normalizeTeamAbbr(home.team.abbreviation));
      const awayTeam = teamRows.find((t) => t.abbreviation === normalizeTeamAbbr(away.team.abbreviation));
      if (!homeTeam || !awayTeam) continue;
      for (const t of teamRows) {
        const { error } = await supabase.from("team_source_ids").upsert({ source_name: "espn", source_team_id: t.source_id, team_id: t.id }, { onConflict: "source_name,source_team_id" });
        if (error) throw new Error(`Team source mapping failed: ${error.message}`);
      }
      const state = event.status?.type?.state ?? "pre";
      const status = state === "post" ? "final" : state === "in" ? "in_progress" : "scheduled";
      const season = Number(payload.leagues?.[0]?.season?.year ?? new Date(event.date).getUTCFullYear());
      const gameRow = { season, scheduled_start: new Date(event.date).toISOString(), home_team_id: homeTeam.id, away_team_id: awayTeam.id, status, status_detail: event.status?.type?.detail ?? null, is_neutral_site: Boolean(event.competitions?.[0]?.neutralSite), is_special_event: !(isNbaTeamAbbr(home.team.abbreviation) && isNbaTeamAbbr(away.team.abbreviation)) };
      const { data: mapping, error: mappingError } = await supabase.from("game_source_ids").select("game_id").eq("source_name", "espn").eq("source_game_id", String(event.id)).maybeSingle();
      if (mappingError) throw new Error(mappingError.message);
      let gameId = mapping?.game_id;
      if (gameId) {
        const { error } = await supabase.from("games").update(gameRow).eq("id", gameId);
        if (error) throw new Error(`Game update failed: ${error.message}`);
      } else {
        const { data, error } = await supabase.from("games").insert(gameRow).select("id").single();
        if (error || !data) throw new Error(`Game insert failed: ${error?.message}`);
        gameId = data.id;
        const { error: mapError } = await supabase.from("game_source_ids").insert({ source_name: "espn", source_game_id: String(event.id), game_id: gameId });
        if (mapError) throw new Error(`Game mapping failed: ${mapError.message}`);
      }
      gamesSaved++;
      const digest = await sha256(JSON.stringify(event));
      const { error: snapError } = await supabase.from("raw_source_snapshots").upsert({ run_id: run.id, source_name: "espn", entity_type: "game", source_entity_id: String(event.id), payload_sha256: digest, payload: event }, { onConflict: "source_name,entity_type,source_entity_id,payload_sha256", ignoreDuplicates: true });
      if (snapError) throw new Error(`Raw snapshot save failed: ${snapError.message}`);
      snapshotsSaved++;
      if (status === "final" && home.score != null && away.score != null) {
        const { error } = await supabase.from("game_results").upsert({ game_id: gameId, home_score: Number(home.score), away_score: Number(away.score), confirmed_at: new Date().toISOString(), confirmation_sources: ["espn"], is_final: true }, { onConflict: "game_id" });
        if (error) throw new Error(`Final score save failed: ${error.message}`);
        resultsSaved++;
      }
    }
    await supabase.from("source_ingestion_runs").update({ finished_at: new Date().toISOString(), ok: true, http_status: 200, records_seen: events.length, metadata: { games_saved: gamesSaved, final_results_saved: resultsSaved, snapshots_saved: snapshotsSaved } }).eq("id", run.id);
    return json({ ok: true, source: "ESPN", league_teams_saved: leagueTeamsSaved, events_seen: events.length, games_saved: gamesSaved, final_results_saved: resultsSaved, snapshots_saved: snapshotsSaved, note: "Scoreboard and final scores only; player/team boxscore statistics are a separate ingestion stage." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from("source_ingestion_runs").update({ finished_at: new Date().toISOString(), ok: false, error_message: message }).eq("id", run.id);
    return json({ ok: false, error: message }, 502);
  }
});