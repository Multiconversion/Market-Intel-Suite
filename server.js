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
import { JSONFile } from "lowdb/node";
import { Low } from "lowdb";

// ========= Config inicial =========
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";
const DB_PATH = process.env.DB_PATH || "/app/data/db.json";
const BILLING_PATH = process.env.BILLING_PATH || "/app/data/billing.json";
const SIGNALS_PATH = process.env.SIGNALS_PATH || "/app/data/signals_events.json";

const logger = pino({ level: process.env.NODE_ENV === "production" ? "info" : "debug" });

const app = express();
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-origin" } }));
app.use(express.json({ limit: "64kb" }));
app.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));

// Auth
app.use((req, res, next) => {
  if (req.path === "/healthz") return next();
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

// ========= LowDB =========
const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, { runs: [], leads: [] });
await db.read();
db.data ||= { runs: [], leads: [] };

// ========= Signals & Billing =========
async function loadSignals() {
  const text = await fs.readFile(SIGNALS_PATH, "utf8").catch(()=> "[]");
  try { return JSON.parse(text); } catch { return []; }
}
let signals = await loadSignals();

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
async function saveBilling(b) { await fs.writeFile(BILLING_PATH, JSON.stringify(b, null, 2)); }
function currentMonth() { return new Date().toISOString().slice(0,7); }

// ========= Providers Config =========
const ENABLE_DATAFORSEO = /^true$/i.test(process.env.ENABLE_DATAFORSEO || "true");

// DataForSEO creds & locale
const DFS_LOGIN = process.env.DFS_LOGIN;
const DFS_PASSWORD = process.env.DFS_PASSWORD;
const DFS_LOCATION_CODE = Number(process.env.DFS_LOCATION_CODE || 2056); // MX
const DFS_LANGUAGE_CODE = process.env.DFS_LANGUAGE_CODE || "es";        // es

// Expansión de keywords
const ENABLE_DFS_KFK = /^true$/i.test(process.env.ENABLE_DFS_KFK || "false");
const MAX_KEYWORDS_EXPANDED = Number(process.env.MAX_KEYWORDS_EXPANDED || 50);

// ========= Costes unitarios (ajusta a tus precios) =========
const UNIT = {
  DFS_SV_TASK: 0.075,            // 1 batch SV (hasta 1000 kw)
  DFS_SERP_PAGE: 0.002,          // 1 página SERP (10 resultados)
  DFS_KFK_TASK: 0.12             // aproximado si activas KfK
};

// ========= HTTP client =========
const http = axios.create({ timeout: 10000 });

// ========= Utils =========
function ensureDir(p) { return fs.mkdir(p, { recursive: true }); }
function uniqNorm(arr){ const s=new Set(); const out=[]; for(const x of arr||[]){ const t=String(x||"").toLowerCase().trim(); if(t && !s.has(t)){ s.add(t); out.push(t); } } return out; }

// ========= Health =========
app.get("/healthz", async (_req, res) => {
  const billing = await loadBilling();
  res.json({ ok: true, month: billing.month, spent: billing.spent_usd });
});

// ========= DataForSEO: SERP Live Advanced (extrae señales + PAA/Related) =========
async function dfsSerpFeatures(keyword, pages = 1) {
  if (!ENABLE_DATAFORSEO) {
    return { paid_density: 0.4, serp_features_load: 0.5, volatility: 0.2, cost: 0,
      serp_signals: { hasNews:false, freshShare:0, paa:[], related:[] } };
  }
  const auth = { username: DFS_LOGIN, password: DFS_PASSWORD };
  const payload = [{
    keyword,
    location_code: DFS_LOCATION_CODE,
    language_code: DFS_LANGUAGE_CODE,
    depth: pages*10
  }];

  try {
    const { data } = await http.post(
      "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
      payload,
      { auth }
    );

    const items = data?.tasks?.[0]?.result?.[0]?.items || [];
    const ads = items.filter(i=>i.type==="ad").length;
    const paid_density = Math.min(1, ads/(pages*10));
    const nonOrganic = items.filter(i=>i.type!=="organic").length;
    const serp_features_load = Math.min(1, nonOrganic/(pages*10));

    // señales dinámicas
    const now = Date.now();
    const THRESH_DAYS = 45;
    const hasNews = items.some(i => ["top_stories","news","google_news"].includes(String(i.type||"").toLowerCase()));
    const freshCount = items.filter(i => {
      const t = i.timestamp || i.published_time || i.datetime;
      if (!t) return false;
      const ts = Number(new Date(t)); return Number.isFinite(ts) && (now - ts) <= THRESH_DAYS*86400000;
    }).length;
    const freshShare = items.length ? freshCount/items.length : 0;

    // PAA & Related
    const paaTitles = [];
    const relatedTerms = [];
    for (const it of items) {
      const t = String(it.type||"").toLowerCase();
      if (t==="people_also_ask" && Array.isArray(it.items)) {
        for (const q of it.items) {
          const text = q.title || q.question || q.text;
          if (text) paaTitles.push(String(text).trim());
        }
      }
      if (t==="related_searches" && Array.isArray(it.items)) {
        for (const r of it.items) {
          const text = r.keyword || r.title || r.text;
          if (text) relatedTerms.push(String(text).trim());
        }
      }
    }

    return {
      paid_density,
      serp_features_load,
      volatility: 0.2,
      cost: UNIT.DFS_SERP_PAGE*pages,
      serp_signals: { hasNews, freshShare:Number(freshShare.toFixed(2)), paa:paaTitles, related:relatedTerms }
    };
  } catch (e) {
    logger.error({ msg:"DFS SERP error", err:e.message });
    return { paid_density:0.5, serp_features_load:0.5, volatility:0.2, cost:0,
      serp_signals:{ hasNews:false, freshShare:0, paa:[], related:[] } };
  }
}

// ========= DataForSEO: Keywords for Keywords (opcional) =========
async function dfsKeywordsForKeywords(seed){
  if (!ENABLE_DATAFORSEO || !ENABLE_DFS_KFK) return { keywords:[], cost:0 };
  const auth = { username: DFS_LOGIN, password: DFS_PASSWORD };
  const payload = [{
    location_code: DFS_LOCATION_CODE,
    language_code: DFS_LANGUAGE_CODE,
    keywords: [seed],
    limit: Math.min(MAX_KEYWORDS_EXPANDED, 200)
  }];

  try {
    const { data } = await http.post(
      "https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live",
      payload,
      { auth }
    );
    const items = data?.tasks?.[0]?.result?.[0]?.items || [];
    const kws = items.map(it => String(it.keyword||"").trim()).filter(Boolean);
    return { keywords: uniqNorm(kws), cost: UNIT.DFS_KFK_TASK };
  } catch (e) {
    logger.warn({ msg:"DFS KfK error", err:e.message });
    return { keywords:[], cost:0 };
  }
}

// ========= DataForSEO: Search Volume batch =========
async function dfsSearchVolumeBatch(keywords){
  if (!ENABLE_DATAFORSEO) {
    return { cost:0, total_sv:10000, avg_cpc:1.2, items:[], trend:0.1, transactional_share:0.5 };
  }
  const auth = { username: DFS_LOGIN, password: DFS_PASSWORD };
  const payload = [{
    location_code: DFS_LOCATION_CODE,
    language_code: DFS_LANGUAGE_CODE,
    keywords: keywords.slice(0, 1000)
  }];

  try {
    const { data } = await http.post(
      "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live",
      payload,
      { auth }
    );
    const items = data?.tasks?.[0]?.result?.[0]?.items || [];

    let total_sv = 0, w_cpc = 0, transCount = 0;
    const months = new Map();
    const isTransactional = (kw, cpc, comp) => {
      const k = (kw||"").toLowerCase();
      const patterns = ["precio","coste","comprar","proveedor","consultor","consultoría","auditor","servicio","software","herramienta","migración","implementación","mejor","oferta","tarifa","planes","apps","plugin"];
      return patterns.some(p => k.includes(p)) || (cpc >= 0.5) || (comp >= 0.5);
    };

    for (const it of items) {
      const kw = String(it.keyword||"");
      const sv = Number(it.search_volume || 0);
      const cpc = Number((it.cpc && it.cpc[0]?.value) || 0);
      const comp = Number(it.competition || 0);

      total_sv += sv;
      w_cpc += cpc * sv;
      if (isTransactional(kw, cpc, comp)) transCount++;

      const ms = it.monthly_searches || it.search_volume_by_month || [];
      for (const m of ms) {
        const y = m.year || m.month?.split("-")?.[0];
        const mon = m.month || (m.month_num && String(m.month_num).padStart(2,"0"));
        const key = (y && mon) ? `${y}-${mon}` : null;
        const v = Number(m.search_volume || m.value || 0);
        if (key) months.set(key, (months.get(key) || 0) + v);
      }
    }

    const avg_cpc = total_sv ? (w_cpc / total_sv) : 0;

    // tendencia 12m
    const sortedMonths = Array.from(months.keys()).sort();
    const last12 = sortedMonths.slice(-12);
    const vals = last12.map(k => months.get(k) || 0);
    const prev6 = vals.slice(0,6).reduce((a,b)=>a+b,0);
    const last6 = vals.slice(-6).reduce((a,b)=>a+b,0);
    const trend = prev6 > 0 ? (last6 - prev6) / prev6 : 0;

    const transactional_share = items.length ? transCount/items.length : 0;

    return { cost: UNIT.DFS_SV_TASK, total_sv, avg_cpc, items, trend, transactional_share };
  } catch (e) {
    logger.error({ msg:"DFS SV batch error", err:e.message });
    return { cost:0, total_sv:0, avg_cpc:0, items:[], trend:0, transactional_share:0 };
  }
}

// ========= Keyword set builder =========
async function buildKeywordSet(topic, serpSignals){
  const seeds = [topic];
  const fromSerp = []
    .concat(serpSignals?.paa || [])
    .concat(serpSignals?.related || []);
  let kfk = { keywords:[], cost:0 };
  if (ENABLE_DFS_KFK) kfk = await dfsKeywordsForKeywords(topic);
  const all = uniqNorm([...seeds, ...fromSerp, ...kfk.keywords]);
  return { keywords: all.slice(0, MAX_KEYWORDS_EXPANDED), cost: kfk.cost };
}

// ========= Urgency 2.0 =========
function mapVertical(topic){
  const t = String(topic||"").toLowerCase();
  if (t.includes("whatsapp")) return "whatsapp";
  if (t.includes("gmail") || t.includes("yahoo") || t.includes("entregabilidad") || t.includes("email")) return "email";
  if (t.includes("shopify") || t.includes("checkout")) return "ecommerce";
  if (t.includes("iso") || t.includes("pci") || t.includes("nis2") || t.includes("data act")) return "compliance";
  return "generic";
}

function computeUrgency(topic, region, serpSignals, allSignals){
  const vertical = mapVertical(topic);
  const today = new Date();

  // señales de fichero
  const relevant = (allSignals||[]).filter(ev =>
    (!vertical || ev.vertical===vertical) && (!region || ev.region===region)
  );

  let base = 0;
  if (relevant.length) {
    base = Math.max(...relevant.map(r => {
      const days = Math.max(0, (new Date(r.deadline) - today) / 86400000);
      const prox = Math.max(0, 1 - Math.min(days,180)/180);
      const sev  = Math.min(Number(r.severity||0),5)/5;
      const imp  = Math.min(Number(r.impact||0),4)/4;
      return 0.5*prox + 0.3*sev + 0.2*imp;
    }));
  }

  // boosts dinámicos
  let boost = 0;
  if (serpSignals?.hasNews) boost += 0.15;
  if ((serpSignals?.freshShare||0) >= 0.3) boost += 0.10;
  const pattern = /\b(202[4-9]|migraci[oó]n|requisitos|obligatorio|v\d(\.\d)?)\b/i;
  if (pattern.test(String(topic))) boost += 0.10;

  return Math.max(0, Math.min(1, base + boost));
}

// ========= Demand Index 2.0 =========
function computeDemandIndex(batch){
  const sv = Number(batch.total_sv || 0);
  const cpc = Number(batch.avg_cpc || 0);
  const trend = Number(batch.trend || 0);
  const trans = Number(batch.transactional_share || 0);

  const svFactor = Math.min(1, Math.sqrt(sv)/220);
  const cpcFactor = Math.min(1, cpc/2);
  const trendClamp = Math.max(-0.5, Math.min(0.5, trend));
  const trendFactor = (trendClamp + 0.5); // 0..1

  const demandIdx = 0.50*svFactor + 0.20*trans + 0.20*trendFactor + 0.10*cpcFactor;
  return Number(demandIdx.toFixed(2));
}

// ========= /score/run =========
const ScoreRunSchema = z.object({
  topic: z.string().min(3).max(160),
  region: z.string().min(2).max(16).default("LATAM"),
  language: z.string().min(2).max(5).default("es")
});

app.post("/score/run", async (req, res) => {
  const parsed = ScoreRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error:"invalid_input", details: parsed.error.issues });
  const { topic, region, language } = parsed.data;

  try {
    // 1) SERP → señales y extracción PAA/Related
    const serp = await dfsSerpFeatures(topic, 1);

    // 2) Keyword set (SERP [+ KfK opcional])
    const { keywords: kwSet, cost: kfkCost } = await buildKeywordSet(topic, serp.serp_signals);

    // 3) Search Volume batch en 1 task para todo el clúster
    const svBatch = await dfsSearchVolumeBatch(kwSet);

    // 4) Urgency 2.0
    const U = computeUrgency(topic, region, serp.serp_signals, signals);

    // 5) Demand 2.0
    const DemandIdx = computeDemandIndex(svBatch);

    // 6) Competencia con señales del SERP
    const CompIdx = Math.max(0, Math.min(1,
      1 - (0.55 + serp.paid_density + serp.serp_features_load)/2.5 + 0.2*serp.volatility
    ));

    // 7) Resto de componentes
    const PlatFit = 0.7;
    const Oper = 0.8;
    const TtC = U >= 0.6 ? 14 : 24;
    const GP = 18320;
    const ProfitIdx = Math.max(0, Math.min(1, GP/20000));
    const gTtC = Math.max(0, Math.min(1, (30 - TtC)/20));

    // 8) Score total
    const score = 25*U + 15*gTtC + 15*ProfitIdx + 15*DemandIdx + 15*CompIdx + 10*PlatFit + 5*Oper;
    const decision = (score>=70 && U>=0.6 && TtC<=21) ? "GO" : (score>=60 ? "CONDITIONAL" : "NO-GO");

    // 9) Coste run + billing
    const runCost = (serp.cost||0) + (svBatch.cost||0) + (kfkCost||0);
    const bill = await loadBilling();
    if (bill.month !== currentMonth()) { bill.month = currentMonth(); bill.spent_usd = 0; }
    bill.spent_usd += runCost; await saveBilling(bill);

    res.json({
      topic, region, language,
      scores: {
        total: Number(score.toFixed(2)),
        urgency: Number(U.toFixed(2)),
        ttc_days: TtC,
        profit30d: GP,
        demand: DemandIdx,
        competition: Number(CompIdx.toFixed(2)),
        platform_fit: Number(PlatFit.toFixed(2)),
        operability: Number(Oper.toFixed(2))
      },
      decision,
      cost: { run_usd: Number(runCost.toFixed(3)), month_spent_usd: bill.spent_usd },
      demand_meta: {
        keywords_used: kwSet.length,
        total_sv: svBatch.total_sv,
        avg_cpc: Number(svBatch.avg_cpc.toFixed(2)),
        trend_12m: Number(svBatch.trend.toFixed(2)),
        transactional_share: Number(svBatch.transactional_share.toFixed(2))
      },
      serp_meta: serp.serp_signals
    });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error:"internal_error", detail:e.message });
  }
});

