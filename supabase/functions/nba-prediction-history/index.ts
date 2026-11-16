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
    const evaluated = forecasts.filter((item: any) => item.evaluated_at != null).length;
    return json({ ok: true, forecasts, meta: {
      total_predictions: forecasts.length, evaluated_predictions: evaluated,
      pending_evaluations: forecasts.length - evaluated, limit: 100,
    } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
});
