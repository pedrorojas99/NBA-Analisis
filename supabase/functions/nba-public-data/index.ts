import { createClient } from "npm:@supabase/supabase-js@2";
const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) return json({ error: "Unauthorized" }, 401);
  if (!SERVICE_KEY) return json({ error: "Server database credentials are not configured" }, 500);
  const supabase = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: games, error: gamesError } = await supabase.from("games")
      .select("id,season,scheduled_start,status,status_detail,home_team_id,away_team_id,is_neutral_site")
      .gte("scheduled_start", from).lte("scheduled_start", to)
      .order("scheduled_start", { ascending: true }).limit(40);
    if (gamesError) throw new Error("Games query failed: " + gamesError.message);
    const teamIds = [...new Set((games ?? []).flatMap((g: any) => [g.home_team_id, g.away_team_id]))];
    const gameIds = (games ?? []).map((g: any) => g.id);
    const [{ data: teams, error: teamsError }, { data: results, error: resultsError }, { data: mappings, error: mappingsError }] = await Promise.all([
      supabase.from("teams").select("id,abbreviation,display_name,city").in("id", teamIds),
      gameIds.length ? supabase.from("game_results").select("game_id,home_score,away_score,is_final,confirmed_at").in("game_id", gameIds) : Promise.resolve({ data: [], error: null }),
      gameIds.length ? supabase.from("game_source_ids").select("game_id,source_game_id").eq("source_name", "espn").in("game_id", gameIds) : Promise.resolve({ data: [], error: null })
    ]);
    if (teamsError) throw new Error("Teams query failed: " + teamsError.message);
    if (resultsError) throw new Error("Results query failed: " + resultsError.message);
    if (mappingsError) throw new Error("Game mappings query failed: " + mappingsError.message);
    const eventIds = (mappings ?? []).map((m: any) => m.source_game_id);
    const { data: snapshots, error: snapshotsError } = eventIds.length
      ? await supabase.from("raw_source_snapshots").select("source_entity_id,payload,captured_at")
          .eq("source_name", "espn").eq("entity_type", "game").in("source_entity_id", eventIds)
          .order("captured_at", { ascending: false }).limit(eventIds.length * 5)
      : { data: [], error: null };
    if (snapshotsError) throw new Error("Live score snapshot query failed: " + snapshotsError.message);
    const teamById = new Map((teams ?? []).map((t: any) => [t.id, t]));
    const resultByGame = new Map((results ?? []).map((r: any) => [r.game_id, r]));
    const eventByGame = new Map((mappings ?? []).map((m: any) => [m.game_id, m.source_game_id]));
    const liveByEvent = new Map<string, any>();
    for (const snap of snapshots ?? []) {
      if (liveByEvent.has(snap.source_entity_id)) continue;
      const competitors = snap.payload?.competitions?.[0]?.competitors ?? [];
      const home = competitors.find((c: any) => c.homeAway === "home");
      const away = competitors.find((c: any) => c.homeAway === "away");
      liveByEvent.set(snap.source_entity_id, {
        home: home?.score == null ? null : Number(home.score),
        away: away?.score == null ? null : Number(away.score),
        captured_at: snap.captured_at
      });
    }
    const [{ data: statRows, error: statRowsError }, { data: playerRows, error: playerRowsError }] = await Promise.all([
      gameIds.length ? supabase.from("player_game_stats")
        .select("game_id,player_id,team_id,stats,captured_at")
        .in("game_id", gameIds).neq("validation_status", "rejected")
        .order("captured_at", { ascending: false }).limit(500)
        : Promise.resolve({ data: [], error: null }),
      Promise.resolve({ data: [], error: null })
    ]);
    if (statRowsError) throw new Error("Player stats query failed: " + statRowsError.message);
    const playerIds = [...new Set((statRows ?? []).map((s: any) => s.player_id))];
    const { data: playerNames, error: playerNamesError } = playerIds.length
      ? await supabase.from("players").select("id,display_name,position").in("id", playerIds)
      : { data: [], error: null };
    if (playerNamesError) throw new Error("Player names query failed: " + playerNamesError.message);
    const playerById = new Map((playerNames ?? []).map((p: any) => [p.id, p]));
    const gameById = new Map((games ?? []).map((g: any) => [g.id, g]));
    const latestStats = new Map<string, any>();
    for (const row of statRows ?? []) {
      const key = row.game_id + ":" + row.player_id;
      if (!latestStats.has(key)) latestStats.set(key, row);
    }
    const playerStatsOut = [...latestStats.values()].map((row: any) => {
      const player = playerById.get(row.player_id);
      const team = teamById.get(row.team_id);
      const game = gameById.get(row.game_id);
      return {
        game_id: row.game_id,
        player_id: row.player_id,
        player_name: player?.display_name ?? "Jugador",
        position: player?.position ?? null,
        team_abbreviation: team?.abbreviation ?? "",
        game_date: game?.scheduled_start ?? row.captured_at,
        stats: row.stats ?? {}
      };
    }).filter((row: any) => row.stats && Object.keys(row.stats).length > 0);
    const gamesOut = (games ?? []).map((g: any) => ({
      id: g.id, season: g.season, scheduled_start: g.scheduled_start, status: g.status,
      status_detail: g.status_detail, is_neutral_site: g.is_neutral_site,
      home_team: teamById.get(g.home_team_id) ?? null,
      away_team: teamById.get(g.away_team_id) ?? null,
      live_score: liveByEvent.get(eventByGame.get(g.id)) ?? null,
      result: resultByGame.get(g.id) ?? null
    }));
    const [{ count: playerStatCount, error: playerStatError }, { count: teamStatCount, error: teamStatError }] = await Promise.all([
      gameIds.length ? supabase.from("player_game_stats").select("id", { count: "exact", head: true }).in("game_id", gameIds).neq("validation_status", "rejected") : Promise.resolve({ count: 0, error: null }),
      gameIds.length ? supabase.from("team_game_stats").select("id", { count: "exact", head: true }).in("game_id", gameIds) : Promise.resolve({ count: 0, error: null })
    ]);
    if (playerStatError) throw new Error("Player stats count failed: " + playerStatError.message);
    if (teamStatError) throw new Error("Team stats count failed: " + teamStatError.message);
    return json({
      ok: true, updated_at: now.toISOString(), window: { from, to },
      games: gamesOut, player_stats: playerStatsOut, meta: {
        games: gamesOut.length, teams: teams?.length ?? 0,
        player_stat_rows: playerStatCount ?? 0, team_stat_rows: teamStatCount ?? 0
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
});