import { createClient } from "npm:@supabase/supabase-js@2";

const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

type TeamGame = {
  date: number;
  pointsFor: number;
  pointsAgainst: number;
  won: boolean;
};

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  if (!SERVICE_KEY) return json({ ok: false, error: "Server database credentials are not configured" }, 500);

  const supabase = createClient(PROJECT_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const futureIso = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: historicalGames, error: historyError } = await supabase
      .from("games")
      .select("id,scheduled_start,home_team_id,away_team_id")
      .lt("scheduled_start", nowIso)
      .order("scheduled_start", { ascending: false })
      .limit(2000);
    if (historyError) throw new Error("Historical games query failed: " + historyError.message);

    const historicalIds = (historicalGames ?? []).map((game: any) => game.id);
    const { data: results, error: resultsError } = historicalIds.length
      ? await supabase.from("game_results")
          .select("game_id,home_score,away_score,is_final")
          .in("game_id", historicalIds).eq("is_final", true)
      : { data: [], error: null };
    if (resultsError) throw new Error("Final results query failed: " + resultsError.message);

    const resultByGame = new Map((results ?? []).map((result: any) => [result.game_id, result]));
    const teamHistory = new Map<string, TeamGame[]>();
    const addTeamGame = (teamId: string, row: TeamGame) => {
      if (!teamHistory.has(teamId)) teamHistory.set(teamId, []);
      teamHistory.get(teamId)!.push(row);
    };

    for (const game of historicalGames ?? []) {
      const result: any = resultByGame.get(game.id);
      if (!result) continue;
      const date = Date.parse(game.scheduled_start);
      const home = Number(result.home_score);
      const away = Number(result.away_score);
      if (!Number.isFinite(home) || !Number.isFinite(away) || home < 0 || away < 0 || home === away) continue;
      addTeamGame(game.home_team_id, { date, pointsFor: home, pointsAgainst: away, won: home > away });
      addTeamGame(game.away_team_id, { date, pointsFor: away, pointsAgainst: home, won: away > home });
    }
    for (const rows of teamHistory.values()) rows.sort((a, b) => b.date - a.date);

    const { data: upcomingGames, error: upcomingError } = await supabase
      .from("games")
      .select("id,season,scheduled_start,status,home_team_id,away_team_id,is_neutral_site")
      .gte("scheduled_start", nowIso)
      .lte("scheduled_start", futureIso)
      .eq("status", "scheduled")
      .order("scheduled_start", { ascending: true })
      .limit(50);
    if (upcomingError) throw new Error("Upcoming games query failed: " + upcomingError.message);

    const teamIds = [...new Set((upcomingGames ?? []).flatMap((game: any) => [game.home_team_id, game.away_team_id]))];
    const { data: teams, error: teamsError } = teamIds.length
      ? await supabase.from("teams").select("id,display_name,abbreviation").in("id", teamIds)
      : { data: [], error: null };
    if (teamsError) throw new Error("Teams query failed: " + teamsError.message);
    const teamById = new Map((teams ?? []).map((team: any) => [team.id, team]));

    const forecasts: any[] = [];
    const skipped: any[] = [];
    for (const game of upcomingGames ?? []) {
      const homeHistory = (teamHistory.get(game.home_team_id) ?? []).slice(0, 10);
      const awayHistory = (teamHistory.get(game.away_team_id) ?? []).slice(0, 10);
      const home = teamById.get(game.home_team_id) as any;
      const away = teamById.get(game.away_team_id) as any;
      if (homeHistory.length < 5 || awayHistory.length < 5) {
        skipped.push({
          game_id: game.id,
          reason: "Insufficient history: each team needs at least 5 final games",
          home_sample: homeHistory.length,
          away_sample: awayHistory.length,
        });
        continue;
      }

      const homeFor = mean(homeHistory.map((row) => row.pointsFor));
      const homeAgainst = mean(homeHistory.map((row) => row.pointsAgainst));
      const awayFor = mean(awayHistory.map((row) => row.pointsFor));
      const awayAgainst = mean(awayHistory.map((row) => row.pointsAgainst));
      const homeWins = homeHistory.filter((row) => row.won).length;
      const awayWins = awayHistory.filter((row) => row.won).length;
      const homeAdvantage = game.is_neutral_site ? 0 : 2.0;

      const predictedHome = (homeFor + awayAgainst) / 2 + homeAdvantage;
      const predictedAway = (awayFor + homeAgainst) / 2;
      const margin = predictedHome - predictedAway;
      const homeWinProbability = clamp(1 / (1 + Math.exp(-margin / 7.5)), 0.05, 0.95);

      forecasts.push({
        game_id: game.id,
        scheduled_start: game.scheduled_start,
        home_team: home?.display_name ?? "Local",
        away_team: away?.display_name ?? "Visitante",
        home_abbreviation: home?.abbreviation ?? "",
        away_abbreviation: away?.abbreviation ?? "",
        predicted_home_score: Number(predictedHome.toFixed(1)),
        predicted_away_score: Number(predictedAway.toFixed(1)),
        predicted_winner: margin >= 0 ? (home?.display_name ?? "Local") : (away?.display_name ?? "Visitante"),
        home_win_probability: Number((homeWinProbability * 100).toFixed(1)),
        away_win_probability: Number(((1 - homeWinProbability) * 100).toFixed(1)),
        expected_margin: Number(margin.toFixed(1)),
        home_recent_record: `${homeWins}-${homeHistory.length - homeWins}`,
        away_recent_record: `${awayWins}-${awayHistory.length - awayWins}`,
        home_sample: homeHistory.length,
        away_sample: awayHistory.length,
        model_version: "rolling-form-0.1",
        model_type: "experimental_statistical_baseline",
        feature_cutoff_at: nowIso,
      });
    }

    return json({
      ok: true,
      generated_at: nowIso,
      model: {
        version: "rolling-form-0.1",
        name: "Rolling Form Baseline",
        description: "Promedio de puntos anotados y permitidos en los últimos 10 partidos finalizados, con ventaja local de 2 puntos.",
        minimum_games_per_team: 5,
        probability_method: "Logística sobre diferencia estimada de puntos; no calibrada aún.",
        status: "experimental",
      },
      forecasts,
      skipped,
      meta: {
        historical_final_games: results?.length ?? 0,
        teams_with_history: teamHistory.size,
        upcoming_games: upcomingGames?.length ?? 0,
        forecasts_generated: forecasts.length,
        games_skipped: skipped.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
});
