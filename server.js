import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import { z } from "zod";
import axios from "axios";
import fs from "fs/promises";
import { JSONFile } from "lowdb/node";
import { Low } from "lowdb";
import path from "path";
import archiver from "archiver";

// ==== Configuración inicial ====
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

// ==== Auth Middleware ====
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

// ==== Signals y Billing ====
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

// ==== Config Providers ====
const ENABLE_DATAFORSEO = /^true$/i.test(process.env.ENABLE_DATAFORSEO || "true");
const DFS_LOGIN = process.env.DFS_LOGIN;
const DFS_PASSWORD = process.env.DFS_PASSWORD;
const DFS_LOCATION_CODE = Number(process.env.DFS_LOCATION_CODE || 2056); // México
const DFS_LANGUAGE_ID = Number(process.env.DFS_LANGUAGE_ID || 1002);    // Español (Search Volume)
const DFS_LANGUAGE_CODE = process.env.DFS_LANGUAGE_CODE || "es";        // Español (SERP)

// ==== Unit Costs ====
const UNIT = {
  DFS_SV_TASK: 0.075,
  DFS_SERP_PAGE: 0.002,
};

// ==== HTTP client ====
const http = axios.create({ timeout: 10000 });

// ==== Health ====
app.get("/healthz", async (_req, res) => {
  const billing = await loadBilling();
  res.json({ ok: true, month: billing.month, spent: billing.spent_usd });
});

// ==== DataForSEO Wrappers corregidos ====
async function dfsSearchVolume(keyword) {
  if (!ENABLE_DATAFORSEO) return { sv: 12000, cpc: 1.2, cost: 0 };
  const auth = { username: DFS_LOGIN, password: DFS_PASSWORD };
  const payload = [{
    location_code: DFS_LOCATION_CODE,
    language_id: DFS_LANGUAGE_ID,
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

async function dfsSerpFeatures(keyword, pages=1) {
  if (!ENABLE_DATAFORSEO) return { paid_density: 0.6, serp_features_load: 0.5, volatility: 0.3, cost: 0 };
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
    const serp_features_load = Math.min(1, (items.filter(i=>i.type!=="organic").length)/(pages*10));
    return { paid_density, serp_features_load, volatility: 0.2, cost: UNIT.DFS_SERP_PAGE*pages };
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
    const DemandIdx = Math.max(0, Math.min(1, Math.sqrt(sv.sv)/110 - 0.3*serp.paid_density));
    const CompIdx = Math.max(0, Math.min(1, 1 - (0.55 + serp.paid_density + serp.serp_features_load)/2.5 + 0.2*serp.volatility));
    const PlatFit = 0.6;
    const Oper = 0.7;
    const TtC = 24;
    const GP = 18320;
    const ProfitIdx = Math.max(0, Math.min(1, GP/20000));
    const gTtC = Math.max(0, Math.min(1, (30 - TtC)/20));

    const score = 25*U + 15*gTtC + 15*ProfitIdx + 15*DemandIdx + 15*CompIdx + 10*PlatFit + 5*Oper;
    const decision = (score>=70 && U>=0.6 && TtC<=21) ? "GO" : (score>=60 ? "CONDITIONAL" : "NO-GO");

    // Billing
    const bill = await loadBilling();
    if (bill.month !== currentMonth()) {
      bill.month = currentMonth();
      bill.spent_usd = 0;
    }
    bill.spent_usd += runCost;
    await saveBilling(bill);

    res.json({
      topic, region, language,
      scores: {
        total: Number(score.toFixed(2)), urgency: U, ttc_days: TtC, profit30d: GP,
        demand: Number(DemandIdx.toFixed(2)), competition: Number(CompIdx.toFixed(2)),
        platform_fit: Number(PlatFit.toFixed(2)), operability: Number(Oper.toFixed(2))
      },
      decision,
      cost: { run_usd: Number(runCost.toFixed(3)), month_spent_usd: bill.spent_usd }
    });

  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: "internal_error", detail: e.message });
  }
});

// ==== Leads ====
app.post("/leads/collect", async (req, res) => {
  try {
    const lead = { ...req.body, ts: new Date().toISOString() };
    db.data.leads.push(lead);
    await db.write();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get("/leads/export", async (req, res) => {
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

// ==== Capture Bootstrap ====
app.use('/l', express.static('/app/data/sites', { extensions: ['html'] }));
app.use('/exports', express.static('/app/data/exports'));

app.post("/capture/bootstrap", async (req, res) => {
  const { slug, title, subtitle, benefits=[], cta, whatsappIntl, calendlyUrl, gtagId, ogImage } = req.body;
  if(!slug) return res.status(400).json({ error:"slug required" });

  const siteDir = `/app/data/sites/${slug}`;
  const expRoot  = `/app/data/exports`;
  const expDir = `/app/data/exports/${slug}`;
  await fs.mkdir(siteDir, { recursive: true }); 
  await fs.mkdir(expRoot, { recursive: true }); 
  await fs.mkdir(expDir, { recursive: true });

  try {
    const html = `
    <!doctype html>
    <html lang="es"><head><meta charset="utf-8">
    <title>${title||"Solución en 21 días"}</title>
    <meta name="description" content="${subtitle||""}">
    <meta property="og:title" content="${title||""}"><meta property="og:description" content="${subtitle||""}">
    <meta property="og:image" content="${ogImage||""}">
    <script src="https://cdn.tailwindcss.com"></script>
    </head><body class="bg-white text-slate-800">
    <h1>${title}</h1><p>${subtitle}</p>
    <a href="https://wa.me/${whatsappIntl||""}">WhatsApp</a>
    <iframe src="${calendlyUrl||""}" width="100%" height="600"></iframe>
    </body></html>`;
    await fs.writeFile(path.join(siteDir, "index.html"), html, "utf8");

    await fs.writeFile(path.join(expDir,"email_sequence.txt"), "Ejemplo secuencia emails", "utf8");
    await fs.writeFile(path.join(expDir,"linkedin_sequence.txt"), "Ejemplo secuencia LinkedIn", "utf8");
    await fs.writeFile(path.join(expDir,"google_ads_editor.csv"), "Campaign,...,etc", "utf8");

    const zipPath = `/app/data/exports/${slug}.zip`;
    const output = (await import('node:fs')).createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(expDir, false);
    await archive.finalize();

    res.json({ ok:true, public_url:`/l/${slug}`, download_zip:`/exports/${slug}.zip` });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: "bootstrap_failed", detail: e.message });
  }
});

// ==== Start ====
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
