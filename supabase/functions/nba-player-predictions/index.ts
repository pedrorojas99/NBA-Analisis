import { createClient } from "npm:@supabase/supabase-js@2";

const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const MODEL_VERSION = "player-impact-top2-0.2";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value: number) => Number(value.toFixed(1));
const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function valuesFromStats(stats: any): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const category of stats?.categories ?? []) {
    if (category?.values && typeof category.values === "object") Object.assign(values, category.values);
  }
  if (stats?.values && typeof stats.values === "object") Object.assign(values, stats.values);
  // ESPN's persisted player_game_stats rows often store boxscore fields directly
  // (MIN, PTS, REB, AST, 3PT), not under categories/values.
  if (stats && typeof stats === "object" && !Array.isArray(stats)) {
    for (const [key, value] of Object.entries(stats)) {
      if ((typeof value === "string" || typeof value === "number") && !(key in values)) values[key] = value;
    }
  }
  return values;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function madeThrees(value: unknown): number | null {
  if (typeof value === "string" && value.includes("-")) return numeric(value.split("-")[0]);
  return numeric(value);
}

function normalizedStatRow(stats: any) {
  const values = valuesFromStats(stats);
  const minutes = numeric(values.MIN);
  const points = numeric(values.PTS);
  const rebounds = numeric(values.REB);
  const assists = numeric(values.AST);
  const threes = madeThrees(values["3PT"]);
  if (minutes === null || points === null || rebounds === null || assists === null || threes === null) return null;
  if (minutes <= 0 || minutes > 80 || points < 0 || points > 100 ||
      rebounds < 0 || rebounds > 40 || assists < 0 || assists > 40 ||
      threes < 0 || threes > 20) return null;
  return { minutes, points, rebounds, assists, threes };
}

function injuryStatusBlocks(status: unknown, injury: any): boolean {
  const value = norm(status);
  if (!value) return Boolean(injury?.details || injury?.type);
  return !["active", "available", "healthy", "returned", "cleared", "probable"].includes(value);
}

