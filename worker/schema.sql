-- =============================================================
--  Schéma databáze Cloudflare D1 pro meteorologický dashboard
--  Stanice: Sencor SWS 9898 WIFI
--  Poslední aktualizace: září 2026
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
    rain_total   REAL,    -- Celkový naměřený úhrn srážek (mm)
    source       TEXT     -- Zdroj záznamu: 'weathercloud' | 'wunderground'
);

-- Primární index pro rychlé dotazy podle časového rozsahu.
-- Zajišťuje, že filtrování WHERE timestamp BETWEEN x AND y nikdy
-- nevyvolá full table scan — kritické pro D1 free tier (5M reads/den).
CREATE INDEX IF NOT EXISTS idx_measurements_timestamp
    ON measurements (timestamp);