// ========= Leads & Captación =========
app.post("/leads/collect", async (req, res) => {
  try {
    const lead = { ...req.body, ts: new Date().toISOString() };
    db.data.leads.push(lead); await db.write();
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get("/leads/export", async (_req, res) => {
  try {
    const list = db.data.leads || [];
    const csv = ["name,email,company,phone,notes,ts"].concat(
      list.map(l => [l.name||"",l.email||"",l.company||"",l.phone||"", (l.notes||"").replace(/,/g," "), l.ts].join(","))
    ).join("\n");
    res.setHeader("Content-Type","text/csv");
    res.setHeader("Content-Disposition","attachment; filename=leads.csv");
    res.send(csv);
  } catch (e) { res.status(500).send("error"); }
});

// Landings/exports estáticos
app.use("/l", express.static("/app/data/sites", { extensions:["html"] }));
app.use("/exports", express.static("/app/data/exports"));

// Bootstrap de captación
app.post("/capture/bootstrap", async (req, res) => {
  const { slug, title, subtitle, benefits=[], cta, whatsappIntl, calendlyUrl, gtagId, ogImage } = req.body;
  if(!slug) return res.status(400).json({ error:"slug required" });

  const siteDir = `/app/data/sites/${slug}`;
  const expRoot = `/app/data/exports`;
  const expDir = `/app/data/exports/${slug}`;
  await ensureDir(siteDir); await ensureDir(expRoot); await ensureDir(expDir);
  try {
    const html = `
    <!doctype html><html lang="es"><head><meta charset="utf-8">
    <title>${title||"Solución en 21 días"}</title>
    <meta name="description" content="${subtitle||""}">
    <meta property="og:title" content="${title||""}"><meta property="og:description" content="${subtitle||""}">
    <meta property="og:image" content="${ogImage||""}">
    <script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-white text-slate-800">
    <section class="max-w-5xl mx-auto px-4 py-12 text-center">
      <h1 class="text-4xl font-bold mb-3">${title||""}</h1>
      <p class="text-slate-600 mb-6">${subtitle||""}</p>
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
      } catch(e){ ok.classList.add('hidden'); er.classList.remove('hidden'); }});
    </script>
    </body></html>`;
    await fs.writeFile(path.join(siteDir, "index.html"), html, "utf8");

    await fs.writeFile(path.join(expDir,"email_sequence.txt"), "Ejemplo secuencia emails", "utf8");
    await fs.writeFile(path.join(expDir,"linkedin_sequence.txt"), "Ejemplo secuencia LinkedIn", "utf8");
    await fs.writeFile(path.join(expDir,"google_ads_editor.csv"), "Campaign,...,etc", "utf8");

    const zipPath = `/app/data/exports/${slug}.zip`;
    const output = fscore.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(expDir, false);
    await archive.finalize();

    res.json({ ok:true, public_url:`/l/${slug}`, download_zip:`/exports/${slug}.zip` });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error:"bootstrap_failed", detail:e.message });
  }
});

app.listen(PORT, () => logger.info(`Market Intel Suite on :${PORT}`));
