import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import { z } from "zod";
import axios from "axios";
import fs from "fs/promises";
import { JSONFile } from "lowdb/node";
import { Low } from "lowdb";

// ==== Configuración inicial ====
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";
const DB_PATH = process.env.DB_PATH || "/app/data/db.json";

const logger = pino({ level: process.env.NODE_ENV === "production" ? "info" : "debug" });

const app = express();
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-origin" } }));
app.use(express.json({ limit: "64kb" }));
app.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));

// Middleware Auth
app.use((req, res, next) => {
  if (req.path === "/healthz") return next();
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

// ==== DB JSON ====
const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, { runs: [], leads: [] });
await db.read();
db.data ||= { runs: [], leads: [] };

// ==== Config Providers ====
const ENABLE_DATAFORSEO = /^true$/i.test(process.env.ENABLE_DATAFORSEO || "true");
const DFS_LOGIN = process.env.DFS_LOGIN;
const DFS_PASSWORD = process.env.DFS_PASSWORD;
const DFS_LOCATION_CODE = Number(process.env.DFS_LOCATION_CODE || 2056); // México
const DFS_LANGUAGE_ID = Number(process.env.DFS_LANGUAGE_ID || 1002);    // Español

// ==== Unit Costs ====
const UNIT = {
  DFS_SV_TASK: 0.075,
  DFS_SERP_PAGE: 0.002,
};

// ==== HTTP client ====
const http = axios.create({ timeout: 10000 });

// ==== Health ====
app.get("/healthz", async (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ==== DataForSEO Wrappers corregidos ====
async function dfsSearchVolume(keyword) {
  if (!ENABLE_DATAFORSEO) return { sv: 12000, cpc: 1.2, cost: 0 };
  const auth = { username: DFS_LOGIN, password: DFS_PASSWORD };
  const payload = [{
    language_id: DFS_LANGUAGE_ID,
    location_code: DFS_LOCATION_CODE,
    keywords: [keyword]
  }];
  try {
    const { data } = await http.post(
      "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live",
      payload,
      { auth }
    );
    const item = data?.tasks?.[0]?.result?.[0]?.items?.[0] || {};
    const sv = item.search_volume || 0;
    const cpc = (item.cpc && item.cpc[0]?.value) || 0;
    return { sv, cpc, cost: UNIT.DFS_SV_TASK };
  } catch (e) {
    logger.error({ msg: "DFS SV error", err: e.message });
    return { sv: 0, cpc: 0, cost: 0 };
  }
}

async function dfsSerpFeatures(keyword, pages = 1) {
  if (!ENABLE_DATAFORSEO) return { paid_density: 0.6, serp_features_load: 0.5, volatility: 0.3, cost: 0 };
  const auth = { username: DFS_LOGIN, password: DFS_PASSWORD };
  const payload = [{
    keyword,
    language_id: DFS_LANGUAGE_ID,
    location_code: DFS_LOCATION_CODE,
    depth: pages * 10
  }];
  try {
    const { data } = await http.post(
      "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
      payload,
      { auth }
    );
    const items = data?.tasks?.[0]?.result?.[0]?.items || [];
    const ads = items.filter(i => i.type === "ad").length;
    const paid_density = Math.min(1, ads / (pages * 10));
    const serp_features_load = Math.min(1, (items.filter(i => i.type !== "organic").length) / (pages * 10));
    return { paid_density, serp_features_load, volatility: 0.2, cost: UNIT.DFS_SERP_PAGE * pages };
  } catch (e) {
    logger.error({ msg: "DFS SERP error", err: e.message });
    return { paid_density: 0.5, serp_features_load: 0.5, volatility: 0.2, cost: 0 };
  }
}

// ==== Score Run ====
const ScoreRunSchema = z.object({
  topic: z.string().min(3).max(160),
  region: z.string().min(2).max(16).default("LATAM"),
  language: z.string().min(2).max(5).default("es")
});

app.post("/score/run", async (req, res) => {
  const parsed = ScoreRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
  const { topic, region, language } = parsed.data;

  let runCost = 0;

  try {
    // Urgency dummy
    const U = 0;

    // DataForSEO
    const [sv, serp] = await Promise.all([
      dfsSearchVolume(topic),
      dfsSerpFeatures(topic, 1)
    ]);
    runCost += sv.cost + serp.cost;

    // Build scores
    const DemandIdx = Math.max(0, Math.min(1, Math.sqrt(sv.sv) / 110 - 0.3 * serp.paid_density));
    const CompIdx = Math.max(0, Math.min(1, 1 - (0.55 + serp.paid_density + serp.serp_features_load) / 2.5 + 0.2 * serp.volatility));
    const PlatFit = 0.6;
    const Oper = 0.7;
    const TtC = 24;
    const GP = 18320;
    const ProfitIdx = Math.max(0, Math.min(1, GP / 20000));
    const gTtC = Math.max(0, Math.min(1, (30 - TtC) / 20));

    const score = 25 * U + 15 * gTtC + 15 * ProfitIdx + 15 * DemandIdx + 15 * CompIdx + 10 * PlatFit + 5 * Oper;
    const decision = (score >= 70 && U >= 0.6 && TtC <= 21) ? "GO" : (score >= 60 ? "CONDITIONAL" : "NO-GO");

    res.json({
      topic, region, language,
      scores: {
        total: Number(score.toFixed(2)), urgency: U, ttc_days: TtC, profit30d: GP,
        demand: Number(DemandIdx.toFixed(2)), competition: Number(CompIdx.toFixed(2)),
        platform_fit: Number(PlatFit.toFixed(2)), operability: Number(Oper.toFixed(2))
      },
      decision,
      cost: { run_usd: Number(runCost.toFixed(3)) }
    });

  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: "internal_error", detail: e.message });
  }
});

// ==== Start ====
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));

