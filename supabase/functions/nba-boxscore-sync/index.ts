import { createClient } from "npm:@supabase/supabase-js@2";
const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function playerRows(boxPlayers: any[]) {
  const rows: any[] = [];
  for (const group of boxPlayers ?? []) {
    const team = group.team ?? {};
    for (const category of group.statistics ?? []) {
      for (const item of category.athletes ?? []) {
        const athlete = item.athlete ?? {};
        if (!athlete.id) continue;
        const names = Array.isArray(category.names) ? category.names : [];
        const values = Array.isArray(item.stats) ? item.stats : [];
        const mapped: Record<string, unknown> = {};
        names.forEach((name: string, i: number) => { if (values[i] !== undefined) mapped[name] = values[i]; });
        // ESPN uses "-" or "--" for players who have not entered the game (DNP / not yet played).
        // Keep their raw boxscore in the immutable snapshot, but do not create fake zero-minute stat rows.
        if (["-", "--", "DNP"].includes(String(mapped.MIN ?? "").trim().toUpperCase())) continue;
        rows.push({
          espn_id: String(athlete.id),
          name: String(athlete.displayName ?? athlete.fullName ?? athlete.shortName ?? "Unknown"),
          position: athlete.position?.abbreviation ?? athlete.position?.name ?? null,
          team_espn_id: team.id ? String(team.id) : null,
          stats: { ...mapped, category: category.name ?? null, labels: category.labels ?? [], raw_stats: values, athlete: athlete }
        });
      }
    }
  }
  return rows;
}
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) return json({ error: "Unauthorized" }, 401);
  if (!SERVICE_KEY) return json({ error: "Server database credentials are not configured" }, 500);
  const supabase = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const startedAt = new Date().toISOString();
  const { data: run, error: runError } = await supabase.from("source_ingestion_runs")
    .insert({ source_name: "espn_boxscore", started_at: startedAt, ok: false }).select("id").single();
  if (runError || !run) return json({ error: "Could not start ingestion log", detail: runError?.message }, 500);
  try {
    const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const { data: games, error: gamesError } = await supabase.from("games")
      .select("id,status,scheduled_start,game_source_ids!inner(source_game_id,source_name)")
      .eq("game_source_ids.source_name", "espn")
      .in("status", ["in_progress", "final"])
      .gte("scheduled_start", cutoff)
      .order("scheduled_start", { ascending: true })
      .limit(30);
    if (gamesError) throw new Error("Could not load active games: " + gamesError.message);
    let gamesChecked = 0, gamesWithBoxscore = 0, teamsSaved = 0, playersSaved = 0, snapshotsSaved = 0;
    const issues: string[] = [];
    for (const game of games ?? []) {
      const mapping = (game as any).game_source_ids?.find((m: any) => m.source_name === "espn") ?? (game as any).game_source_ids?.[0];
      const eventId = mapping?.source_game_id;
      if (!eventId) continue;
      if (game.status === "final") {
        // An in-progress snapshot is not a final boxscore. Skip only after a final marker
        // has been written following successful normalized-stat ingestion.
        const { data: finalMarker, error: markerError } = await supabase.from("raw_source_snapshots")
          .select("id").eq("source_name", "espn").eq("entity_type", "boxscore_final")
          .eq("source_entity_id", String(eventId)).limit(1).maybeSingle();
        if (markerError) throw new Error("Final boxscore marker lookup failed: " + markerError.message);
        if (finalMarker) continue;
      }
      if (gamesChecked > 0) await wait(1000);
      gamesChecked++;
      const response = await fetch(`${BASE}/summary?event=${encodeURIComponent(eventId)}`, {
        headers: { "accept": "application/json", "user-agent": "NBA-Analytics/1.0 boxscore-ingestion" },
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) { issues.push(`${eventId}: ESPN HTTP ${response.status}`); continue; }
      const summary = await response.json();
      const box = summary.boxscore;
      if (!box || (!Array.isArray(box.players) && !Array.isArray(box.teams))) continue;
      const capturedAt = new Date().toISOString();
      const digest = await sha256(JSON.stringify(summary));
      const { error: snapError } = await supabase.from("raw_source_snapshots").upsert({
        run_id: run.id, source_name: "espn", entity_type: "boxscore", source_entity_id: String(eventId),
        payload_sha256: digest, payload: summary
      }, { onConflict: "source_name,entity_type,source_entity_id,payload_sha256", ignoreDuplicates: true });
      if (snapError) throw new Error("Raw boxscore snapshot failed: " + snapError.message);
      snapshotsSaved++;
      let localTeamCount = 0;
      for (const teamBox of box.teams ?? []) {
        const sourceTeamId = teamBox.team?.id ? String(teamBox.team.id) : null;
        if (!sourceTeamId) continue;
        const { data: teamMap, error: mapError } = await supabase.from("team_source_ids")
          .select("team_id").eq("source_name", "espn").eq("source_team_id", sourceTeamId).maybeSingle();
        if (mapError) throw new Error("Team mapping lookup failed: " + mapError.message);
        if (!teamMap?.team_id) { issues.push(`${eventId}: unknown team ${sourceTeamId}`); continue; }
        const { error } = await supabase.from("team_game_stats").insert({
          game_id: game.id, team_id: teamMap.team_id, source_name: "espn", captured_at: capturedAt,
          stats: { team: teamBox.team ?? {}, statistics: teamBox.statistics ?? [] }, validation_status: "pending"
        });
        if (error && !error.message.includes("duplicate key")) throw new Error("Team stats insert failed: " + error.message);
        if (!error) { teamsSaved++; localTeamCount++; }
      }
      const extractedPlayers = playerRows(box.players ?? []);
      for (const row of extractedPlayers) {
        if (!row.team_espn_id || !Array.isArray(row.stats.raw_stats) || row.stats.raw_stats.length === 0) continue;
        const { data: teamMap, error: teamError } = await supabase.from("team_source_ids")
          .select("team_id").eq("source_name", "espn").eq("source_team_id", row.team_espn_id).maybeSingle();
        if (teamError) throw new Error("Player team mapping lookup failed: " + teamError.message);
        if (!teamMap?.team_id) continue;
        const { data: playerMap, error: playerMapError } = await supabase.from("player_source_ids")
          .select("player_id").eq("source_name", "espn").eq("source_player_id", row.espn_id).maybeSingle();
        if (playerMapError) throw new Error("Player mapping lookup failed: " + playerMapError.message);
        let playerId = playerMap?.player_id;
        if (!playerId) {
          const { data: player, error: playerError } = await supabase.from("players")
            .insert({ display_name: row.name, position: row.position, active: true }).select("id").single();
          if (playerError || !player) throw new Error("Player insert failed: " + playerError?.message);
          playerId = player.id;
          const { error: sourceError } = await supabase.from("player_source_ids")
            .insert({ source_name: "espn", source_player_id: row.espn_id, player_id: playerId });
          if (sourceError) throw new Error("Player source mapping insert failed: " + sourceError.message);
        } else {
          const { error: updateError } = await supabase.from("players")
            .update({ display_name: row.name, position: row.position, active: true, updated_at: new Date().toISOString() }).eq("id", playerId);
          if (updateError) throw new Error("Player update failed: " + updateError.message);
        }
        const { error: statError } = await supabase.from("player_game_stats").insert({
          game_id: game.id, player_id: playerId, team_id: teamMap.team_id, source_name: "espn",
          captured_at: capturedAt, stats: row.stats, validation_status: "pending"
        });
        if (statError && !statError.message.includes("duplicate key")) throw new Error("Player stats insert failed: " + statError.message);
        if (!statError) playersSaved++;
      }
      if (game.status === "final" && (localTeamCount > 0 || extractedPlayers.length > 0)) {
        // This marker is deliberately written last: if any stat insert fails, the next
        // scheduled run retries the final boxscore instead of treating a partial save as complete.
        const { error: finalMarkerError } = await supabase.from("raw_source_snapshots").upsert({
          run_id: run.id, source_name: "espn", entity_type: "boxscore_final",
          source_entity_id: String(eventId), payload_sha256: digest, payload: summary
        }, { onConflict: "source_name,entity_type,source_entity_id,payload_sha256", ignoreDuplicates: true });
        if (finalMarkerError) throw new Error("Final boxscore marker save failed: " + finalMarkerError.message);
      }
      if (localTeamCount > 0 || extractedPlayers.length > 0) gamesWithBoxscore++;
    }
    const metadata = { games_checked: gamesChecked, games_with_boxscore: gamesWithBoxscore, team_stat_rows_saved: teamsSaved, player_stat_rows_saved: playersSaved, snapshots_saved: snapshotsSaved, issues };
    const { error: logError } = await supabase.from("source_ingestion_runs").update({
      finished_at: new Date().toISOString(), ok: true, http_status: 200,
      records_seen: gamesChecked, metadata
    }).eq("id", run.id);
    if (logError) throw new Error("Could not finish ingestion log: " + logError.message);
    return json({ ok: true, source: "ESPN", ...metadata });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from("source_ingestion_runs").update({ finished_at: new Date().toISOString(), ok: false, error_message: message }).eq("id", run.id);
    return json({ ok: false, error: message }, 502);
  }
});