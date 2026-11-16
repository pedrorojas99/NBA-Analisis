import { createClient } from "npm:@supabase/supabase-js@2";

const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const MODEL_VERSION = "player-starter-form-0.1";

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
  return !["active", "available", "healthy", "returned", "cleared"].includes(value);
}

function extractAvailability(summary: any, expectedEspnTeamIds: string[], localTeamByEspn: Map<string, string>) {
  const injuryGroups = summary?.injuries;
  if (!Array.isArray(injuryGroups)) return { verified: false, candidates: [], reason: "injury_report_unavailable" };
  const reportedTeams = new Set(injuryGroups.map((group: any) => String(group?.team?.id ?? "")));
  if (!expectedEspnTeamIds.every((id) => reportedTeams.has(id))) {
    return { verified: false, candidates: [], reason: "injury_report_incomplete" };
  }

  const injuredIds = new Set<string>();
  for (const group of injuryGroups) {
    for (const injury of group?.injuries ?? []) {
      const id = String(injury?.athlete?.id ?? "");
      if (id && injuryStatusBlocks(injury?.status ?? injury?.type?.description, injury)) injuredIds.add(id);
    }
  }

  const players = summary?.boxscore?.players;
  if (!Array.isArray(players)) return { verified: true, candidates: [], reason: "starting_lineups_unavailable" };
  const byPlayer = new Map<string, any>();
  for (const teamGroup of players) {
    const espnTeamId = String(teamGroup?.team?.id ?? "");
    const localTeamId = localTeamByEspn.get(espnTeamId);
    if (!localTeamId) continue;
    for (const category of teamGroup?.statistics ?? []) {
      for (const item of category?.athletes ?? []) {
        const entry = item?.athlete ?? item ?? {};
        const athlete = entry?.athlete ?? entry;
        const playerId = String(athlete?.id ?? entry?.id ?? "");
        if (!playerId || entry?.starter !== true || entry?.active !== true || entry?.didNotPlay === true) continue;
        if (injuredIds.has(playerId)) continue;
        byPlayer.set(playerId, {
          espn_player_id: playerId,
          team_id: localTeamId,
          player_name: athlete?.displayName ?? athlete?.fullName ?? entry?.displayName ?? "Jugador",
          position: athlete?.position?.abbreviation ?? athlete?.position?.displayName ?? null,
          starter_confirmed: true,
          injury_clear: true,
        });
      }
    }
  }
  return { verified: true, candidates: [...byPlayer.values()], reason: byPlayer.size ? null : "no_confirmed_healthy_starters" };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!SERVICE_KEY) return json({ ok: false, error: "Server database credentials are not configured" }, 500);

  let persistRequested = false;
  try { persistRequested = (await req.json())?.persist === true; } catch { /* read-only default */ }

  const supabase = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
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
    if (!gameIds.length) return json({
      ok: true, model: { version: MODEL_VERSION, status: "experimental" },
      slate_date: null, slate_status: slateStatus, player_forecasts: [], skipped: [],
      meta: { games_checked: 0, player_forecasts: 0, predictions_persisted: 0, predictions_evaluated: 0 },
    });

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
          model_description: "Proyecciones experimentales de puntos, rebotes, asistencias y triples para titulares confirmados y sin lesión reportada por ESPN.",
          parameters: { method: "blend_last5_last10_60_40", min_games: 5, max_games: 10, availability_gate: "espn_confirmed_starter_and_complete_injury_report" },
          validation_metrics: { status: "not_yet_validated", note: "No promover sin backtest cronológico de jugadores." },
          status: "experimental",
        }).select("id").single();
        if (createError || !created) throw new Error("Could not register player model: " + (createError?.message ?? "missing row"));
        modelRows?.push?.({ id: created.id });
      }

      const activeModelId = modelVersionId ?? modelRows?.[0]?.id;
      const candidates = slateGames.flatMap((game: any) =>
        (availabilityByGame.get(game.id)?.candidates ?? []).map((p: any) => ({ ...p, game_id: game.id, scheduled_start: game.scheduled_start }))
      );
      const candidateEspnIds = [...new Set(candidates.map((p: any) => p.espn_player_id))];
      const { data: playerMappings, error: playerMapError } = candidateEspnIds.length
        ? await supabase.from("player_source_ids").select("player_id,source_player_id")
            .eq("source_name", "espn").in("source_player_id", candidateEspnIds)
        : { data: [], error: null };
      if (playerMapError) throw new Error("ESPN player mappings failed: " + playerMapError.message);
      const localPlayerByEspn = new Map((playerMappings ?? []).map((m: any) => [String(m.source_player_id), m.player_id]));
      const localPlayerIds = [...new Set((playerMappings ?? []).map((m: any) => m.player_id))];
      const { data: playerRows, error: playerRowsError } = localPlayerIds.length
        ? await supabase.from("players").select("id,display_name,position,active").in("id", localPlayerIds)
        : { data: [], error: null };
      if (playerRowsError) throw new Error("Player records lookup failed: " + playerRowsError.message);
      const playerById = new Map((playerRows ?? []).map((p: any) => [p.id, p]));

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
        if (history.length < 5) {
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
          starter_confirmed: true,
          injury_clear: true,
          availability_source: "ESPN game summary",
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
          starter_confirmed: true, injury_clear: true, availability_source: "ESPN",
        };
        predictionRows.push({
          game_id: candidate.game_id, model_version_id: activeModelId,
          feature_cutoff_at: nowIso, prediction_type: "player", target_key: playerId,
          forecast, input_snapshot_sha256: await sha256(JSON.stringify(snapshot)),
        });
      }
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
        if (forecast.starter_confirmed !== true || forecast.injury_clear !== true) continue;
        const game = slateGames.find((g: any) => g.id === row.game_id);
        if (!game) continue;
        if (game.status === "scheduled" && Date.parse(game.scheduled_start) > now.getTime()) {
          const ids = candidateIdsByGame.get(game.id) ?? new Set<string>();
          const mapping = (await supabase.from("player_source_ids").select("source_player_id")
            .eq("source_name", "espn").eq("player_id", forecast.player_id).maybeSingle()).data?.source_player_id;
          if (!mapping || !ids.has(String(mapping))) continue;
        }
        forecasts.push(forecast);
      }
    }

    // Settle only players who actually appeared in a final boxscore. DNPs remain unevaluated.
    if (persistRequested && slateGames.some((g: any) => g.status === "final")) {
      const finalSlateIds = slateGames.filter((g: any) => g.status === "final").map((g: any) => g.id);
      const { data: saved, error: savedError } = await supabase.from("predictions")
        .select("id,game_id,forecast").in("game_id", finalSlateIds).eq("prediction_type", "player");
      if (savedError) throw new Error("Player predictions for evaluation failed: " + savedError.message);
      const actualRows: any[] = [];
      for (let offset = 0; offset < finalSlateIds.length; offset += 100) {
        const { data, error } = await supabase.from("player_game_stats")
          .select("game_id,player_id,stats,validation_status")
          .in("game_id", finalSlateIds.slice(offset, offset + 100))
          .neq("validation_status", "rejected");
        if (error) throw new Error("Final player boxscores lookup failed: " + error.message);
        actualRows.push(...(data ?? []));
      }
      const actualMap = new Map<string, any>();
      for (const row of actualRows) {
        const parsed = normalizedStatRow(row.stats);
        if (parsed) actualMap.set(`${row.game_id}:${row.player_id}`, parsed);
      }
      const evalRows: any[] = [];
      for (const prediction of saved ?? []) {
        const forecast = prediction.forecast ?? {};
        const actual = actualMap.get(`${prediction.game_id}:${forecast.player_id}`);
        if (!actual) continue;
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
      for (let offset = 0; offset < evalRows.length; offset += 50) {
        const { data, error } = await supabase.from("prediction_evaluations").upsert(evalRows.slice(offset, offset + 50), {
          onConflict: "prediction_id", ignoreDuplicates: true,
        }).select("id");
        if (error) throw new Error("Player evaluations persistence failed: " + error.message);
        predictionsEvaluated += data?.length ?? 0;
      }
    }

    return json({
      ok: true,
      generated_at: nowIso,
      model: { version: MODEL_VERSION, name: "Starter Player Rolling Blend", status: "experimental",
        description: "60% media últimos 10 partidos y 40% media últimos 5; solo titulares confirmados, con informe de lesiones completo y sin lesión reportada por ESPN.",
        minimum_games: 5, availability_gate: "confirmed_starter_and_clear_injury_report" },
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
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
});
