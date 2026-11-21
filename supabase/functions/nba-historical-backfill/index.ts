import { createClient } from "npm:@supabase/supabase-js@2";
const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const NBA_TEAM_ABBREVIATIONS = new Set(["ATL","BKN","BOS","CHA","CHI","CLE","DAL","DEN","DET","GSW","HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK","OKC","ORL","PHI","PHX","POR","SAC","SAS","TOR","UTA","WAS"]);
function normalizeTeamAbbr(value: unknown) {
  const abbr = String(value ?? "").toUpperCase();
  const aliases: Record<string, string> = { GS: "GSW", NY: "NYK", NO: "NOP", SA: "SAS", UTAH: "UTA", WSH: "WAS" };
  return aliases[abbr] ?? abbr;
}
function isNbaTeamAbbr(value: unknown) { return NBA_TEAM_ABBREVIATIONS.has(normalizeTeamAbbr(value)); }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fetchEspn(url: string, userAgent: string, attempts = 4): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await fetch(url, {
      headers: { "accept": "application/json", "user-agent": userAgent },
      signal: AbortSignal.timeout(20000)
    });
    if (last.ok || ![403, 408, 429, 500, 502, 503, 504].includes(last.status)) return last;
    if (attempt + 1 < attempts) await wait(1200 * (attempt + 1));
  }
  return last!;
}
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function dateKey(d: Date) { return d.toISOString().slice(0, 10).replaceAll("-", ""); }
function seasonYear(iso: string) {
  // NBA season is stored by ending year: 2025-26 => 2026; 2026-27 => 2027.
  const d = new Date(iso);
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}
function playerRows(boxPlayers: any[]) {
  const byId = new Map<string, any>();
  for (const group of boxPlayers ?? []) {
    const team = group.team ?? {};
    for (const category of group.statistics ?? []) {
      for (const item of category.athletes ?? []) {
        const athlete = item.athlete ?? {};
        if (!athlete.id || item.didNotPlay === true) continue;
        const names = Array.isArray(category.names) ? category.names : [];
        const values = Array.isArray(item.stats) ? item.stats : [];
        if (!values.length) continue;
        const mapped: Record<string, unknown> = {};
        names.forEach((name: string, i: number) => { if (values[i] !== undefined) mapped[name] = values[i]; });
        // Do not persist DNP / not-yet-played rows as zero-minute player performances.
        if (["-", "--", "DNP"].includes(String(mapped.MIN ?? "").trim().toUpperCase())) continue;
        const id = String(athlete.id);
        const existing = byId.get(id) ?? {
          espn_id: id,
          name: String(athlete.displayName ?? athlete.fullName ?? athlete.shortName ?? "Unknown"),
          position: athlete.position?.abbreviation ?? athlete.position?.name ?? null,
          team_espn_id: team.id ? String(team.id) : null,
          stats: { categories: [] as any[] }
        };
        existing.stats.categories.push({ category: category.name ?? null, labels: category.labels ?? [], values: mapped, raw_stats: values });
        byId.set(id, existing);
      }
    }
  }
  return [...byId.values()];
}

