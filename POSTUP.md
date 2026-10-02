# 📋 POSTUP — Meteorologický dashboard "Stanice"

> Tento soubor slouží jako deník projektu. Zaznamenává co bylo hotovo a co zbývá.  
> Poslední aktualizace: **2. října 2026**

---

## 🧱 Architektura systému

```
Sencor SWS 9898 WIFI
       │ (každou minutu odesílá data)
       ▼
Weather Underground (prostředník)
       │
       │ Cloudflare Worker (cron každou minutu)
       ▼
Cloudflare D1 (SQLite databáze)
       │
       │ REST API (read-only)
       ▼
Frontend — GitHub Pages (dashboard s grafy)
```

**Provoz zdarma:** Cloudflare Workers Free + D1 Free + GitHub Pages Free

---

## ✅ VŠE HOTOVO 🎉

### Chat 1 — Analýza a plánování (září 2026)
- [x] Analyzována stanice Sencor SWS 9898 (nemá UV/solar, má indoor senzor)
- [x] Analyzována CSV data z Weathercloudu (UTF-16LE, středník, tlak s čárkou, Prague čas)
- [x] Navržena celá architektura systému
- [x] Navrženo SQL schéma databáze
- [x] Vytvořen `README.md` se specifikací projektu

### Chat 2 — Backend a databáze (30. září 2026)
- [x] Vytvořen `worker/schema.sql` — struktura D1 databáze
  - Tabulka `measurements` s UNIQUE na `timestamp`
  - INDEX na `timestamp` pro rychlé dotazy
  - Sloupec `source` (weathercloud / wunderground)
- [x] Vytvořen `scripts/import_weathercloud.js` — import historických CSV
  - Dekóduje UTF-16LE, středník, tlak `1,012.7 → 1012.7`
  - Převod Prague (CEST/CET) → UTC timestamp
  - `INSERT OR IGNORE` — bezpečný opakovaný import
  - Dávkování po 500 řádcích kvůli Wrangler CLI limitu
- [x] Nainstalován Wrangler CLI (`npm install wrangler --save-dev`)
- [x] Přihlášení k Cloudflare (`npx wrangler login`)
- [x] Vytvořena D1 databáze `stanice-db` na Cloudflare
  - database_id: `2ca5d340-b444-4083-b85d-18d0150efc62`
- [x] Vytvořena tabulka v D1 (`worker/schema.sql` nasazen)
- [x] Naimportována historická data (květen–srpen 2026) do D1
- [x] Vytvořen `worker/wrangler.toml` — konfigurace Workeru
- [x] Vytvořen `worker/src/index.js` — kompletní Cloudflare Worker
  - Cron každou minutu → stahuje WU API → ukládá do D1
  - REST API: `/api/current`, `/api/history`, `/api/daily`, `/api/records`, `/api/stats`
  - Maximální bezpečnost (CORS, parametrizované dotazy, validace vstupů)

### Chat 3 — Deploy a živá data (2. října 2026)
- [x] Uložen `WU_STATION_ID` jako Cloudflare Secret
- [x] Uložen `WU_API_KEY` jako Cloudflare Secret
- [x] Worker nasazen na Cloudflare (`npx wrangler deploy`)
  - URL: `https://stanice-worker.petmat247.workers.dev`
  - Cron běží každou minutu ✅
- [x] Ověřena funkčnost REST API v prohlížeči (`/api/current` vrací JSON) ✅
- [x] Živá data z WU se ukládají do D1 každou minutu ✅
- [x] Doimportována data za **září 2026** (4 294 záznamů) a **říjen 2026** (105 záznamů)
- [x] Databáze obsahuje celkem **~17 000+ záznamů** (+ roste každou minutu)

