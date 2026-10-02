# 📋 POSTUP — Meteorologický dashboard "Stanice"

> Tento soubor slouží jako deník projektu. Zaznamenává co bylo hotovo a co zbývá.  
> Poslední aktualizace: **3. října 2026**

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

+ Weathercloud (cron každých 10 min) → doplňuje indoor data (temp_in, humidity_in)
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
- [x] Vytvořen `scripts/import_weathercloud.js` — import historických CSV
- [x] Nainstalován Wrangler CLI, přihlášení k Cloudflare
- [x] Vytvořena D1 databáze `stanice-db` (ID: `2ca5d340-b444-4083-b85d-18d0150efc62`)
- [x] Vytvořen `worker/src/index.js` — kompletní Cloudflare Worker
  - Cron každou minutu → WU API → D1
  - REST API: `/api/current`, `/api/history`, `/api/daily`, `/api/records`, `/api/stats`
  - Maximální bezpečnost (CORS, parametrizované dotazy, validace vstupů)

### Chat 3 — Deploy a živá data (2. října 2026)
- [x] Uloženy Cloudflare Secrets (`WU_STATION_ID`, `WU_API_KEY`)
- [x] Worker nasazen, cron běží každou minutu ✅
- [x] Naimportována data za září + říjen 2026 (celkem ~17 000+ záznamů)

### Chat 4 — GitHub + Pages + CORS (2. října 2026)
- [x] Vytvořen git repozitář, pushnut na GitHub
- [x] Zapnuty GitHub Pages ze složky `/docs`
  - Živá URL: `https://petmat247-cloud.github.io/WeatherStation/`
- [x] Nastaven CORS, nasazen Worker s novým CORS
- [x] Proveden bezpečnostní audit — výsledek: BEZPEČNÉ ✅

### Chat 5 — Frontend dashboard (2. října 2026)
- [x] Kompletní frontend dashboard (`index.html` + `style.css` + `app.js`)
  - Světlý + tmavý režim (auto-detect + manuální přepínání)
  - Záložky: Aktuálně / Grafy / Statistiky / Rekordy
  - Grafy: teplota (3 křivky), vlhkost, tlak, vítr, srážky
  - Přepínání rozsahu grafů: 24h / 7d / 30d
  - Automatická obnova každou minutu
  - Responzivní design

### Chat 6 — Indoor data + word návod + grafy (2. října 2026)
- [x] Přidán druhý cron `*/10 * * * *` — stahuje indoor data z Weathercloudu
  - `fetchFromWeathercloud()`, `updateIndoorData()`, `handleWeathercloudCron()`
  - Secrets: `WC_COOKIE`, `WC_DEVICE_ID`
  - Diagnostický endpoint `GET /api/test-wc`
- [x] Fix: Weathercloud vrátí teplotu v °C (ne ×10) — opravena logika parsování
- [x] Fix `/api/current`: COALESCE subquery — indoor hodnota se nikdy nezobrazí jako `—`
- [x] `updateIndoorData` aktualizuje záznamy z posledních 2 hodin (pokrytí při mezerách)
- [x] Opraveny vadné záznamy v DB (2 záznamy s `temp_in = 2.0` místo 20.2)
- [x] Přidány 2 nové grafy indoor dat (`chart-temp-in`, `chart-hum-in`)
- [x] Přejmenovány grafy: „Teplota" → „Venkovní teplota", „Vlhkost" → „Venkovní vlhkost"
- [x] `/api/stats` rozšířen o `avg_temp_in`, `max_temp_in`, `min_temp_in`, `avg_hum_in`
- [x] `/api/records` rozšířen o `temp_in_max`, `temp_in_min`, `humidity_in_min`, `humidity_in_max`
- [x] Statistiky a rekordy na webu zobrazují indoor hodnoty
- [x] Vytvořen Word návod pro obnovu Weathercloud cookie
  - `docs/Navod_Obnova_Weathercloud_Cookie.docx`
  - `scripts/generate_tutorial_docx.py`

### Chat 7 — Rozsahy grafů + čistota dat + opravy (3. října 2026)
- [x] Přidány rozsahy grafů: **1h / 60d / 90d / 180d / 365d / Vše**
  - Celá paleta: 1h · 24h · 7d · 30d · 60d · 90d · 180d · 365d · Vše
  - „Vše" pokrývá 5 let dozadu — výhledově pro budoucí data
- [x] **Čistka dat v D1** — nereálná indoor teplota ze sluníčka na senzoru (léto):
  - 236 záznamů s `temp_in ≥ 33 °C` nastaveno na `NULL`
  - Rekordy (Max. teplota doma) se automaticky aktualizovaly