async function callSecondaryBoxscore(body: Record<string, unknown>) {
  const response = await fetch(`${PROJECT_URL}/functions/v1/nba-secondary-boxscore`, {
    method: "POST",
    headers: { "content-type": "application/json", "apikey": PUBLIC_KEY! },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(105000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, error: `secondary function HTTP ${response.status}` };
  return payload;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) return json({ error: "Unauthorized" }, 401);
  if (!SERVICE_KEY) return json({ error: "Server database credentials are not configured" }, 500);
  const supabase = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let runId: string | null = null;
  let jobId: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    jobId = typeof body.job_id === "string" ? body.job_id : null;
    let jobQuery = supabase.from("historical_backfill_jobs").select("*");
    if (jobId) jobQuery = jobQuery.eq("id", jobId);
    else jobQuery = jobQuery.in("status", ["queued", "running"]).order("created_at", { ascending: true }).limit(1);
    const { data: job, error: jobError } = jobId ? await jobQuery.maybeSingle() : await jobQuery.maybeSingle();
    if (jobError || !job) return json({ error: "No pending historical job found", detail: jobError?.message }, 404);
    jobId = job.id;
    if (job.status === "completed") return json({ ok: true, status: "completed", job_id: job.id, metadata: job.metadata });
    // Atomically claim queued work so overlapping cron invocations cannot process the same date range.
    const { data: claimedJob, error: claimError } = await supabase.from("historical_backfill_jobs")
      .update({ status: "running", updated_at: new Date().toISOString(), last_error: null })
      .eq("id", job.id).eq("status", "queued").select("id").maybeSingle();
    if (claimError) throw new Error("Could not claim historical job: " + claimError.message);
    if (!claimedJob) return json({ ok: true, status: "busy", job_id: job.id }, 202);

    const startedAt = new Date().toISOString();
    const { data: run, error: runError } = await supabase.from("source_ingestion_runs")
      .insert({ source_name: "espn_historical_backfill", started_at: startedAt, ok: false })
      .select("id").single();
    if (runError || !run) throw new Error("Could not start ingestion log: " + runError?.message);
    runId = run.id;
    await supabase.from("historical_backfill_jobs").update({ status: "running", updated_at: startedAt, last_error: null }).eq("id", job.id);

    const { count: teamsSynced, error: teamsCountError } = await supabase.from("teams").select("id", { count: "exact", head: true }).eq("team_type", "nba");
    if (teamsCountError || (teamsSynced ?? 0) < 30) throw new Error(`Expected at least 30 registered NBA teams, found ${teamsSynced ?? 0}`);

    // Retry previously missed boxscores with the secondary NBA feed before processing new dates.
    try {
      await callSecondaryBoxscore({ mode: "recover_pending", limit: 1 });
    } catch (recoveryError) {
      issues.push("Secondary recovery pass: " + (recoveryError instanceof Error ? recoveryError.message : String(recoveryError)));
    }
    let cursor = new Date(job.next_date + "T00:00:00.000Z");
    const end = new Date(job.end_date + "T00:00:00.000Z");
    const maxDays = Math.min(7, Math.max(1, Number(job.days_per_run) || 3));
    let datesChecked = 0, gamesSeen = 0, gamesSaved = 0, resultsSaved = 0, boxscoresSaved = 0, teamStatsSaved = 0, playerStatsSaved = 0;
    const issues: string[] = [];
    while (cursor <= end && datesChecked < maxDays) {
      const key = dateKey(cursor);
      const response = await fetchEspn(`${BASE}/scoreboard?dates=${key}&limit=1000`, "NBA-Analytics/1.0 data-ingestion");
      if (!response.ok) throw new Error(`ESPN scoreboard ${key} HTTP ${response.status}`);
      const payload = await response.json();
      const events = Array.isArray(payload.events) ? payload.events : [];
      gamesSeen += events.length;
      for (const event of events) {
        const competitors = event.competitions?.[0]?.competitors ?? [];
        const home = competitors.find((c: any) => c.homeAway === "home");
        const away = competitors.find((c: any) => c.homeAway === "away");
        if (!event.id || !event.date || !home?.team?.abbreviation || !away?.team?.abbreviation) continue;
        const statusType = event.status?.type ?? {};
        const state = statusType.state ?? "pre";
        const statusLabel = `${statusType.name ?? ""} ${statusType.detail ?? ""}`;
        // A postponed/cancelled event can have state=post and 0-0 scores. Only ingest completed games.
        if (state !== "post" || statusType.completed !== true || /postponed|cancelled|canceled/i.test(statusLabel) || home.score == null || away.score == null) continue;
        const teamIds: Record<string, string> = {};
        for (const item of [home, away]) {
          const team = item.team;
          const abbreviation = normalizeTeamAbbr(team.abbreviation);
          const row = { abbreviation, display_name: String(team.displayName ?? team.name ?? abbreviation), city: team.location ?? null, team_type: isNbaTeamAbbr(abbreviation) ? "nba" : "special" };
          const { data: savedTeam, error } = await supabase.from("teams").upsert(row, { onConflict: "abbreviation" }).select("id").single();
          if (error || !savedTeam) throw new Error("Game team upsert failed: " + error?.message);
          teamIds[abbreviation] = savedTeam.id;
          if (team.id) {
            const { error: mapError } = await supabase.from("team_source_ids").upsert({ source_name: "espn", source_team_id: String(team.id), team_id: savedTeam.id }, { onConflict: "source_name,source_team_id" });
            if (mapError) throw new Error("Game team source mapping failed: " + mapError.message);
          }
        }
        const homeAbbr = normalizeTeamAbbr(home.team.abbreviation);
        const awayAbbr = normalizeTeamAbbr(away.team.abbreviation);
        const gameRow = {
          season: seasonYear(event.date), scheduled_start: new Date(event.date).toISOString(),
          home_team_id: teamIds[homeAbbr], away_team_id: teamIds[awayAbbr], status: "final",
          status_detail: event.status?.type?.detail ?? "Final",
          is_neutral_site: Boolean(event.competitions?.[0]?.neutralSite),
          is_special_event: !(isNbaTeamAbbr(homeAbbr) && isNbaTeamAbbr(awayAbbr))
        };
        const { data: existingMap, error: lookupError } = await supabase.from("game_source_ids")
          .select("game_id").eq("source_name", "espn").eq("source_game_id", String(event.id)).maybeSingle();
        if (lookupError) throw new Error("Game mapping lookup failed: " + lookupError.message);
        let gameId = existingMap?.game_id;
        if (gameId) {
          const { error } = await supabase.from("games").update(gameRow).eq("id", gameId);
          if (error) throw new Error("Game update failed: " + error.message);
        } else {
          const { data: savedGame, error } = await supabase.from("games").insert(gameRow).select("id").single();
          if (error || !savedGame) throw new Error("Game insert failed: " + error?.message);
          gameId = savedGame.id;
          const { error: mapError } = await supabase.from("game_source_ids").insert({ source_name: "espn", source_game_id: String(event.id), game_id: gameId });
          if (mapError) throw new Error("Game source mapping failed: " + mapError.message);
        }
        gamesSaved++;
        const { error: resultError } = await supabase.from("game_results").upsert({
          game_id: gameId, home_score: Number(home.score), away_score: Number(away.score),
          confirmed_at: new Date().toISOString(), confirmation_sources: ["espn"], is_final: true
        }, { onConflict: "game_id" });
        if (resultError) throw new Error("Game result upsert failed: " + resultError.message);
        resultsSaved++;
        const digestEvent = await sha256(JSON.stringify(event));
        const { error: eventSnapError } = await supabase.from("raw_source_snapshots").upsert({
          run_id: run.id, source_name: "espn", entity_type: "game", source_entity_id: String(event.id),
          payload_sha256: digestEvent, payload: event
        }, { onConflict: "source_name,entity_type,source_entity_id,payload_sha256", ignoreDuplicates: true });
        if (eventSnapError) throw new Error("Event snapshot failed: " + eventSnapError.message);

        if (gamesSaved > 1) await wait(350);
        const summaryResponse = await fetchEspn(`${BASE}/summary?event=${encodeURIComponent(String(event.id))}`, "NBA-Analytics/1.0 boxscore-ingestion");
        // ESPN may permanently remove historical summaries. A 404 is not transient:
        // keep the final game/result already saved, record the missing boxscore, and
        // continue with the next event so one unavailable game cannot freeze the cursor.
        if (!summaryResponse.ok) {
          const fallback = await callSecondaryBoxscore({
            game_id: gameId, espn_event_id: String(event.id), game_date: event.date,
            home_abbr: homeAbbr, away_abbr: awayAbbr,
            home_score: Number(home.score), away_score: Number(away.score)
          });
          if (fallback?.ok) {
            boxscoresSaved++;
            teamStatsSaved += Number(fallback.team_stat_rows_saved ?? 0);
            playerStatsSaved += Number(fallback.player_stat_rows_saved ?? 0);
            issues.push(`ESPN HTTP ${summaryResponse.status}; NBA secondary source recovered ${event.id}`);
            continue;
          }
          issues.push(`ESPN HTTP ${summaryResponse.status}; NBA secondary queued ${event.id}: ${fallback?.error ?? "unavailable"}`);
          if (summaryResponse.status !== 404) throw new Error(`ESPN summary ${event.id} HTTP ${summaryResponse.status}; secondary queued for retry`);
          continue;
        }
        const summary = await summaryResponse.json();
        const box = summary.boxscore;
        const hasTeamStats = Array.isArray(box?.teams) && box.teams.length >= 2 && box.teams.every((t: any) => Array.isArray(t.statistics) && t.statistics.length > 0);
        const hasPlayerStats = Array.isArray(box?.players) && box.players.some((g: any) => (g.statistics ?? []).some((c: any) => (c.athletes ?? []).length > 0));
        if (!hasTeamStats || !hasPlayerStats) {
          const fallback = await callSecondaryBoxscore({
            game_id: gameId, espn_event_id: String(event.id), game_date: event.date,
            home_abbr: homeAbbr, away_abbr: awayAbbr,
            home_score: Number(home.score), away_score: Number(away.score)
          });
          if (fallback?.ok) {
            boxscoresSaved++;
            teamStatsSaved += Number(fallback.team_stat_rows_saved ?? 0);
            playerStatsSaved += Number(fallback.player_stat_rows_saved ?? 0);
            issues.push(`ESPN boxscore missing; NBA secondary recovered ${event.id}`);
          } else {
            issues.push(`ESPN boxscore missing; NBA secondary queued ${event.id}: ${fallback?.error ?? "unavailable"}`);
          }
          continue;
        }
        const capturedAt = new Date().toISOString();
        const compactSummary = { header: summary.header ?? null, boxscore: box };
        const digest = await sha256(JSON.stringify(compactSummary));
        const { error: snapError } = await supabase.from("raw_source_snapshots").upsert({
          run_id: run.id, source_name: "espn", entity_type: "historical_boxscore", source_entity_id: String(event.id),
          payload_sha256: digest, payload: compactSummary
        }, { onConflict: "source_name,entity_type,source_entity_id,payload_sha256", ignoreDuplicates: true });
        if (snapError) throw new Error("Boxscore snapshot failed: " + snapError.message);
        boxscoresSaved++;
        for (const teamBox of box.teams ?? []) {
          const sourceTeamId = teamBox.team?.id ? String(teamBox.team.id) : null;
          if (!sourceTeamId) continue;
          const { data: teamMap, error: teamMapError } = await supabase.from("team_source_ids").select("team_id")
            .eq("source_name", "espn").eq("source_team_id", sourceTeamId).maybeSingle();
          if (teamMapError) throw new Error("Team stat mapping lookup failed: " + teamMapError.message);
          if (!teamMap?.team_id) continue;
          const { data: existingStat, error: existingStatError } = await supabase.from("team_game_stats").select("id")
            .eq("game_id", gameId).eq("team_id", teamMap.team_id).eq("source_name", "espn").limit(1).maybeSingle();
          if (existingStatError) throw new Error("Team stat duplicate check failed: " + existingStatError.message);
          if (existingStat) continue;
          const { error } = await supabase.from("team_game_stats").insert({
            game_id: gameId, team_id: teamMap.team_id, source_name: "espn", captured_at: capturedAt,
            stats: { team: teamBox.team ?? {}, statistics: teamBox.statistics ?? [] }, validation_status: "pending"
          });
          if (error) throw new Error("Team stat insert failed: " + error.message);
          teamStatsSaved++;
        }
        for (const row of playerRows(box.players ?? [])) {
          if (!row.team_espn_id) continue;
          const { data: teamMap, error: teamMapError } = await supabase.from("team_source_ids").select("team_id")
            .eq("source_name", "espn").eq("source_team_id", row.team_espn_id).maybeSingle();
          if (teamMapError) throw new Error("Player team mapping lookup failed: " + teamMapError.message);
          if (!teamMap?.team_id) continue;
          const { data: playerMap, error: playerMapError } = await supabase.from("player_source_ids").select("player_id")
            .eq("source_name", "espn").eq("source_player_id", row.espn_id).maybeSingle();
          if (playerMapError) throw new Error("Player mapping lookup failed: " + playerMapError.message);
          let playerId = playerMap?.player_id;
          if (!playerId) {
            const { data: player, error: playerError } = await supabase.from("players")
              .insert({ display_name: row.name, position: row.position, active: false }).select("id").single();
            if (playerError || !player) throw new Error("Player insert failed: " + playerError?.message);
            playerId = player.id;
            const { error: sourceError } = await supabase.from("player_source_ids")
              .insert({ source_name: "espn", source_player_id: row.espn_id, player_id: playerId });
            if (sourceError) throw new Error("Player source mapping insert failed: " + sourceError.message);
          }
          const { data: existingStat, error: existingStatError } = await supabase.from("player_game_stats").select("id")
            .eq("game_id", gameId).eq("player_id", playerId).eq("source_name", "espn").limit(1).maybeSingle();
          if (existingStatError) throw new Error("Player stat duplicate check failed: " + existingStatError.message);
          if (existingStat) continue;
          const { error: statError } = await supabase.from("player_game_stats").insert({
            game_id: gameId, player_id: playerId, team_id: teamMap.team_id, source_name: "espn",
            captured_at: capturedAt, stats: row.stats, validation_status: "pending"
          });
          if (statError) throw new Error("Player stat insert failed: " + statError.message);
          playerStatsSaved++;
        }
      }
      datesChecked++;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const finished = cursor > end;
    const nextDate = cursor.toISOString().slice(0, 10);
    const prev = job.metadata ?? {};
    const metadata = {
      dates_checked_total: Number(prev.dates_checked_total ?? 0) + datesChecked,
      games_seen_total: Number(prev.games_seen_total ?? 0) + gamesSeen,
      games_saved_total: Number(prev.games_saved_total ?? 0) + gamesSaved,
      results_saved_total: Number(prev.results_saved_total ?? 0) + resultsSaved,
      boxscores_saved_total: Number(prev.boxscores_saved_total ?? 0) + boxscoresSaved,
      team_stats_saved_total: Number(prev.team_stats_saved_total ?? 0) + teamStatsSaved,
      player_stats_saved_total: Number(prev.player_stats_saved_total ?? 0) + playerStatsSaved,
      teams_synced: teamsSynced,
      last_batch: { dates_checked: datesChecked, games_seen: gamesSeen, games_saved: gamesSaved, results_saved: resultsSaved, boxscores_saved: boxscoresSaved, team_stats_saved: teamStatsSaved, player_stats_saved: playerStatsSaved, issues }
    };
    const { error: jobUpdateError } = await supabase.from("historical_backfill_jobs").update({
      next_date: finished ? job.end_date : nextDate,
      status: finished ? "completed" : "queued", metadata, last_error: null,
      updated_at: new Date().toISOString(), completed_at: finished ? new Date().toISOString() : null
    }).eq("id", job.id);
    if (jobUpdateError) throw new Error("Could not update historical cursor: " + jobUpdateError.message);
    const { error: logError } = await supabase.from("source_ingestion_runs").update({
      finished_at: new Date().toISOString(), ok: true, http_status: 200, records_seen: gamesSeen,
      metadata: { job_id: job.id, dates_checked: datesChecked, next_date: finished ? null : nextDate, ...metadata.last_batch }
    }).eq("id", run.id);
    if (logError) throw new Error("Could not finish ingestion log: " + logError.message);
    return json({ ok: true, job_id: job.id, status: finished ? "completed" : "queued", dates_checked: datesChecked, next_date: finished ? null : nextDate, ...metadata });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Keep transient failures queued so the cron retries the same cursor.
    if (jobId) await supabase.from("historical_backfill_jobs").update({ status: "queued", last_error: message, updated_at: new Date().toISOString() }).eq("id", jobId).eq("status", "running");
    if (runId) await supabase.from("source_ingestion_runs").update({ finished_at: new Date().toISOString(), ok: false, error_message: message }).eq("id", runId);
    return json({ ok: false, error: message, job_id: jobId }, 502);
  }
});