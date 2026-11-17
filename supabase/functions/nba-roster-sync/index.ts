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

const careerStat = (data: any, statName: string): number | null => {
  const categories = data?.splits?.categories ?? [];
  for (const category of categories) {
    for (const stat of category?.stats ?? []) {
      if (stat?.name === statName) {
        const value = Number(stat.value);
        return Number.isFinite(value) ? Number(value.toFixed(1)) : null;
      }
    }
  }
  return null;
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
      .select("player_id,source_player_id,headshot_url,jersey,position,synced_at,career_games,career_points_avg,career_rebounds_avg,career_threes_avg,career_stats_synced_at,players!inner(id,display_name)")
      .eq("team_id", teamId).eq("active", true).order("position").order("players(display_name)");
    if (rosterErr) throw rosterErr;
    const staleCareerRows = (roster ?? []).filter((r: any) => {
      const last = r.career_stats_synced_at ? new Date(r.career_stats_synced_at).getTime() : 0;
      return !last || Date.now() - last > 24 * 60 * 60 * 1000;
    });
    for (let offset = 0; offset < staleCareerRows.length; offset += 5) {
      const batch = staleCareerRows.slice(offset, offset + 5);
      await Promise.all(batch.map(async (r: any) => {
        try {
          const careerResponse = await fetch(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/${r.source_player_id}/statistics`, {
            headers: { "accept": "application/json", "user-agent": "NBA-Analytics/1.0" }
          });
          if (!careerResponse.ok) return;
          const careerData = await careerResponse.json();
          const careerGames = careerStat(careerData, "gamesPlayed");
          const careerPoints = careerStat(careerData, "avgPoints");
          const careerRebounds = careerStat(careerData, "avgRebounds");
          const careerThrees = careerStat(careerData, "avgThreePointFieldGoalsMade");
          const syncedAt = new Date().toISOString();
          const { error: careerErr } = await db.from("team_roster").update({
            career_games: careerGames == null ? null : Math.round(careerGames),
            career_points_avg: careerPoints,
            career_rebounds_avg: careerRebounds,
            career_threes_avg: careerThrees,
            career_stats_synced_at: syncedAt
          }).eq("team_id", teamId).eq("player_id", r.player_id);
          if (careerErr) throw careerErr;
          r.career_games = careerGames == null ? null : Math.round(careerGames);
          r.career_points_avg = careerPoints;
          r.career_rebounds_avg = careerRebounds;
          r.career_threes_avg = careerThrees;
          r.career_stats_synced_at = syncedAt;
        } catch (careerError) {
          console.warn("career stats refresh failed", r.source_player_id, careerError);
        }
      }));
    }
    const playersOut = (roster ?? []).map((r: any) => ({
      player_id: r.player_id, name: r.players?.display_name ?? "Jugador",
      position: r.position ?? "Sin posición", jersey: r.jersey,
      headshot_url: r.headshot_url, games: r.career_games ?? 0,
      points_avg: r.career_points_avg, rebounds_avg: r.career_rebounds_avg,
      threes_avg: r.career_threes_avg
    })).sort((a: any, b: any) => (a.position ?? "").localeCompare(b.position ?? "") || a.name.localeCompare(b.name));
    return json({ ok: true, team, players: playersOut, synced_at: (roster ?? []).reduce((latest: string | null, r: any) => !latest || r.synced_at > latest ? r.synced_at : latest, null), stats_type: "career_regular_season", stats_synced_at: (roster ?? []).reduce((latest: string | null, r: any) => !latest || (r.career_stats_synced_at && r.career_stats_synced_at > latest) ? r.career_stats_synced_at : latest, null) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("nba-roster-sync", message);
    return json({ ok: false, error: message }, 500);
  }
});