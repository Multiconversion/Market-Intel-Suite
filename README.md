# Market Intel Suite — Plug & Play (Render)

Sistema completo para **validar ideas** y **activar captación** en minutos:
- **Score 2.0** (urgencia, TtC, beneficio 30d, demanda, competencia, platform fit, operabilidad).
- **Guardrails de presupuesto** (por run y mensual).
- **Bootstrap de captación**: landing pública, formulario, WhatsApp, Calendly, guiones de outbound y CSV de Google Ads.
- **Persistencia** en JSON (LowDB) — sin BBDD para despliegue rápido en **Render**.

## 1) Despliegue en Render (paso a paso)

1. **Repo**: sube estos archivos a GitHub.
2. **Render → New → Web Service → Connect repo**.
3. **Runtime**:
   - *Node*: Build `npm i`, Start `node server.js`, o
   - *Docker*: Render detecta el `Dockerfile`.
4. **Environment**:
   - `API_KEY=tu-clave-secreta`
   - `DB_PATH=/app/data/db.json`
   - `BILLING_PATH=/app/data/billing.json`
   - `SIGNALS_PATH=/app/data/signals_events.json`
   - Presupuestos: `BUDGET_MONTHLY_LIMIT_USD=250`, `BUDGET_MAX_PER_RUN_USD=1.0`
   - Proveedores (opcional): activa/desactiva con `true/false` y rellena credenciales (`.env.example`).
5. **Disk**: añade un Disk (1–5 GB) montado en `/app/data` (persistencia).
6. **Deploy**: Render te dará una URL `https://xxxx.onrender.com` (apúntala para el GPT Action y Ads).

## 2) Pruebas iniciales (curl)

```bash
# Salud
curl -s https://TU-URL/healthz

# Score con mocks (sin proveedores): 0 $ por run
curl -s -X POST https://TU-URL/score/run \
 -H "x-api-key: TU-CLAVE" -H "Content-Type: application/json" \
 -d '{"topic":"Rescate de entregabilidad email (Gmail/Yahoo)","region":"LATAM","language":"es"}' | jq .

# Bootstrap de captación
curl -s -X POST https://TU-URL/capture/bootstrap \
 -H "x-api-key: TU-CLAVE" -H "Content-Type: application/json" \
 -d '{"slug":"deliverability-mx","title":"Recupera entregabilidad en 10 días","subtitle":"SPF/DKIM/DMARC + one-click + warmup","benefits":["Implementación express","Plan de calentamiento","Panel Postmaster"],"cta":"Quiero mi demo","whatsappIntl":"5215512345678","calendlyUrl":"https://calendly.com/TU-USUARIO/15min","gtagId":"G-XXXX","ogImage":"https://..."}' | jq .

# Abre en navegador:
# https://TU-URL/l/deliverability-mx
```

## 3) Activar proveedores y costes por uso

1. En **Render → Environment**:
   - `ENABLE_DATAFORSEO=true` y rellena `DFS_LOGIN`, `DFS_PASSWORD`, `DFS_LOCATION_CODE`, `DFS_LANGUAGE_CODE`.
   - (Opcional) `ENABLE_RAPIDAPI_TRAFFIC=true` + `RAPIDAPI_TRAFFIC_KEY`, `RAPIDAPI_TRAFFIC_HOST`.
   - (Opcional) `ENABLE_SERPSTAT=true` + `SERPSTAT_TOKEN`.
   - (Opcional) `ENABLE_WAPPALYZER_RAPIDAPI=true` + keys/host.
   - (Opcional) `ENABLE_CLEARBIT_RAPIDAPI=true` + keys/host.
2. **Presupuestos**:
   - `BUDGET_MONTHLY_LIMIT_USD`: tope mensual (p.ej. 250).
   - `BUDGET_MAX_PER_RUN_USD`: tope por evaluación (p.ej. 1.0).
3. **Ver costes acumulados**: respuesta de `/score/run` incluye `cost.run_usd` y `cost.month_spent_usd`.
   - Si excedes presupuesto: el endpoint devuelve `402 budget_exceeded`.

## 4) Conectar el GPT con Action

- En el **Builder de GPTs → Actions → Add Action**:
  - Importa `openapi.yaml` y cambia `servers.url` a tu URL de Render.
  - **Auth**: API Key header → `x-api-key` (usa tu `API_KEY`).
  - (Opcional) **Structured Outputs** para tarjetas estandarizadas.

## 5) Flujo operativo (Día 0–2)

- **Día 0**: desplegar, probar `/healthz` y `/score/run`.
- **Día 1**: activar DataForSEO (y otros) con presupuesto; correr lote de 10–20 ideas.
- **Día 1 tarde**: elegir 3 con `decision=GO`; por cada una **/capture/bootstrap**.
- **Día 2**: publicar landings, enviar **outbound a 200 cuentas** y activar **Google Ads** con el CSV.

## 6) Export de leads

```bash
curl -s https://TU-URL/leads/export -H "x-api-key: TU-CLAVE" -o leads.csv
```

## 7) Buenas prácticas y errores comunes

- **401 unauthorized** → faltó `x-api-key`.
- **402 budget_exceeded** → baja dominios/keywords o sube `BUDGET_MAX_PER_RUN_USD`.
- **Time-out proveedores** → reintenta; los endpoints ya tienen `timeout=10s`.
- **Render Disk**: asegúrate de montar `/app/data` (si no, no persiste).
- **No pongas claves** en prompts del GPT; usa solo el header.

## 8) Estructura

```
market-intel-suite/
├─ Dockerfile
├─ package.json
├─ server.js
├─ openapi.yaml
├─ templates/
│  ├─ landing.html
│  ├─ email_sequence.txt
│  ├─ linkedin_sequence.txt
│  └─ google_ads_editor.csv
├─ data/
│  ├─ db.json
│  ├─ billing.json
│  └─ signals_events.json
└─ .env.example
```

## 9) Tuning del coste por idea

- Ajusta **UNIT.*** en `server.js` según tus precios reales.
- Limita dominios en `competitors` (3 sugeridos) para controlar coste.
- Usa **DFS depth=1** para SERP y **SV 1 task** por idea (hasta 1.000 keywords semilla).

¡Listo para correr y vender!