function extractAvailability(summary: any, expectedEspnTeamIds: string[], localTeamByEspn: Map<string, string>) {
  const injuryGroups = summary?.injuries;
  const injuryReportAvailable = Array.isArray(injuryGroups);
  const reportedTeams = new Set((injuryGroups ?? []).map((group: any) => String(group?.team?.id ?? "")));
  const injuryReportComplete = injuryReportAvailable &&
    expectedEspnTeamIds.every((id) => reportedTeams.has(id));

  // Use this endpoint only for injury exclusions; player candidates come from validated historical appearances.
  const injuredIds = new Set<string>();
  for (const group of injuryGroups ?? []) {
    for (const injury of group?.injuries ?? []) {
      const id = String(injury?.athlete?.id ?? "");
      if (id && injuryStatusBlocks(injury?.status ?? injury?.type?.description, injury)) injuredIds.add(id);
    }
  }

  return {
    verified: injuryReportComplete,
    candidates: [],
    injured_ids: [...injuredIds],
    reason: !injuryReportAvailable
      ? "injury_report_unavailable"
      : !injuryReportComplete
      ? "injury_report_incomplete"
      : injuredIds.size ? "injury_report_loaded" : null
  };
}


Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!SERVICE_KEY) return json({ ok: false, error: "Server database credentials are not configured" }, 500);

  const supabase = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let requestBody: any = {};
  try { requestBody = await req.json(); } catch { /* empty body is read-only */ }
  const requested = requestBody?.persist === true;
  let persistRequested = false;
  if (requested) {
    const automationToken = req.headers.get("x-automation-token") ?? "";
    const automationHash = automationToken ? await sha256(automationToken) : "";
    const { data: automationRecord, error: automationError } = await supabase
      .from("internal_automation_tokens").select("token_hash").eq("name", "nba-slate-gate").maybeSingle();
    if (automationError) {
      return json({ ok: false, error: "Could not validate server automation authorization." }, 503);
    }
    const automationAuthorized = !!automationRecord?.token_hash && automationHash === automationRecord.token_hash;
    if (!automationAuthorized) {
      return json({ ok: false, error: "Persistence is restricted to authorized server automation." }, 403);
    }
    persistRequested = true;
  }
  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const from = new Date(now.getTime() - 14 * 86400000).toISOString();
    const to = new Date(now.getTime() + 14 * 86400000).toISOString();
    const dateFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    });
    const nbaDateKey = (value: string) => {
      const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(value)).map((p) => [p.type, p.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };

    const { data: windowGames, error: gamesError } = await supabase.from("games")
      .select("id,season,scheduled_start,status,home_team_id,away_team_id")
      .gte("scheduled_start", from).lte("scheduled_start", to)
      .order("scheduled_start", { ascending: true }).limit(300);
    if (gamesError) throw new Error("Slate lookup failed: " + gamesError.message);

    const nonFinalDates = [...new Set((windowGames ?? [])
      .filter((g: any) => g.status !== "final").map((g: any) => nbaDateKey(g.scheduled_start)))].sort();
    const slateDate = nonFinalDates[0] ?? null;
    const slateGames = slateDate ? (windowGames ?? []).filter((g: any) => nbaDateKey(g.scheduled_start) === slateDate) : [];
    const slateStarted = slateGames.some((g: any) => g.status === "in_progress" || g.status === "final" || Date.parse(g.scheduled_start) <= now.getTime());
    const slateStatus = !slateDate ? "no_upcoming_slate" : slateStarted ? "in_progress" : "ready";

    const teamIds = [...new Set(slateGames.flatMap((g: any) => [g.home_team_id, g.away_team_id]))];
    const gameIds = slateGames.map((g: any) => g.id);
    // Do not return early when there is no upcoming slate: pending player
    // forecasts from recently completed games must still be settled below.

    const [{ data: teamMappings, error: teamMapError }, { data: modelRows, error: modelError }] = await Promise.all([
      supabase.from("team_source_ids").select("team_id,source_team_id").eq("source_name", "espn").in("team_id", teamIds),
      supabase.from("model_versions").select("id").eq("version_name", MODEL_VERSION).limit(1),
    ]);
    if (teamMapError) throw new Error("ESPN team mappings failed: " + teamMapError.message);
    if (modelError) throw new Error("Player model lookup failed: " + modelError.message);
    const localTeamByEspn = new Map((teamMappings ?? []).map((m: any) => [String(m.source_team_id), m.team_id]));
    const espnTeamByLocal = new Map((teamMappings ?? []).map((m: any) => [m.team_id, String(m.source_team_id)]));
    const modelVersionId = modelRows?.[0]?.id ?? null;

    const availabilityByGame = new Map<string, any>();
    const skipped: any[] = [];
    for (const game of slateGames) {
      if (slateStatus === "in_progress" && (game.status === "in_progress" || game.status === "final" || Date.parse(game.scheduled_start) <= now.getTime())) continue;
      const homeEspn = espnTeamByLocal.get(game.home_team_id);
      const awayEspn = espnTeamByLocal.get(game.away_team_id);
      if (!homeEspn || !awayEspn) {
        skipped.push({ game_id: game.id, reason: "team_source_mapping_missing" });
        continue;
      }
      const mapping = await supabase.from("game_source_ids").select("source_game_id")
        .eq("source_name", "espn").eq("game_id", game.id).maybeSingle();
      if (mapping.error || !mapping.data?.source_game_id) {
        skipped.push({ game_id: game.id, reason: "espn_game_mapping_missing" });
        continue;
      }
      try {
        const response = await fetch(`${ESPN_BASE}/summary?event=${encodeURIComponent(mapping.data.source_game_id)}`, {
          headers: { accept: "application/json", "user-agent": "NBA-Analytics/1.0 player-predictions" },
          signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) {
          skipped.push({ game_id: game.id, reason: `espn_summary_http_${response.status}` });
          continue;
        }
        const summary = await response.json();
        const availability = extractAvailability(summary, [homeEspn, awayEspn], localTeamByEspn);
        availabilityByGame.set(game.id, availability);
        if (!availability.verified || !availability.candidates.length) skipped.push({ game_id: game.id, reason: availability.reason });
      } catch {
        skipped.push({ game_id: game.id, reason: "espn_summary_unavailable" });
      }
    }

    const { data: teams, error: teamsError } = await supabase.from("teams")
      .select("id,display_name,abbreviation").in("id", teamIds);
    if (teamsError) throw new Error("Team names lookup failed: " + teamsError.message);
    const teamById = new Map((teams ?? []).map((t: any) => [t.id, t]));

    let forecasts: any[] = [];
    let predictionsPersisted = 0;
    let predictionsEvaluated = 0;

    if (slateStatus === "ready" && persistRequested) {
      if (!modelVersionId) {
        const { data: created, error: createError } = await supabase.from("model_versions").insert({
          version_name: MODEL_VERSION,
          feature_set_version: "player-starter-features-0.1",
          model_description: "Proyecciones experimentales de los dos jugadores de mayor impacto por equipo, clasificados por producción estadística reciente y minutos; excluye jugadores con estado Out, Doubtful o Questionable en el informe ESPN.",
          parameters: { method: "blend_last5_last10_60_40", min_games: 3, max_games: 10, team_player_limit: 2, ranking: "projected_points_rebounds_assists_threes_minutes", availability_gate: "exclude_out_doubtful_questionable", roster_source: "ESPN boxscore player pool" },
          validation_metrics: { status: "not_yet_validated", note: "No promover sin backtest cronológico de jugadores." },
          status: "experimental",
        }).select("id").single();
        if (createError || !created) throw new Error("Could not register player model: " + (createError?.message ?? "missing row"));
        modelRows?.push?.({ id: created.id });
      }

      const activeModelId = modelVersionId ?? modelRows?.[0]?.id;
      const candidates: any[] = [];
      const localPlayerByEspn = new Map<string, string>();
      const playerById = new Map<string, any>();


      const statRows: any[] = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase.from("player_game_stats")
          .select("game_id,player_id,team_id,stats,validation_status,captured_at")
          .in("team_id", teamIds).neq("validation_status", "rejected")
          .order("captured_at", { ascending: false }).range(offset, offset + pageSize - 1);
        if (error) throw new Error("Historical player stats query failed: " + error.message);
        statRows.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
        if (statRows.length >= 12000) break;
      }

      const historicalGameIds = [...new Set(statRows.map((r: any) => r.game_id))];
      const historicalGames: any[] = [];
      for (let offset = 0; offset < historicalGameIds.length; offset += 100) {
        const { data, error } = await supabase.from("games").select("id,scheduled_start,status")
          .in("id", historicalGameIds.slice(offset, offset + 100));
        if (error) throw new Error("Historical player games query failed: " + error.message);
        historicalGames.push(...(data ?? []));
      }
      const finalGameIds: string[] = [];
      for (let offset = 0; offset < historicalGameIds.length; offset += 100) {
        const { data, error } = await supabase.from("game_results").select("game_id,is_final")
          .in("game_id", historicalGameIds.slice(offset, offset + 100)).eq("is_final", true);
        if (error) throw new Error("Final player game results query failed: " + error.message);
        finalGameIds.push(...(data ?? []).map((r: any) => r.game_id));
      }
      const finalSet = new Set(finalGameIds);
      const gameById = new Map(historicalGames.map((g: any) => [g.id, g]));
      const historyByPlayer = new Map<string, any[]>();
      const seenPlayerGames = new Set<string>();
      for (const row of statRows) {
        if (!finalSet.has(row.game_id)) continue;
        const key = `${row.game_id}:${row.player_id}`;
        if (seenPlayerGames.has(key)) continue;
        seenPlayerGames.add(key); // Query is newest-first: keep only the latest snapshot for each player/game.
        const normalized = normalizedStatRow(row.stats);
        if (!normalized) continue;
        const game = gameById.get(row.game_id);
        if (!game || Date.parse(game.scheduled_start) >= Date.parse(slateGames[0].scheduled_start)) continue;
        if (!historyByPlayer.has(row.player_id)) historyByPlayer.set(row.player_id, []);
        historyByPlayer.get(row.player_id)!.push({ ...normalized, game_id: row.game_id, team_id: row.team_id, date: Date.parse(game.scheduled_start) });
      }
      for (const rows of historyByPlayer.values()) rows.sort((a, b) => b.date - a.date);
      // Build the eligible roster from players with recent validated appearances for each team.
      // This avoids requiring ESPN to publish a confirmed starting lineup before forecasts can exist.
      const historyPlayerIds = [...historyByPlayer.keys()];
      const [{ data: playerRows, error: playerRowsError }, { data: playerMappings, error: playerMapError }] = await Promise.all([
        historyPlayerIds.length
          ? supabase.from("players").select("id,display_name,position,active").in("id", historyPlayerIds)
          : Promise.resolve({ data: [], error: null }),
        historyPlayerIds.length
          ? supabase.from("player_source_ids").select("player_id,source_player_id")
              .eq("source_name", "espn").in("player_id", historyPlayerIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (playerRowsError) throw new Error("Historical player catalog lookup failed: " + playerRowsError.message);
      if (playerMapError) throw new Error("Historical ESPN player mappings failed: " + playerMapError.message);
      for (const mapping of playerMappings ?? []) localPlayerByEspn.set(String(mapping.source_player_id), mapping.player_id);
      for (const player of playerRows ?? []) playerById.set(player.id, player);
      const espnByLocalPlayer = new Map((playerMappings ?? []).map((m: any) => [m.player_id, String(m.source_player_id)]));
      for (const game of slateGames) {
        const availability = availabilityByGame.get(game.id);
        const injuredIds = new Set<string>(availability?.injured_ids ?? []);
        for (const teamId of [game.home_team_id, game.away_team_id]) {
          for (const player of playerRows ?? []) {
            if (player.active !== true) continue;
            const history = historyByPlayer.get(player.id) ?? [];
            const teamHistory = history.filter((row: any) => row.team_id === teamId);
            if (teamHistory.length < 3 || history.length === 0 || history[0].team_id !== teamId) continue;
            const espnPlayerId = espnByLocalPlayer.get(player.id);
            if (!espnPlayerId) continue;
            if (injuredIds.has(espnPlayerId)) {
              skipped.push({ game_id: game.id, player: player.display_name, reason: "injury_report_excluded" });
              continue;
            }
            candidates.push({
              game_id: game.id,
              scheduled_start: game.scheduled_start,
              espn_player_id: espnPlayerId,
              team_id: teamId,
              player_name: player.display_name ?? "Jugador",
              position: player.position ?? null,
              starter_confirmed: false,
              injury_clear: availability?.verified === true,
            });
          }
        }
      }


      const existingByKey = new Map<string, any>();
      for (let offset = 0; offset < gameIds.length; offset += 100) {
        const { data, error } = await supabase.from("predictions").select("id,game_id,target_key,forecast")
          .in("game_id", gameIds.slice(offset, offset + 100)).eq("model_version_id", activeModelId)
          .eq("prediction_type", "player");
        if (error) throw new Error("Existing player forecast lookup failed: " + error.message);
        for (const row of data ?? []) existingByKey.set(`${row.game_id}:${row.target_key}`, row);
      }

      const predictionRows: any[] = [];
      for (const candidate of candidates) {
        const playerId = localPlayerByEspn.get(candidate.espn_player_id);
        const player = playerId ? playerById.get(playerId) : null;
        if (!player || player.active !== true) {
          skipped.push({ game_id: candidate.game_id, player: candidate.player_name, reason: "player_not_in_active_catalog" });
          continue;
        }
        const history = (historyByPlayer.get(playerId) ?? []).filter((r: any) => r.team_id === candidate.team_id).slice(0, 10);
        if (history.length < 3) {
          skipped.push({ game_id: candidate.game_id, player: candidate.player_name, reason: "insufficient_valid_history", sample: history.length });
          continue;
        }
        const recent5 = history.slice(0, 5);
        const project = (key: string) => round(0.6 * mean(history.map((r: any) => r[key])) + 0.4 * mean(recent5.map((r: any) => r[key])));
        const team = teamById.get(candidate.team_id) as any;
        const forecast = {
          game_id: candidate.game_id,
          scheduled_start: candidate.scheduled_start,
          player_id: playerId,
          player_name: player.display_name ?? candidate.player_name,
          team_id: candidate.team_id,
          team_name: team?.display_name ?? "",
          team_abbreviation: team?.abbreviation ?? "",
          position: player.position ?? candidate.position,
          starter_confirmed: candidate.starter_confirmed === true,
          injury_clear: candidate.injury_clear === true,
          availability_source: candidate.injury_clear === true ? "ESPN injury report complete" : "ESPN injury report incomplete",
          availability_checked_at: nowIso,
          predicted_points: project("points"),
          predicted_rebounds: project("rebounds"),
          predicted_assists: project("assists"),
          predicted_threes: project("threes"),
          predicted_minutes: project("minutes"),
          sample_games: history.length,
          recent5_sample: recent5.length,
          model_version: MODEL_VERSION,
          model_type: "experimental_player_rolling_blend",
          feature_cutoff_at: nowIso,
        };
        const existing = existingByKey.get(`${candidate.game_id}:${playerId}`);
        if (existing) {
          forecasts.push(existing.forecast);
          continue;
        }
        forecasts.push(forecast);
        const snapshot = {
          game_id: candidate.game_id, player_id: playerId, player_history: history,
          starter_confirmed: candidate.starter_confirmed === true, injury_clear: candidate.injury_clear === true, availability_source: candidate.injury_clear === true ? "ESPN injury report complete" : "ESPN injury report incomplete",
        };
        predictionRows.push({
          game_id: candidate.game_id, model_version_id: activeModelId,
          feature_cutoff_at: nowIso, prediction_type: "player", target_key: playerId,
          forecast, input_snapshot_sha256: await sha256(JSON.stringify(snapshot)),
        });
      }
      // Rank eligible players within each game/team by projected statistical impact.
      // Out, Doubtful and Questionable players have already been removed by the availability filter.
      const rankedGroups = new Map<string, any[]>();
      for (const forecast of forecasts) {
        const key = `${forecast.game_id}:${forecast.team_id}`;
        if (!rankedGroups.has(key)) rankedGroups.set(key, []);
        rankedGroups.get(key)!.push(forecast);
      }
      const selectedForecasts: any[] = [];
      const selectedKeys = new Set<string>();
      for (const group of rankedGroups.values()) {
        group.sort((a, b) => {
          const impact = (p: any) => Number(p.predicted_points ?? 0)
            + 1.2 * Number(p.predicted_rebounds ?? 0)
            + 1.5 * Number(p.predicted_assists ?? 0)
            + 0.5 * Number(p.predicted_threes ?? 0)
            + 0.1 * Number(p.predicted_minutes ?? 0);
          return impact(b) - impact(a);
        });
        for (const [index, forecast] of group.slice(0, 2).entries()) {
          forecast.team_rank = index + 1;
          selectedForecasts.push(forecast);
          selectedKeys.add(`${forecast.game_id}:${forecast.player_id}`);
        }
      }
      forecasts = selectedForecasts;
      const selectedPredictionRows = predictionRows.filter((row: any) =>
        selectedKeys.has(`${row.game_id}:${row.target_key}`)
      );
      for (const row of selectedPredictionRows) {
        const selected = forecasts.find((forecast: any) =>
          forecast.game_id === row.game_id && forecast.player_id === row.target_key
        );
        if (selected) row.forecast = selected;
      }
      predictionRows.length = 0;
      predictionRows.push(...selectedPredictionRows);

      for (let offset = 0; offset < predictionRows.length; offset += 50) {
        const { data, error } = await supabase.from("predictions").upsert(predictionRows.slice(offset, offset + 50), {
          onConflict: "game_id,model_version_id,prediction_type,target_key,input_snapshot_sha256",
          ignoreDuplicates: true,
        }).select("id");
        if (error) throw new Error("Player forecast persistence failed: " + error.message);
        predictionsPersisted += data?.length ?? 0;
      }
    } else {
      const { data: saved, error } = await supabase.from("predictions")
        .select("game_id,target_key,forecast").in("game_id", gameIds)
        .eq("prediction_type", "player").order("created_at", { ascending: false }).limit(500);
      if (error) throw new Error("Saved player forecasts lookup failed: " + error.message);
      const eligibleNow = new Map<string, Set<string>>();
      for (const game of slateGames) {
        const availability = availabilityByGame.get(game.id);
        if (game.status !== "final" && availability?.verified) {
          eligibleNow.set(game.id, new Set((availability.candidates ?? []).map((p: any) => {
            const mapping = (teamMappings ?? []).length ? p.espn_player_id : "";
            return mapping;
          })));
        }
      }
      const candidateIdsByGame = new Map<string, Set<string>>();
      for (const game of slateGames) {
        const ids = new Set<string>((availabilityByGame.get(game.id)?.candidates ?? []).map((p: any) => p.espn_player_id));
        candidateIdsByGame.set(game.id, ids);
      }
      for (const row of saved ?? []) {
        const forecast = row.forecast ?? {};
        // Non-starters are eligible: the ranking selects the two most influential available players.
        const game = slateGames.find((g: any) => g.id === row.game_id);
        if (!game) continue;
        // Keep the original pre-game availability verification in the immutable forecast.
        // A temporary ESPN injury-report outage must not hide a previously validated prediction.
        forecasts.push(forecast);
      }
    }

    // Settle pending player forecasts independently of the current upcoming slate.
    // The previous implementation only inspected slateGames (the next non-final date),
    // so completed games disappeared from that list before this evaluator could see them.
    const settlementDiagnostics: Record<string, number> = {
      final_games: 0, saved_forecasts: 0, stats_rows: 0, normalized_stats: 0,
      forecasts_with_actual: 0, evaluation_rows: 0, inserted_evaluations: 0,
    };
    const settlementKeySamples: Record<string, unknown> = { saved: [], actual: [] };
    if (persistRequested) {
      const settlementFrom = new Date(now.getTime() - 14 * 86400000).toISOString();
      const { data: recentFinalGames, error: finalGamesError } = await supabase.from("games")
        .select("id").eq("status", "final").gte("scheduled_start", settlementFrom)
        .lte("scheduled_start", nowIso).order("scheduled_start", { ascending: false }).limit(300);
      if (finalGamesError) throw new Error("Recent final games lookup failed: " + finalGamesError.message);
      const recentFinalIds = (recentFinalGames ?? []).map((g: any) => g.id);
      settlementDiagnostics.final_games = recentFinalIds.length;
      if (recentFinalIds.length) {
        const { data: saved, error: savedError } = await supabase.from("predictions")
          .select("id,game_id,forecast").in("game_id", recentFinalIds).eq("prediction_type", "player");
        if (savedError) throw new Error("Player predictions for evaluation failed: " + savedError.message);
        settlementDiagnostics.saved_forecasts = (saved ?? []).length;
        const actualRows: any[] = [];
        // Query only games that actually have saved player forecasts. This avoids
        // losing matches when a large recent-final slate is paged independently.
        const savedGameIds = [...new Set((saved ?? []).map((p: any) => p.game_id).filter(Boolean))];
        for (let offset = 0; offset < savedGameIds.length; offset += 100) {
          const { data, error } = await supabase.from("player_game_stats")
            .select("game_id,player_id,stats,validation_status,captured_at")
            .in("game_id", savedGameIds.slice(offset, offset + 100))
            .eq("validation_status", "validated")
            .order("captured_at", { ascending: false });
          if (error) throw new Error("Final player boxscores lookup failed: " + error.message);
          actualRows.push(...(data ?? []));
        }
        settlementDiagnostics.stats_rows = actualRows.length;
        const actualMap = new Map<string, any>();
        const normalizeId = (value: unknown) => String(value ?? "").trim().toLowerCase();
        for (const row of actualRows) {
          const parsed = normalizedStatRow(row.stats);
          const key = `${normalizeId(row.game_id)}:${normalizeId(row.player_id)}`;
          // Rows are newest-first; retain one validated final boxscore per player/game.
          if (parsed && !actualMap.has(key)) actualMap.set(key, parsed);
        }
        settlementDiagnostics.normalized_stats = actualMap.size;
        settlementKeySamples.actual = [...actualMap.keys()].slice(0, 5);
        const savedIds = (saved ?? []).map((p: any) => p.id);
        const existingEvalIds = new Set<string>();
        for (let offset = 0; offset < savedIds.length; offset += 100) {
          const { data, error } = await supabase.from("prediction_evaluations")
            .select("prediction_id").in("prediction_id", savedIds.slice(offset, offset + 100));
          if (error) throw new Error("Existing player evaluations lookup failed: " + error.message);
          for (const row of data ?? []) existingEvalIds.add(row.prediction_id);
        }
        settlementKeySamples.saved = (saved ?? []).slice(0, 5).map((p: any) => {
          const raw = p.forecast ?? {};
          const f = typeof raw === "string" ? JSON.parse(raw) : raw;
          const key = `${normalizeId(p.game_id ?? f.game_id)}:${normalizeId(f.player_id ?? f.playerId)}`;
          return { key, has_actual: actualMap.has(key), game_id: p.game_id, player_id: f.player_id };
        });
        const evalRows: any[] = [];
        for (const prediction of saved ?? []) {
          if (existingEvalIds.has(prediction.id)) continue;
          const rawForecast = prediction.forecast ?? {};
          const forecast = typeof rawForecast === "string" ? JSON.parse(rawForecast) : rawForecast;
          const matchGameId = normalizeId(prediction.game_id ?? forecast.game_id);
          const matchPlayerId = normalizeId(forecast.player_id ?? forecast.playerId);
          const actual = actualMap.get(`${matchGameId}:${matchPlayerId}`);
          if (!actual) continue; // DNP / missing validated boxscore: keep pending, never invent zeroes.
          settlementDiagnostics.forecasts_with_actual += 1;
          const fields = ["points", "rebounds", "assists", "threes", "minutes"];
          const errorMetrics: Record<string, number> = {};
          for (const field of fields) {
            const predicted = Number(forecast[`predicted_${field}`]);
            if (Number.isFinite(predicted)) errorMetrics[`${field}_abs_error`] = round(Math.abs(predicted - actual[field]));
          }
          evalRows.push({
            prediction_id: prediction.id,
            actual: { game_id: prediction.game_id, player_id: forecast.player_id, ...actual, source: "ESPN final boxscore" },
            error_metrics: errorMetrics,
            result_source_names: ["espn"],
          });
        }
        settlementDiagnostics.evaluation_rows = evalRows.length;
        for (let offset = 0; offset < evalRows.length; offset += 50) {
          const { data, error } = await supabase.from("prediction_evaluations").upsert(evalRows.slice(offset, offset + 50), {
            onConflict: "prediction_id", ignoreDuplicates: true,
          }).select("id");
          if (error) throw new Error("Player evaluations persistence failed: " + error.message);
          predictionsEvaluated += data?.length ?? 0;
          settlementDiagnostics.inserted_evaluations += data?.length ?? 0;
        }
      }
    }

    return json({
      ok: true,
      generated_at: nowIso,
      model: { version: MODEL_VERSION, name: "Starter Player Rolling Blend", status: "experimental",
        description: "Dos jugadores de mayor impacto por equipo, rankeados por proyección estadística; se excluyen estados Out, Doubtful y Questionable. La disponibilidad se marca como no verificada si el informe de lesiones está incompleto.",
        minimum_games: 3, players_per_team: 2, availability_gate: "exclude_out_doubtful_questionable" },
      slate_date: slateDate, slate_status: slateStatus,
      player_forecasts: forecasts,
      skipped,
      meta: {
        games_checked: slateGames.length,
        games_with_verified_availability: [...availabilityByGame.values()].filter((a: any) => a.verified).length,
        players_forecasted: forecasts.length,
        predictions_persisted: predictionsPersisted,
        predictions_evaluated: predictionsEvaluated,
        persistence_requested: persistRequested,
        settlement_diagnostics: settlementDiagnostics,
        settlement_key_samples: settlementKeySamples,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
});
