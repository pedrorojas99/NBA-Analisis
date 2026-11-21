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
  box?: Record<string, number>;
};

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const parseDisplayNumber = (value: unknown) => {
  const n = Number(String(value ?? "").replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
};
const parseTeamBox = (raw: any): Record<string, number> | null => {
  const entries = raw?.statistics;
  if (!Array.isArray(entries)) return null;
  const byName = new Map(entries.map((entry: any) => [entry.name, String(entry.displayValue ?? "")]));
  const pair = (key: string) => {
    const value = byName.get(key);
    if (typeof value !== "string" || !value.includes("-")) return null;
    const [made, attempted] = value.split("-").map(Number);
    return Number.isFinite(made) && Number.isFinite(attempted) ? [made, attempted] : null;
  };
  const fg = pair("fieldGoalsMade-fieldGoalsAttempted");
  const threes = pair("threePointFieldGoalsMade-threePointFieldGoalsAttempted");
  const ft = pair("freeThrowsMade-freeThrowsAttempted");
  const read = (key: string) => parseDisplayNumber(byName.get(key));
  const values: Record<string, number | null> = {
    fgm: fg?.[0] ?? null, fga: fg?.[1] ?? null, fg_pct: read("fieldGoalPct"),
    threes_made: threes?.[0] ?? null, threes_attempted: threes?.[1] ?? null, three_pct: read("threePointFieldGoalPct"),
    ftm: ft?.[0] ?? null, fta: ft?.[1] ?? null, ft_pct: read("freeThrowPct"),
    rebounds: read("totalRebounds"), offensive_rebounds: read("offensiveRebounds"),
    defensive_rebounds: read("defensiveRebounds"), assists: read("assists"),
    steals: read("steals"), blocks: read("blocks"), turnovers: read("turnovers"),
    points_in_paint: read("pointsInPaint"), fast_break_points: read("fastBreakPoints"),
  };
  const required = ["fgm","fga","threes_made","threes_attempted","ftm","fta","rebounds","assists","turnovers"];
  if (required.some((key) => values[key] === null)) return null;
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== null));
};
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
    const requested = body?.persist === true;
    const automationToken = req.headers.get("x-automation-token") ?? "";
    const automationHash = automationToken ? await sha256(automationToken) : "";
    const { data: automationRecord, error: automationError } = await supabase
      .from("internal_automation_tokens").select("token_hash").eq("name", "nba-slate-gate").maybeSingle();
    const automationAuthorized = !automationError && !!automationRecord?.token_hash &&
      automationHash === automationRecord.token_hash;
    if (requested && !automationAuthorized) {
      return json({ ok: false, error: "Persistence is restricted to authorized server automation." }, 403);
    }
    persistRequested = requested && automationAuthorized;
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
    // Keep PostgREST request URLs small: hundreds of UUIDs in one .in() filter
    // can exceed gateway/request-line limits and make the prediction endpoint fail.
    const results: any[] = [];
    for (let offset = 0; offset < historicalIds.length; offset += 100) {
      const batchIds = historicalIds.slice(offset, offset + 100);
      const { data: batchResults, error: resultsError } = await supabase.from("game_results")
        .select("game_id,home_score,away_score,is_final,confirmed_at,confirmation_sources")
        .in("game_id", batchIds).eq("is_final", true);
      if (resultsError) throw new Error("Final results query failed (batch " + Math.floor(offset / 100 + 1) + "): " + resultsError.message);
      results.push(...(batchResults ?? []));
    }

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
    // Attach ESPN team boxscores to the same final-game history; pending rows are
    // explicitly labelled provisional until cross-source validation is completed.
    const boxRows: any[] = [];
    for (let offset = 0; offset < historicalIds.length; offset += 100) {
      const { data, error } = await supabase.from("team_game_stats")
        .select("game_id,team_id,stats,validation_status")
        .in("game_id", historicalIds.slice(offset, offset + 100))
        .neq("validation_status", "rejected");
      if (error) throw new Error("Historical team boxscores query failed: " + error.message);
      boxRows.push(...(data ?? []));
    }
    const boxByGameTeam = new Map<string, any>();
    for (const row of boxRows) {
      const parsed = parseTeamBox(row.stats);
      if (parsed) boxByGameTeam.set(`${row.game_id}:${row.team_id}`, { stats: parsed, validation: row.validation_status ?? "pending" });
    }
    for (const game of historicalGames ?? []) {
      const home = teamHistory.get(game.home_team_id)?.find((row) => row.date === Date.parse(game.scheduled_start));
      const away = teamHistory.get(game.away_team_id)?.find((row) => row.date === Date.parse(game.scheduled_start));
      const homeBox = boxByGameTeam.get(`${game.id}:${game.home_team_id}`);
      const awayBox = boxByGameTeam.get(`${game.id}:${game.away_team_id}`);
      if (home && homeBox) home.box = homeBox.stats;
      if (away && awayBox) away.box = awayBox.stats;
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
        .from("model_versions").select("id").eq("version_name", "complete-boxscore-0.3").maybeSingle();
      if (modelVersionError || !modelVersion) {
        throw new Error("Prediction model version is not registered: " + (modelVersionError?.message ?? "missing model row"));
      }
      modelVersionId = modelVersion.id;
    }

    // Team-level feedback: learn only from prior, settled forecasts; require 15 samples
    // and cap the correction so the established team baseline is not destabilized.
    const teamBias = new Map<string, number[]>();
    if (persistRequested && modelVersionId) {
      const priorPredictions: any[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase.from("predictions")
          .select("id,game_id,forecast")
          .eq("prediction_type", "game")
          .order("created_at", { ascending: false }).range(offset, offset + 499);
        if (error) throw new Error("Prior team forecasts lookup failed: " + error.message);
        priorPredictions.push(...(data ?? []));
        if (!data || data.length < 500 || priorPredictions.length >= 2000) break;
      }
      const priorIds = [...new Set(priorPredictions.map((row: any) => row.game_id))];
      const priorGames: any[] = [];
      for (let offset = 0; offset < priorIds.length; offset += 100) {
        const { data, error } = await supabase.from("games")
          .select("id,scheduled_start,home_team_id,away_team_id")
          .in("id", priorIds.slice(offset, offset + 100));
        if (error) throw new Error("Prior team game lookup failed: " + error.message);
        priorGames.push(...(data ?? []));
      }
      const priorGameById = new Map(priorGames.map((game: any) => [game.id, game]));
      const priorPredictionIds = priorPredictions.map((row: any) => row.id);
      const priorEvaluations: any[] = [];
      for (let offset = 0; offset < priorPredictionIds.length; offset += 100) {
        const { data, error } = await supabase.from("prediction_evaluations")
          .select("prediction_id,actual")
          .in("prediction_id", priorPredictionIds.slice(offset, offset + 100));
        if (error) throw new Error("Prior team evaluation lookup failed: " + error.message);
        priorEvaluations.push(...(data ?? []));
      }
      const evalByPrediction = new Map(priorEvaluations.map((item: any) => [item.prediction_id, item]));
      for (const prediction of priorPredictions) {
        const game: any = priorGameById.get(prediction.game_id);
        const evaluation: any = evalByPrediction.get(prediction.id);
        const forecast: any = prediction.forecast ?? {};
        if (!game || Date.parse(game.scheduled_start) >= now.getTime() || !evaluation?.actual) continue;
        const actualHome = Number(evaluation.actual.home_score);
        const actualAway = Number(evaluation.actual.away_score);
        const predictedHome = Number(forecast.predicted_home_score);
        const predictedAway = Number(forecast.predicted_away_score);
        if (![actualHome, actualAway, predictedHome, predictedAway].every(Number.isFinite)) continue;
        for (const [teamId, errorValue] of [
          [game.home_team_id, predictedHome - actualHome],
          [game.away_team_id, predictedAway - actualAway],
        ] as [string, number][]) {
          teamBias.set(teamId, [...(teamBias.get(teamId) ?? []), errorValue].slice(-20));
        }
      }
    }

    const forecasts: any[] = [];
    const skipped: any[] = [];
    const predictionRows: any[] = [];
    let slateForecastsReused = 0;

    // Reuse the newest immutable forecast for every game in the current slate.
    // This prevents each 15-minute cron run from creating another snapshot for the same game.
    // If the slate has started, only stored forecasts are returned; no late recalculation is allowed.
    const seenGames = new Set<string>();
    if (persistRequested && modelVersionId && slateGames.length) {
      const slateGameIds = slateGames.map((game: any) => game.id);
      const { data: storedSlatePredictions, error: storedSlateError } = await supabase
        .from("predictions").select("game_id,forecast,created_at")
        .in("game_id", slateGameIds)
        .eq("model_version_id", modelVersionId)
        .eq("prediction_type", "game")
        .eq("target_key", "winner_and_score")
        .order("created_at", { ascending: false });
      if (storedSlateError) throw new Error("Current slate forecast lookup failed: " + storedSlateError.message);
      for (const row of storedSlatePredictions ?? []) {
        if (seenGames.has(row.game_id)) continue;
        seenGames.add(row.game_id);
        forecasts.push(row.forecast);
        slateForecastsReused++;
      }
    }
    for (const game of upcomingGames ?? []) {
      if (seenGames.has(game.id)) continue;
      const homeHistory = (teamHistory.get(game.home_team_id) ?? []).slice(0, 10);
      const awayHistory = (teamHistory.get(game.away_team_id) ?? []).slice(0, 10);
      const home = teamById.get(game.home_team_id) as any;
      const away = teamById.get(game.away_team_id) as any;
      if (homeHistory.length < 3 || awayHistory.length < 3) {
        skipped.push({
          game_id: game.id,
          reason: "Insufficient history: each team needs at least 3 final games",
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

      const baselineHome = (homeFor + awayAgainst) / 2 + homeAdvantage;
      const baselineAway = (awayFor + homeAgainst) / 2;
      const homeErrors = teamBias.get(game.home_team_id) ?? [];
      const awayErrors = teamBias.get(game.away_team_id) ?? [];
      const homeCorrection = homeErrors.length >= 15 ? clamp(mean(homeErrors) * 0.25, -2, 2) : 0;
      const awayCorrection = awayErrors.length >= 15 ? clamp(mean(awayErrors) * 0.25, -2, 2) : 0;
      const predictedHome = Math.max(0, baselineHome - homeCorrection);
      const predictedAway = Math.max(0, baselineAway - awayCorrection);
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
        learning_adjustments: {
          home_points: Number(homeCorrection.toFixed(2)),
          away_points: Number(awayCorrection.toFixed(2)),
        },
        learning_samples: { home: homeErrors.length, away: awayErrors.length },
        team_boxscore: {
          home: Object.fromEntries(["fgm","fga","fg_pct","threes_made","threes_attempted","three_pct","ftm","fta","ft_pct","rebounds","offensive_rebounds","defensive_rebounds","assists","steals","blocks","turnovers","points_in_paint","fast_break_points"].map((key) => [key, Number(mean(homeHistory.filter((row) => row.box?.[key] !== undefined).map((row) => row.box![key]).slice(0,10)).toFixed(1))])),
          away: Object.fromEntries(["fgm","fga","fg_pct","threes_made","threes_attempted","three_pct","ftm","fta","ft_pct","rebounds","offensive_rebounds","defensive_rebounds","assists","steals","blocks","turnovers","points_in_paint","fast_break_points"].map((key) => [key, Number(mean(awayHistory.filter((row) => row.box?.[key] !== undefined).map((row) => row.box![key]).slice(0,10)).toFixed(1))])),
          home_boxscore_samples: homeHistory.filter((row) => row.box).length,
          away_boxscore_samples: awayHistory.filter((row) => row.box).length,
          source: "ESPN final boxscores",
          validation: "provisional_pending_cross_source_validation",
        },
        model_version: "complete-boxscore-0.3",
        model_type: "experimental_team_boxscore_baseline",
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
            onConflict: "game_id,model_version_id,prediction_type,target_key",
            ignoreDuplicates: true,
          }).select("id");
        if (persistError) throw new Error("Prediction history persistence failed: " + persistError.message);
        predictionsPersisted += inserted?.length ?? 0;
      }
    }

    let predictionsEvaluated = 0;
    if (persistRequested && resultByGame.size) {
      const finalGameIds = [...resultByGame.keys()];
      const savedPredictions: any[] = [];
      for (let offset = 0; offset < finalGameIds.length; offset += 100) {
        const batchIds = finalGameIds.slice(offset, offset + 100);
        const { data: batchPredictions, error: savedPredictionsError } = await supabase
          .from("predictions").select("id,game_id,forecast").in("game_id", batchIds);
        if (savedPredictionsError) throw new Error("Prediction history lookup for evaluation failed (batch " + Math.floor(offset / 100 + 1) + "): " + savedPredictionsError.message);
        savedPredictions.push(...(batchPredictions ?? []));
      }
      const historicalById = new Map((historicalGames ?? []).map((game: any) => [game.id, game]));
      const finalBoxRows: any[] = [];
      for (let offset = 0; offset < finalGameIds.length; offset += 100) {
        const { data, error } = await supabase.from("team_game_stats")
          .select("game_id,team_id,stats,validation_status")
          .in("game_id", finalGameIds.slice(offset, offset + 100))
          .neq("validation_status", "rejected");
        if (error) throw new Error("Final team boxscores lookup failed: " + error.message);
        finalBoxRows.push(...(data ?? []));
      }
      const actualTeamBoxByGame = new Map<string, any>();
      for (const row of finalBoxRows) {
        const parsed = parseTeamBox(row.stats);
        if (!parsed) continue;
        const existing = actualTeamBoxByGame.get(row.game_id) ?? {};
        existing[row.team_id] = { stats: parsed, validation_status: row.validation_status ?? "pending" };
        actualTeamBoxByGame.set(row.game_id, existing);
      }
      const evaluationRows: any[] = [];
      for (const prediction of savedPredictions) {
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
        const teamBoxes = actualTeamBoxByGame.get(prediction.game_id) ?? {};
        const actualHomeBox = teamBoxes[game.home_team_id];
        const actualAwayBox = teamBoxes[game.away_team_id];
        const usesTeamBoxscoreModel = forecast.model_version === "complete-boxscore-0.3";
        // Do not permanently settle a complete-boxscore forecast until both teams'
        // final boxscores are present; the next scheduled sync will retry it.
        if (usesTeamBoxscoreModel && (!actualHomeBox || !actualAwayBox)) continue;
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
            ...(actualHomeBox && actualAwayBox ? {
              team_boxscore: {
                home: actualHomeBox.stats,
                away: actualAwayBox.stats,
                validation: {
                  home: actualHomeBox.validation_status,
                  away: actualAwayBox.validation_status,
                },
              },
            } : {}),
          },
          error_metrics: {
            winner_correct: predictedHomeWin === actualHomeWin,
            home_score_abs_error: Number(Math.abs(predictedHome - actualHome).toFixed(2)),
            away_score_abs_error: Number(Math.abs(predictedAway - actualAway).toFixed(2)),
            total_score_abs_error: Number(Math.abs((predictedHome + predictedAway) - (actualHome + actualAway)).toFixed(2)),
            margin_abs_error: Number(Math.abs(predictedMargin - actualMargin).toFixed(2)),
            brier_score: Number(((homeWinProbability - (actualHomeWin ? 1 : 0)) ** 2).toFixed(4)),
            predicted_home_win_probability: Number((homeWinProbability * 100).toFixed(1)),
            ...(forecast.team_boxscore && actualHomeBox && actualAwayBox ? {
              team_boxscore_abs_error: {
                home: Object.fromEntries(Object.keys(forecast.team_boxscore.home ?? {}).filter((key) => typeof forecast.team_boxscore.home[key] === "number" && typeof actualHomeBox.stats[key] === "number").map((key) => [key, Number(Math.abs(forecast.team_boxscore.home[key] - actualHomeBox.stats[key]).toFixed(2))])),
                away: Object.fromEntries(Object.keys(forecast.team_boxscore.away ?? {}).filter((key) => typeof forecast.team_boxscore.away[key] === "number" && typeof actualAwayBox.stats[key] === "number").map((key) => [key, Number(Math.abs(forecast.team_boxscore.away[key] - actualAwayBox.stats[key]).toFixed(2))])),
              },
              team_boxscore_validation: { home: actualHomeBox.validation_status, away: actualAwayBox.validation_status },
            } : {}),
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
        version: "complete-boxscore-0.3",
        name: "Complete Boxscore Rolling Form",
        description: "Predice marcador, ganador y promedios de estadísticas colectivas de los últimos 10 boxscores ESPN finalizados por equipo. Los boxscores aún pendientes de validación cruzada se marcan como provisionales.",
        minimum_games_per_team: 3,
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
    console.error("nba-predictions failed:", message);
    return json({ ok: false, error: message }, 502);
  }
});
