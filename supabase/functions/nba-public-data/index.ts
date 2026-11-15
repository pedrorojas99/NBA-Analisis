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
    const [{ data: teams, error: teamsError }, { data: results, error: resultsError }] = await Promise.all([
      supabase.from("teams").select("id,abbreviation,display_name,city").in("id", teamIds),
      gameIds.length ? supabase.from("game_results").select("game_id,home_score,away_score,is_final,confirmed_at").in("game_id", gameIds) : Promise.resolve({ data: [], error: null })
    ]);
    if (teamsError) throw new Error("Teams query failed: " + teamsError.message);
    if (resultsError) throw new Error("Results query failed: " + resultsError.message);
    const teamById = new Map((teams ?? []).map((t: any) => [t.id, t]));
    const resultByGame = new Map((results ?? []).map((r: any) => [r.game_id, r]));
    const gamesOut = (games ?? []).map((g: any) => ({
      id: g.id, season: g.season, scheduled_start: g.scheduled_start, status: g.status,
      status_detail: g.status_detail, is_neutral_site: g.is_neutral_site,
      home_team: teamById.get(g.home_team_id) ?? null,
      away_team: teamById.get(g.away_team_id) ?? null,
      result: resultByGame.get(g.id) ?? null
    }));
    const [{ count: playerStatCount, error: playerStatError }, { count: teamStatCount, error: teamStatError }] = await Promise.all([
      gameIds.length ? supabase.from("player_game_stats").select("id", { count: "exact", head: true }).in("game_id", gameIds) : Promise.resolve({ count: 0, error: null }),
      gameIds.length ? supabase.from("team_game_stats").select("id", { count: "exact", head: true }).in("game_id", gameIds) : Promise.resolve({ count: 0, error: null })
    ]);
    if (playerStatError) throw new Error("Player stats count failed: " + playerStatError.message);
    if (teamStatError) throw new Error("Team stats count failed: " + teamStatError.message);
    return json({
      ok: true, updated_at: now.toISOString(), window: { from, to },
      games: gamesOut, meta: {
        games: gamesOut.length, teams: teams?.length ?? 0,
        player_stat_rows: playerStatCount ?? 0, team_stat_rows: teamStatCount ?? 0
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
});