// Storage (LowDB)
const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, { runs: [], leads: [] });
await db.read();
db.data ||= { runs: [], leads: [] };

// Signals
async function loadSignals() {
  const text = await fs.readFile(SIGNALS_PATH, "utf8").catch(()=> "[]");
  try { return JSON.parse(text); } catch { return []; }
}

let signals = await loadSignals();

// Billing (simple monthly tracker)
async function loadBilling() {
  const text = await fs.readFile(BILLING_PATH, "utf8").catch(()=> null);
  if (!text) {
    const fresh = { month: new Date().toISOString().slice(0,7), spent_usd: 0 };
    await fs.writeFile(BILLING_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try { return JSON.parse(text); } catch {
    const fresh = { month: new Date().toISOString().slice(0,7), spent_usd: 0 };
    await fs.writeFile(BILLING_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

async function saveBilling(b) {
  await fs.writeFile(BILLING_PATH, JSON.stringify(b, null, 2));
}

function currentMonth() { return new Date().toISOString().slice(0,7); }

// Guardrails
const BUDGET_MONTHLY_LIMIT_USD = Number(process.env.BUDGET_MONTHLY_LIMIT_USD || 250);
const BUDGET_MAX_PER_RUN_USD = Number(process.env.BUDGET_MAX_PER_RUN_USD || 1.0);

// Provider toggles
const ENABLE_DATAFORSEO = /^true$/i.test(process.env.ENABLE_DATAFORSEO || "true");
const ENABLE_RAPIDAPI_TRAFFIC = /^true$/i.test(process.env.ENABLE_RAPIDAPI_TRAFFIC || "false");
const ENABLE_SERPSTAT = /^true$/i.test(process.env.ENABLE_SERPSTAT || "false");
const ENABLE_WAPPALYZER_RAPIDAPI = /^true$/i.test(process.env.ENABLE_WAPPALYZER_RAPIDAPI || "false");
const ENABLE_CLEARBIT_RAPIDAPI = /^true$/i.test(process.env.ENABLE_CLEARBIT_RAPIDAPI || "false");

// Unit costs (USD) — adjust with your negotiated prices
const UNIT = {
  DFS_SV_TASK: 0.075,           // Search Volume (up to 1000 kw)
  DFS_SERP_PAGE: 0.002,         // per SERP page (10 results)
  DFS_DOMAIN_TECH: 0.01,        // per domain technology lookup
  RAPID_TRAFFIC_PER_DOMAIN: 0.03,// avg per domain (estimator)
  SERPSTAT_PER_DOMAIN: 0.02,    // avg per domain metric pull
  WAPPA_RAPID_PER_DOMAIN: 0.03, // avg per domain lookup/enrichment
  CLEARBIT_PER_DOMAIN: 0.03     // avg enrichment per domain
};

// HTTP client with timeout
const http = axios.create({ timeout: 10000 });

// ---------- Utilities ----------
function ensureDir(p) { return fs.mkdir(p, { recursive: true }); }
function benefitItems(arr) { return (arr||[]).slice(0,3).map(b=>`<div class="p-4 border rounded-xl"><b>✓</b> ${b}</div>`).join(""); }

// ---------- Endpoints ----------
app.get("/healthz", async (req, res) => {
  const billing = await loadBilling();
  res.json({ ok: true, month: billing.month, spent: billing.spent_usd });
});

app.get("/signals/urgency", async (req, res) => {
  const vertical = req.query.vertical || null;
  const region = req.query.region || null;
  const today = new Date();
  const rows = signals.filter(ev => (!vertical || ev.vertical===vertical) && (!region || ev.region===region));
  if (!rows.length) return res.json({ urgency: 0 });
  const scores = rows.map(r => {
    const days = Math.max(0,(new Date(r.deadline)-today)/86400000);
    const prox = Math.max(0, 1 - (days/180));
    const sev  = (r.severity||0)/5;
    const imp  = Math.min(Number(r.impact||0),4)/4;
    return 0.4*sev + 0.4*prox + 0.2*imp;
  });
  res.json({ urgency: Math.max(...scores) });
});

// -------- Providers (optional) --------
async function dfsSearchVolume(keyword, location_code, language_code){
  if (!ENABLE_DATAFORSEO) return { sv: 12000, cpc: 1.2, cost: 0 };
  const auth = { username: process.env.DFS_LOGIN, password: process.env.DFS_PASSWORD };
  const payload = [{ language_code, location_code, keywords: [keyword] }];
  try {
    const { data } = await http.post("https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live", payload, { auth });
    const item = data?.tasks?.[0]?.result?.[0]?.items?.[0] || {};
    const sv = item.search_volume || 0;
    const cpc = (item.cpc && item.cpc[0]?.value) || 0;
    return { sv, cpc, cost: UNIT.DFS_SV_TASK };
  } catch (e) {
    logger.warn({ msg: "DFS SV error", err: e.message });
    return { sv: 0, cpc: 0, cost: 0 };
  }
}

async function dfsSerpFeatures(keyword, location_code, language_code, pages=1){
  if (!ENABLE_DATAFORSEO) return { paid_density: 0.6, serp_features_load: 0.5, volatility: 0.3, cost: 0 };
  const auth = { username: process.env.DFS_LOGIN, password: process.env.DFS_PASSWORD };
  const payload = [{ keyword, language_code, location_code, depth: pages*10 }];
  try {
    const { data } = await http.post("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", payload, { auth });
    const items = data?.tasks?.[0]?.result?.[0]?.items || [];
    const ads = items.filter(i=>i.type==="ad").length;
    const paid_density = Math.min(1, ads/(pages*10));
    const serp_features_load = Math.min(1, (items.filter(i=>i.type!=="organic").length)/(pages*10));
    return { paid_density, serp_features_load, volatility: 0.2, cost: UNIT.DFS_SERP_PAGE*pages };
  } catch (e) {
    logger.warn({ msg: "DFS SERP error", err: e.message });
    return { paid_density: 0.5, serp_features_load: 0.5, volatility: 0.2, cost: 0 };
  }
}

async function dfsDomainTech(domains){
  if (!ENABLE_DATAFORSEO) return { count: domains.length, cost: 0, tech: [] };
  const auth = { username: process.env.DFS_LOGIN, password: process.env.DFS_PASSWORD };
  try {
    // batch per docs would be list of domains; simplifying as cost only
    return { count: domains.length, cost: UNIT.DFS_DOMAIN_TECH * domains.length, tech: [] };
  } catch (e) {
    logger.warn({ msg: "DFS DomainTech error", err: e.message });
    return { count: 0, cost: 0, tech: [] };
  }
}

async function trafficEstimator(domains){
  if (!ENABLE_RAPIDAPI_TRAFFIC) return { cost: 0, stats: domains.map(d=>({domain:d, visits:0})) };
  const key = process.env.RAPIDAPI_TRAFFIC_KEY, host = process.env.RAPIDAPI_TRAFFIC_HOST;
  let cost = 0; const stats=[];
  for (const d of domains) {
    try {
      const { data } = await http.get(`https://${host}/estimate`, {
        headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host },
        params: { domain: d }
      });
      stats.push({ domain: d, visits: data?.visits || 0 });
      cost += UNIT.RAPID_TRAFFIC_PER_DOMAIN;
    } catch (e) {
      stats.push({ domain: d, visits: 0 });
    }
  }
  return { cost, stats };
}

async function serpstatBacklinks(domains){
  if (!ENABLE_SERPSTAT) return { cost: 0, backlinks: domains.map(d=>({domain:d, dr:0})) };
  const token = process.env.SERPSTAT_TOKEN;
  let cost = 0; const bl=[];
  for (const d of domains) {
    try {
      const { data } = await http.get(`https://api.serpstat.com/v4/?action=BacklinksSummary&query=${encodeURIComponent(d)}&token=${token}`);
      const dr = data?.result?.[0]?.sdb || 0; // placeholder metric
      bl.push({ domain: d, dr });
      cost += UNIT.SERPSTAT_PER_DOMAIN;
    } catch (e) {
      bl.push({ domain: d, dr: 0 });
    }
  }
  return { cost, backlinks: bl };
}

async function wappaTech(domains){
  if (!ENABLE_WAPPALYZER_RAPIDAPI) return { cost: 0, tech: domains.map(d=>({domain:d, tech:[]})) };
  const key = process.env.WAPPALYZER_RAPIDAPI_KEY, host = process.env.WAPPALYZER_RAPIDAPI_HOST;
  let cost=0; const out=[];
  for (const d of domains) {
    try {
      const { data } = await http.get(`https://${host}/lookup/`, {
        headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host },
        params: { urls: d }
      });
      out.push({ domain: d, tech: data?.[0]?.technologies || [] });
      cost += UNIT.WAPPA_RAPID_PER_DOMAIN;
    } catch (e) {
      out.push({ domain: d, tech: [] });
    }
  }
  return { cost, tech: out };
}

async function clearbitEnrich(domains){
  if (!ENABLE_CLEARBIT_RAPIDAPI) return { cost: 0, companies: domains.map(d=>({domain:d})) };
  const key = process.env.CLEARBIT_RAPIDAPI_KEY, host = process.env.CLEARBIT_RAPIDAPI_HOST;
  let cost = 0; const companies=[];
  for (const d of domains) {
    try {
      const { data } = await http.get(`https://${host}/enrich`, {
        headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host },
        params: { domain: d }
      });
      companies.push({ domain: d, size: data?.company?.metrics?.employeesRange || "", sector: data?.company?.category?.sector || "" });
      cost += UNIT.CLEARBIT_PER_DOMAIN;
    } catch (e) {
      companies.push({ domain: d });
    }
  }
  return { cost, companies };
}

// ---------- Scoring ----------
const ScoreRunSchema = z.object({
  topic: z.string().min(3).max(160),
  region: z.string().min(2).max(16).default("LATAM"),
  language: z.string().min(2).max(5).default("es"),
  competitors: z.array(z.string()).optional(),
  budget_soft: z.number().optional()
});

function mapVertical(topic){
  const t = topic.toLowerCase();
  return t.includes("whatsapp") ? "whatsapp"
    : (t.includes("email")||t.includes("entregabilidad")) ? "email"
    : (t.includes("shopify")||t.includes("checkout")) ? "ecommerce"
    : (t.includes("iso")||t.includes("pci")) ? "compliance" : "generic";
}

function ttCash(channel){ return channel==="remediation"?14: channel==="compliance"?24: 7; }
function operability(topic){
  const t = topic.toLowerCase();
  if (t.includes("rescate")||t.includes("entregabilidad")||t.includes("whatsapp")||t.includes("checkout")) return 0.9;
  return 0.7;
}
function profit30d({deals=2,ticket=12000,margin=0.75,cost=400}){ return deals*ticket*margin - cost; }

app.post("/score/run", async (req, res) => {
  const parsed = ScoreRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
  const { topic, region, language, competitors=[], budget_soft } = parsed.data;

  // Budget check (monthly & per run soft)
  const bill = await loadBilling();
  if (bill.month !== currentMonth()) { bill.month = currentMonth(); bill.spent_usd = 0; await saveBilling(bill); }
  const budgetLeft = BUDGET_MONTHLY_LIMIT_USD - bill.spent_usd;

  let runCost = 0;

  try {
    const vertical = mapVertical(topic);
    const channel = ["email","whatsapp","ecommerce"].includes(vertical) ? "remediation" : "compliance";

    // Urgency
    const urgReq = await (await fetch("http://localhost:"+PORT+"/healthz")).ok; // no-op
    const today = new Date();
    const rows = signals.filter(ev => (!vertical || ev.vertical===vertical) && (!region || ev.region===region));
    const U = rows.length ? Math.max(...rows.map(r => {
      const days = Math.max(0,(new Date(r.deadline)-today)/86400000);
      const prox = Math.max(0, 1 - (days/180)); const sev=(r.severity||0)/5; const imp=Math.min(Number(r.impact||0),4)/4;
      return 0.4*sev + 0.4*prox + 0.2*imp;
    })) : 0;

    // Demand + SERP (DataForSEO)
    const loc = Number(process.env.DFS_LOCATION_CODE || 2056);
    const lang = process.env.DFS_LANGUAGE_CODE || "es";
    const [sv, serp] = await Promise.all([
      dfsSearchVolume(topic, loc, lang),
      dfsSerpFeatures(topic, loc, lang, 1)
    ]);
    runCost += sv.cost + serp.cost;

    // Tech & competition domains (choose up to 3 from competitors)
    const domains = (competitors||[]).slice(0,3);
    // platform fit via DFS DomainTech or Wappalyzer
    const [dt, wtech] = await Promise.all([ dfsDomainTech(domains), wappaTech(domains) ]);
    runCost += dt.cost + wtech.cost;

    // Traffic & backlinks & enrichment
    const [traf, bl, enr] = await Promise.all([
      trafficEstimator(domains),
      serpstatBacklinks(domains),
      clearbitEnrich(domains)
    ]);
    runCost += traf.cost + bl.cost + enr.cost;

    // Budget guardrails
    if (runCost > (budget_soft || BUDGET_MAX_PER_RUN_USD) || (runCost > budgetLeft)) {
      return res.status(402).json({ error: "budget_exceeded", runCost, budgetLeft, hint: "Reduce dominios, desactiva proveedores o sube BUDGET_MAX_PER_RUN_USD" });
    }

    // Compute subscores
    const TtC = ttCash(channel);
    const Oper = operability(topic);
    const GP = profit30d({ deals: 2, ticket: vertical==="compliance"?22000:12000, margin: vertical==="compliance"?0.62:0.78, cost: 400 });

    const DemandIdx = Math.max(0, Math.min(1, Math.sqrt(sv.sv)/110 + 0.15 /*trend12m mock*/ + 0.08 /*accel8w mock*/ - 0.3*serp.paid_density));
    const CompIdx = Math.max(0, Math.min(1, 1 - (0.55 /*seo_difficulty mock*/ + serp.paid_density + serp.serp_features_load)/2.5 + 0.2*serp.volatility));
    const PlatFit = domains.length ? 0.75 : (["whatsapp","ecommerce","email"].includes(vertical)?0.8:0.6);
    const gTtC = Math.max(0, Math.min(1, (30 - TtC)/20));
    const ProfitIdx = Math.max(0, Math.min(1, GP/20000));

    const score = 25*U + 15*gTtC + 15*ProfitIdx + 15*DemandIdx + 15*CompIdx + 10*PlatFit + 5*Oper;
    const decision = (score>=70 && U>=0.6 && TtC<=21) ? "GO" : (score>=60 ? "CONDITIONAL" : "NO-GO");

    // Bill the run
    bill.spent_usd += runCost;
    await saveBilling(bill);

    // Save run
    db.data.runs.push({
      id: Date.now().toString(),
      topic, region, language, vertical, created_at: new Date().toISOString(),
      cost_usd: runCost, providers_used: {
        dataforseo: ENABLE_DATAFORSEO, rapid_traffic: ENABLE_RAPIDAPI_TRAFFIC, serpstat: ENABLE_SERPSTAT,
        wappalyzer: ENABLE_WAPPALYZER_RAPIDAPI, clearbit: ENABLE_CLEARBIT_RAPIDAPI
      },
      scores: { total: Number(score.toFixed(2)), urgency: U, ttc_days: TtC }
    });
    await db.write();

    const plan = decision==="GO" ? [
      { step:"Landing + Calendly", pre:["copy listo"], effect:"página publicada y GA4 ok" },
      { step:"Outbound 200 (ES neutro)", pre:["lista ICP"], effect:"≥16 respuestas / 10 reuniones" },
      { step:"Demos & propuestas 48h", pre:["one‑pager"], effect:"2 acuerdos prepago" }
    ] : [
      { step:"Experimento 72h", pre:["ads 300€ o 200 outbound"], effect:"≥1 demo calificada; si no, pivot/kill" }
    ];

    res.json({
      topic, region, language,
      scores: {
        total: Number(score.toFixed(2)), urgency: U, ttc_days: TtC, profit30d: GP,
        demand: Number(DemandIdx.toFixed(2)), competition: Number(CompIdx.toFixed(2)),
        platform_fit: Number(PlatFit.toFixed(2)), operability: Number(Oper.toFixed(2))
      },
      decision,
      cost: { run_usd: Number(runCost.toFixed(4)), month_spent_usd: Number(bill.spent_usd.toFixed(2)), month_limit_usd: BUDGET_MONTHLY_LIMIT_USD },
      why_now: [
        "Urgencia por señales de plataforma/regulación",
        "Entrega en ≤21 días",
        "Buen margen por configuración/no-code"
      ],
      what_to_sell: vertical==="email" ? "Bulk‑Sender Compliance Sprint (8–18k€)"
                   : vertical==="whatsapp" ? "WhatsApp Cost‑Cut & Performance (8–25k€)"
                   : vertical==="ecommerce" ? "Shopify Checkout Extensibility Rescue (7–20k€)"
                   : "ISO/PCI Readiness Pack (18–40k€)",
      who_buys: vertical==="email" ? ["Head of Growth","CRM/Marketing Ops"]
              : vertical==="whatsapp" ? ["Ecommerce Lead","CX/Operaciones"]
              : vertical==="ecommerce" ? ["Ecommerce Manager","Head of Marketing"]
              : ["CTO/COO","Compliance"],
      "30d_projection": { expected_deals: 2, ticket_hint: vertical==="compliance"?22000:12000, margin_hint: vertical==="compliance"?0.62:0.78 },
      plan
    });

  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: "internal_error", detail: e.message });
  }
});

