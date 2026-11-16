import { createClient } from "npm:@supabase/supabase-js@2";
const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!SERVICE_KEY) return json({ ok: false, error: "Server database credentials are not configured" }, 500);
  const supabase = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data: predictions, error: predictionsError } = await supabase.from("predictions")
      .select("id,game_id,created_at,feature_cutoff_at,forecast,model_version_id")
      .order("created_at", { ascending: false }).limit(100);
    if (predictionsError) throw new Error("Prediction history query failed: " + predictionsError.message);
    const rows = predictions ?? [];
    const gameIds = [...new Set(rows.map((row: any) => row.game_id))];
    const predictionIds = rows.map((row: any) => row.id);
    const { data: games, error: gamesError } = gameIds.length
      ? await supabase.from("games").select("id,scheduled_start,home_team_id,away_team_id").in("id", gameIds)
      : { data: [], error: null };
    if (gamesError) throw new Error("Game details query failed: " + gamesError.message);
    const teamIds = [...new Set((games ?? []).flatMap((game: any) => [game.home_team_id, game.away_team_id]))];
    const { data: teams, error: teamsError } = teamIds.length
      ? await supabase.from("teams").select("id,display_name,abbreviation").in("id", teamIds)
      : { data: [], error: null };
    if (teamsError) throw new Error("Team details query failed: " + teamsError.message);
    const { data: evaluations, error: evaluationsError } = predictionIds.length
      ? await supabase.from("prediction_evaluations")
          .select("prediction_id,evaluated_at,actual,error_metrics,result_source_names")
          .in("prediction_id", predictionIds)
      : { data: [], error: null };
    if (evaluationsError) throw new Error("Prediction evaluations query failed: " + evaluationsError.message);

    const gameById = new Map((games ?? []).map((game: any) => [game.id, game]));
    const teamById = new Map((teams ?? []).map((team: any) => [team.id, team]));
    const evaluationByPrediction = new Map((evaluations ?? []).map((item: any) => [item.prediction_id, item]));
    const forecasts = rows.map((row: any) => {
      const game: any = gameById.get(row.game_id);
      const home: any = game ? teamById.get(game.home_team_id) : null;
      const away: any = game ? teamById.get(game.away_team_id) : null;
      const forecast: any = row.forecast ?? {};
      const evaluation: any = evaluationByPrediction.get(row.id);
      return {
        id: row.id,
        game_id: row.game_id,
        created_at: row.created_at,
        feature_cutoff_at: row.feature_cutoff_at,
        scheduled_start: game?.scheduled_start ?? forecast.scheduled_start ?? null,
        home_team: home?.display_name ?? forecast.home_team ?? "Local",
        away_team: away?.display_name ?? forecast.away_team ?? "Visitante",
        home_abbreviation: home?.abbreviation ?? forecast.home_abbreviation ?? "",
        away_abbreviation: away?.abbreviation ?? forecast.away_abbreviation ?? "",
        predicted_home_score: forecast.predicted_home_score ?? null,
        predicted_away_score: forecast.predicted_away_score ?? null,
        predicted_winner: forecast.predicted_winner ?? null,
        home_win_probability: forecast.home_win_probability ?? null,
        away_win_probability: forecast.away_win_probability ?? null,
        model_version: forecast.model_version ?? "unknown",
        evaluated_at: evaluation?.evaluated_at ?? null,
        actual: evaluation?.actual ?? null,
        error_metrics: evaluation?.error_metrics ?? null,
        result_source_names: evaluation?.result_source_names ?? [],
      };
    });
    const evaluatedForecasts = forecasts.filter((item: any) => item.evaluated_at != null && item.actual);
    const teamStats = new Map<string, any>();
    const getTeamStats = (teamId: string, team: any) => {
      if (!teamStats.has(teamId)) {
        teamStats.set(teamId, {
          team_id: teamId,
          team: team?.display_name ?? "Equipo",
          abbreviation: team?.abbreviation ?? "",
          games: 0, home_games: 0, away_games: 0,
          winner_picks_correct: 0,
          predicted_points_sum: 0, actual_points_sum: 0,
          points_abs_error_sum: 0, points_signed_error_sum: 0,
          opponent_points_abs_error_sum: 0,
          margin_abs_error_sum: 0,
        });
      }
      return teamStats.get(teamId);
    };
    for (const item of evaluatedForecasts) {
      const game: any = gameById.get(item.game_id);
      const actual: any = item.actual ?? {};
      const homeId = game?.home_team_id ?? actual.home_team_id;
      const awayId = game?.away_team_id ?? actual.away_team_id;
      const homeTeam: any = homeId ? teamById.get(homeId) : null;
      const awayTeam: any = awayId ? teamById.get(awayId) : null;
      const actualHome = Number(actual.home_score);
      const actualAway = Number(actual.away_score);
      const predictedHome = Number(item.predicted_home_score);
      const predictedAway = Number(item.predicted_away_score);
      const homeProbability = Number(item.home_win_probability);
      if (!homeId || !awayId || ![actualHome, actualAway, predictedHome, predictedAway, homeProbability].every(Number.isFinite)) continue;
      const actualHomeWon = actualHome > actualAway;
      const predictedHomeWon = homeProbability >= 50;
      const marginError = Math.abs((predictedHome - predictedAway) - (actualHome - actualAway));
      const addTeamSide = (teamId: string, team: any, isHome: boolean) => {
        const stats = getTeamStats(teamId, team);
        const predictedFor = isHome ? predictedHome : predictedAway;
        const actualFor = isHome ? actualHome : actualAway;
        const predictedAgainst = isHome ? predictedAway : predictedHome;
        const actualAgainst = isHome ? actualAway : actualHome;
        const pickedTeamWon = isHome ? predictedHomeWon : !predictedHomeWon;
        const teamActuallyWon = isHome ? actualHomeWon : !actualHomeWon;
        stats.games++;
        if (isHome) stats.home_games++; else stats.away_games++;
        if (pickedTeamWon === teamActuallyWon) stats.winner_picks_correct++;
        stats.predicted_points_sum += predictedFor;
        stats.actual_points_sum += actualFor;
        stats.points_abs_error_sum += Math.abs(predictedFor - actualFor);
        stats.points_signed_error_sum += predictedFor - actualFor;
        stats.opponent_points_abs_error_sum += Math.abs(predictedAgainst - actualAgainst);
        stats.margin_abs_error_sum += marginError;
      };
      addTeamSide(homeId, homeTeam, true);
      addTeamSide(awayId, awayTeam, false);
    }
    const teamAnalysis = [...teamStats.values()].map((stats: any) => ({
      team_id: stats.team_id,
      team: stats.team,
      abbreviation: stats.abbreviation,
      games_evaluated: stats.games,
      home_games: stats.home_games,
      away_games: stats.away_games,
      winner_accuracy_pct: Number((100 * stats.winner_picks_correct / stats.games).toFixed(1)),
      mean_predicted_points: Number((stats.predicted_points_sum / stats.games).toFixed(1)),
      mean_actual_points: Number((stats.actual_points_sum / stats.games).toFixed(1)),
      points_mae: Number((stats.points_abs_error_sum / stats.games).toFixed(2)),
      points_bias: Number((stats.points_signed_error_sum / stats.games).toFixed(2)),
      opponent_points_mae: Number((stats.opponent_points_abs_error_sum / stats.games).toFixed(2)),
      margin_mae: Number((stats.margin_abs_error_sum / stats.games).toFixed(2)),
    })).sort((a: any, b: any) => b.games_evaluated - a.games_evaluated || b.points_mae - a.points_mae);
    // Select the most recent NBA date for which every saved forecast has a final evaluation.
    const nbaDate = (value: string) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(value));
      const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
      return `${part("year")}-${part("month")}-${part("day")}`;
    };
    const slateGroups = new Map<string, any[]>();
    for (const item of forecasts) {
      if (!item.scheduled_start) continue;
      const date = nbaDate(item.scheduled_start);
      if (!slateGroups.has(date)) slateGroups.set(date, []);
      slateGroups.get(date)!.push(item);
    }
    const completedSlates = [...slateGroups.entries()]
      .filter(([, items]) => items.length > 0 && items.every((item: any) => item.evaluated_at != null && item.actual != null))
      .sort((a, b) => b[0].localeCompare(a[0]));
    const previousSlateEntry = completedSlates[0] ?? null;
    const previousSlateGames = previousSlateEntry?.[1] ?? [];
    const previousSlateCorrect = previousSlateGames.filter((item: any) => item.error_metrics?.winner_correct === true).length;
    const scoreErrors = previousSlateGames.map((item: any) => {
      const home = Number(item.error_metrics?.home_score_abs_error);
      const away = Number(item.error_metrics?.away_score_abs_error);
      return Number.isFinite(home) && Number.isFinite(away) ? (home + away) / 2 : null;
    }).filter((value: number | null): value is number => value != null);
    const marginErrors = previousSlateGames.map((item: any) => Number(item.error_metrics?.margin_abs_error))
      .filter((value: number) => Number.isFinite(value));
    const average = (values: number[]) => values.length
      ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
      : null;
    const previousSlate = previousSlateEntry ? {
      date: previousSlateEntry[0],
      games: previousSlateGames,
      summary: {
        total_games: previousSlateGames.length,
        winner_correct: previousSlateCorrect,
        winner_accuracy_pct: Number((100 * previousSlateCorrect / previousSlateGames.length).toFixed(1)),
        average_score_error: average(scoreErrors),
        average_margin_error: average(marginErrors),
      },
    } : null;
    const evaluated = evaluatedForecasts.length;
    return json({ ok: true, forecasts, previous_slate: previousSlate, team_analysis: teamAnalysis, meta: {
      total_predictions: forecasts.length, evaluated_predictions: evaluated,
      pending_evaluations: forecasts.length - evaluated, teams_analyzed: teamAnalysis.length,
      team_analysis_scope: "last_100_forecasts", limit: 100,
    } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
});
