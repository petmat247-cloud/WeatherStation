# 🌦️ Stanice — Osobní meteorologický dashboard

> Vlastní webový dashboard pro meteorologickou/měřicí stanici **Sencor SWS 9898 WIFI**.  
> Backend postavený na **Cloudflare Workers** stahuje každou minutu data přes oficiální **Weather Underground API** a ukládá je do **Cloudflare D1**. Zobrazování zajišťuje statická stránka hostovaná na **GitHub Pages**.

---

## 📌 O projektu

Cílem projektu je vytvořit dlouhodobě fungující, bezpečný a plně automatický meteorologický dashboard, který nabídne:
- Přehlednější aktuální hodnoty než výchozí mobilní aplikace.
- Neomezenou historii díky ukládání vlastních dat do SQL databáze.
- Vlastní grafy, statistiky a rekordy.
- Provoz **zcela zdarma** (serverless architektura na GitHub Pages a Cloudflare).

Vzhledem k tomu, že použitý hardware stanice nepodporuje přímé odesílání na vlastní "Custom Server", systém využívá The Weather Company (Weather Underground) jako prostředníka, na kterého stanice data odesílá nativně.

---

## 📊 Sledované meteorologické hodnoty (Sencor SWS 9898)

Na základě analýzy reálných dat ze stanice uchováváme tyto naměřené hodnoty (stanice **nemá** UV senzor ani senzor solárního záření, a logujeme obě hodnoty teploty a vlhkosti):

| Kategorie | Hodnoty |
|-----------|---------|
| **Teplota** | Venkovní teplota, vnitřní teplota, pocitová teplota (wind chill/heat index), rosný bod (venkovní) |
| **Vlhkost** | Venkovní relativní vlhkost (%), vnitřní relativní vlhkost (%) |
| **Tlak** | Atmosférický tlak (hPa) |
| **Vítr** | Průměrná rychlost větru (m/s), nárazy větru (gust - m/s), směr větru (°) |
| **Srážky** | Úhrn srážek (mm), intenzita srážek (mm/h) |
| **Čas** | Přesný timestamp každého záznamu (UTC) |

> **Poznámka:** Weather Underground API neposkytuje indoor data (vnitřní teplota a vlhkost) — pro live záznamy jsou tyto hodnoty `null`. Historická data z Weathercloudu (před říjnem 2026) indoor hodnoty obsahují.

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
       │
       │  Cloudflare Worker se dotazuje (Cron každou 1 minutu)
       ▼
┌─────────────────────────────────────────┐
│        Cloudflare Worker (Backend)      │
│                                         │
│  1. Fetch() na WU API (s API klíčem)    │
│  2. Parsování JSONu                     │
│  3. Uložení do databáze D1              │
│  4. Poskytování REST API pro Frontend   │
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
Obsahuje historická data z Weathercloudu (květen–říjen 2026) i živá data z Weather Underground.

