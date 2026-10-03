# 🌦️ WeatherStation — Osobní meteorologický dashboard

> Vlastní webový dashboard pro meteorologickou/měřicí stanici **Sencor SWS 9898 WIFI**.  
> Backend postavený na **Cloudflare Workers** stahuje každou minutu data přes oficiální **Weather Underground API** a ukládá je do **Cloudflare D1**. Zobrazování zajišťuje statická stránka hostovaná na **GitHub Pages**.

---

## 📌 O projektu

Cílem projektu je vytvořit dlouhodobě fungující, bezpečný a plně automatický meteorologický dashboard, který nabídne:
- Přehlednější aktuální hodnoty než výchozí mobilní aplikace.
- Neomezenou historii díky ukládání vlastních dat do SQL databáze.
- Vlastní grafy, statistiky a rekordy.
- Provoz **zcela zdarma** (serverless architektura na GitHub Pages a Cloudflare).

Vzhledem k tomu, že použitý hardware stanice nepodporuje přímé odesílání na vlastní "Custom Server", systém využívá The Weather Company (Weather Underground) jako prostředníka, na kterého stanice data odesílá nativně. Vnitřní teplota a vlhkost jsou doplovány každých 10 minut z **Weathercloudu** (neoficiální endpoint + session cookie).

---

## 📊 Sledované meteorologické hodnoty (Sencor SWS 9898)

| Kategorie | Hodnoty |
|-----------|---------|
| **Teplota** | Venkovní teplota, vnitřní teplota, pocitová teplota (wind chill/heat index), rosný bod |
| **Vlhkost** | Venkovní relativní vlhkost (%), vnitřní relativní vlhkost (%) |
| **Tlak** | Atmosférický tlak (hPa) |
| **Vítr** | Průměrná rychlost větru (m/s), nárazy větru (gust - m/s), směr větru (°) |
| **Srážky** | Úhrn srážek (mm), intenzita srážek (mm/h) |
| **Čas** | Přesný timestamp každého záznamu (UTC) |

> **Poznámka:** WU API indoor data neposkytuje. Doplňuje je druhý cron z Weathercloudu každých 10 minut. Při výpadku cookie se indoor hodnota na webu zobrazí z posledního platného záznamu (COALESCE subquery).

---

## 🏗️ Architektura systému a tok dat

```
┌─────────────────────────────────────────┐
│     Meteorologická stanice (Doma)       │
│           (Sencor SWS 9898)             │
│   Měří senzory a odesílá přes Wi-Fi     │
└──────┬──────────────────────────────────┘
       │ ~1x za minutu
       ▼
┌─────────────────────────────────────────┐
│       Weather Underground (WU)          │
│    Ukládá data a poskytuje PWS API      │
└──────┬──────────────────────────────────┘
       │  Cron každou minutu
       ▼
┌─────────────────────────────────────────┐    ┌─────────────────────────┐
│        Cloudflare Worker (Backend)      │◀───│  Weathercloud (indoor)  │
│                                         │    │  Cron každých 10 minut  │
│  1. Fetch WU API → INSERT do D1         │    └─────────────────────────┘
│  2. Fetch Weathercloud → UPDATE temp_in │
│  3. REST API pro frontend               │
└──────┬──────────────────────────────────┘
       │
       ▼
┌──────────────────┐           ┌──────────────────┐
│  Cloudflare D1   │           │   GitHub Pages   │
│  (SQLite DB)     │           │   (Frontend)     │
│  Ukládá historii │ ◀──────── │  Vykresluje web  │
└──────────────────┘  REST API └──────────────────┘
```

---

## 🗄️ Databázové schéma (D1) — nasazeno ✅

Databáze `stanice-db` běží na Cloudflare D1 a je optimalizovaná pro čtení podle času.

```sql
CREATE TABLE IF NOT EXISTS measurements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp    INTEGER NOT NULL UNIQUE,   -- Unix timestamp UTC
    temp_out     REAL,    -- Venkovní teplota (°C)
    temp_in      REAL,    -- Vnitřní teplota (°C)
    feels_like   REAL,    -- Pocitová teplota (°C)
    dew_point    REAL,    -- Venkovní rosný bod (°C)
    humidity_out INTEGER, -- Venkovní relativní vlhkost (%)
    humidity_in  INTEGER, -- Vnitřní relativní vlhkost (%)
    pressure     REAL,    -- Atmosférický tlak (hPa)
    wind_speed   REAL,    -- Průměrná rychlost větru (m/s)
    wind_gust    REAL,    -- Nárazy větru — gust (m/s)
    wind_dir     INTEGER, -- Směr větru (0–360°)
    rain_rate    REAL,    -- Okamžitá intenzita srážek (mm/h)
    rain_total   REAL,    -- Celkový naměřený úhrn srážek (mm)
    source       TEXT     -- Zdroj: 'weathercloud' nebo 'wunderground'
);

CREATE INDEX IF NOT EXISTS idx_measurements_timestamp ON measurements (timestamp);
```

---

