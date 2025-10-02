import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import { z } from "zod";
import axios from "axios";
import fs from "fs/promises";
import fscore from "fs";
import path from "path";
import archiver from "archiver";
import { XMLParser } from "fast-xml-parser";

/* ==========================
   CONFIG
========================== */
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";

const DATA_DIR = "/app/data";
const DB_PATH = process.env.DB_PATH || `${DATA_DIR}/db.json`;
const BILLING_PATH = process.env.BILLING_PATH || `${DATA_DIR}/billing.json`;
const SIGNALS_PATH = process.env.SIGNALS_PATH || `${DATA_DIR}/signals_events.json`;

const ENABLE_DATAFORSEO = /^true$/i.test(process.env.ENABLE_DATAFORSEO || "true");
const DFS_LOGIN = process.env.DFS_LOGIN || "";
const DFS_PASSWORD = process.env.DFS_PASSWORD || "";
const DFS_LOCATION_CODE = Number(process.env.DFS_LOCATION_CODE || 2056); // MX default
const DFS_LANGUAGE_CODE = process.env.DFS_LANGUAGE_CODE || "es";
const ENABLE_DFS_KFK = /^true$/i.test(process.env.ENABLE_DFS_KFK || "true");

const MAX_KEYWORDS_EXPANDED = Math.min(200, Math.max(10, Number(process.env.MAX_KEYWORDS_EXPANDED || 120)));
const DFS_SV_BATCH_SIZE = Math.min(1000, Math.max(1, Number(process.env.DFS_SV_BATCH_SIZE || 200)));
const DFS_SLEEP_MS = Math.max(0, Number(process.env.DFS_SLEEP_MS || 650));

/* Urgency weights */
const W_PROX = Number(process.env.URGENCY_W_PROX || 0.5);
const W_SEV  = Number(process.env.URGENCY_W_SEV  || 0.3);
const W_IMP  = Number(process.env.URGENCY_W_IMP  || 0.2);
const B_NEWS = Number(process.env.URGENCY_BOOST_NEWS  || 0.15);
const B_FRESH= Number(process.env.URGENCY_BOOST_FRESH || 0.10);
const B_PAT  = Number(process.env.URGENCY_BOOST_PATTERN || 0.10);
const URGENCY_FLOOR = Number(process.env.URGENCY_FLOOR || 0.15); // piso opcional

/* Clustering */
const CLUSTER_JACCARD_T = Math.max(0.1, Math.min(0.9, Number(process.env.CLUSTER_JACCARD_T || 0.42)));
const CLUSTER_MIN_SIZE  = Math.max(1, Number(process.env.CLUSTER_MIN_SIZE || 2));

/* Cost units (aprox) */
const UNIT = { DFS_SV_TASK: 0.075, DFS_SERP_PAGE: 0.002, DFS_KFK_TASK: 0.12, DFS_AUTOCOMPLETE: 0.002 };

/* Señales por defecto (se sobreescriben si subes tu sources.json) */
const DEFAULT_SIGNALS_SOURCES = [
  { url: "https://workspaceupdates.googleblog.com/feeds/posts/default", vertical: "email",      region: "LATAM", type: "platform", ttl_days: 365 },
  { url: "https://developer.chrome.com/feeds/blog.xml",                  vertical: "generic",    region: "LATAM", type: "platform", ttl_days: 365 },
  { url: "https://www.pcisecuritystandards.org/pci_security/rss",        vertical: "compliance", region: "LATAM", type: "regulatory", ttl_days: 365 },
  { url: "https://shopify.engineering/atom.xml",                         vertical: "ecommerce",  region: "LATAM", type: "platform", ttl_days: 365 }
];

/* ==========================
   APP & MIDDLEWARE
========================== */
const app = express();
const logger = pino({ level: process.env.NODE_ENV === "production" ? "info" : "debug" });

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-origin" } }));
app.use(express.json({ limit: "256kb" }));
app.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));

/* Auth simple para todo excepto /healthz */
app.use((req, res, next) => {
  if (req.path === "/healthz") return next();
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

/* ==========================
   HELPERS
========================== */
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function ensureDir(p){ await fs.mkdir(p, { recursive: true }); }
function currentMonth(){ return new Date().toISOString().slice(0,7); }
function stripAccents(s){ return s.normalize("NFD").replace(/[\u0300-\u036f]/g,""); }
function uniqNorm(arr){ const s=new Set(); const out=[]; for(const x of arr||[]){ const t=String(x||"").toLowerCase().trim(); if(t && !s.has(t)){ s.add(t); out.push(t);} } return out; }

const http = axios.create({ timeout: 15000 });
const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"" });

function resolveGeo(language, region){
  const lang = (language || DFS_LANGUAGE_CODE || "es").toLowerCase();
  let loc = DFS_LOCATION_CODE;
  const r = (region||"").toLowerCase();
  if (["us","united states","usa"].includes(r)) loc = 2840;
  if (["mx","mexico","latam"].includes(r))      loc = 2056;
  if (["es","spain"].includes(r))               loc = 2124;
  return { lang, loc };
}

/* Stopwords & tokenización */
const STOP_ES = new Set(["de","la","que","el","en","y","a","los","del","se","las","por","un","para","con","no","una","su","al","lo","como","más","pero","sus","le","ya","o","este","sí","porque","esta","entre","cuando","muy","sin","sobre","también","me","hasta","hay","donde","quien","desde"]);
const STOP_EN = new Set(["the","of","to","and","a","in","is","it","you","that","for","on","with","as","are","this","be","or","by","from","at","an","have","has","how","what","why","which"]);
function tokenizeKw(kw){ const s=stripAccents(String(kw||"").toLowerCase()); return s.split(/[^a-z0-9+]+/i).map(t=>t.trim()).filter(t=>t && !STOP_ES.has(t) && !STOP_EN.has(t)); }
function jaccard(aSet,bSet){ const a=new Set(aSet), b=new Set(bSet); const inter=[...a].filter(x=>b.has(x)).length; const uni=new Set([...a,...b]).size||1; return inter/uni; }