// ---------- Leads ----------
app.post("/leads/collect", async (req, res) => {
  try {
    const lead = { ...req.body, ts: new Date().toISOString() };
    const text = await fs.readFile(DB_PATH, "utf8");
    const state = JSON.parse(text);
    state.leads = state.leads || [];
    state.leads.push(lead);
    await fs.writeFile(DB_PATH, JSON.stringify(state, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get("/leads/export", async (req, res) => {
  try {
    const text = await fs.readFile(DB_PATH, "utf8");
    const state = JSON.parse(text);
    const list = state.leads || [];
    const csv = ["name,email,company,phone,notes,ts"].concat(
      list.map(l => [l.name||"",l.email||"",l.company||"",l.phone||"", (l.notes||"").replace(/,/g," "), l.ts].join(","))
    ).join("\n");
    res.setHeader("Content-Type","text/csv");
    res.setHeader("Content-Disposition","attachment; filename=leads.csv");
    res.send(csv);
  } catch (e) { res.status(500).send("error"); }
});

// ---------- Capture Bootstrap ----------
app.use('/l', express.static('/app/data/sites', { extensions: ['html'] }));
app.use('/exports', express.static('/app/data/exports'));

app.post("/capture/bootstrap", async (req, res) => {
  const { slug, title, subtitle, benefits=[], cta, whatsappIntl, calendlyUrl, gtagId, ogImage } = req.body;
  if(!slug) return res.status(400).json({ error:"slug required" });

  const siteDir = `/app/data/sites/${slug}`;
  const expRoot  = `/app/data/exports`;
  const expDir = `/app/data/exports/${slug}`;
  await ensureDir(siteDir); await ensureDir(expRoot); await ensureDir(expDir);
  try {
    // Build landing from template
    const tplPath = path.join(process.cwd(), "templates", "landing.html");
    let html = await fs.readFile(tplPath, "utf8");
    html = html
      .replaceAll("{{TITLE}}", title || "Solución en 21 días")
      .replaceAll("{{SUBTITLE}}", subtitle || "")
      .replaceAll("{{BENEFITS}}", benefitItems(benefits))
      .replaceAll("{{CTA}}", cta || "Quiero mi demo")
      .replaceAll("{{WHATSAPP_INTL}}", whatsappIntl || "")
      .replaceAll("{{CALENDLY_URL}}", calendlyUrl || "")
      .replaceAll("{{GTAG_ID}}", gtagId || "")
      .replaceAll("{{OG_IMAGE}}", ogImage || "");

    await fs.writeFile(path.join(siteDir, "index.html"), html, "utf8");

    // Outbound & Ads assets
    const emailSrc = await fs.readFile(path.join(process.cwd(), "templates", "email_sequence.txt"), "utf8");
    const linkSrc  = await fs.readFile(path.join(process.cwd(), "templates", "linkedin_sequence.txt"), "utf8");
    const adsSrc   = (await fs.readFile(path.join(process.cwd(), "templates", "google_ads_editor.csv"), "utf8")).replaceAll("SLUG", slug);

    await fs.writeFile(path.join(expDir,"email_sequence.txt"), emailSrc, "utf8");
    await fs.writeFile(path.join(expDir,"linkedin_sequence.txt"), linkSrc, "utf8");
    await fs.writeFile(path.join(expDir,"google_ads_editor.csv"), adsSrc, "utf8");

    // ZIP
    const zipPath = `/app/data/exports/${slug}.zip`;
    const output = fscore.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(expDir, false);
    await archive.finalize();

    res.json({
      ok:true,
      public_url: `/l/${slug}`,
      download_zip: `/exports/${slug}.zip`,
      next_steps: [
        "Carga 200 cuentas ICP y envía la secuencia email/LinkedIn",
        "Sube el CSV a Google Ads Editor y activa búsqueda",
        "Monitorea /leads/export y agenda demos (Calendly)"
      ]
    });

  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: "bootstrap_failed", detail: e.message });
  }
});

// Start
app.listen(PORT, () => logger.info(`Market Intel Suite on :${PORT}`));
