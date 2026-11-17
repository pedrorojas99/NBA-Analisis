import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
const positionLabel = (p: any) => {
  const v = String(p?.abbreviation ?? p?.displayName ?? p?.name ?? "").toUpperCase();
  if (v === "PG" || v === "G" || v.includes("GUARD")) return "Base / Escolta";
  if (v === "SG") return "Escolta";
  if (v === "SF" || v === "F" || v.includes("FORWARD")) return "Alero";
  if (v === "PF") return "Ala-pívot";
  if (v === "C" || v.includes("CENTER")) return "Pívot";
  return v || "Sin posición";
};
const asNum = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const threeMade = (v: any) => {
  if (typeof v === "number") return v;
  const s = String(v ?? "0");
  const n = Number(s.split("-")[0]);
  return Number.isFinite(n) ? n : 0;
};
const flattenAthletes = (data: any): any[] => {
  const raw = data?.athletes ?? data?.roster ?? [];
  const out: any[] = [];
  const walk = (v: any) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== "object") return;
    if (v.id && (v.fullName || v.displayName || v.firstName || v.lastName)) { out.push(v); return; }
    if (Array.isArray(v.items)) walk(v.items);
    if (Array.isArray(v.athletes)) walk(v.athletes);
  };
  walk(raw);
  const seen = new Set<string>();
  return out.filter((p) => {
    const id = String(p.id ?? "");
    if (!id || seen.has(id)) return false;
    seen.add(id); return true;
  });
};
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (!PUBLIC_KEY || req.headers.get("apikey") !== PUBLIC_KEY) return json({ ok: false, error: "Unauthorized" }, 401);
  if (!SERVICE_KEY) return json({ ok: false, error: "Server database credentials are not configured" }, 500);
  const db = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "team_roster");
    if (action === "sync_all") {
      const { data: mappings, error: mapErr } = await db.from("team_source_ids")
        .select("source_team_id,team_id,teams!inner(id,abbreviation,display_name)")
        .eq("source_name", "espn");
      if (mapErr) throw mapErr;
      const nbaTeams = (mappings ?? []).filter((m: any) =>
        !["TBD","STARS","STRIPES","WORLD"].includes(m.teams?.abbreviation));
      const summary: any[] = [];
      for (const team of nbaTeams) {
        const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team.source_team_id}/roster`, {
          headers: { "user-agent": "NBA-Analytics/1.0" }
        });
        if (!response.ok) {
          summary.push({ team: team.teams?.abbreviation, ok: false, http_status: response.status });
          continue;
        }
        const rosterData = await response.json();
        const athletes = flattenAthletes(rosterData);
        if (!athletes.length) {
          summary.push({ team: team.teams?.abbreviation, ok: false, error: "Empty roster response" });
          continue;
        }
        const { error: deactivateErr } = await db.from("team_roster")
          .update({ active: false, updated_at: new Date().toISOString() }).eq("team_id", team.team_id);
        if (deactivateErr) throw deactivateErr;
        for (const athlete of athletes) {
          const sourcePlayerId = String(athlete.id);
          const displayName = String(athlete.displayName ?? athlete.fullName ?? [athlete.firstName, athlete.lastName].filter(Boolean).join(" "));
          const position = positionLabel(athlete.position);
          let playerId: string | null = null;
          const { data: mapping } = await db.from("player_source_ids").select("player_id")
            .eq("source_name", "espn").eq("source_player_id", sourcePlayerId).maybeSingle();
          playerId = mapping?.player_id ?? null;
          if (!playerId) {
            const { data: player, error: playerErr } = await db.from("players")
              .insert({ display_name: displayName, position, active: true }).select("id").single();
            if (playerErr) throw playerErr;
            playerId = player.id;
            const { error: sourceErr } = await db.from("player_source_ids")
              .insert({ source_name: "espn", source_player_id: sourcePlayerId, player_id: playerId });
            if (sourceErr) throw sourceErr;
          } else {
            const { error: playerErr } = await db.from("players").update({
              display_name: displayName, position, active: true, updated_at: new Date().toISOString()
            }).eq("id", playerId);
            if (playerErr) throw playerErr;
          }
          const headshot = athlete.headshot?.href ?? athlete.headshot?.url ?? null;
          const { error: rosterErr } = await db.from("team_roster").upsert({
            team_id: team.team_id, player_id: playerId, source_name: "espn",
            source_player_id: sourcePlayerId, headshot_url: headshot,
            jersey: athlete.jersey == null ? null : String(athlete.jersey),
            position, active: true, synced_at: new Date().toISOString(), updated_at: new Date().toISOString()
          }, { onConflict: "team_id,player_id" });
          if (rosterErr) throw rosterErr;
        }
        summary.push({ team: team.teams?.abbreviation, ok: true, players: athletes.length });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return json({ ok: true, teams_processed: summary.length, successful: summary.filter(x => x.ok).length, summary });
    }
    const teamId = String(body?.team_id ?? "");
    if (!teamId) return json({ ok: false, error: "team_id is required" }, 400);
    const { data: team, error: teamErr } = await db.from("teams")
      .select("id,abbreviation,display_name").eq("id", teamId).maybeSingle();
    if (teamErr) throw teamErr;
    if (!team) return json({ ok: false, error: "Team not found" }, 404);
    const { data: roster, error: rosterErr } = await db.from("team_roster")
      .select("player_id,source_player_id,headshot_url,jersey,position,synced_at,players!inner(id,display_name)")
      .eq("team_id", teamId).eq("active", true).order("position").order("players(display_name)");
    if (rosterErr) throw rosterErr;
    const playerIds = (roster ?? []).map((r: any) => r.player_id);
    const seasonStart = new Date().getUTCMonth() >= 9 ? new Date(Date.UTC(new Date().getUTCFullYear(), 9, 1)) : new Date(Date.UTC(new Date().getUTCFullYear() - 1, 9, 1));
    const statsByPlayer = new Map<string, any[]>();
    for (let offset = 0; offset < playerIds.length; offset += 50) {
      const batch = playerIds.slice(offset, offset + 50);
      const { data: statRows, error: statsErr } = await db.from("player_game_stats")
        .select("player_id,game_id,stats,captured_at")
        .eq("team_id", teamId).in("player_id", batch)
        .or("validation_status.is.null,validation_status.neq.rejected")
        .order("captured_at", { ascending: false }).limit(5000);
      if (statsErr) throw statsErr;
      const latest = new Map<string, any>();
      for (const row of statRows ?? []) if (!latest.has(row.player_id + ":" + row.game_id)) latest.set(row.player_id + ":" + row.game_id, row);
      const rows = [...latest.values()];
      const gameIds = [...new Set(rows.map((r: any) => r.game_id))];
      const gameDates = new Map<string, string>();
      for (let i = 0; i < gameIds.length; i += 100) {
        const { data: games, error: gamesErr } = await db.from("games").select("id,scheduled_start")
          .in("id", gameIds.slice(i, i + 100)).gte("scheduled_start", seasonStart.toISOString());
        if (gamesErr) throw gamesErr;
        for (const g of games ?? []) gameDates.set(g.id, g.scheduled_start);
      }
      for (const row of rows) {
        if (!gameDates.has(row.game_id)) continue;
        if (!statsByPlayer.has(row.player_id)) statsByPlayer.set(row.player_id, []);
        statsByPlayer.get(row.player_id)!.push(row.stats ?? {});
      }
    }
    const playersOut = (roster ?? []).map((r: any) => {
      const stats = statsByPlayer.get(r.player_id) ?? [];
      const avg = (key: string) => stats.length ? Number((stats.reduce((sum, s) => sum + asNum(s[key]), 0) / stats.length).toFixed(1)) : null;
      const threes = stats.length ? Number((stats.reduce((sum, s) => sum + threeMade(s["3PT"]), 0) / stats.length).toFixed(1)) : null;
      return {
        player_id: r.player_id, name: r.players?.display_name ?? "Jugador",
        position: r.position ?? "Sin posición", jersey: r.jersey,
        headshot_url: r.headshot_url, games: stats.length,
        points_avg: avg("PTS"), rebounds_avg: avg("REB"), threes_avg: threes
      };
    }).sort((a: any, b: any) => (a.position ?? "").localeCompare(b.position ?? "") || a.name.localeCompare(b.name));
    return json({ ok: true, team, players: playersOut, synced_at: (roster ?? []).reduce((latest: string | null, r: any) => !latest || r.synced_at > latest ? r.synced_at : latest, null), season_start: seasonStart.toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("nba-roster-sync", message);
    return json({ ok: false, error: message }, 500);
  }
});