/* Mapeo vertical simple */
function mapVertical(topic){
  const t = String(topic||"").toLowerCase();
  if (t.includes("whatsapp")) return "whatsapp";
  if (t.includes("gmail") || t.includes("yahoo") || t.includes("entregabilidad") || t.includes("email")) return "email";
  if (t.includes("shopify") || t.includes("checkout")) return "ecommerce";
  if (t.includes("iso") || t.includes("pci") || t.includes("nis2") || t.includes("data act")) return "compliance";
  if (t.includes("restaurant") || t.includes("pos")) return "ecommerce";
  return "generic";
}

/* Heurística enriquecida (incluye restaurant software) */
function heuristicExpand(topic){
  const t=(topic||"").toLowerCase();
  const out = [];
  if (t.includes("pci")) {
    out.push(
      "pci dss v4.0","auditoría pci","certificación pci dss","cumplimiento pci 2025",
      "requisitos pci dss","qsa pci","saq pci dss","controles pci dss","normativa pci pagos",
      "pci dss checklist 2025","procesadores pagos pci","servicio consultoría pci"
    );
  } else if (t.includes("shopify") || t.includes("checkout")) {
    out.push(
      "shopify checkout extensibility","migración checkout shopify","plantillas checkout shopify",
      "apps checkout shopify","custom checkout shopify","checkout extensibility migration",
      "checkout ui extensions","checkout editor","shopify functions checkout"
    );
  } else if (t.includes("whatsapp")) {
    out.push(
      "whatsapp business api precios","plantillas whatsapp 2025","verificación whatsapp",
      "enrutamiento conversaciones whatsapp","wa cloud api pricing"
    );
  }
  // Restaurant / POS / Hospitality
  if (/\brestaurant|food service|pos\b/i.test(t)) {
    out.push(
      "restaurant pos","point of sale for restaurants","restaurant management software",
      "restaurant software pricing","best restaurant software","top restaurant pos systems",
      "restaurant software for small business","restaurant software cloud",
      "restaurant inventory management","restaurant scheduling software","restaurant payroll software",
      "restaurant crm","restaurant loyalty program","restaurant online ordering system",
      "restaurant delivery management","qr menu for restaurants","digital menu for restaurants",
      "kitchen display system","kds for restaurants","table management software",
      "reservation system for restaurants","restaurant kiosk software","self ordering kiosk restaurant",
      "tip management software","labor cost control restaurant","food cost calculator software",
      "restaurant pos price","restaurant pos cost","restaurant software plans",
      "restaurant software quotes","restaurant pos vendors","restaurant software implementation"
    );
  }
  return out;
}

