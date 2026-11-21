import { createClient } from "npm:@supabase/supabase-js@2";
const PROJECT_URL=Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")??"{}");
const PUBLISHABLE_KEYS=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")??"{}");
const SERVICE_KEY=SECRET_KEYS.default??Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLIC_KEY=PUBLISHABLE_KEYS.default??Deno.env.get("SUPABASE_ANON_KEY");
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const dateKey=(iso:string)=>{const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(iso)).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
async function sha256(value:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");}
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return json({ok:false,error:"Use POST"},405);
 if(!PUBLIC_KEY||req.headers.get("apikey")!==PUBLIC_KEY)return json({ok:false,error:"Unauthorized"},401);
 if(!SERVICE_KEY)return json({ok:false,error:"Server credentials unavailable"},500);
 const db=createClient(PROJECT_URL,SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 try{
  const authorization=req.headers.get("authorization")??"";
  const suppliedToken=authorization.startsWith("Bearer ")?authorization.slice(7):"";
  const suppliedHash=suppliedToken?await sha256(suppliedToken):"";
  const {data:automationSecret,error:secretError}=await db.from("internal_automation_tokens").select("token_hash").eq("name","nba-slate-gate").maybeSingle();
  if(secretError||!automationSecret?.token_hash||suppliedHash!==automationSecret.token_hash)return json({ok:false,error:"Scheduled automation only"},403);
  const now=new Date(),nowIso=now.toISOString(),start=new Date(now.getTime()-10*86400000).toISOString(),end=new Date(now.getTime()+21*86400000).toISOString();
  const {data:games,error}=await db.from("games").select("id,scheduled_start,status,home_team_id,away_team_id").gte("scheduled_start",start).lte("scheduled_start",end).order("scheduled_start").limit(500);if(error)throw error;
  const grouped=new Map<string,any[]>();for(const g of games??[]){const k=dateKey(g.scheduled_start);if(!grouped.has(k))grouped.set(k,[]);grouped.get(k)!.push(g);}
  const ids=(games??[]).map((g:any)=>g.id),finals=new Set<string>();
  for(let i=0;i<ids.length;i+=100){const {data,error}=await db.from("game_results").select("game_id,home_score,away_score,is_final").in("game_id",ids.slice(i,i+100)).eq("is_final",true);if(error)throw error;for(const r of data??[])if(Number.isFinite(Number(r.home_score))&&Number.isFinite(Number(r.away_score))&&Number(r.home_score)>=0&&Number(r.away_score)>=0&&Number(r.home_score)!==Number(r.away_score))finals.add(r.game_id);}
  const slates=[...grouped.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,rows])=>({date,total:rows.length,finalized:rows.filter((g:any)=>g.status==="final"&&finals.has(g.id)).length,all_final:rows.length>0&&rows.every((g:any)=>g.status==="final"&&finals.has(g.id)),rows}));
  const previous=slates.filter(s=>s.date<=dateKey(nowIso)).at(-1)??null;
  const open=!!previous&&previous.all_final;
  const next=open?slates.find(s=>s.date>previous.date&&s.rows.every((g:any)=>g.status==="scheduled")):null;
  const slateId=next?.rows.map((g:any)=>g.id)??[];
  let calls:any[]=[];
  if(open&&next&&slateId.length){
    // Call existing generators only when the previous slate is fully settled; their immutable/upsert logic remains intact.
    for(const slug of ["nba-predictions","nba-player-predictions"]){
      const resp=await fetch(PROJECT_URL+"/functions/v1/"+slug,{method:"POST",headers:{"Content-Type":"application/json","apikey":PUBLIC_KEY,"Authorization":`Bearer ${SERVICE_KEY}`},body:JSON.stringify({persist:true,trigger:"slate_gate",gate_slate_date:next.date,previous_slate_date:previous.date,requested_at:nowIso})});
      let body:any;try{body=await resp.json();}catch{body={text:await resp.text()};}
      calls.push({function:slug,http_status:resp.status,ok:resp.ok,result:body});
      if(!resp.ok)break;
    }
  }
  return json({ok:true,mode:"slate_gate_and_trigger",checked_at:nowIso,timezone:"America/New_York",gate_open:open,completed_slate:previous?{date:previous.date,total:previous.rows.length,finalized:previous.finalized}:null,triggered_slate:next?{date:next.date,game_count:next.rows.length}:null,calls,reason:!previous?"no_completed/current slate":!open?"previous slate not fully settled":!next?"no next scheduled slate":"gate_passed"});
 }catch(e){return json({ok:false,error:e instanceof Error?e.message:String(e)},502);}
});