### Chat 4 — GitHub + Pages + CORS (2. října 2026)
- [x] Vytvořen `.gitignore` (vylučuje `node_modules/`, `.DS_Store`, `.wrangler/`, Word temp soubory)
- [x] Inicializován git repozitář (`git init`)
- [x] Vytvořen repozitář na GitHubu: [petmat247-cloud/WeatherStation](https://github.com/petmat247-cloud/WeatherStation)
- [x] Kód pushnut na GitHub (`git push -u origin main`)
- [x] Zapnuty **GitHub Pages** ze složky `/docs` na větvi `main`
  - Živá URL: `https://petmat247-cloud.github.io/WeatherStation/`
- [x] Aktualizován CORS v `worker/wrangler.toml`
  - `ALLOWED_ORIGIN = "https://petmat247-cloud.github.io"`
- [x] Worker znovu nasazen s novým CORS (`npx wrangler deploy`)
- [x] Proveden kompletní **bezpečnostní audit** repozitáře
  - Výsledek: BEZPEČNÉ ✅ — žádné API klíče, čistá git historie, SQL injection chráněno
  - Dokumentace uložena lokálně: `docs/Bezpecnostni_audit_Stanice.docx`
- [x] VS Code nastaven pro přímý push na GitHub (Source Control panel)

### Chat 5 — Frontend dashboard (2. října 2026)
- [x] Vytvořen kompletní frontend dashboard — nahrazuje placeholder
  - Rozděleno do 3 souborů: `index.html` + `style.css` + `app.js`
  - Záložková struktura: Aktuálně / Grafy / Statistiky / Rekordy
  - Světlý + tmavý režim (auto-detect + manuální přepínání, uložení do localStorage)
  - **Aktuálně:** 6 karet (venkovní teplota, vnitřní teplota, vlhkost, tlak, vítr, srážky)
  - Pocitová teplota, rosný bod, popis vlhkosti a tlaku, otáčecí šipka směru větru
  - **Grafy:** 5 grafů s Chart.js — teplota (3 křivky), vlhkost, tlak, vítr, srážky
  - Přepínání rozsahu grafů: 24h / 7 dní / 30 dní
  - **Statistiky:** 24h / 7d / 30d (avg/max/min teplota, vlhkost, vítr, počet záznamů)
  - **Rekordy:** absolutní rekordy ze všech ~17 000+ záznamů
  - Automatická obnova každou minutu
  - Responzivní design (funguje na mobilu i desktopu)
- [x] Pushnut na GitHub → GitHub Pages živé ✅
- [x] Zprovozněno stahování **živých indoor dat z Weathercloudu** každých 10 minut:
  - Doplňuje `temp_in` a `humidity_in` do live záznamů v D1
  - Karta vnitřní teploty na webu i API `/api/current` již plnohodnotně zobrazují vnitřní teplotu a vlhkost domova ✅

---

## 🔜 CO ZBÝVÁ

### Průběžná údržba — Import nových CSV
Každý měsíc stáhnout CSV ze Weathercloudu do `Tabulky/` a spustit:
```bash
node scripts/import_weathercloud.js
```
Duplicity se automaticky přeskočí (`INSERT OR IGNORE`).

### Volitelná vylepšení do budoucna
- Úpravy designu dashboardu dle potřeby
- Případné rozšíření o další grafy nebo pohledy

---

## 📁 Struktura projektu

```
Stanice/
├── POSTUP.md                        ← tento soubor
├── README.md                        ← specifikace projektu
├── .gitignore                       ← vylučuje node_modules, temp soubory ✅
├── Tabulky/
│   ├── Weathercloud ... 2026-05.csv
│   ├── Weathercloud ... 2026-06.csv
│   ├── Weathercloud ... 2026-07.csv
│   ├── Weathercloud ... 2026-08.csv
│   ├── Weathercloud ... 2026-09.csv
│   └── Weathercloud ... 2026-10.csv
├── worker/
│   ├── schema.sql                   ← struktura D1 databáze ✅
│   ├── wrangler.toml                ← konfigurace Workeru ✅
│   └── src/
│       └── index.js                 ← kód Workeru (cron + REST API) ✅
├── scripts/
│   └── import_weathercloud.js       ← import CSV → D1 ✅
├── frontend/
│   └── index.html                   ← záloha starého placeholderu
└── docs/                            ← GitHub Pages (frontend) ✅
    ├── index.html                   ← HTML kostra dashboardu ✅
    ├── style.css                    ← styly + light/dark theme ✅
    └── app.js                       ← logika, API volání, grafy ✅
```

---

## 🔒 Bezpečnostní architektura

| Oblast | Ochrana |
|--------|---------|
| API klíče | Cloudflare Secrets — nikdy v kódu ani na GitHubu |
| CORS | Pouze `petmat247-cloud.github.io`, žádné wildcard `*` |
| SQL injection | Parametrizované dotazy (`?` bindování) |
| Vstupní validace | Všechny URL parametry ověřeny |
| Chybové zprávy | Nikdy neodhalí interní chyby |
| Zápis do DB | Jen z Cron handleru, API je read-only |
| D1 databáze | Přístupná pouze Workeru, ne veřejně |
| Cache | `/api/current` cachován 60s → ochrana D1 limitu |

---

## ⚙️ Technické detaily

| Položka | Hodnota |
|---------|---------|
| D1 databáze | `stanice-db` |
| database_id | `2ca5d340-b444-4083-b85d-18d0150efc62` |
| Worker název | `stanice-worker` |
| Worker URL | `https://stanice-worker.petmat247.workers.dev` |
| GitHub repozitář | `https://github.com/petmat247-cloud/WeatherStation` |
| GitHub Pages URL | `https://petmat247-cloud.github.io/WeatherStation/` |
| Cron interval | každou minutu (`* * * * *`) |
| WU API | `api.weather.com/v2/pws/observations/current` |
| Jednotky | metrické (°C, m/s, hPa, mm) |
| Timestamp v DB | Unix UTC (celá čísla sekund) |
| Historická data | ~17 000+ záznamů, květen–říjen 2026 |
| Live data od | 2. října 2026, roste každou minutu |