## 🖥️ Frontend dashboard — nasazeno ✅

Plný meteorologický dashboard na **GitHub Pages** se skládá ze 3 souborů:

| Soubor | Obsah |
|--------|-------|
| `docs/index.html` | HTML kostra stránky |
| `docs/style.css` | Styly + světlý/tmavý režim |
| `docs/app.js` | Veškerá logika — API volání, Chart.js grafy, záložky |

### Záložky dashboardu:

- **🌡️ Aktuálně** — karty s živými hodnotami (venkovní i vnitřní teplota, vlhkost, tlak, vítr, srážky), automatická obnova každou minutu
- **📈 Grafy** — 7 grafů (venkovní teplota, vnitřní teplota, venkovní vlhkost, vnitřní vlhkost, tlak, vítr, srážky), přepínání rozsahu: **1h / 24h / 7d / 30d / 60d / 90d / 180d / 365d / Vše**
- **📊 Statistiky** — min/max/průměr venkovní i vnitřní teploty a vlhkosti za 24h, 7d, 30d
- **🏆 Rekordy** — absolutní rekordy ze všech naměřených dat (včetně vnitřní teploty a vlhkosti)

### Chytré vzorkování grafů (downsampling):

Pro dlouhé rozsahy vrací API vždy ~1 440 rovnoměrně rozložených bodů přes celý rozsah (GROUP BY časový bucket). Uživatel tak vidí trend za celý rok, aniž by se stahovala stovky tisíc záznamů.

| Rozsah | Krok vzorkování |
|--------|----------------|
| 1h / 24h | každá minuta |
| 7d | každých ~7 min |
| 30d | každých ~30 min |
| 60–180d | každou hodinu |
| 365d / Vše | každých ~6 hodin |

---

## 🔒 Bezpečnost

| Oblast | Ochrana |
|--------|---------|
| API klíče | Cloudflare Secrets — nikdy v kódu ani na GitHubu |
| Indoor cookie | Cloudflare Secret `WC_COOKIE`, obnovuje se ručně dle návodu |
| CORS | Pouze `petmat247-cloud.github.io`, žádné wildcard `*` |
| SQL injection | Parametrizované dotazy (`?` bindování) |
| Vstupní validace | Všechny URL parametry ověřeny |
| Chybové zprávy | Nikdy neodhalí interní chyby |
| Zápis do DB | Jen z Cron handlerů, API je read-only |
| D1 databáze | Přístupná pouze Workeru, ne veřejně |
| Cache | `/api/current` cachován 60s → ochrana D1 limitu |

---

## 🛡️ Práce v bezplatných limitech (Free Tiers)

| Zdroj | Limit | Využití |
|-------|-------|---------|
| WU API | 1 500 volání/den | 1 440 volání/den (~96 %) |
| Cloudflare Workers | 100 000 spuštění/den | ~4 000/den |
| D1 zápisy | 100 000 řádků/den | ~1 440/den (1,4 %) |
| D1 úložiště | 5 GB | ~100 MB/rok |

---

## 🔗 Živé odkazy

| Co | URL |
|----|-----|
| **GitHub repozitář** | [github.com/petmat247-cloud/WeatherStation](https://github.com/petmat247-cloud/WeatherStation) |
| **GitHub Pages (frontend)** | [petmat247-cloud.github.io/WeatherStation](https://petmat247-cloud.github.io/WeatherStation/) |
| **Worker API** | [stanice-worker.petmat247.workers.dev/api/current](https://stanice-worker.petmat247.workers.dev/api/current) |
| **Diagnostika Weathercloud** | [stanice-worker.petmat247.workers.dev/api/test-wc](https://stanice-worker.petmat247.workers.dev/api/test-wc) |

---

## 📁 Struktura repozitáře

```
Stanice/
│
├── docs/                      # GitHub Pages (frontend) — nasazeno ✅
│   ├── index.html             # HTML kostra dashboardu
│   ├── style.css              # Styly + light/dark theme
│   ├── app.js                 # Logika, API volání, Chart.js grafy
│   └── Navod_Obnova_Weathercloud_Cookie.docx  # Návod na obnovu cookie ✅
│
├── worker/                    # Cloudflare Worker (backend) — nasazeno ✅
│   ├── src/
│   │   └── index.js           # Cron (WU + WC → D1) + REST API
│   ├── wrangler.toml          # Konfigurace (bez tajemství)
│   └── schema.sql             # SQL struktura databáze D1
│
├── scripts/
│   ├── import_weathercloud.js       # Import historických CSV dat
│   └── generate_tutorial_docx.py   # Generátor Word návodu
│
├── Tabulky/                   # Historická CSV data ze Weathercloudu
│   └── Weathercloud ... 2026-0X.csv
│
├── .gitignore
├── POSTUP.md                  # Deník projektu
└── README.md                  # Tento dokument
```

---

*Poslední aktualizace: říjen 2026 — systém plně funkční, grafy s rozsahy 1h–Vše, indoor data živá, ~17 000+ záznamů a roste*
