import { createClient } from "npm:@supabase/supabase-js@2";
const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY = PUBLISHABLE_KEYS.default ?? Deno.env.get("SUPABASE_ANON_KEY");
const BOXSCORE_BASE = "https://cdn.nba.com/static/json/liveData/boxscore/boxscore_";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function easternDate(value: string) {
  const raw = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(raw));
}
function seasonStartYear(value: string) {
  const d = new Date(value);
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}
async function getSchedule(year: number) {
  const url = `https://data.nba.com/data/10s/v2015/json/mobile_teams/nba/${year}/league/00_full_schedule.json`;
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "NBA-Analytics/1.0 schedule-fallback" }, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`NBA schedule HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.lscd ?? []).flatMap((day: any) => day.mscd?.g ?? []);
}
function nbaAbbr(value: string) {
  const a = String(value ?? "").toUpperCase();
  const aliases: Record<string,string> = { GSW: "GS", NYK: "NY", SAS: "SA", NOP: "NO", UTA: "UTAH", PHO: "PHX" };
  return aliases[a] ?? a;
}
function localAbbr(value: string) {
  const a = String(value ?? "").toUpperCase();
  const aliases: Record<string,string> = { GS: "GSW", NY: "NYK", SA: "SAS", NO: "NOP", UTAH: "UTA", PHO: "PHX" };
  return aliases[a] ?? a;
}
function normalizePlayerName(value: string) {
  return String(value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
}
async function espnPlayerCatalog(supabase: any) {
  const { data, error } = await supabase.from("players").select("id,display_name").limit(5000);
  if (error) throw new Error("Player catalog lookup failed: " + error.message);
  const map = new Map<string,string>();
  for (const row of data ?? []) {
    const key = normalizePlayerName(String(row.display_name ?? ""));
    if (key && !map.has(key)) map.set(key, row.id);
  }
  return map;
}
function teamStatsArray(source: any) {
  const s = source ?? {};
  const defs: [string,string,string[]][] = [
    ["fieldGoalsMade-fieldGoalsAttempted","FG",["fieldGoalsMade","fieldGoalsAttempted"]],
    ["threePointFieldGoalsMade-threePointFieldGoalsAttempted","3PT",["threePointersMade","threePointersAttempted"]],
    ["freeThrowsMade-freeThrowsAttempted","FT",["freeThrowsMade","freeThrowsAttempted"]],
    ["totalRebounds","REB",["reboundsTotal","totalRebounds"]],
    ["offensiveRebounds","OR",["reboundsOffensive","offensiveRebounds"]],
    ["defensiveRebounds","DR",["reboundsDefensive","defensiveRebounds"]],
    ["assists","AST",["assists"]],["steals","STL",["steals"]],["blocks","BLK",["blocks"]],
    ["turnovers","TO",["turnovers"]],["fouls","PF",["foulsPersonal","personalFouls"]],["points","PTS",["points"]]
  ];
  return defs.flatMap(([name,label,keys]) => {
    if (keys.length === 2) {
      const a = s[keys[0]], b = s[keys[1]];
      return a !== undefined && b !== undefined ? [{ name, label, abbreviation: label, displayValue: `${a}-${b}` }] : [];
    }
    const value = s[keys[0]];
    return value !== undefined && value !== null ? [{ name, label, abbreviation: label, displayValue: String(value) }] : [];
  });
}
function playerStats(player: any) {
  const s = player.statistics ?? player.stats ?? {};
  const rawMin = String(s.minutes ?? s.min ?? "");
  let minutes = rawMin;
  const iso = rawMin.match(/^PT(?:(\d+)M)?([\d.]+S)?$/);
  if (iso) minutes = String(Number(iso[1] ?? 0) + Number(iso[2]?.replace("S","") ?? 0) / 60);
  if (!minutes || minutes === "0" || minutes === "0.0") return null;
  const pairs: [string,any][] = [
    ["MIN", minutes], ["PTS", s.points], ["FG", s.fieldGoalsMade !== undefined && s.fieldGoalsAttempted !== undefined ? `${s.fieldGoalsMade}-${s.fieldGoalsAttempted}` : undefined],
    ["3PT", s.threePointersMade !== undefined && s.threePointersAttempted !== undefined ? `${s.threePointersMade}-${s.threePointersAttempted}` : undefined],
    ["FT", s.freeThrowsMade !== undefined && s.freeThrowsAttempted !== undefined ? `${s.freeThrowsMade}-${s.freeThrowsAttempted}` : undefined],
    ["REB", s.reboundsTotal ?? s.rebounds], ["AST", s.assists], ["TO", s.turnovers], ["STL", s.steals], ["BLK", s.blocks],
    ["OREB", s.reboundsOffensive], ["DREB", s.reboundsDefensive], ["PF", s.foulsPersonal], ["+/-", s.plusMinus]
  ];
  const values: Record<string,string> = {};
  for (const [key,value] of pairs) if (value !== undefined && value !== null && value !== "") values[key] = String(value);
  const labels = ["MIN","PTS","FG","3PT","FT","REB","AST","TO","STL","BLK","OREB","DREB","PF","+/-"].filter(k => values[k] !== undefined);
  return { categories: [{ category: null, labels, values, raw_stats: labels.map(k => values[k]) }] };
}
async function saveNbaFallback(supabase:any,runId:string,input:any) {
  const {game_id,espn_event_id,game_date,home_abbr,away_abbr,home_score,away_score}=input;
  if(!game_id||!game_date||!home_abbr||!away_abbr) throw new Error("Missing game identity for secondary recovery");
  const year=seasonStartYear(game_date);
  const games=await getSchedule(year);
  const h=nbaAbbr(home_abbr), a=nbaAbbr(away_abbr), targetDate=easternDate(game_date);
  const matches=games.filter((g:any)=>g.h?.ta===h&&g.v?.ta===a&&g.gdte&&Math.abs(Date.parse(g.gdte+"T00:00:00Z")-Date.parse(targetDate+"T00:00:00Z"))<=86400000);
  if(!matches.length) throw new Error(`NBA schedule has no matching game ${a}@${h} near ${targetDate}`);
  const chosen=matches.sort((x:any,y:any)=>Math.abs(Date.parse(x.gdte)-Date.parse(targetDate))-Math.abs(Date.parse(y.gdte)-Date.parse(targetDate)))[0];
  if(!chosen.gid) throw new Error("NBA schedule match has no game id");
  const res=await fetch(`${BOXSCORE_BASE}${chosen.gid}.json`,{headers:{"accept":"application/json","user-agent":"NBA-Analytics/1.0 secondary-boxscore"},signal:AbortSignal.timeout(25000)});
  if(!res.ok) throw new Error(`NBA CDN boxscore HTTP ${res.status} for ${chosen.gid}`);
  const payload=await res.json(), game=payload.game??{}, home=game.homeTeam, away=game.awayTeam;
  if(!home||!away) throw new Error("NBA CDN boxscore missing home/away teams");
  const hs=Number(home.score), as=Number(away.score);
  if(home_score!==null&&home_score!==undefined&&(hs!==Number(home_score)||as!==Number(away_score))) throw new Error(`NBA score mismatch: ESPN ${home_score}-${away_score}, NBA ${hs}-${as}`);
  if(chosen.stt&&!/final/i.test(String(chosen.stt)) && Number(game.gameStatus)!==3) throw new Error(`NBA game is not final (${chosen.stt})`);
  const digest=await sha256(JSON.stringify(payload));
  const {error:snapError}=await supabase.from("raw_source_snapshots").upsert({
    run_id:runId,source_name:"nba",entity_type:"boxscore_secondary",source_entity_id:String(chosen.gid),
    payload_sha256:digest,payload
  },{onConflict:"source_name,entity_type,source_entity_id,payload_sha256",ignoreDuplicates:true});
  if(snapError) throw new Error("NBA raw snapshot failed: "+snapError.message);
  const sourceGame={source_name:"nba",source_game_id:String(chosen.gid),game_id};
  const {error:gameMapError}=await supabase.from("game_source_ids").upsert(sourceGame,{onConflict:"source_name,source_game_id"});
  if(gameMapError) throw new Error("NBA game mapping failed: "+gameMapError.message);
  let teamRows=0,playerRows=0;
  const catalogPlayers=await espnPlayerCatalog(supabase);
  for(const teamBox of [home,away]) {
    const nbaTeamId=String(teamBox.teamId??"");
    const abbr=localAbbr(teamBox.teamTricode??"");
    if(!nbaTeamId||!abbr) continue;
    const {data:team,error:teamError}=await supabase.from("teams").select("id,abbreviation").eq("abbreviation",abbr).maybeSingle();
    if(teamError||!team) throw new Error(`NBA team mapping missing for ${abbr}: ${teamError?.message??"not found"}`);
    const {error:mapError}=await supabase.from("team_source_ids").upsert({source_name:"nba",source_team_id:nbaTeamId,team_id:team.id},{onConflict:"source_name,source_team_id"});
    if(mapError) throw new Error("NBA team source mapping failed: "+mapError.message);
    const statArray=teamStatsArray(teamBox.statistics??{});
    if(statArray.length) {
      const {data:existing,error:existingError}=await supabase.from("team_game_stats").select("id").eq("game_id",game_id).eq("team_id",team.id).eq("validation_status","validated").limit(1).maybeSingle();
      if(existingError) throw new Error("NBA team duplicate check failed: "+existingError.message);
      if(!existing) {
        const {error}=await supabase.from("team_game_stats").insert({
          game_id,team_id:team.id,source_name:"nba",captured_at:new Date().toISOString(),
          stats:{team:{id:nbaTeamId,abbreviation:teamBox.teamTricode,name:teamBox.teamName,displayName:teamBox.teamName},statistics:statArray},
          validation_status:"pending"
        });
        if(error) throw new Error("NBA team stats insert failed: "+error.message);
        teamRows++;
      }
    }
    for(const p of teamBox.players??[]) {
      const personId=String(p.personId??"");
      if(!personId) continue;
      const stats=playerStats(p);
      if(!stats) continue;
      const {data:existingMap,error:mapLookupError}=await supabase.from("player_source_ids").select("player_id").eq("source_name","nba").eq("source_player_id",personId).maybeSingle();
      if(mapLookupError) throw new Error("NBA player mapping lookup failed: "+mapLookupError.message);
      const playerName=String(p.name??p.nameI??"Unknown");
      let playerId=existingMap?.player_id ?? catalogPlayers.get(normalizePlayerName(playerName));
      if(!playerId) {
        const {data:gamePlayers,error:gamePlayersError}=await supabase.from("player_game_stats")
          .select("player_id,players!inner(display_name)").eq("game_id",game_id).eq("team_id",team.id);
        if(gamePlayersError) throw new Error("Existing player identity lookup failed: "+gamePlayersError.message);
        const same=(gamePlayers??[]).find((row:any)=>normalizePlayerName(String(row.players?.display_name??""))===normalizePlayerName(playerName));
        if(same) playerId=same.player_id;
      }
      if(!playerId) {
        const {data:created,error:createError}=await supabase.from("players").insert({display_name:playerName,position:p.position??null,active:true}).select("id").single();
        if(createError||!created) throw new Error("NBA player insert failed: "+createError?.message);
        playerId=created.id;
      }
      const {error:sourceError}=await supabase.from("player_source_ids").upsert({source_name:"nba",source_player_id:personId,player_id:playerId},{onConflict:"source_name,source_player_id"});
      if(sourceError) throw new Error("NBA player source mapping failed: "+sourceError.message);
      const {data:existingStat,error:statLookupError}=await supabase.from("player_game_stats").select("id").eq("game_id",game_id).eq("player_id",playerId).eq("validation_status","validated").limit(1).maybeSingle();
      if(statLookupError) throw new Error("NBA player duplicate check failed: "+statLookupError.message);
      if(existingStat) continue;
      const {error:statError}=await supabase.from("player_game_stats").insert({
        game_id,player_id:playerId,team_id:team.id,source_name:"nba",captured_at:new Date().toISOString(),stats,validation_status:"pending"
      });
      if(statError) throw new Error("NBA player stats insert failed: "+statError.message);
      playerRows++;
    }
  }
  const {error:queueError}=await supabase.from("game_data_recovery_queue").upsert({
    game_id,status:"complete",attempt_count:0,last_error:null,updated_at:new Date().toISOString(),
    espn_event_id:espn_event_id??null,game_date,home_abbr,away_abbr,home_score,away_score
  },{onConflict:"game_id"});
  if(queueError) throw new Error("Recovery queue completion failed: "+queueError.message);
  return {ok:true,source:"nba",nba_game_id:String(chosen.gid),team_stat_rows_saved:teamRows,player_stat_rows_saved:playerRows,raw_snapshot_saved:true};
}

function bbrAbbr(value:string) {
  const a=String(value??"").toUpperCase();
  const aliases:Record<string,string>={NY:"NYK",SA:"SAS",NO:"NOP",UTAH:"UTA",PHX:"PHO"};
  return aliases[a]??a;
}
function htmlText(value:string) {
  return value.replace(/<[^>]*>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&")
    .replace(/&#39;|&#x27;/gi,"'").replace(/&quot;/gi,'"').replace(/&ndash;/gi,"-")
    .replace(/&mdash;/gi,"-").replace(/\s+/g," ").trim();
}
function bbrRows(html:string,abbr:string) {
  const id=`box-${bbrAbbr(abbr)}-game-basic`;
  const at=html.indexOf(`id="${id}"`);
  if(at<0) throw new Error(`Basketball-Reference table missing: ${id}`);
  const start=html.lastIndexOf("<table",at), end=html.indexOf("</table>",at);
  if(start<0||end<0) throw new Error(`Basketball-Reference table incomplete: ${id}`);
  const table=html.slice(start,end+8);
  const body=table; // includes player rows in tbody and team totals in tfoot
  const rows:any[]=[];
  for(const match of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml=match[1], cells:any={};
    for(const cell of rowHtml.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const attr=cell[2].match(/data-stat="([^"]+)"/i);
      if(attr) cells[attr[1]]=htmlText(cell[3]);
      if(cell[1].toLowerCase()==="th"&&/data-stat="player"/i.test(cell[2])) {
        const csv=cell[2].match(/data-append-csv="([^"]+)"/i);
        if(csv) cells.player_id=csv[1];
      }
    }
    if(Object.keys(cells).length) rows.push(cells);
  }
  return rows;
}
function bbrPlayerStats(row:any) {
  const rawMin=String(row.mp??"");
  const minMatch=rawMin.match(/^(\d+):(\d{2})$/);
  if(!minMatch) return null;
  const min=String(Number(minMatch[1])+Number(minMatch[2])/60);
  const values:Record<string,string>={};
  const pairs:[string,any][]=[
    ["MIN",min],["PTS",row.pts],["FG",row.fg!==undefined&&row.fga!==undefined?`${row.fg}-${row.fga}`:undefined],
    ["3PT",row.fg3!==undefined&&row.fg3a!==undefined?`${row.fg3}-${row.fg3a}`:undefined],
    ["FT",row.ft!==undefined&&row.fta!==undefined?`${row.ft}-${row.fta}`:undefined],
    ["REB",row.trb],["AST",row.ast],["TO",row.tov],["STL",row.stl],["BLK",row.blk],
    ["OREB",row.orb],["DREB",row.drb],["PF",row.pf],["+/-",row.plus_minus]
  ];
  for(const [k,v] of pairs) if(v!==undefined&&v!==null&&v!=="") values[k]=String(v);
  const labels=["MIN","PTS","FG","3PT","FT","REB","AST","TO","STL","BLK","OREB","DREB","PF","+/-"].filter(k=>values[k]!==undefined);
  return {categories:[{category:null,labels,values,raw_stats:labels.map(k=>values[k])}]};
}
async function saveBbrFallback(supabase:any,runId:string,input:any,nbaError:string) {
  const {game_id,espn_event_id,game_date,home_abbr,away_abbr,home_score,away_score}=input;
  const date=easternDate(game_date).replaceAll("-","");
  const bbrHome=bbrAbbr(home_abbr), bbrAway=bbrAbbr(away_abbr);
  const bbrGameId=`${date}0${bbrHome}`;
  const url=`https://www.basketball-reference.com/boxscores/${bbrGameId}.html`;
  const html=String(input.secondary_html??"");
  if(!html.includes("<html")) throw new Error("Basketball-Reference returned no HTML document");
  const homeRows=bbrRows(html,home_abbr), awayRows=bbrRows(html,away_abbr);
  const homeTotal=homeRows.find(r=>/^team totals$/i.test(r.player??""));
  const awayTotal=awayRows.find(r=>/^team totals$/i.test(r.player??""));
  if(!homeTotal||!awayTotal) throw new Error(`NBA feed: ${nbaError}; Basketball-Reference team totals unavailable`);
  const hs=Number(homeTotal.pts), as=Number(awayTotal.pts);
  if(!Number.isFinite(hs)||!Number.isFinite(as)||hs!==Number(home_score)||as!==Number(away_score))
    throw new Error(`NBA feed: ${nbaError}; Basketball-Reference score mismatch ${hs}-${as} vs expected ${home_score}-${away_score}`);
  const digest=await sha256(html);
  const {error:snapError}=await supabase.from("raw_source_snapshots").upsert({
    run_id:runId,source_name:"basketball_reference",entity_type:"boxscore_secondary",source_entity_id:bbrGameId,
    payload_sha256:digest,payload:{url,html}
  },{onConflict:"source_name,entity_type,source_entity_id,payload_sha256",ignoreDuplicates:true});
  if(snapError) throw new Error("Basketball-Reference raw snapshot failed: "+snapError.message);
  const {error:gameMapError}=await supabase.from("game_source_ids").upsert({
    source_name:"basketball_reference",source_game_id:bbrGameId,game_id
  },{onConflict:"source_name,source_game_id"});
  if(gameMapError) throw new Error("Basketball-Reference game mapping failed: "+gameMapError.message);
  let teamRows=0,playerRows=0;
  const catalogPlayers=await espnPlayerCatalog(supabase);
  for(const [abbr,rows,total] of [[home_abbr,homeRows,homeTotal],[away_abbr,awayRows,awayTotal]] as any[]) {
    const {data:team,error:teamError}=await supabase.from("teams").select("id,abbreviation").eq("abbreviation",abbr).maybeSingle();
    if(teamError||!team) throw new Error(`Team lookup failed for ${abbr}: ${teamError?.message??"not found"}`);
    const stats:any[]=[];
    const defs:[string,string,string][]=[
      ["fieldGoalsMade-fieldGoalsAttempted","FG","fg/fga"],["threePointFieldGoalsMade-threePointFieldGoalsAttempted","3PT","fg3/fg3a"],
      ["freeThrowsMade-freeThrowsAttempted","FT","ft/fta"],["totalRebounds","REB","trb"],["offensiveRebounds","OR","orb"],
      ["defensiveRebounds","DR","drb"],["assists","AST","ast"],["steals","STL","stl"],["blocks","BLK","blk"],
      ["turnovers","TO","tov"],["fouls","PF","pf"],["points","PTS","pts"]
    ];
    for(const [name,label,key] of defs) {
      let value:any;
      if(key.includes("/")) {const [a,b]=key.split("/");if(total[a]!==undefined&&total[b]!==undefined)value=`${total[a]}-${total[b]}`;}
      else value=total[key];
      if(value!==undefined&&value!=="") stats.push({name,label,abbreviation:label,displayValue:String(value)});
    }
    const {data:existingTeam,error:existingTeamError}=await supabase.from("team_game_stats").select("id")
      .eq("game_id",game_id).eq("team_id",team.id).eq("validation_status","validated").limit(1).maybeSingle();
    if(existingTeamError) throw new Error("Team duplicate check failed: "+existingTeamError.message);
    if(!existingTeam&&stats.length) {
      const {error}=await supabase.from("team_game_stats").insert({
        game_id,team_id:team.id,source_name:"basketball_reference",captured_at:new Date().toISOString(),
        stats:{team:{id:abbr,abbreviation:abbr,displayName:abbr},statistics:stats},validation_status:"pending"
      });
      if(error) throw new Error("Basketball-Reference team stats insert failed: "+error.message);
      teamRows++;
    }
    for(const row of rows) {
      const playerName=String(row.player??"");
      const sourcePlayerId=String(row.player_id??"");
      if(!playerName||!sourcePlayerId||/^team totals$/i.test(playerName)) continue;
      const statsObj=bbrPlayerStats(row);
      if(!statsObj) continue;
      const {data:existingMap,error:mapError}=await supabase.from("player_source_ids").select("player_id")
        .eq("source_name","basketball_reference").eq("source_player_id",sourcePlayerId).maybeSingle();
      if(mapError) throw new Error("Basketball-Reference player map lookup failed: "+mapError.message);
      let playerId=existingMap?.player_id ?? catalogPlayers.get(normalizePlayerName(playerName));
      if(!playerId) {
        const {data:gamePlayers,error:gamePlayersError}=await supabase.from("player_game_stats")
          .select("player_id,players!inner(display_name)").eq("game_id",game_id).eq("team_id",team.id);
        if(gamePlayersError) throw new Error("Existing player identity lookup failed: "+gamePlayersError.message);
        const norm=(v:string)=>v.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
        const same=(gamePlayers??[]).find((r:any)=>norm(String(r.players?.display_name??""))===norm(playerName));
        if(same) playerId=same.player_id;
      }
      if(!playerId) {
        const {data:created,error:createError}=await supabase.from("players").insert({display_name:playerName,active:true}).select("id").single();
        if(createError||!created) throw new Error("Basketball-Reference player insert failed: "+createError?.message);
        playerId=created.id;
      }
      const {error:sourceError}=await supabase.from("player_source_ids").upsert({
        source_name:"basketball_reference",source_player_id:sourcePlayerId,player_id:playerId
      },{onConflict:"source_name,source_player_id"});
      if(sourceError) throw new Error("Basketball-Reference player source mapping failed: "+sourceError.message);
      const {data:existingStat,error:statLookupError}=await supabase.from("player_game_stats").select("id")
        .eq("game_id",game_id).eq("player_id",playerId).eq("validation_status","validated").limit(1).maybeSingle();
      if(statLookupError) throw new Error("Player duplicate check failed: "+statLookupError.message);
      if(existingStat) continue;
      const {error:statError}=await supabase.from("player_game_stats").insert({
        game_id,player_id:playerId,team_id:team.id,source_name:"basketball_reference",
        captured_at:new Date().toISOString(),stats:statsObj,validation_status:"pending"
      });
      if(statError) throw new Error("Basketball-Reference player stats insert failed: "+statError.message);
      playerRows++;
    }
  }
  const {error:queueError}=await supabase.from("game_data_recovery_queue").upsert({
    game_id,status:"complete",attempt_count:0,last_error:null,updated_at:new Date().toISOString(),
    espn_event_id:espn_event_id??null,game_date,home_abbr,away_abbr,home_score,away_score
  },{onConflict:"game_id"});
  if(queueError) throw new Error("Recovery queue completion failed: "+queueError.message);
  return {ok:true,source:"basketball_reference",secondary_after:"nba",source_game_id:bbrGameId,team_stat_rows_saved:teamRows,player_stat_rows_saved:playerRows,raw_snapshot_saved:true};
}
async function saveFallback(supabase:any,runId:string,input:any) {
  if(!input.secondary_request_id && input.game_id && input.status!=="processing") {
    const {data:existingQueue,error:existingQueueError}=await supabase.from("game_data_recovery_queue")
      .select("status,secondary_request_id").eq("game_id",input.game_id).maybeSingle();
    if(existingQueueError) throw new Error("Recovery queue lookup failed: "+existingQueueError.message);
    if(existingQueue?.status==="complete") return {ok:true,source:"already_recovered",team_stat_rows_saved:0,player_stat_rows_saved:0};
    if(existingQueue?.status==="waiting_source"||existingQueue?.status==="processing")
      return {ok:false,pending:true,source:"basketball_reference",request_id:existingQueue.secondary_request_id??null};
  }
  if(input.secondary_request_id) {
    const {data:pageData,error:pageError}=await supabase.rpc("read_bbr_boxscore_response",{p_request_id:input.secondary_request_id});
    if(pageError) throw new Error("Basketball-Reference response lookup failed: "+pageError.message);
    if(pageData?.status===null||pageData?.status===undefined) {
      await supabase.from("game_data_recovery_queue").update({status:"waiting_source",updated_at:new Date().toISOString()}).eq("game_id",input.game_id);
      return {ok:false,pending:true,source:"basketball_reference",request_id:input.secondary_request_id};
    }
    if(Number(pageData.status)!==200) throw new Error(`Basketball-Reference HTTP ${pageData.status}`);
    return await saveBbrFallback(supabase,runId,{...input,secondary_html:String(pageData.body??"")},String(input.last_error??"NBA feed unavailable"));
  }
  try { return await saveNbaFallback(supabase,runId,input); }
  catch(nbaError) {
    const message=nbaError instanceof Error?nbaError.message:String(nbaError);
    const date=easternDate(String(input.game_date)).replaceAll("-","");
    const bbrGameId=`${date}0${bbrAbbr(String(input.home_abbr))}`;
    const url=`https://www.basketball-reference.com/boxscores/${bbrGameId}.html`;
    const {data:requestId,error:enqueueError}=await supabase.rpc("enqueue_bbr_boxscore_page",{p_url:url});
    if(enqueueError||!requestId) throw new Error(`NBA feed: ${message}; Basketball-Reference enqueue failed: ${enqueueError?.message??"no request id"}`);
    const {error:queueError}=await supabase.from("game_data_recovery_queue").upsert({
      game_id:input.game_id,espn_event_id:input.espn_event_id??null,game_date:input.game_date,
      home_abbr:input.home_abbr,away_abbr:input.away_abbr,home_score:input.home_score??null,away_score:input.away_score??null,
      status:"waiting_source",attempt_count:(input.attempt_count??0)+1,last_error:message,
      secondary_request_id:requestId,secondary_url:url,secondary_requested_at:new Date().toISOString(),updated_at:new Date().toISOString()
    },{onConflict:"game_id"});
    if(queueError) throw new Error("Could not queue Basketball-Reference request: "+queueError.message);
    return {ok:false,pending:true,source:"basketball_reference",request_id:requestId,error:message};
  }
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST") return json({error:"Use POST"},405);
  if(!PUBLIC_KEY||req.headers.get("apikey")!==PUBLIC_KEY) return json({error:"Unauthorized"},401);
  if(!SERVICE_KEY) return json({error:"Server database credentials are not configured"},500);
  const supabase=createClient(PROJECT_URL,SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const startedAt=new Date().toISOString();
  const {data:run,error:runError}=await supabase.from("source_ingestion_runs").insert({source_name:"nba_secondary_recovery",started_at:startedAt,ok:false}).select("id").single();
  if(runError||!run) return json({error:"Could not start secondary ingestion log",detail:runError?.message},500);
  try {
    const body=await req.json().catch(()=>({}));
    if(body.mode==="recover_pending") {
      await supabase.from("game_data_recovery_queue").update({status:"pending",secondary_request_id:null,secondary_url:null,secondary_requested_at:null,updated_at:new Date().toISOString()})
        .eq("status","processing").lt("updated_at",new Date(Date.now()-15*60*1000).toISOString());
      const {data:pending,error}=await supabase.from("game_data_recovery_queue").select("*").in("status",["pending","waiting_source"]).order("updated_at",{ascending:true}).limit(Math.min(5,Math.max(1,Number(body.limit)||1)));
      if(error) throw error;
      const recovered:any[]=[],failed:any[]=[],waiting:any[]=[];
      for(const item of pending??[]) {
        const {data:claimed,error:claimError}=await supabase.from("game_data_recovery_queue")
          .update({status:"processing",updated_at:new Date().toISOString()}).eq("game_id",item.game_id).in("status",["pending","waiting_source"]).select("*").maybeSingle();
        if(claimError) throw claimError;
        if(!claimed) continue;
        try {
          const result=await saveFallback(supabase,run.id,claimed);
          if(result?.ok) recovered.push(result);
          else waiting.push({game_id:claimed.game_id,request_id:result?.request_id??claimed.secondary_request_id??null});
        }
        catch(e) {
          const message=e instanceof Error?e.message:String(e);
          await supabase.from("game_data_recovery_queue").update({status:"pending",secondary_request_id:null,secondary_url:null,secondary_requested_at:null,attempt_count:(claimed.attempt_count??0)+1,last_error:message,updated_at:new Date().toISOString()}).eq("game_id",claimed.game_id);
          failed.push({game_id:claimed.game_id,error:message});
        }
        await wait(300);
      }
      const metadata={mode:"recover_pending",checked:pending?.length??0,recovered,waiting,failed};
      await supabase.from("source_ingestion_runs").update({finished_at:new Date().toISOString(),ok:true,http_status:200,records_seen:pending?.length??0,metadata}).eq("id",run.id);
      return json({ok:true,...metadata});
    }
    try {
      const result=await saveFallback(supabase,run.id,body);
      await supabase.from("source_ingestion_runs").update({finished_at:new Date().toISOString(),ok:true,http_status:200,records_seen:1,metadata:result}).eq("id",run.id);
      return json(result);
    } catch(e) {
      const message=e instanceof Error?e.message:String(e);
      if(body.game_id) await supabase.from("game_data_recovery_queue").upsert({
        game_id:body.game_id,espn_event_id:body.espn_event_id??null,game_date:body.game_date,
        home_abbr:body.home_abbr,away_abbr:body.away_abbr,home_score:body.home_score??null,away_score:body.away_score??null,
        status:"pending",attempt_count:1,last_error:message,updated_at:new Date().toISOString()
      },{onConflict:"game_id"});
      await supabase.from("source_ingestion_runs").update({finished_at:new Date().toISOString(),ok:false,error_message:message,metadata:{fallback_failed:true}}).eq("id",run.id);
      return json({ok:false,error:message,queued:Boolean(body.game_id)},200);
    }
  } catch(e) {
    const message=e instanceof Error?e.message:String(e);
    await supabase.from("source_ingestion_runs").update({finished_at:new Date().toISOString(),ok:false,error_message:message}).eq("id",run.id);
    return json({ok:false,error:message},502);
  }
});