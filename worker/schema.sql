-- =============================================================
--  Schéma databáze Cloudflare D1 pro meteorologický dashboard
--  Stanice: Sencor SWS 9898 WIFI
--  Poslední aktualizace: listopad 2026
-- =============================================================

-- Hlavní tabulka měření
-- Každý záznam = jeden odečet stanice (interval ~10 min z Weathercloud,
-- nebo ~1 min z Weather Underground Workers).
-- timestamp je Unix čas v UTC (celá čísla sekund).
-- UNIQUE na timestamp zaručuje, že opakovaný import neprodukuje duplicity.

CREATE TABLE IF NOT EXISTS measurements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp    INTEGER NOT NULL UNIQUE,   -- Unix timestamp UTC (sekundy)
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
    rain_total   REAL,    -- Celkový naměřený úhrn srážek od půlnoci (mm)
    source       TEXT     -- Zdroj záznamu: 'weathercloud' | 'wunderground'
);

-- Primární index pro rychlé dotazy podle časového rozsahu.
-- Zajišťuje, že filtrování WHERE timestamp BETWEEN x AND y nikdy
-- nevyvolá full table scan — kritické pro D1 free tier (5M reads/den).
CREATE INDEX IF NOT EXISTS idx_measurements_timestamp
    ON measurements (timestamp);

-- Tabulka absolutních rekordů stanice (17 řádků).
-- Šetří D1 limit tím, že se rekordy nepočítají z celé tabulky při každé návštěvě.
CREATE TABLE IF NOT EXISTS all_time_records (
    metric      TEXT PRIMARY KEY,
    value       REAL,
    timestamp   INTEGER
);

-- Denní souhrny v přesném časovém pásmu Europe/Prague (vč. letního/zimního času).
-- 1 řádek na den (~365 řádků/rok) — dramaticky snižuje čtení D1 pro /api/records,
-- /api/stats a /api/daily bez nutnosti skenovat celou tabulku measurements.
CREATE TABLE IF NOT EXISTS daily_stats (
    day             TEXT PRIMARY KEY,          -- YYYY-MM-DD (Europe/Prague)
    min_ts          INTEGER NOT NULL,
    max_ts          INTEGER NOT NULL,
    records_count   INTEGER NOT NULL DEFAULT 0,
    temp_out_sum    REAL    NOT NULL DEFAULT 0,
    temp_out_cnt    INTEGER NOT NULL DEFAULT 0,
    temp_out_min    REAL,
    temp_out_max    REAL,
    temp_in_sum     REAL    NOT NULL DEFAULT 0,
    temp_in_cnt     INTEGER NOT NULL DEFAULT 0,
    temp_in_min     REAL,
    temp_in_max     REAL,
    hum_out_sum     INTEGER NOT NULL DEFAULT 0,
    hum_out_cnt     INTEGER NOT NULL DEFAULT 0,
    hum_out_min     INTEGER,
    hum_out_max     INTEGER,
    hum_in_sum      INTEGER NOT NULL DEFAULT 0,
    hum_in_cnt      INTEGER NOT NULL DEFAULT 0,
    hum_in_min      INTEGER,
    hum_in_max      INTEGER,
    pressure_min    REAL,
    pressure_max    REAL,
    wind_gust_max   REAL,
    rain_rate_max   REAL,
    rain_total_max  REAL,
    has_rain        INTEGER                    -- 1 = pršelo, 0 = bez deště, NULL = bez údajů
);

-- Klíč-hodnota stavová tabulka (např. latest_indoor, daily_stats_ready, stats_cache).
-- Zajišťuje čtení posledních indoor dat nebo snapshotu statistik za cenu 1 řádku.
CREATE TABLE IF NOT EXISTS app_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