```sql
CREATE TABLE IF NOT EXISTS measurements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp    INTEGER NOT NULL UNIQUE,   -- Unix timestamp UTC
    temp_out     REAL,    -- Venkovní teplota (°C)
    temp_in      REAL,    -- Vnitřní teplota (°C)
    feels_like   REAL,    -- Pocitová teplota (°C) — wind chill nebo heat index
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

- **🌡️ Aktuálně** — 6 karet s živými hodnotami (teplota, vlhkost, tlak, vítr, srážky), automatická obnova každou minutu
- **📈 Grafy** — 5 grafů (teplota se 3 křivkami, vlhkost, tlak, vítr, srážky), přepínání rozsahu 24h / 7d / 30d
- **📊 Statistiky** — min/max/průměr za 24h, 7 a 30 dní
- **🏆 Rekordy** — absolutní rekordy ze všech ~17 000+ naměřených dat

---

## 🛡️ Práce v bezplatných limitech (Free Tiers)

Tento systém je navržen tak, aby i při frekvenci 1 minuty bezpečně fungoval v rámci bezplatných tarifů navždy. Zde je rozbor limitů a ochran:

### 1. Weather Underground API
*   **Limit:** 1 500 volání denně.
*   **Naše využití:** Cron běží 1x za minutu = **1 440 volání denně**. Zůstává malá rezerva na ladění a restarty.

### 2. Cloudflare Workers
*   **Limit počtu spuštění:** 100 000 / den. (Využijeme max jednotky tisíc).
*   **Limit CPU času:** 10 ms / request. (Práce sítě / čekání na WU se do CPU nepočítá, jednoduchý zápis z JSON do SQL je hotový v řádu milisekund).

### 3. Cloudflare D1 Databáze
*   **Limit zápisu (Writes):** 100 000 řádků / den. Využíváme 1 440 řádků (cca 1,4 %).
*   **Limit úložiště (Storage):** 5 GB. Rok běhu (při zápisu po minutě) spotřebuje cca 100 MB. Vydrží desetiletí.
*   **Limit čtení (Reads) - NEJKRITIČTĚJŠÍ:** 5 milionů *prohledaných* (nikoliv vrácených) řádků denně.
    *   **Ochrana 1 (SQL Indexy):** Tabulka má primární index nad sloupcem `timestamp`. Dotazy pro frontend nesmí nikdy způsobit *full table scan*.
    *   **Ochrana 2 (Worker Cache):** Cloudflare Worker cachuje API odpovědi pro frontend, aby 5 rychlých obnovení stránky znamenalo jen 1 dotaz do databáze.

---

## 🔐 Bezpečnost
- Zdrojový kód (zde na GitHubu) **neobsahuje žádná hesla ani API klíče**.
- Station ID a API Key z Weather Underground jsou bezpečně uloženy v Cloudflare v rámci zašifrovaných tzv. **Secrets**.
- Databáze D1 není přístupná veřejně. Je zamknutá pouze pro zápis/čtení Workerem.
- Na Workeru je nastavený CORS, takže odpovídá pouze na požadavky pocházející z domény GitHub Pages webu.

---

## 🔗 Živé odkazy

| Co | URL |
|----|-----|
| **GitHub repozitář** | [github.com/petmat247-cloud/WeatherStation](https://github.com/petmat247-cloud/WeatherStation) |
| **GitHub Pages (frontend)** | [petmat247-cloud.github.io/WeatherStation](https://petmat247-cloud.github.io/WeatherStation/) |
| **Worker API** | [stanice-worker.petmat247.workers.dev/api/current](https://stanice-worker.petmat247.workers.dev/api/current) |

---

## 📁 Struktura repozitáře

```
Stanice/
│
├── docs/                      # GitHub Pages (frontend) — nasazeno ✅
│   ├── index.html             # HTML kostra dashboardu
│   ├── style.css              # Styly + light/dark theme
│   ├── app.js                 # Logika, API volání, Chart.js grafy
│   └── Navod_Obnova_Weathercloud_Cookie.docx # Podrobný návod na obnovu cookie ✅
│
├── worker/                    # Cloudflare Worker (backend) — nasazeno ✅
│   ├── src/
│   │   └── index.js           # Cron (WU API → D1) + REST API pro frontend
│   ├── wrangler.toml          # Konfigurace (bez tajemství)
│   └── schema.sql             # SQL struktura databáze D1
│
├── scripts/
│   └── import_weathercloud.js # Import historických CSV dat z Weathercloudu
│
├── Tabulky/                   # Historická CSV data ze Weathercloudu
│   ├── Weathercloud ... 2026-05.csv
│   ├── Weathercloud ... 2026-06.csv
│   ├── Weathercloud ... 2026-07.csv
│   ├── Weathercloud ... 2026-08.csv
│   ├── Weathercloud ... 2026-09.csv
│   └── Weathercloud ... 2026-10.csv
│
├── .gitignore                 # Vylučuje node_modules, temp soubory
├── POSTUP.md                  # Deník projektu — co je hotovo, co zbývá
└── README.md                  # Tento dokument
```

---

*Poslední aktualizace: říjen 2026 — systém plně funkční, dashboard živý, databáze ~17 000+ záznamů a roste*