/* Sanitización kw */
function sanitizeKeywords(keywords){
  const MAX_LEN=80, BAD=/[?¿“”"<>#%{}|\\^~\[\]]/g;
  const cleaned=[], rejected=[];
  for (let kw of keywords||[]){
    if(!kw) continue;
    let k=String(kw).normalize("NFKC").replace(BAD," ").replace(/\s+/g," ").trim();
    if(k.length>MAX_LEN) k=k.slice(0,MAX_LEN).trim();
    if(!k || k.length<2){ rejected.push(kw); continue; }
    cleaned.push(k);
  }
  return { cleaned: uniqNorm(cleaned), rejected };
}

/* Urgencia (con boosts + piso opcional) */
function computeUrgency(topic, region, serpSignals, allSignals){
  const vertical = mapVertical(topic); const today = new Date();
  const relevant = (allSignals||[]).filter(ev => (!vertical || ev.vertical===vertical) && (!region || ev.region===region));
  let base=0;
  if (relevant.length) base = Math.max(...relevant.map(r => {
    const days=Math.max(0,(new Date(r.deadline)-today)/86400000);
    const prox=Math.max(0,1-Math.min(days,180)/180);
    const sev=Math.min(Number(r.severity||0),5)/5;
    const imp=Math.min(Number(r.impact||0),4)/4;
    return W_PROX*prox + W_SEV*sev + W_IMP*imp;
  }));
  let boost=0;
  if (serpSignals?.hasNews) boost+=B_NEWS;
  if ((serpSignals?.freshShare||0)>=0.3) boost+=B_FRESH;
  const pattern=/\b(202[4-9]|migraci[oó]n|requisitos|obligatorio|v\d(\.\d)?)\b/i;
  if (pattern.test(String(topic))) boost+=B_PAT;
  let U = Math.max(0, Math.min(1, base+boost));
  // Piso si hay actividad en SERP
  if (U === 0) {
    const hasActivity = (serpSignals?.hasNews === true) || ((serpSignals?.paa||[]).length >= 4);
    if (hasActivity) U = Math.max(U, URGENCY_FLOOR);
  }
  return U;
}

/* Demand index */
function computeDemandIndex(batch){
  const sv=Number(batch.total_sv||0), cpc=Number(batch.avg_cpc||0), trend=Number(batch.trend||0), trans=Number(batch.transactional_share||0);
  const svFactor=Math.min(1, Math.sqrt(sv)/220);
  const cpcFactor=Math.min(1, cpc/2);
  const trendClamp=Math.max(-0.5, Math.min(0.5, trend));
  const trendFactor=(trendClamp+0.5);
  const demandIdx=0.50*svFactor + 0.20*trans + 0.20*trendFactor + 0.10*cpcFactor;
  return Number(demandIdx.toFixed(2));
}

/* Clustering Jaccard */
function clusterKeywords(perKwItems){
  const entries=(perKwItems||[]).map(it=>({ ...it, tokens: tokenizeKw(it.keyword) })).filter(e=>e.tokens.length);
  const clusters=[]; let idSeq=1;
  for(const e of entries){
    let bestIdx=-1, bestSim=0;
    for(let i=0;i<clusters.length;i++){ const sim=jaccard(clusters[i].tokensCentroid,e.tokens); if(sim>bestSim){bestSim=sim; bestIdx=i;} }
    if(bestSim>=CLUSTER_JACCARD_T){
      const cl=clusters[bestIdx]; cl.keywords.push(e); cl.sum_sv+=e.sv; cl.sum_cpc_w+=e.cpc*e.sv; cl.trans_count+=e.transactional?1:0; cl.tokensCentroid=new Set([...cl.tokensCentroid,...e.tokens]);
    } else {
      clusters.push({ id:`c${idSeq++}`, tokensCentroid:new Set(e.tokens), keywords:[e], sum_sv:e.sv, sum_cpc_w:e.cpc*e.sv, trans_count:e.transactional?1:0 });
    }
  }
  const enriched=clusters.map(cl=>{
    const total=cl.keywords.length; const avg_cpc=cl.sum_sv?cl.sum_cpc_w/cl.sum_sv:0; const tRatio=total?cl.trans_count/total:0;
    const tf=new Map(); for(const e of cl.keywords) for(const t of e.tokens) tf.set(t,(tf.get(t)||0)+1);
    const head=[...tf.entries()].sort((a,b)=> b[1]-a[1] || b[0].length-a[0].length).slice(0,3).map(x=>x[0]);
    return { id:cl.id, label: head.join(" "), total_sv:cl.sum_sv, avg_cpc:Number(avg_cpc.toFixed(2)), transactional_ratio:Number(tRatio.toFixed(2)), size:total, sample_queries: cl.keywords.slice(0,5).map(k=>k.keyword), head_terms: head, keywords: cl.keywords };
  }).filter(cl=> cl.size>=CLUSTER_MIN_SIZE || cl.total_sv>0).sort((a,b)=> (b.total_sv-a.total_sv) || (b.size-a.size));
  return enriched;
}

/* ==========================
   DATAFORSEO CALLS
========================== */
async function dfsSerpFeatures(keyword, pages, geo){
  if (!ENABLE_DATAFORSEO) return { paid_density:0.4, serp_features_load:0.5, volatility:0.2, cost:0, serp_signals:{ hasNews:false, freshShare:0, paa:[], related:[] } };
  const auth={ username: DFS_LOGIN, password: DFS_PASSWORD }; const lang=geo?.lang||DFS_LANGUAGE_CODE; const loc=geo?.loc||DFS_LOCATION_CODE;
  const payload=[{ keyword, location_code:loc, language_code:lang, depth:(pages||1)*10 }];
  try{
    const { data } = await http.post("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", payload, { auth });
    const items=data?.tasks?.[0]?.result?.[0]?.items||[];
    const ads=items.filter(i=>i.type==="ad").length;
    const paid_density=Math.min(1, ads/((pages||1)*10));
    const nonOrganic=items.filter(i=>i.type!=="organic").length;
    const serp_features_load=Math.min(1, nonOrganic/((pages||1)*10));
    const now=Date.now(), THRESH=45;
    const hasNews = items.some(i => ["top_stories","news","google_news"].includes(String(i.type||"").toLowerCase()));
    const freshCount = items.filter(i => { const t=i.timestamp||i.published_time||i.datetime; if(!t) return false; const ts=Number(new Date(t)); return Number.isFinite(ts) && (now-ts)<=THRESH*86400000; }).length;
    const freshShare = items.length ? freshCount/items.length : 0;
    const paa=[], related=[];
    for(const it of items){
      const t=String(it.type||"").toLowerCase();
      if(t==="people_also_ask" && Array.isArray(it.items)) for(const q of it.items){ const txt=q.title||q.question||q.text; if(txt) paa.push(String(txt).trim()); }
      if(t==="related_searches" && Array.isArray(it.items)) for(const r of it.items){ const txt=r.keyword||r.title||r.text; if(txt) related.push(String(txt).trim()); }
    }
    return { paid_density, serp_features_load, volatility:0.2, cost:UNIT.DFS_SERP_PAGE*(pages||1), serp_signals:{ hasNews, freshShare:Number(freshShare.toFixed(2)), paa, related } };
  }catch(e){
    logger.warn({ msg:"DFS SERP error", err:e.message });
    return { paid_density:0.5, serp_features_load:0.5, volatility:0.2, cost:0, serp_signals:{ hasNews:false, freshShare:0, paa:[], related:[] } };
  }
}

async function dfsKeywordsForKeywords(seeds, geo){
  if(!ENABLE_DATAFORSEO || !seeds?.length) return { keywords:[], cost:0 };
  const auth={ username: DFS_LOGIN, password: DFS_PASSWORD };
  const lang=geo?.lang||DFS_LANGUAGE_CODE;
  const loc=geo?.loc||DFS_LOCATION_CODE;
  const seedList=uniqNorm(seeds).slice(0,10);

  const payload=[{
    location_code: loc,
    language_code: lang,
    keywords: seedList,
    include_seed: true
  }];

  try{
    const { data } = await http.post(
      "https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live",
      payload,
      { auth }
    );
    const items = data?.tasks?.[0]?.result?.[0]?.items || [];

    const kwList = [];
    for (const it of items) {
      const k =
        it.keyword ||
        it?.keyword_info?.keyword ||
        it?.keyword_data?.keyword ||
        it?.string || null;
      if (k) kwList.push(String(k).trim());
    }
    return { keywords: uniqNorm(kwList).slice(0, MAX_KEYWORDS_EXPANDED), cost: UNIT.DFS_KFK_TASK };
  } catch(e){
    logger.warn({ msg:"DFS KfK error", err: e.message });
    return { keywords:[], cost:0 };
  }
}

async function dfsAutocompleteExpand(seeds, geo){
  if(!seeds?.length) return { keywords:[], cost:0 };
  const auth={ username: DFS_LOGIN, password: DFS_PASSWORD };
  const lang=geo?.lang||DFS_LANGUAGE_CODE;
  const loc=geo?.loc||DFS_LOCATION_CODE;

  const prefixes = ["best", "top", "affordable", "enterprise", "cloud"];
  const suffixes = ["pricing", "cost", "plans", "implementation", "vendors", "near me"];
  const variants = new Set();

  for (const s0 of uniqNorm(seeds)) {
    variants.add(s0);
    for (const suf of suffixes) variants.add(`${s0} ${suf}`);
    for (const pre of prefixes) variants.add(`${pre} ${s0}`);
  }
  for (const s0 of uniqNorm(seeds)) {
    if (/\brestaurant\b/i.test(s0)) {
      [
        "restaurant pos","restaurant management software","restaurant online ordering",
        "kitchen display system","restaurant inventory software","restaurant scheduling software"
      ].forEach(v => variants.add(v));
    }
  }

  const out=new Set(); let cost=0;
  const list=[...variants].slice(0, 20);
  for(const s of list){
    const payload=[{ keyword:s, language_code:lang, location_code:loc }];
    try{
      const { data } = await http.post("https://api.dataforseo.com/v3/serp/google/autocomplete/live", payload, { auth });
      const items=data?.tasks?.[0]?.result?.[0]?.items||[];
      for(const it of items) if(it.suggestion) out.add(String(it.suggestion).trim());
      cost += UNIT.DFS_AUTOCOMPLETE;
    }catch(e){
      logger.warn({ msg:"DFS autocomplete error", seed:s, err:e.message });
    }
    await sleep(150);
  }
  return { keywords: Array.from(out), cost };
}

async function dfsSearchVolumeChunks(keywords, geo){
  if(!ENABLE_DATAFORSEO) return { cost:0, total_sv:15000, avg_cpc:1.1, trend:0.12, transactional_share:0.6, items:[] };
  const { cleaned, rejected } = sanitizeKeywords(keywords);
  if(!cleaned.length) return { cost:0, total_sv:0, avg_cpc:0, trend:0, transactional_share:0, items:[] };
  if (rejected.length) logger.warn({ msg:"SV rejected", count: rejected.length, sample: rejected.slice(0,5) });

  const auth={ username: DFS_LOGIN, password: DFS_PASSWORD };
  const lang=geo?.lang||DFS_LANGUAGE_CODE;
  const loc=geo?.loc||DFS_LOCATION_CODE;

  const chunks=[]; for(let i=0;i<cleaned.length;i+=DFS_SV_BATCH_SIZE) chunks.push(cleaned.slice(i,i+DFS_SV_BATCH_SIZE));
  let total_sv=0, w_cpc=0, transCount=0, tasksCost=0; const months=new Map(); const perKw=[];
  const isTrans=(kw,cpc,comp)=>{ const k=(kw||"").toLowerCase(); const pats=["price","pricing","cost","buy","vendor","consultant","service","software","tool","implementation","migration","plans","quote","plan","package","pos"]; return pats.some(p=>k.includes(p)) || cpc>=0.5 || comp>=0.5; };

  for(let c=0;c<chunks.length;c++){
    const payload=[{ location_code:loc, language_code:lang, keywords:chunks[c] }];
    try{
      const { data } = await http.post("https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live", payload, { auth });
      const items=data?.tasks?.[0]?.result?.[0]?.items||[];
      for(const it of items){
        const kw=String(it.keyword||"");
        const sv=Number(it.search_volume||0);
        const cpc=Number((it.cpc && (Array.isArray(it.cpc) ? it.cpc[0]?.value : it.cpc.value)) || 0);
        const comp=Number(it.competition||0);
        const trans=isTrans(kw,cpc,comp);
        total_sv+=sv; w_cpc+=cpc*sv; if(trans) transCount++;
        perKw.push({ keyword:kw, sv, cpc, comp, transactional:trans });
        const ms=it.monthly_searches||it.search_volume_by_month||[];
        for(const m of ms){
          const y=m.year||m.month?.split("-")?.[0];
          const mon=m.month||(m.month_num&&String(m.month_num).padStart(2,"0"));
          const key=(y&&mon)?`${y}-${mon}`:null;
          const v=Number(m.search_volume||m.value||0);
          if(key) months.set(key,(months.get(key)||0)+v);
        }
      }
      tasksCost+=UNIT.DFS_SV_TASK;
    }catch(e){
      logger.warn({ msg:"DFS SV error", err:e.message });
    }
    if(c<chunks.length-1 && DFS_SLEEP_MS>0) await sleep(DFS_SLEEP_MS);
  }

  const avg_cpc = total_sv ? (w_cpc/total_sv) : 0;
  const sorted=Array.from(months.keys()).sort(); const last12=sorted.slice(-12); const vals=last12.map(k=>months.get(k)||0);
  const prev6=vals.slice(0,6).reduce((a,b)=>a+b,0), last6=vals.slice(-6).reduce((a,b)=>a+b,0);
  const trend = prev6>0 ? (last6-prev6)/prev6 : 0;
  const transactional_share = (perKw.length||1) ? (perKw.filter(x=>x.transactional).length/Math.max(1,perKw.length)) : 0;
  return { cost:tasksCost, total_sv, avg_cpc, trend, transactional_share, items: perKw };
}

/* ==========================
   SIGNALS SOURCES
========================== */
let SOURCES_PATH_RESOLVED = null;
let SOURCES_ORIGIN = null;

function candidatePaths(){
  return [process.env.SIGNALS_SOURCES_PATH, `${DATA_DIR}/signals_sources.json`, "/opt/render/project/src/data/signals_sources.json"].filter(Boolean);
}
async function tryWriteJson(filePath, obj){
  try{ await ensureDir(path.dirname(filePath)); await fs.writeFile(filePath, JSON.stringify(obj,null,2), "utf8"); return true; }
  catch{ return false; }
}
async function bootstrapSources(){
  if(process.env.SIGNALS_SOURCES_JSON){
    try{
      const parsed=JSON.parse(process.env.SIGNALS_SOURCES_JSON);
      const target=process.env.SIGNALS_SOURCES_PATH || `${DATA_DIR}/signals_sources.json`;
      if(await tryWriteJson(target, parsed)){ SOURCES_PATH_RESOLVED=target; SOURCES_ORIGIN="env_json"; return; }
    }catch(e){}
  }
  if(process.env.SIGNALS_SOURCES_B64){
    try{
      const parsed=JSON.parse(Buffer.from(process.env.SIGNALS_SOURCES_B64,"base64").toString("utf8"));
      const target=process.env.SIGNALS_SOURCES_PATH || `${DATA_DIR}/signals_sources.json`;
      if(await tryWriteJson(target, parsed)){ SOURCES_PATH_RESOLVED=target; SOURCES_ORIGIN="env_b64"; return; }
    }catch(e){}
  }
  for(const p of candidatePaths()){ try{ if(fscore.existsSync(p)){ SOURCES_PATH_RESOLVED=p; SOURCES_ORIGIN="file_existing"; return; } }catch(e){} }
  const fallback=`${DATA_DIR}/signals_sources.json`;
  if(await tryWriteJson(fallback, DEFAULT_SIGNALS_SOURCES)){ SOURCES_PATH_RESOLVED=fallback; SOURCES_ORIGIN="default_bootstrap"; }
}

/* ==========================
   BILLING (fs json)
========================== */
function currentMonthObj(){ return { month: currentMonth(), spent_usd: 0 }; }
async function loadBilling(){
  try{
    const t=await fs.readFile(BILLING_PATH,"utf8");
    const b=JSON.parse(t);
    if(b.month!==currentMonth()){ const fresh=currentMonthObj(); await fs.writeFile(BILLING_PATH, JSON.stringify(fresh,null,2)); return fresh; }
    return b;
  }catch{
    const fresh=currentMonthObj(); await ensureDir(path.dirname(BILLING_PATH)); await fs.writeFile(BILLING_PATH, JSON.stringify(fresh,null,2)); return fresh;
  }
}
async function saveBilling(b){ await fs.writeFile(BILLING_PATH, JSON.stringify(b,null,2)); }

/* ==========================
   START
========================== */
async function start(){
  await ensureDir(DATA_DIR);
  await bootstrapSources();

  /* Health */
  app.get("/healthz", async (_req,res)=>{ const b=await loadBilling(); res.json({ ok:true, month:b.month, spent:b.spent_usd }); });

  /* Debug fuentes */
  app.get("/signals/sources/debug", async (_req,res)=>{
    const envPath=process.env.SIGNALS_SOURCES_PATH||null;
    const envJson=!!process.env.SIGNALS_SOURCES_JSON;
    const envB64=!!process.env.SIGNALS_SOURCES_B64;
    const candidates=candidatePaths().map(p=>{ let exists=false,size=null; try{ if(fscore.existsSync(p)){ const st=fscore.statSync(p); exists=true; size=st.size; } }catch{} return { path:p, exists, size }; });
    let head=null; if(SOURCES_PATH_RESOLVED){ try{ head=(await fs.readFile(SOURCES_PATH_RESOLVED,"utf8")).slice(0,400); }catch{} }
    res.json({ env:{ SIGNALS_SOURCES_PATH:envPath, has_JSON:envJson, has_B64:envB64, SIGNALS_PATH }, cwd:process.cwd(), candidates, resolved:SOURCES_PATH_RESOLVED, origin:SOURCES_ORIGIN, head_preview:head });
  });

  /* Cargar/poner fuentes */
  app.post("/signals/sources/put", async (req,res)=>{
    try{
      const body=req.body; const sources=Array.isArray(body)? body : (Array.isArray(body?.sources)? body.sources : null);
      if(!sources) return res.status(400).json({ ok:false, error:"Provide array or {sources:[...]}"} );
      const target=process.env.SIGNALS_SOURCES_PATH || `${DATA_DIR}/signals_sources.json`;
      await ensureDir(path.dirname(target)); await fs.writeFile(target, JSON.stringify(sources,null,2), "utf8");
      SOURCES_PATH_RESOLVED=target; SOURCES_ORIGIN="put_endpoint";
      res.json({ ok:true, path:target, count:sources.length });
    }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
  });

  /* Auto-refresh señales (RSS/Atom) */
  function guessVertical(title){ const t=(title||"").toLowerCase(); if(t.includes("pci"))return"compliance"; if(t.includes("nis2")||t.includes("data act"))return"compliance"; if(t.includes("shopify"))return"ecommerce"; if(t.includes("gmail")||t.includes("yahoo"))return"email"; if(t.includes("whatsapp"))return"whatsapp"; if(t.includes("pos")||t.includes("restaurant")) return "ecommerce"; return"generic"; }
  function guessRegionFromUrl(url){ if(!url) return process.env.SIGNALS_REGION_DEFAULT||"LATAM"; if(url.includes("europa.eu")) return "EU"; return process.env.SIGNALS_REGION_DEFAULT||"LATAM"; }
  function severityFromText(title){ const t=(title||"").toLowerCase(); if(t.includes("mandatory")||t.includes("obligatorio")||t.includes("deadline")) return 5; if(t.includes("required")||t.includes("requisitos")) return 4; return 3; }

  app.post("/signals/auto/refresh", async (_req,res)=>{
    try{
      if(!SOURCES_PATH_RESOLVED) await bootstrapSources();
      const src=SOURCES_PATH_RESOLVED;
      if(!src || !fscore.existsSync(src)) return res.json({ ok:true, added:0, total:0, note:"signals_sources.json not found (post-bootstrap)" });

      let sources=[]; try{ const txt=await fs.readFile(src,"utf8"); const parsed=JSON.parse(txt); sources=Array.isArray(parsed)? parsed : (Array.isArray(parsed?.sources)? parsed.sources : []); }catch(e){ return res.status(400).json({ ok:false, error:"invalid_sources_json", detail:e.message }); }

      const raw=await fs.readFile(SIGNALS_PATH,"utf8").catch(()=> "[]"); const arr=JSON.parse(raw); let added=0;
      for(const s of sources){
        if(!s?.url) continue;
        try{
          const { data } = await axios.get(s.url, { timeout:15000 });
          const xml=parser.parse(data); let items=[];
          if(xml?.rss?.channel?.item) items=xml.rss.channel.item; else if(xml?.feed?.entry) items=xml.feed.entry; else if(Array.isArray(xml?.rss?.item)) items=xml.rss.item; else if(Array.isArray(xml?.entry)) items=xml.entry;
          if(!Array.isArray(items)) items=[items].filter(Boolean);
          if(!items.length) continue;
          for(const it of items){
            const title=it.title?.["#text"] || it.title || it.name || "";
            const link = it.link?.href || it.link || it.guid || "";
            const vertical=s.vertical || guessVertical(title);
            const region=s.region || guessRegionFromUrl(String(link));
            const sev=s.severity || severityFromText(title);
            const imp=s.impact || 3.0;
            const yearMatch=String(title).match(/\b(202[4-9])\b/);
            const deadline=yearMatch?`${yearMatch[1]}-12-31`:new Date(Date.now()+90*86400000).toISOString().slice(0,10);
            const id=`auto_${Buffer.from((title+link)).toString("base64").slice(0,12)}`;
            const idx=arr.findIndex(x=>x.id===id); const obj={ id, vertical, region, type:s.type||"platform", title, severity:sev, impact:imp, deadline, source_url:link, ttl_days:s.ttl_days||365, updated_at:new Date().toISOString() };
            if(idx>=0) arr[idx]={...arr[idx],...obj}; else { arr.push(obj); added++; }
          }
        }catch(e){ logger.warn({ msg:"signals source error", url:s.url, err:e.message }); }
      }
      await ensureDir(path.dirname(SIGNALS_PATH)); await fs.writeFile(SIGNALS_PATH, JSON.stringify(arr,null,2));
      res.json({ ok:true, added, total:arr.length, used_path:src, origin:SOURCES_ORIGIN });
    }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
  });

  app.get("/signals/list", async (req,res)=>{
    try{
      const {region,vertical,activeOnly}=req.query;
      const raw=await fs.readFile(SIGNALS_PATH,"utf8").catch(()=> "[]"); let arr=JSON.parse(raw);
      if(activeOnly==="true"){ const now=Date.now(); arr=arr.filter(s=>{ const ttl=Number(s.ttl_days||0); if(!ttl) return true; const base=new Date(s.updated_at||s.deadline||Date.now()).getTime(); return (now-base) <= (ttl*86400000); }); }
      const filtered=arr.filter(s => (!region||s.region===region) && (!vertical||s.vertical===vertical));
      res.json({ ok:true, total:filtered.length, signals:filtered });
    }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
  });

  app.post("/signals/upsert", async (req,res)=>{
    try{
      const now=new Date().toISOString();
      const raw=await fs.readFile(SIGNALS_PATH,"utf8").catch(()=> "[]"); const arr=JSON.parse(raw);
      const obj={...req.body}; obj.id=obj.id||`sig_${Date.now()}`; obj.updated_at=now;
      const idx=arr.findIndex(s=>s.id===obj.id); if(idx>=0) arr[idx]={...arr[idx],...obj}; else arr.push(obj);
      await fs.writeFile(SIGNALS_PATH, JSON.stringify(arr,null,2));
      res.json({ ok:true, id:obj.id, total:arr.length });
    }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
  });

  app.delete("/signals/delete", async (req,res)=>{
    try{
      const { id }=req.query; if(!id) return res.status(400).json({ ok:false, error:"id required" });
      const raw=await fs.readFile(SIGNALS_PATH,"utf8").catch(()=> "[]"); let arr=JSON.parse(raw);
      const before=arr.length; arr=arr.filter(s=>s.id!==id); await fs.writeFile(SIGNALS_PATH,JSON.stringify(arr,null,2));
      res.json({ ok:true, removed: before-arr.length });
    }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
  });

  /* ====== DEBUG expansión keywords ====== */
  app.post("/keywords/expand/debug", async (req,res)=>{
    try{
      const { topic, region="US", language="en" } = req.body || {};
      const geo = resolveGeo(language, region);
      const serp = await dfsSerpFeatures(topic, 1, geo);
      const fromSerp = [].concat(serp.serp_signals?.paa||[]).concat(serp.serp_signals?.related||[]);
      const heur = heuristicExpand(topic);
      const kfk = await dfsKeywordsForKeywords([topic, ...fromSerp, ...heur], geo);
      const auto = await dfsAutocompleteExpand([topic, ...heur], geo);
      const rawSet = uniqNorm([topic, ...fromSerp, ...(kfk.keywords||[]), ...(auto.keywords||[]), ...heur]);
      const { cleaned, rejected } = sanitizeKeywords(rawSet);
      res.json({
        counts: {
          paa: (serp.serp_signals?.paa||[]).length,
          related: (serp.serp_signals?.related||[]).length,
          heur: heur.length,
          kfk: (kfk.keywords||[]).length,
          autocomplete: (auto.keywords||[]).length,
          raw_total: rawSet.length,
          cleaned: cleaned.length,
          rejected: rejected.length
        },
        samples: {
          paa: (serp.serp_signals?.paa||[]).slice(0,10),
          related: (serp.serp_signals?.related||[]).slice(0,10),
          heur: heur.slice(0,20),
          kfk: (kfk.keywords||[]).slice(0,30),
          autocomplete: (auto.keywords||[]).slice(0,30),
          cleaned: cleaned.slice(0,50),
          rejected: rejected.slice(0,20)
        }
      });
    }catch(e){
      res.status(500).json({ error:"debug_failed", detail:e.message });
    }
  });

  /* ====== SCORE ====== */
  const ScoreRunSchema = z.object({ topic:z.string().min(3).max(160), region:z.string().min(2).max(24).default("LATAM"), language:z.string().min(2).max(7).default("es") });
  async function getSignals(){ try{ const t=await fs.readFile(SIGNALS_PATH,"utf8").catch(()=> "[]"); return JSON.parse(t); }catch{ return []; } }

  app.post("/score/run", async (req,res)=>{
    const parsed=ScoreRunSchema.safeParse(req.body);
    if(!parsed.success) return res.status(400).json({ error:"invalid_input", details: parsed.error.issues });
    const { topic, region, language }=parsed.data; const geo=resolveGeo(language, region);
    try{
      const serp=await dfsSerpFeatures(topic,1,geo);
      const fromSerp=[].concat(serp.serp_signals?.paa||[]).concat(serp.serp_signals?.related||[]);
      const heur=heuristicExpand(topic);
      const kfk=await dfsKeywordsForKeywords(uniqNorm([topic, ...fromSerp, ...heur]), geo);
      const auto=await dfsAutocompleteExpand([topic, ...heur], geo);
      const kwSet=uniqNorm([topic, ...fromSerp, ...(kfk.keywords||[]), ...(auto.keywords||[]), ...heur]).slice(0, MAX_KEYWORDS_EXPANDED);

      let svAgg=await dfsSearchVolumeChunks(kwSet, geo);
      // Fallback demanda a US/en si 0
      if (svAgg.total_sv === 0 && (language || "").toLowerCase() !== "en") {
        const geoAlt = resolveGeo("en", "US");
        const svAlt  = await dfsSearchVolumeChunks(kwSet, geoAlt);
        if (svAlt.total_sv > svAgg.total_sv) svAgg = { ...svAgg, ...svAlt };
      }

      const clusters=clusterKeywords(svAgg.items);
      const signals=await getSignals();
      let U=computeUrgency(topic, region, serp.serp_signals, signals);
      const DemandIdx=computeDemandIndex(svAgg);
      const CompIdx=Math.max(0, Math.min(1, 1 - (0.55 + serp.paid_density + serp.serp_features_load)/2.5 + 0.2*serp.volatility ));
      const PlatFit=0.7, Oper=0.8; const TtC=U>=0.6 ? 14 : 24; const GP=18320; const ProfitIdx=Math.max(0,Math.min(1,GP/20000)); const gTtC=Math.max(0,Math.min(1,(30-TtC)/20));
      const score = 25*U + 15*gTtC + 15*ProfitIdx + 15*DemandIdx + 15*CompIdx + 10*PlatFit + 5*Oper;
      const decision = (score>=70 && U>=0.6 && TtC<=21) ? "GO" : (score>=60 ? "CONDITIONAL" : "NO-GO");

      const bill=await loadBilling(); bill.spent_usd += (serp.cost||0) + (svAgg.cost||0) + (kfk.cost||0) + (auto.cost||0); await saveBilling(bill);

      res.json({
        topic, region, language,
        scores:{ total:Number(score.toFixed(2)), urgency:Number(U.toFixed(2)), ttc_days:TtC, profit30d:GP, demand:DemandIdx, competition:Number(CompIdx.toFixed(2)), platform_fit:Number(PlatFit.toFixed(2)), operability:Number(Oper.toFixed(2)) },
        decision,
        cost:{ run_usd:Number(((serp.cost||0)+(svAgg.cost||0)+(kfk.cost||0)+(auto.cost||0)).toFixed(3)), month_spent_usd: bill.spent_usd },
        demand_meta:{ keywords_used: kwSet.length, total_sv: svAgg.total_sv, avg_cpc:Number(svAgg.avg_cpc.toFixed(2)), trend_12m:Number(svAgg.trend.toFixed(2)), transactional_share:Number(svAgg.transactional_share.toFixed(2)), clusters_count: clusters.length },
        serp_meta: serp.serp_signals,
        keywords_sample: kwSet.slice(0,50),
        clusters_top: clusters.slice(0,10).map(c=>({ id:c.id, label:c.label, total_sv:c.total_sv, avg_cpc:c.avg_cpc, transactional_ratio:c.transactional_ratio, size:c.size, sample_queries:c.sample_queries }))
      });
    }catch(e){ res.status(500).json({ error:"internal_error", detail:e.message }); }
  });

  /* ====== CLUSTER ====== */
  const ClusterRunSchema = ScoreRunSchema;
  app.post("/keywords/cluster", async (req,res)=>{
    const parsed=ClusterRunSchema.safeParse(req.body);
    if(!parsed.success) return res.status(400).json({ error:"invalid_input", details: parsed.error.issues });
    const { topic, region, language }=parsed.data; const geo=resolveGeo(language, region);
    try{
      const serp=await dfsSerpFeatures(topic,1,geo);
      const fromSerp=[].concat(serp.serp_signals?.paa||[]).concat(serp.serp_signals?.related||[]);
      const heur=heuristicExpand(topic);
      const kfk=await dfsKeywordsForKeywords(uniqNorm([topic, ...fromSerp, ...heur]), geo);
      const auto=await dfsAutocompleteExpand([topic, ...heur], geo);
      const kwSet=uniqNorm([topic, ...fromSerp, ...(kfk.keywords||[]), ...(auto.keywords||[]), ...heur]).slice(0, MAX_KEYWORDS_EXPANDED);

      let svAgg=await dfsSearchVolumeChunks(kwSet, geo);
      if (svAgg.total_sv === 0 && (language || "").toLowerCase() !== "en") {
        const geoAlt = resolveGeo("en", "US");
        const svAlt  = await dfsSearchVolumeChunks(kwSet, geoAlt);
        if (svAlt.total_sv > svAgg.total_sv) svAgg = { ...svAgg, ...svAlt };
      }

      const clusters=clusterKeywords(svAgg.items);
      const bill=await loadBilling(); bill.spent_usd += (serp.cost||0) + (svAgg.cost||0) + (kfk.cost||0) + (auto.cost||0); await saveBilling(bill);
      res.json({ topic, region, language, counts:{ keywords: kwSet.length, clusters: clusters.length }, totals:{ sv: svAgg.total_sv, avg_cpc:Number(svAgg.avg_cpc.toFixed(2)) }, keywords_sample: kwSet.slice(0,50), clusters, cost:{ run_usd:Number(((serp.cost||0)+(svAgg.cost||0)+(kfk.cost||0)+(auto.cost||0)).toFixed(3)), month_spent_usd: bill.spent_usd } });
    }catch(e){ res.status(500).json({ error:"internal_error", detail:e.message }); }
  });

  /* ====== LEADS & CAPTACIÓN ====== */
  app.post("/leads/collect", async (req,res)=>{ try{
    const raw=await fs.readFile(DB_PATH,"utf8").catch(()=> JSON.stringify({leads:[]})); const db=JSON.parse(raw); db.leads=db.leads||[];
    const lead={...req.body, ts:new Date().toISOString()}; db.leads.push(lead);
    await ensureDir(path.dirname(DB_PATH)); await fs.writeFile(DB_PATH, JSON.stringify(db,null,2)); res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }});

  app.get("/leads/export", async (_req,res)=>{ try{
    const raw=await fs.readFile(DB_PATH,"utf8").catch(()=> JSON.stringify({leads:[]})); const db=JSON.parse(raw); const list=db.leads||[];
    const csv=["name,email,company,phone,notes,ts"].concat(list.map(l=>[l.name||"",l.email||"",l.company||"",l.phone||"", String(l.notes||"").replace(/,/g," "), l.ts].join(","))).join("\n");
    res.setHeader("Content-Type","text/csv"); res.setHeader("Content-Disposition","attachment; filename=leads.csv"); res.send(csv);
  }catch(e){ res.status(500).send("error"); }});

  app.use("/l", express.static(`${DATA_DIR}/sites`, { extensions:["html"] }));
  app.use("/exports", express.static(`${DATA_DIR}/exports`));

  app.post("/capture/bootstrap", async (req,res)=>{
    const { slug, title, subtitle, whatsappIntl, calendlyUrl, ogImage }=req.body;
    if(!slug) return res.status(400).json({error:"slug required"});
    const siteDir=`${DATA_DIR}/sites/${slug}`, expRoot=`${DATA_DIR}/exports`, expDir=`${DATA_DIR}/exports/${slug}`;
    try{
      await ensureDir(siteDir); await ensureDir(expRoot); await ensureDir(expDir);
      const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title||"Solución en 21 días"}</title>
<meta name="description" content="${subtitle||""}"><meta property="og:title" content="${title||""}">
<meta property="og:description" content="${subtitle||""}"><meta property="og:image" content="${ogImage||""}">
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-white text-slate-800">
<section class="max-w-5xl mx-auto px-4 py-12 text-center">
<h1 class="text-4xl font-bold mb-3">${title||""}</h1><p class="text-slate-600 mb-6">${subtitle||""}</p>
<a href="https://wa.me/${whatsappIntl||""}" class="inline-block bg-green-500 text-white px-5 py-3 rounded-lg">WhatsApp</a>
</section>
<section class="max-w-3xl mx-auto px-4 pb-12"><iframe src="${calendlyUrl||""}" width="100%" height="620"></iframe></section>
<section class="max-w-3xl mx-auto px-4 pb-16">
<form id="leadForm" class="grid gap-3">
<input name="name" placeholder="Nombre" class="border rounded px-3 py-2">
<input name="email" placeholder="Email" class="border rounded px-3 py-2">
<input name="company" placeholder="Empresa" class="border rounded px-3 py-2">
<input name="phone" placeholder="Tel/WhatsApp" class="border rounded px-3 py-2">
<textarea name="notes" placeholder="¿Qué necesitas?" class="border rounded px-3 py-2"></textarea>
<button class="bg-black text-white px-4 py-2 rounded" type="submit">Enviar</button>
</form>
<p id="ok" class="hidden text-green-700 mt-2">¡Gracias! Te contactamos en breve.</p>
<p id="err" class="hidden text-red-700 mt-2">Error al enviar.</p>
</section>
<script>
const f=document.getElementById('leadForm'), ok=document.getElementById('ok'), er=document.getElementById('err');
f.addEventListener('submit', async (e)=>{e.preventDefault(); const p=Object.fromEntries(new FormData(f).entries());
try{ const r=await fetch('/leads/collect',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(p)});
if(!r.ok) throw new Error(); ok.classList.remove('hidden'); er.classList.add('hidden'); f.reset();
}catch(e){ ok.classList.add('hidden'); er.classList.remove('hidden'); }});
</script></body></html>`;
      await fs.writeFile(path.join(siteDir,"index.html"), html, "utf8");
      await fs.writeFile(path.join(expDir,"email_sequence.txt"), "Secuencia emails (plantilla)", "utf8");
      await fs.writeFile(path.join(expDir,"linkedin_sequence.txt"), "Secuencia LinkedIn (plantilla)", "utf8");
      await fs.writeFile(path.join(expDir,"google_ads_editor.csv"), "Campaign,...,etc", "utf8");
      const zipPath=`${DATA_DIR}/exports/${slug}.zip`; const output=fscore.createWriteStream(zipPath); const archive=archiver("zip",{zlib:{level:9}});
      await new Promise((resolve,reject)=>{ output.on("close",resolve); archive.on("error",reject); archive.pipe(output); archive.directory(expDir,false); archive.finalize(); });
      res.json({ ok:true, public_url:`/l/${slug}`, download_zip:`/exports/${slug}.zip` });
    }catch(e){ res.status(500).json({error:"bootstrap_failed", detail:e.message}); }
  });

  app.listen(PORT, () => logger.info(`Market Intel Suite running on :${PORT}`));
}

start();