- [x] **Fix downsamplingu** pro dlouhé rozsahy (60d–365d):
  - Původní bug: modulo trick `% step < 60` nefungoval — záznamy ukládané každých 60s mají zbytek vždy násobek 60, takže podmínka splnila téměř nic → grafy ukazovaly jen 2–3 body
  - Nové řešení: `GROUP BY CAST((timestamp - from) / step AS INTEGER)` + `MIN(rowid)` — spolehlivě vybere první záznam z každého časového bucketu
  - Výsledek: 60d / 90d / 180d / 365d ukazují data rovnoměrně přes celý rozsah ✅
- [x] **Fix formátu času** na ose X grafů:
  - macOS Chrome zobrazoval AM/PM formát
  - Přidán `ticks.callback` v Chart.js — vynucuje `HH:mm` bez ohledu na locale prohlížeče/OS
  - 1h/24h → `13:45`, delší rozsahy → `02.10.`
- [x] MAX_LIMIT v handleHistory zvýšen z 1440 na 2880 (rezerva pro budoucnost)
- [x] Maximální rozsah API rozšířen z 365d na 5 let (pro tlačítko „Vše")

---

## 🔜 CO ZBÝVÁ

### Průběžná údržba — Obnova Weathercloud cookie
Přibližně jednou za pár týdnů/měsíců cookie vyprší. Postup je popsán v:
```
docs/Navod_Obnova_Weathercloud_Cookie.docx
```
Poté spustit:
```bash
npx wrangler secret put WC_COOKIE --config worker/wrangler.toml
```

### Průběžná údržba — Import nových CSV (volitelné)
Živá data se ukládají automaticky každou minutu. CSV import je jen záloha/doplnění:
```bash
node scripts/import_weathercloud.js
```

### Volitelná vylepšení do budoucna
- Úpravy designu dashboardu dle potřeby
- Případné rozšíření statistik o delší časová okna (60d/90d)

---

## 📁 Struktura projektu

```
Stanice/
├── POSTUP.md                        ← tento soubor
├── README.md                        ← specifikace projektu
├── .gitignore
├── Tabulky/
│   ├── Weathercloud ... 2026-05.csv
│   ├── Weathercloud ... 2026-06.csv
│   ├── Weathercloud ... 2026-07.csv
│   ├── Weathercloud ... 2026-08.csv
│   ├── Weathercloud ... 2026-09.csv
│   └── Weathercloud ... 2026-10.csv
├── worker/
│   ├── schema.sql                   ← struktura D1 databáze ✅
│   ├── wrangler.toml                ← konfigurace (dual cron: WU + WC) ✅
│   └── src/
│       └── index.js                 ← Worker (cron WU + WC, REST API, downsampling) ✅
├── scripts/
│   ├── import_weathercloud.js       ← import CSV → D1 ✅
│   └── generate_tutorial_docx.py   ← generátor Word návodu ✅
└── docs/                            ← GitHub Pages (frontend) ✅
    ├── index.html                   ← HTML kostra dashboardu ✅
    ├── style.css                    ← styly + light/dark theme ✅
    ├── app.js                       ← logika, API volání, grafy, rozsahy ✅
    └── Navod_Obnova_Weathercloud_Cookie.docx ← návod pro cookie ✅
```

---

## 🔒 Bezpečnostní architektura

| Oblast | Ochrana |
|--------|---------|
| API klíče | Cloudflare Secrets — nikdy v kódu ani na GitHubu |
| Indoor cookie | Cloudflare Secret `WC_COOKIE` |
| CORS | Pouze `petmat247-cloud.github.io` |
| SQL injection | Parametrizované dotazy (`?` bindování) |
| Vstupní validace | Všechny URL parametry ověřeny |
| Zápis do DB | Jen z Cron handlerů, API je read-only |
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
| Cron WU | každou minutu (`* * * * *`) |
| Cron Weathercloud | každých 10 minut (`*/10 * * * *`) |
| WU API | `api.weather.com/v2/pws/observations/current` |
| Jednotky | metrické (°C, m/s, hPa, mm) |
| Timestamp v DB | Unix UTC (celá čísla sekund) |
| Historická data | ~17 000+ záznamů, květen–říjen 2026 |
| Live data od | 2. října 2026, roste každou minutu |
| Rozsahy grafů | 1h / 24h / 7d / 30d / 60d / 90d / 180d / 365d / Vše |
| Downsampling | GROUP BY bucket → vždy ~1 440 bodů rovnoměrně přes celý rozsah |
