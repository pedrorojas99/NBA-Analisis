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
    const body = await req.json().catch(() => ({}));
    if (body?.action === "team_stats") {
      const { data: teamRows, error: teamError } = await supabase.from("teams")
        .select("id,abbreviation,display_name,city").order("display_name", { ascending: true });
      if (teamError) throw new Error("Team catalog query failed: " + teamError.message);
      const teamsOut = (teamRows ?? []).map((team: any) => ({
        ...team,
        logo_url: `https://a.espncdn.com/i/teamlogos/nba/500/${String(team.abbreviation ?? "").toLowerCase()}.png`
      }));
      const teamId = typeof body?.team_id === "string" ? body.team_id : null;
      if (!teamId) return json({ ok: true, teams: teamsOut, team: null, summary: null, recent_games: [] });
      const selected = (teamRows ?? []).find((team: any) => team.id === teamId);
      if (!selected) return json({ ok: false, error: "Equipo no encontrado." }, 404);
      const nowIso = new Date().toISOString();
      const { data: teamGames, error: gamesError } = await supabase.from("games")
        .select("id,season,scheduled_start,home_team_id,away_team_id")
        .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
        .lt("scheduled_start", nowIso).order("scheduled_start", { ascending: false }).limit(500);
      if (gamesError) throw new Error("Team history query failed: " + gamesError.message);
      const ids = (teamGames ?? []).map((game: any) => game.id);
      const resultRows: any[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const { data, error } = await supabase.from("game_results")
          .select("game_id,home_score,away_score,is_final")
          .in("game_id", ids.slice(offset, offset + 100)).eq("is_final", true);
        if (error) throw new Error("Team results query failed: " + error.message);
        resultRows.push(...(data ?? []));
      }
      const resultById = new Map(resultRows.map((row: any) => [row.game_id, row]));
      const teamById = new Map((teamRows ?? []).map((team: any) => [team.id, team]));
      const history = (teamGames ?? []).flatMap((game: any) => {
        const result: any = resultById.get(game.id);
        if (!result) return [];
        const isHome = game.home_team_id === teamId;
        const scored = Number(isHome ? result.home_score : result.away_score);
        const conceded = Number(isHome ? result.away_score : result.home_score);
        if (!Number.isFinite(scored) || !Number.isFinite(conceded)) return [];
        const opponent = teamById.get(isHome ? game.away_team_id : game.home_team_id) as any;
        return [{
          game_id: game.id, date: game.scheduled_start, season: game.season,
          opponent: opponent?.display_name ?? "Rival",
          opponent_abbreviation: opponent?.abbreviation ?? "",
          opponent_logo_url: opponent ? `https://a.espncdn.com/i/teamlogos/nba/500/${String(opponent.abbreviation ?? "").toLowerCase()}.png` : null,
          team_score: scored, opponent_score: conceded, won: scored > conceded,
          home_away: isHome ? "Local" : "Visitante"
        }];
      }).sort((a: any, b: any) => Date.parse(b.date) - Date.parse(a.date));
      const wins = history.filter((game: any) => game.won).length;
      const losses = history.length - wins;
      const avg = (values: number[]) => values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)) : null;
      return json({
        ok: true, teams: teamsOut,
        team: { ...selected, logo_url: `https://a.espncdn.com/i/teamlogos/nba/500/${String(selected.abbreviation ?? "").toLowerCase()}.png` },
        summary: {
          games: history.length, wins, losses,
          win_pct: history.length ? Number((100 * wins / history.length).toFixed(1)) : null,
          points_for: avg(history.map((g: any) => g.team_score)),
          points_against: avg(history.map((g: any) => g.opponent_score)),
          point_diff: avg(history.map((g: any) => g.team_score - g.opponent_score)),
          last10_wins: history.slice(0, 10).filter((g: any) => g.won).length,
          last10_losses: history.slice(0, 10).filter((g: any) => !g.won).length
        },
        recent_games: history.slice(0, 20),
        meta: { historical_games_available: history.length, source: "confirmed final game scores" }
      });
    }
    if (body?.action === "head_to_head") {
      const homeId = typeof body?.home_team_id === "string" ? body.home_team_id : "";
      const awayId = typeof body?.away_team_id === "string" ? body.away_team_id : "";
      if (!homeId || !awayId || homeId === awayId) return json({ ok: false, error: "Se requieren dos equipos válidos." }, 400);
      const nowIso = new Date().toISOString();
      const { data: games, error: gamesError } = await supabase.from("games")
        .select("id,scheduled_start,home_team_id,away_team_id")
        .or(`and(home_team_id.eq.${homeId},away_team_id.eq.${awayId}),and(home_team_id.eq.${awayId},away_team_id.eq.${homeId})`)
        .lt("scheduled_start", nowIso).order("scheduled_start", { ascending: false }).limit(30);
      if (gamesError) throw new Error("Head-to-head games query failed: " + gamesError.message);
      const ids = (games ?? []).map((game: any) => game.id);
      const [{ data: results, error: resultsError }, { data: teamRows, error: teamsError }] = await Promise.all([
        ids.length ? supabase.from("game_results").select("game_id,home_score,away_score,is_final").in("game_id", ids).eq("is_final", true) : Promise.resolve({ data: [], error: null }),
        supabase.from("teams").select("id,display_name,abbreviation").in("id", [homeId, awayId])
      ]);
      if (resultsError) throw new Error("Head-to-head results query failed: " + resultsError.message);
      if (teamsError) throw new Error("Head-to-head teams query failed: " + teamsError.message);
      const resultById = new Map((results ?? []).map((row: any) => [row.game_id, row]));
      const teamById = new Map((teamRows ?? []).map((team: any) => [team.id, team]));
      const meetings = (games ?? []).flatMap((game: any) => {
        const result: any = resultById.get(game.id);
        if (!result) return [];
        const home = teamById.get(game.home_team_id) as any;
        const away = teamById.get(game.away_team_id) as any;
        const homeScore = Number(result.home_score), awayScore = Number(result.away_score);
        return [{
          game_id: game.id, date: game.scheduled_start,
          home_team: home?.display_name ?? "Local", away_team: away?.display_name ?? "Visitante",
          home_abbreviation: home?.abbreviation ?? "", away_abbreviation: away?.abbreviation ?? "",
          home_logo_url: home ? `https://a.espncdn.com/i/teamlogos/nba/500/${String(home.abbreviation ?? "").toLowerCase()}.png` : null,
          away_logo_url: away ? `https://a.espncdn.com/i/teamlogos/nba/500/${String(away.abbreviation ?? "").toLowerCase()}.png` : null,
          home_score: homeScore, away_score: awayScore,
          winner: homeScore > awayScore ? (home?.display_name ?? "Local") : (away?.display_name ?? "Visitante")
        }];
      }).slice(0, 5);
      return json({ ok: true, games: meetings, meta: { returned: meetings.length, requested: 5 } });
    }
    if (body?.action === "player_stats") {
      // PostgREST may cap responses at 1,000 rows even when a larger limit is requested.
      // Page through the full eligible stats index so players beyond the first page are not omitted.
      const statIndex: any[] = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error: indexError } = await supabase
          .from("player_game_stats").select("player_id,game_id")
          .or("validation_status.is.null,validation_status.neq.rejected")
          .order("player_id", { ascending: true }).order("game_id", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (indexError) throw new Error("Player catalog query failed: " + indexError.message);
        statIndex.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
      }
      const gameSets = new Map<string, Set<string>>();
      for (const row of statIndex ?? []) {
        if (!gameSets.has(row.player_id)) gameSets.set(row.player_id, new Set());
        gameSets.get(row.player_id)!.add(row.game_id);
      }
      const playerIds = [...gameSets.keys()];
      // Keep URL/query sizes bounded: a large .in() list can fail before PostgREST responds.
      const playerRows: any[] = [];
      for (let offset = 0; offset < playerIds.length; offset += 100) {
        const batch = playerIds.slice(offset, offset + 100);
        const { data, error: playersError } = await supabase.from("players")
          .select("id,display_name,position,active")
          .in("id", batch).order("display_name", { ascending: true });
        if (playersError) throw new Error("Players query failed: " + playersError.message);
        playerRows.push(...(data ?? []));
      }
      const playersOut = (playerRows ?? []).map((p: any) => ({
        id: p.id, name: p.display_name, position: p.position,
        active: p.active, games_count: gameSets.get(p.id)?.size ?? 0
      }));
      const playerId = typeof body?.player_id === "string" ? body.player_id : null;
      let playerGamesOut: any[] = [];
      let seasonsOut: number[] = [];
      if (playerId && gameSets.has(playerId)) {
        const { data: rows, error: rowsError } = await supabase
          .from("player_game_stats")
          .select("game_id,player_id,team_id,stats,captured_at")
          .eq("player_id", playerId)
          .or("validation_status.is.null,validation_status.neq.rejected")
          .order("captured_at", { ascending: false }).limit(300);
        if (rowsError) throw new Error("Selected player stats query failed: " + rowsError.message);
        const uniqueRows = new Map<string, any>();
        for (const row of rows ?? []) if (!uniqueRows.has(row.game_id)) uniqueRows.set(row.game_id, row);
        const gameIds = [...uniqueRows.keys()];
        const { data: gameRows, error: gameError } = gameIds.length
          ? await supabase.from("games")
              .select("id,season,scheduled_start,home_team_id,away_team_id,status")
              .in("id", gameIds)
          : { data: [], error: null };
        if (gameError) throw new Error("Player games query failed: " + gameError.message);
        const teamIds = [...new Set((gameRows ?? []).flatMap((g: any) => [g.home_team_id, g.away_team_id]))];
        const { data: teamRows, error: teamError } = teamIds.length
          ? await supabase.from("teams").select("id,abbreviation,display_name").in("id", teamIds)
          : { data: [], error: null };
        if (teamError) throw new Error("Player teams query failed: " + teamError.message);
        const gameById = new Map((gameRows ?? []).map((g: any) => [g.id, g]));
        const teamById = new Map((teamRows ?? []).map((t: any) => [t.id, t]));
        playerGamesOut = [...uniqueRows.values()].map((row: any) => {
          const game = gameById.get(row.game_id);
          const team = teamById.get(row.team_id);
          const opponentId = game
            ? (game.home_team_id === row.team_id ? game.away_team_id : game.home_team_id)
            : null;
          const opponent = opponentId ? teamById.get(opponentId) : null;
          return {
            game_id: row.game_id, game_date: game?.scheduled_start ?? row.captured_at,
            season: game?.season ?? null,
            season_start_year: game ? (new Date(game.scheduled_start).getUTCMonth() >= 6 ? new Date(game.scheduled_start).getUTCFullYear() : new Date(game.scheduled_start).getUTCFullYear() - 1) : null,
            game_status: game?.status ?? null,
            team_abbreviation: team?.abbreviation ?? "",
            opponent_abbreviation: opponent?.abbreviation ?? "—",
            stats: row.stats ?? {}
          };
        }).sort((a: any, b: any) => Date.parse(b.game_date) - Date.parse(a.game_date));
        seasonsOut = [...new Set(playerGamesOut.map((g: any) => g.season_start_year).filter((v: any) => Number.isInteger(v)))].sort((a, b) => b - a);
      }
      return json({
        ok: true, players: playersOut, selected_player_id: playerId,
        player_games: playerGamesOut, seasons: seasonsOut,
        meta: { players_with_stats: playersOut.length, player_games: playerGamesOut.length }
      });
    }
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
    const { data: statRows, error: statRowsError } = gameIds.length
      ? await supabase.from("player_game_stats")
        .select("game_id,player_id,team_id,stats,captured_at")
        .in("game_id", gameIds).or("validation_status.is.null,validation_status.neq.rejected")
        .order("captured_at", { ascending: false }).limit(500)
      : { data: [], error: null };
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