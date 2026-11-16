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
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  if (!SERVICE_KEY) return json({ ok: false, error: "Server database credentials are not configured" }, 500);
  let persistRequested = false;
  try {
    const body = await req.json();
    persistRequested = body?.persist === true;
  } catch {
    // Empty bodies preserve read-only behavior for older clients.
  }

  const supabase = createClient(PROJECT_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const futureIso = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const slateWindowStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const nbaDateFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    });
    const nbaDateKey = (value: string) => {
      const parts = Object.fromEntries(nbaDateFormatter.formatToParts(new Date(value))
        .map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };

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
          .select("game_id,home_score,away_score,is_final,confirmed_at,confirmation_sources")
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

    // Select exactly one NBA slate (Eastern Time), not an arbitrary rolling 7-day window.
    // Include recently started games so an unfinished current slate blocks the next one.
    const { data: slateWindowGames, error: upcomingError } = await supabase
      .from("games")
      .select("id,season,scheduled_start,status,home_team_id,away_team_id,is_neutral_site")
      .gte("scheduled_start", slateWindowStart)
      .lte("scheduled_start", futureIso)
      .order("scheduled_start", { ascending: true })
      .limit(250);
    if (upcomingError) throw new Error("NBA slate query failed: " + upcomingError.message);

    const nonFinalDates = [...new Set((slateWindowGames ?? [])
      .filter((game: any) => game.status !== "final")
      .map((game: any) => nbaDateKey(game.scheduled_start)))].sort();
    const slateDate = nonFinalDates[0] ?? null;
    const slateGames = slateDate
      ? (slateWindowGames ?? []).filter((game: any) => nbaDateKey(game.scheduled_start) === slateDate)
      : [];
    const slateHasStarted = slateGames.some((game: any) =>
      game.status === "in_progress" || game.status === "final" ||
      Date.parse(game.scheduled_start) <= now.getTime()
    );
    const slateStatus = !slateDate ? "no_upcoming_slate" : (slateHasStarted ? "in_progress" : "ready");
    const upcomingGames = slateStatus === "ready"
      ? slateGames.filter((game: any) => game.status === "scheduled")
      : [];

    const teamIds = [...new Set((upcomingGames ?? []).flatMap((game: any) => [game.home_team_id, game.away_team_id]))];
    const { data: teams, error: teamsError } = teamIds.length
      ? await supabase.from("teams").select("id,display_name,abbreviation").in("id", teamIds)
      : { data: [], error: null };
    if (teamsError) throw new Error("Teams query failed: " + teamsError.message);
    const teamById = new Map((teams ?? []).map((team: any) => [team.id, team]));
    let modelVersionId: string | null = null;
    if (persistRequested) {
      const { data: modelVersion, error: modelVersionError } = await supabase
        .from("model_versions").select("id").eq("version_name", "rolling-form-0.1").maybeSingle();
      if (modelVersionError || !modelVersion) {
        throw new Error("Prediction model version is not registered: " + (modelVersionError?.message ?? "missing model row"));
      }
      modelVersionId = modelVersion.id;
    }

    const forecasts: any[] = [];
    const skipped: any[] = [];
    const predictionRows: any[] = [];
    let slateForecastsReused = 0;

    // Once a slate has started, never recalculate or replace its forecasts.
    // Return the original stored snapshots so the APK can still display them.
    if (slateStatus === "in_progress" && persistRequested && modelVersionId && slateGames.length) {
      const slateGameIds = slateGames.map((game: any) => game.id);
      const { data: storedSlatePredictions, error: storedSlateError } = await supabase
        .from("predictions").select("game_id,forecast,created_at")
        .in("game_id", slateGameIds).eq("model_version_id", modelVersionId)
        .order("created_at", { ascending: false });
      if (storedSlateError) throw new Error("Current slate forecast lookup failed: " + storedSlateError.message);
      const seenGames = new Set<string>();
      for (const row of storedSlatePredictions ?? []) {
        if (seenGames.has(row.game_id)) continue;
        seenGames.add(row.game_id);
        forecasts.push(row.forecast);
        slateForecastsReused++;
      }
    }
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

      const forecast = {
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
      };
      forecasts.push(forecast);
      if (persistRequested && modelVersionId) {
        const inputSnapshot = { game_id: game.id, home_history: homeHistory, away_history: awayHistory, home_advantage: homeAdvantage };
        predictionRows.push({
          game_id: game.id, model_version_id: modelVersionId, feature_cutoff_at: nowIso,
          prediction_type: "game", target_key: "winner_and_score", forecast,
          input_snapshot_sha256: await sha256(JSON.stringify(inputSnapshot)),
        });
      }
    }

    let predictionsPersisted = 0;
    if (persistRequested && predictionRows.length) {
      for (let offset = 0; offset < predictionRows.length; offset += 50) {
        const { data: inserted, error: persistError } = await supabase.from("predictions")
          .upsert(predictionRows.slice(offset, offset + 50), {
            onConflict: "game_id,model_version_id,prediction_type,target_key,input_snapshot_sha256",
            ignoreDuplicates: true,
          }).select("id");
        if (persistError) throw new Error("Prediction history persistence failed: " + persistError.message);
        predictionsPersisted += inserted?.length ?? 0;
      }
    }

    let predictionsEvaluated = 0;
    if (persistRequested && resultByGame.size) {
      const finalGameIds = [...resultByGame.keys()];
      const { data: savedPredictions, error: savedPredictionsError } = await supabase
        .from("predictions").select("id,game_id,forecast").in("game_id", finalGameIds);
      if (savedPredictionsError) throw new Error("Prediction history lookup for evaluation failed: " + savedPredictionsError.message);
      const historicalById = new Map((historicalGames ?? []).map((game: any) => [game.id, game]));
      const evaluationRows: any[] = [];
      for (const prediction of savedPredictions ?? []) {
        const actual: any = resultByGame.get(prediction.game_id);
        const game: any = historicalById.get(prediction.game_id);
        const forecast: any = prediction.forecast ?? {};
        if (!actual || !game) continue;
        const predictedHome = Number(forecast.predicted_home_score);
        const predictedAway = Number(forecast.predicted_away_score);
        const homeWinProbability = Number(forecast.home_win_probability) / 100;
        if (!Number.isFinite(predictedHome) || !Number.isFinite(predictedAway) ||
            !Number.isFinite(homeWinProbability) || homeWinProbability < 0 || homeWinProbability > 1) continue;
        const actualHome = Number(actual.home_score);
        const actualAway = Number(actual.away_score);
        const actualHomeWin = actualHome > actualAway;
        const predictedHomeWin = homeWinProbability >= 0.5;
        const actualMargin = actualHome - actualAway;
        const predictedMargin = predictedHome - predictedAway;
        evaluationRows.push({
          prediction_id: prediction.id,
          actual: {
            game_id: prediction.game_id,
            home_team_id: game.home_team_id,
            away_team_id: game.away_team_id,
            home_score: actualHome,
            away_score: actualAway,
            winner_team_id: actualHomeWin ? game.home_team_id : game.away_team_id,
            confirmed_at: actual.confirmed_at,
          },
          error_metrics: {
            winner_correct: predictedHomeWin === actualHomeWin,
            home_score_abs_error: Number(Math.abs(predictedHome - actualHome).toFixed(2)),
            away_score_abs_error: Number(Math.abs(predictedAway - actualAway).toFixed(2)),
            total_score_abs_error: Number(Math.abs((predictedHome + predictedAway) - (actualHome + actualAway)).toFixed(2)),
            margin_abs_error: Number(Math.abs(predictedMargin - actualMargin).toFixed(2)),
            brier_score: Number(((homeWinProbability - (actualHomeWin ? 1 : 0)) ** 2).toFixed(4)),
            predicted_home_win_probability: Number((homeWinProbability * 100).toFixed(1)),
          },
          result_source_names: Array.isArray(actual.confirmation_sources) && actual.confirmation_sources.length
            ? actual.confirmation_sources : ["unknown"],
        });
      }
      for (let offset = 0; offset < evaluationRows.length; offset += 50) {
        const { data: inserted, error: evaluationError } = await supabase.from("prediction_evaluations")
          .upsert(evaluationRows.slice(offset, offset + 50), {
            onConflict: "prediction_id",
            ignoreDuplicates: true,
          }).select("id");
        if (evaluationError) throw new Error("Prediction evaluation persistence failed: " + evaluationError.message);
        predictionsEvaluated += inserted?.length ?? 0;
      }
    }

    return json({
      ok: true,
      generated_at: nowIso,
      model: {
        version: "rolling-form-0.1",
        name: "Rolling Form Baseline",
        description: "Pronostica únicamente la próxima jornada NBA (fecha de calendario en hora del Este). Espera al cierre de la jornada en curso; usa los últimos 10 partidos finalizados de cada equipo, con ventaja local de 2 puntos.",
        minimum_games_per_team: 5,
        probability_method: "Logística sobre diferencia estimada de puntos; no calibrada aún.",
        status: "experimental",
      },
      forecasts,
      skipped,
      meta: {
        historical_final_games: results?.length ?? 0,
        teams_with_history: teamHistory.size,
        upcoming_games: upcomingGames.length,
        slate_date: slateDate,
        slate_status: slateStatus,
        slate_games: slateGames.length,
        slate_forecasts_reused: slateForecastsReused,
        forecasts_generated: forecasts.length,
        games_skipped: skipped.length,
        persistence_requested: persistRequested,
        predictions_persisted: predictionsPersisted,
        predictions_evaluated: predictionsEvaluated,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
});
