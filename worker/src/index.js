/**
 * Cloudflare Worker — Meteorologický dashboard "Stanice"
 * ═══════════════════════════════════════════════════════
 *
 * Dělá dvě věci:
 *   1. CRON:
 *      - každou minutu (* * * * *): stáhne aktuální data z WU API -> D1
 *      - každých 10 minut (*\/10 * * * *): doplní indoor data z Weathercloud -> D1
 *   2. HTTP API (fetch): poskytuje read-only REST API pro frontend.
 *
 * Secrets (nastavuje se příkazem: npx wrangler secret put <NÁZEV>):
 *   - WU_STATION_ID   Vaše ID stanice na Weather Underground
 *   - WU_API_KEY      API klíč z wunderground.com/member/api-keys
 *   - WC_DEVICE_ID    Weathercloud Device ID
 *   - WC_COOKIE       Session cookie z přihlášení na app.weathercloud.net
 *   - TEST_WC_TOKEN   (Volitelné) Token pro ochranu /api/test-wc
 *
 * Proměnné (nastaveno v wrangler.toml [vars]):
 *   - ALLOWED_ORIGIN  URL GitHub Pages frontendu (např. https://petmat247-cloud.github.io)
 *
 * REST API endpointy (vše GET, read-only):
 *   GET /api/current          Poslední záznam (+ rain_1h)
 *   GET /api/history          Záznamy v časovém rozsahu
 *                             ?from=UNIX_TS&to=UNIX_TS&limit=N (max 2880)
 *   GET /api/daily            Denní souhrny (min/max/avg) za posledních N dní
 *                             ?days=N (max 365)
 *   GET /api/records          Absolutní rekordy (nejvy., nejnižší, …)
 *   GET /api/stats            Statistiky za 1h / 24h / 7d / 30d / 60d / 90d / 180d / 365d / all
 *   GET /api/test-wc          Diagnostika Weathercloud cookie
 */

'use strict';

// ─── Konstanty ────────────────────────────────────────────────────────────────

const WU_API_BASE            = 'https://api.weather.com/v2/pws/observations/current';
const CACHE_CURRENT_TTL      = 60;    // 1 minuta — cache pro /api/current
const CACHE_RECORDS_TTL      = 3600;  // 1 hodina — cache pro /api/records
const CACHE_STATS_TTL        = 1800;  // 30 minut — cache pro /api/stats (Edge i D1 snapshot)
const CACHE_HISTORY_TTL      = 300;   // 5 minut — výchozí cache pro /api/history
const CACHE_HISTORY_1H_TTL   = 120;   // 2 minuty — cache pro 1h historii
const CACHE_DAILY_TTL        = 1800;  // 30 minut — cache pro /api/daily
const CACHE_TEST_WC_OK_TTL   = 30;    // 30 sekund — ochrana před spamováním /api/test-wc po úspěchu
const MAX_LIMIT              = 2880;  // max záznamů pro /api/history
const MAX_DAYS               = 365;   // max počet dní pro /api/daily
const TOTAL_RECORD_METRICS   = 17;

const PRAGUE_TZ = 'Europe/Prague';
const PRAGUE_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRAGUE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// ─── Časové pomocné funkce (Europe/Prague vč. DST) ───────────────────────────

/** Převede Unix timestamp (sekundy) na datum YYYY-MM-DD v časovém pásmu Europe/Prague. */
function getPragueDate(unixSec) {
  return PRAGUE_DATE_FMT.format(new Date(unixSec * 1000));
}

/** Přičte dny ke kalendářnímu datu YYYY-MM-DD bez časových posunů. */
function addDaysToIsoDate(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

/** Vrátí Unix timestamp (sekundy) půlnoci 00:00:00 pro zadané YYYY-MM-DD v Europe/Prague. */
function getPragueDayStartUnixFromDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const utcMidnight = Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000);
  // Praha je vždy UTC+1 (CET) nebo UTC+2 (CEST).
  return getPragueDate(utcMidnight - 7200) === isoDate ? utcMidnight - 7200 : utcMidnight - 3600;
}

/** Vrátí Unix timestamp půlnoci dnešního dne (v Europe/Prague) pro daný timestamp. */
function getPragueDayStartUnix(unixSec) {
  return getPragueDayStartUnixFromDate(getPragueDate(unixSec));
}

function roundTo(val, decimals) {
  if (val === null || val === undefined || !Number.isFinite(val)) return null;
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

function minNullable(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

function maxNullable(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

// ─── Bezpečnostní hlavičky ────────────────────────────────────────────────────

function securityHeaders() {
  return {
    'X-Content-Type-Options'    : 'nosniff',
    'X-Frame-Options'           : 'DENY',
    'Referrer-Policy'           : 'strict-origin-when-cross-origin',
    'Strict-Transport-Security' : 'max-age=31536000; includeSubDomains',
    'Cache-Control'             : 'no-store',
  };
}

/**
 * Sestaví CORS hlavičky — povolí přístup POUZE z nakonfigurované domény.
 * Pokud origin nesouhlasí, Access-Control-Allow-Origin se vůbec nepošle (nikdy '* ' ani 'null').
 */
function corsHeaders(allowedOrigin, requestOrigin) {
  const headers = {
    'Vary': 'Origin',
  };
  if (allowedOrigin && requestOrigin === allowedOrigin) {
    headers['Access-Control-Allow-Origin']  = allowedOrigin;
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age']       = '86400';
  }
  return headers;
}

// ─── Pomocné funkce pro odpovědi ──────────────────────────────────────────────

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...securityHeaders(),
      ...extraHeaders,
    },
  });
}

function errorResponse(publicMessage, status = 500, extraHeaders = {}) {
  return jsonResponse({ error: publicMessage }, status, extraHeaders);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ─── Validace vstupních parametrů ─────────────────────────────────────────────

function parsePositiveInt(value, defaultVal, max) {
  if (value === null || value === undefined || value === '') return defaultVal;
  if (!/^\d+$/.test(String(value).trim())) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, max);
}

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d+$/.test(String(value).trim())) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1577836800 || n > 4102444800) return null;
  return n;
}

// ─── Tabulky app_state & daily_stats (ochrana D1 limitu) ──────────────────────

function sqlMinMerge(col) {
  return `CASE WHEN daily_stats.${col} IS NULL THEN excluded.${col} WHEN excluded.${col} IS NULL THEN daily_stats.${col} ELSE MIN(daily_stats.${col}, excluded.${col}) END`;
}

function sqlMaxMerge(col) {
  return `CASE WHEN daily_stats.${col} IS NULL THEN excluded.${col} WHEN excluded.${col} IS NULL THEN daily_stats.${col} ELSE MAX(daily_stats.${col}, excluded.${col}) END`;
}

async function ensureAppTables(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS app_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS daily_stats (
        day             TEXT PRIMARY KEY,
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
        has_rain        INTEGER
      )
    `),
  ]);
}

async function getAppState(db, key) {
  try {
    return await db.prepare('SELECT value, updated_at FROM app_state WHERE key = ?').bind(key).first();
  } catch (_) {
    return null;
  }
}

async function setAppState(db, key, value, updatedAt = Math.floor(Date.now() / 1000)) {
  return db.prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, typeof value === 'string' ? value : JSON.stringify(value), updatedAt).run();
}

/**
 * Jednorázový backfill daily_stats z tabulky measurements po hodinových koších (UTC).
 * Protože Europe/Prague má vždy celohodinový posun (+1h / +2h), každá UTC hodina
 * spadá celá do jednoho přesného pražského dne včetně přechodů na letní/zimní čas.
 */
async function ensureDailyStatsTable(db) {
  let ready = await getAppState(db, 'daily_stats_ready');
  if (ready?.value === '1') {
    return;
  }

  await ensureAppTables(db);
  ready = await getAppState(db, 'daily_stats_ready');
  if (ready?.value === '1') {
    return;
  }

  const existingRow = await db.prepare('SELECT 1 AS ok FROM daily_stats LIMIT 1').first();
  if (existingRow) {
    await setAppState(db, 'daily_stats_ready', '1');
    return;
  }

  const hourlyRes = await db.prepare(`
    SELECT
      CAST(timestamp / 3600 AS INTEGER) AS hr,
      MIN(timestamp) AS min_ts,
      MAX(timestamp) AS max_ts,
      COUNT(*) AS records_count,
      SUM(CASE WHEN temp_out IS NOT NULL THEN temp_out ELSE 0 END) AS temp_out_sum,
      COUNT(temp_out) AS temp_out_cnt,
      MIN(temp_out) AS temp_out_min,
      MAX(temp_out) AS temp_out_max,
      SUM(CASE WHEN temp_in IS NOT NULL THEN temp_in ELSE 0 END) AS temp_in_sum,
      COUNT(temp_in) AS temp_in_cnt,
      MIN(temp_in) AS temp_in_min,
      MAX(temp_in) AS temp_in_max,
      SUM(CASE WHEN humidity_out IS NOT NULL THEN humidity_out ELSE 0 END) AS hum_out_sum,
      COUNT(humidity_out) AS hum_out_cnt,
      MIN(humidity_out) AS hum_out_min,
      MAX(humidity_out) AS hum_out_max,
      SUM(CASE WHEN humidity_in IS NOT NULL THEN humidity_in ELSE 0 END) AS hum_in_sum,
      COUNT(humidity_in) AS hum_in_cnt,
      MIN(humidity_in) AS hum_in_min,
      MAX(humidity_in) AS hum_in_max,
      MIN(pressure) AS pressure_min,
      MAX(pressure) AS pressure_max,
      MAX(wind_gust) AS wind_gust_max,
      MAX(rain_rate) AS rain_rate_max,
      MAX(rain_total) AS rain_total_max,
      MAX(CASE
        WHEN rain_rate > 0 OR rain_total > 0 THEN 1
        WHEN rain_rate IS NOT NULL OR rain_total IS NOT NULL THEN 0
        ELSE NULL
      END) AS has_rain
    FROM measurements
    GROUP BY hr
    ORDER BY hr ASC
  `).all();

  const hourlyRows = hourlyRes?.results ?? [];
  if (hourlyRows.length === 0) {
    return;
  }

  const byDay = new Map();
  for (const h of hourlyRows) {
    const day = getPragueDate(h.hr * 3600);
    let d = byDay.get(day);
    if (!d) {
      d = {
        day,
        min_ts: h.min_ts,
        max_ts: h.max_ts,
        records_count: 0,
        temp_out_sum: 0, temp_out_cnt: 0, temp_out_min: null, temp_out_max: null,
        temp_in_sum: 0,  temp_in_cnt: 0,  temp_in_min: null,  temp_in_max: null,
        hum_out_sum: 0,  hum_out_cnt: 0,  hum_out_min: null,  hum_out_max: null,
        hum_in_sum: 0,   hum_in_cnt: 0,   hum_in_min: null,   hum_in_max: null,
        pressure_min: null, pressure_max: null,
        wind_gust_max: null,
        rain_rate_max: null,
        rain_total_max: null,
        has_rain: null,
      };
      byDay.set(day, d);
    }

    d.min_ts = Math.min(d.min_ts, h.min_ts);
    d.max_ts = Math.max(d.max_ts, h.max_ts);
    d.records_count += h.records_count ?? 0;

    d.temp_out_sum += h.temp_out_sum ?? 0;
    d.temp_out_cnt += h.temp_out_cnt ?? 0;
    d.temp_out_min = minNullable(d.temp_out_min, h.temp_out_min);
    d.temp_out_max = maxNullable(d.temp_out_max, h.temp_out_max);

    d.temp_in_sum += h.temp_in_sum ?? 0;
    d.temp_in_cnt += h.temp_in_cnt ?? 0;
    d.temp_in_min = minNullable(d.temp_in_min, h.temp_in_min);
    d.temp_in_max = maxNullable(d.temp_in_max, h.temp_in_max);

    d.hum_out_sum += h.hum_out_sum ?? 0;
    d.hum_out_cnt += h.hum_out_cnt ?? 0;
    d.hum_out_min = minNullable(d.hum_out_min, h.hum_out_min);
    d.hum_out_max = maxNullable(d.hum_out_max, h.hum_out_max);

    d.hum_in_sum += h.hum_in_sum ?? 0;
    d.hum_in_cnt += h.hum_in_cnt ?? 0;
    d.hum_in_min = minNullable(d.hum_in_min, h.hum_in_min);
    d.hum_in_max = maxNullable(d.hum_in_max, h.hum_in_max);

    d.pressure_min = minNullable(d.pressure_min, h.pressure_min);
    d.pressure_max = maxNullable(d.pressure_max, h.pressure_max);
    d.wind_gust_max = maxNullable(d.wind_gust_max, h.wind_gust_max);
    d.rain_rate_max = maxNullable(d.rain_rate_max, h.rain_rate_max);
    d.rain_total_max = maxNullable(d.rain_total_max, h.rain_total_max);

    if (h.has_rain === 1 || d.has_rain === 1) d.has_rain = 1;
    else if (h.has_rain === 0 && d.has_rain === null) d.has_rain = 0;
  }

  const days = Array.from(byDay.values());
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO daily_stats (
      day, min_ts, max_ts, records_count,
      temp_out_sum, temp_out_cnt, temp_out_min, temp_out_max,
      temp_in_sum, temp_in_cnt, temp_in_min, temp_in_max,
      hum_out_sum, hum_out_cnt, hum_out_min, hum_out_max,
      hum_in_sum, hum_in_cnt, hum_in_min, hum_in_max,
      pressure_min, pressure_max,
      wind_gust_max, rain_rate_max, rain_total_max, has_rain
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const CHUNK_SIZE = 50;
  for (let i = 0; i < days.length; i += CHUNK_SIZE) {
    const chunk = days.slice(i, i + CHUNK_SIZE);
    await db.batch(
      chunk.map(d =>
        insertStmt.bind(
          d.day, d.min_ts, d.max_ts, d.records_count,
          d.temp_out_sum, d.temp_out_cnt, d.temp_out_min, d.temp_out_max,
          d.temp_in_sum, d.temp_in_cnt, d.temp_in_min, d.temp_in_max,
          d.hum_out_sum, d.hum_out_cnt, d.hum_out_min, d.hum_out_max,
          d.hum_in_sum, d.hum_in_cnt, d.hum_in_min, d.hum_in_max,
          d.pressure_min, d.pressure_max,
          d.wind_gust_max, d.rain_rate_max, d.rain_total_max, d.has_rain
        )
      )
    );
  }

  await setAppState(db, 'daily_stats_ready', '1');
}

async function upsertDailyStatsMeasurement(db, record) {
  const day = getPragueDate(record.timestamp);
  const hasRain = (record.rain_rate > 0 || record.rain_total > 0)
    ? 1
    : (record.rain_rate !== null || record.rain_total !== null) ? 0 : null;

  return db.prepare(`
    INSERT INTO daily_stats (
      day, min_ts, max_ts, records_count,
      temp_out_sum, temp_out_cnt, temp_out_min, temp_out_max,
      temp_in_sum, temp_in_cnt, temp_in_min, temp_in_max,
      hum_out_sum, hum_out_cnt, hum_out_min, hum_out_max,
      hum_in_sum, hum_in_cnt, hum_in_min, hum_in_max,
      pressure_min, pressure_max,
      wind_gust_max, rain_rate_max, rain_total_max, has_rain
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      min_ts = MIN(daily_stats.min_ts, excluded.min_ts),
      max_ts = MAX(daily_stats.max_ts, excluded.max_ts),
      records_count = daily_stats.records_count + 1,
      temp_out_sum = daily_stats.temp_out_sum + excluded.temp_out_sum,
      temp_out_cnt = daily_stats.temp_out_cnt + excluded.temp_out_cnt,
      temp_out_min = ${sqlMinMerge('temp_out_min')},
      temp_out_max = ${sqlMaxMerge('temp_out_max')},
      temp_in_sum = daily_stats.temp_in_sum + excluded.temp_in_sum,
      temp_in_cnt = daily_stats.temp_in_cnt + excluded.temp_in_cnt,
      temp_in_min = ${sqlMinMerge('temp_in_min')},
      temp_in_max = ${sqlMaxMerge('temp_in_max')},
      hum_out_sum = daily_stats.hum_out_sum + excluded.hum_out_sum,
      hum_out_cnt = daily_stats.hum_out_cnt + excluded.hum_out_cnt,
      hum_out_min = ${sqlMinMerge('hum_out_min')},
      hum_out_max = ${sqlMaxMerge('hum_out_max')},
      hum_in_sum = daily_stats.hum_in_sum + excluded.hum_in_sum,
      hum_in_cnt = daily_stats.hum_in_cnt + excluded.hum_in_cnt,
      hum_in_min = ${sqlMinMerge('hum_in_min')},
      hum_in_max = ${sqlMaxMerge('hum_in_max')},
      pressure_min = ${sqlMinMerge('pressure_min')},
      pressure_max = ${sqlMaxMerge('pressure_max')},
      wind_gust_max = ${sqlMaxMerge('wind_gust_max')},
      rain_rate_max = ${sqlMaxMerge('rain_rate_max')},
      rain_total_max = ${sqlMaxMerge('rain_total_max')},
      has_rain = CASE
        WHEN daily_stats.has_rain = 1 OR excluded.has_rain = 1 THEN 1
        WHEN daily_stats.has_rain = 0 OR excluded.has_rain = 0 THEN 0
        ELSE NULL
      END
  `).bind(
    day,
    record.timestamp,
    record.timestamp,
    record.temp_out ?? 0, record.temp_out !== null ? 1 : 0, record.temp_out, record.temp_out,
    record.temp_in ?? 0, record.temp_in !== null ? 1 : 0, record.temp_in, record.temp_in,
    record.humidity_out ?? 0, record.humidity_out !== null ? 1 : 0, record.humidity_out, record.humidity_out,
    record.humidity_in ?? 0, record.humidity_in !== null ? 1 : 0, record.humidity_in, record.humidity_in,
    record.pressure, record.pressure,
    record.wind_gust, record.rain_rate, record.rain_total, hasRain
  ).run();
}

// ─── WU API stahování ─────────────────────────────────────────────────────────

async function fetchFromWU(stationId, apiKey) {
  const url = new URL(WU_API_BASE);
  url.searchParams.set('stationId', stationId);
  url.searchParams.set('format', 'json');
  url.searchParams.set('units', 'm');
  url.searchParams.set('numericPrecision', 'decimal');
  url.searchParams.set('apiKey', apiKey);

  const response = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
    cf: { cacheTtl: 0 },
  });

  if (!response.ok) {
    throw new Error(`WU API vrátilo status ${response.status}`);
  }

  const data = await response.json();
  const obs = data?.observations?.[0];
  if (!obs) throw new Error('WU API: žádná data v odpovědi');

  const m = obs.metric;
  let feelsLike = m.temp;
  if (m.windChill !== null && m.windChill !== undefined && m.windChill < m.temp) {
    feelsLike = m.windChill;
  } else if (m.heatIndex !== null && m.heatIndex !== undefined && m.heatIndex > m.temp) {
    feelsLike = m.heatIndex;
  }

  return {
    timestamp   : obs.epoch,
    temp_out    : m.temp       ?? null,
    temp_in     : null,
    feels_like  : feelsLike    ?? null,
    dew_point   : m.dewpt      ?? null,
    humidity_out: obs.humidity ?? null,
    humidity_in : null,
    pressure    : m.pressure   ?? null,
    wind_speed  : m.windSpeed  ?? null,
    wind_gust   : m.windGust   ?? null,
    wind_dir    : obs.winddir  ?? null,
    rain_rate   : m.precipRate ?? null,
    rain_total  : m.precipTotal ?? null,
    source      : 'wunderground',
  };
}

async function saveToDB(db, record) {
  return db.prepare(`
    INSERT OR IGNORE INTO measurements
      (timestamp, temp_out, temp_in, feels_like, dew_point,
       humidity_out, humidity_in, pressure, wind_speed, wind_gust,
       wind_dir, rain_rate, rain_total, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.timestamp,
    record.temp_out,
    record.temp_in,
    record.feels_like,
    record.dew_point,
    record.humidity_out,
    record.humidity_in,
    record.pressure,
    record.wind_speed,
    record.wind_gust,
    record.wind_dir,
    record.rain_rate,
    record.rain_total,
    record.source,
  ).run();
}

/** Spočítá aktuální hodinový úhrn srážek pro hodinu daného záznamu (jen když prší). */
async function getCurrentHourRainTotal(db, record) {
  if (record.rain_total === null || record.rain_total === undefined || record.rain_total <= 0) {
    return record.rain_total === 0 ? 0 : null;
  }
  const hourStart = Math.floor(record.timestamp / 3600) * 3600;
  const hourEnd = hourStart + 3600;
  const row = await db.prepare(`
    SELECT MIN(rain_total) AS start_rain
    FROM measurements
    WHERE timestamp >= ? AND timestamp < ? AND rain_total IS NOT NULL
  `).bind(hourStart, hourEnd).first();

  if (row?.start_rain === null || row?.start_rain === undefined) return 0;
  return roundTo(Math.max(0, record.rain_total - row.start_rain), 1);
}

// ─── Cron handler (WU) ────────────────────────────────────────────────────────

async function handleCron(env) {
  if (!env.WU_STATION_ID || !env.WU_API_KEY) {
    console.error('[CRON] Chybí WU_STATION_ID nebo WU_API_KEY secret!');
    return;
  }

  try {
    await ensureDailyStatsTable(env.DB);
    await ensureRecordsTable(env.DB);

    const record = await fetchFromWU(env.WU_STATION_ID, env.WU_API_KEY);
    const result = await saveToDB(env.DB, record);
    const inserted = (result.meta?.changes ?? 0) > 0;

    if (inserted) {
      await upsertDailyStatsMeasurement(env.DB, record);
      const rainHour = await getCurrentHourRainTotal(env.DB, record);
      await checkRecordExtremes(env.DB, { ...record, rain_hour: rainHour });
      console.log(`[CRON] OK — timestamp: ${record.timestamp}, temp: ${record.temp_out}°C`);
    } else {
      console.log(`[CRON] Duplicitní timestamp ${record.timestamp}, přeskočeno`);
    }
  } catch (err) {
    console.error('[CRON] Chyba při stahování dat:', err.message);
  }
}

// ─── Cloudflare Edge Cache Helper ─────────────────────────────────────────────

async function handleCachedEndpoint(cacheApi, cacheKey, ttlSeconds, corsHdrs, ctx, fetcher) {
  if (cacheApi) {
    try {
      const cached = await cacheApi.match(cacheKey);
      if (cached) {
        const body = await cached.json();
        return jsonResponse(body, 200, {
          ...corsHdrs,
          'Cache-Control': `public, max-age=${ttlSeconds}`,
          'X-Cache': 'HIT',
        });
      }
    } catch (err) {
      console.warn('[CACHE] Chyba při čtení:', err.message);
    }
  }

  const result = await fetcher();
  const resp = jsonResponse(result, 200, {
    ...corsHdrs,
    'Cache-Control': `public, max-age=${ttlSeconds}`,
    'X-Cache': 'MISS',
  });

  if (cacheApi) {
    try {
      const putPromise = cacheApi.put(cacheKey, resp.clone());
      if (ctx?.waitUntil) {
        ctx.waitUntil(putPromise);
      } else {
        await putPromise;
      }
    } catch (err) {
      console.warn('[CACHE] Chyba při ukládání:', err.message);
    }
  }

  return resp;
}

// ─── Pomocná funkce pro výpočet deště v posledních 60 min / N hodinách ────────

/**
 * Vrátí úhrn srážek (mm) za okno [windowStart, endTs] z kumulativního denního čítače rain_total.
 * Používá pouze 1–2 bodové dotazy přes index timestamp (minimální spotřeba D1 rows_read).
 */
async function computeRainWindowFromCounters(db, windowStart, endTs, endRainTotal, windowMaxSameDay, windowMinSameDay) {
  const endDay = getPragueDate(endTs);
  const todayStart = getPragueDayStartUnixFromDate(endDay);

  // Okno je celé v rámci dnešního dne (Europe/Prague)
  if (windowStart >= todayStart) {
    if (endRainTotal === null || endRainTotal === undefined) return null;
    if (endRainTotal === 0 && (windowMaxSameDay ?? 0) === 0) return 0;

    const before = await db.prepare(`
      SELECT rain_total, timestamp
      FROM measurements
      WHERE timestamp >= ? AND timestamp <= ? AND rain_total IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 1
    `).bind(todayStart, windowStart).first();

    const baseline = before ? before.rain_total : (windowMinSameDay ?? endRainTotal);
    const maxVal = maxNullable(endRainTotal, windowMaxSameDay);
    return roundTo(Math.max(0, maxVal - baseline), 1);
  }

  // Okno zasahuje do předchozího dne (např. 24h nebo 1h těsně po půlnoci)
  const startDay = getPragueDate(windowStart);
  const startDayStart = getPragueDayStartUnixFromDate(startDay);
  const startDayNext = addDaysToIsoDate(startDay, 1);
  const startDayEnd = getPragueDayStartUnixFromDate(startDayNext);

  // Rychlá zkratka: pokud se okno 1h přehouplo přes půlnoc a ani dnes ani včera nepršelo
  const startDayStats = await db.prepare(
    'SELECT rain_total_max, max_ts FROM daily_stats WHERE day = ?'
  ).bind(startDay).first();

  let middleDaysRain = 0;
  if (startDayNext < endDay) {
    const mid = await db.prepare(
      'SELECT SUM(COALESCE(rain_total_max, 0)) AS mid_rain FROM daily_stats WHERE day >= ? AND day < ?'
    ).bind(startDayNext, endDay).first();
    middleDaysRain = mid?.mid_rain ?? 0;
  }

  const todayRain = maxNullable(endRainTotal, windowMaxSameDay) ?? 0;
  const startDayMax = startDayStats?.rain_total_max ?? 0;

  if (startDayMax === 0 && middleDaysRain === 0) {
    return endRainTotal === null && windowMaxSameDay === null ? null : roundTo(Math.max(0, todayRain), 1);
  }

  const beforeStart = await db.prepare(`
    SELECT rain_total
    FROM measurements
    WHERE timestamp >= ? AND timestamp <= ? AND rain_total IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT 1
  `).bind(startDayStart, windowStart).first();

  let startPortion = 0;
  if (beforeStart) {
    startPortion = Math.max(0, startDayMax - beforeStart.rain_total);
  } else {
    const firstInWindow = await db.prepare(`
      SELECT MIN(rain_total) AS min_rt, MAX(rain_total) AS max_rt
      FROM measurements
      WHERE timestamp > ? AND timestamp < ? AND rain_total IS NOT NULL
    `).bind(windowStart, startDayEnd).first();
    if (firstInWindow && firstInWindow.max_rt !== null) {
      startPortion = Math.max(0, firstInWindow.max_rt - (firstInWindow.min_rt ?? firstInWindow.max_rt));
    }
  }

  return roundTo(todayRain + middleDaysRain + startPortion, 1);
}

// ─── REST API handlery ────────────────────────────────────────────────────────

/** GET /api/current — poslední naměřený záznam + přesný úhrn srážek za poslední 1h */
async function getCurrentData(db) {
  await ensureAppTables(db);

  const row = await db.prepare(`
    SELECT *
    FROM measurements
    ORDER BY timestamp DESC
    LIMIT 1
  `).first();

  if (!row) {
    const err = new Error('Žádná data');
    err.status = 404;
    throw err;
  }

  // Fallback indoor hodnot z app_state (1 řádek místo zpětného skenu measurements)
  if (row.temp_in === null || row.humidity_in === null) {
    const indoorState = await getAppState(db, 'latest_indoor');
    let parsed = null;
    if (indoorState?.value) {
      try { parsed = JSON.parse(indoorState.value); } catch (_) {}
    }

    if (!parsed) {
      const fallbackRow = await db.prepare(`
        SELECT temp_in, humidity_in, timestamp
        FROM measurements
        WHERE temp_in IS NOT NULL OR humidity_in IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT 1
      `).first();
      if (fallbackRow) {
        parsed = {
          temp_in: fallbackRow.temp_in ?? null,
          humidity_in: fallbackRow.humidity_in ?? null,
          timestamp: fallbackRow.timestamp,
        };
        await setAppState(db, 'latest_indoor', parsed);
      }
    }

    if (parsed) {
      if (row.temp_in === null) row.temp_in = parsed.temp_in ?? null;
      if (row.humidity_in === null) row.humidity_in = parsed.humidity_in ?? null;
    }
  }

  // Srážky za posledních 60 minut (v mm)
  let rain1h = null;
  const ts1h = row.timestamp - 3600;
  const todayStart = getPragueDayStartUnix(row.timestamp);

  if (row.rain_total === 0 && ts1h >= todayStart) {
    rain1h = 0;
  } else if (row.rain_total !== null || ts1h < todayStart) {
    rain1h = await computeRainWindowFromCounters(
      db,
      ts1h,
      row.timestamp,
      row.rain_total,
      row.rain_total,
      row.rain_total
    );
  }

  return {
    ...row,
    rain_1h: rain1h,
  };
}

/** GET /api/history?from=TS&to=TS&limit=N */
async function fetchHistoryData(db, url) {
  const params = url.searchParams;
  const now    = Math.floor(Date.now() / 1000);

  const fromParam = params.get('from');
  const toParam   = params.get('to');
  const from      = fromParam !== null ? parseTimestamp(fromParam) : (now - 86400);
  const to        = toParam !== null ? parseTimestamp(toParam) : now;
  const limit     = parsePositiveInt(params.get('limit'), 144, MAX_LIMIT);

  if (from === null || to === null) {
    const err = new Error('Neplatný časový rozsah');
    err.status = 400;
    throw err;
  }
  if (limit === null || limit === 0) {
    const err = new Error('Neplatný parametr limit');
    err.status = 400;
    throw err;
  }
  if (from > to) {
    const err = new Error('from musí být menší než to');
    err.status = 400;
    throw err;
  }
  if ((to - from) > 1825 * 86400) {
    const err = new Error('Maximální rozsah je 5 let');
    err.status = 400;
    throw err;
  }

  const rangeSeconds = to - from;
  const rawStep      = rangeSeconds / limit;
  const step         = Math.max(60, Math.round(rawStep / 60) * 60);

  const cols = `
    timestamp, temp_out, feels_like, dew_point, temp_in,
    humidity_out, humidity_in, pressure, wind_speed, wind_gust, rain_rate
  `;

  let rows;
  if (step <= 60) {
    rows = await db
      .prepare(`
        SELECT ${cols}
        FROM measurements
        WHERE timestamp BETWEEN ? AND ?
        ORDER BY timestamp ASC
        LIMIT ?
      `)
      .bind(from, to, limit)
      .all();
  } else {
    rows = await db
      .prepare(`
        SELECT ${cols}
        FROM measurements
        WHERE rowid IN (
          SELECT MIN(rowid)
          FROM measurements
          WHERE timestamp BETWEEN ? AND ?
          GROUP BY CAST((timestamp - ?) / ? AS INTEGER)
        )
        ORDER BY timestamp ASC
        LIMIT ?
      `)
      .bind(from, to, from, step, limit)
      .all();
  }

  return { count: rows.results.length, data: rows.results };
}

/** GET /api/daily?days=N — denní min/max/avg z předpočítané tabulky daily_stats */
async function fetchDailyData(db, url) {
  const params = url.searchParams;
  const days   = parsePositiveInt(params.get('days'), 30, MAX_DAYS);
  if (days === null || days === 0) {
    const err = new Error('Neplatný parametr days');
    err.status = 400;
    throw err;
  }

  await ensureDailyStatsTable(db);

  const today = getPragueDate(Math.floor(Date.now() / 1000));
  const minDay = addDaysToIsoDate(today, -(days - 1));

  const rows = await db.prepare(`
    SELECT
      day,
      ROUND(temp_out_min, 1) AS temp_min,
      ROUND(temp_out_max, 1) AS temp_max,
      CASE WHEN temp_out_cnt > 0 THEN ROUND(temp_out_sum / temp_out_cnt, 1) ELSE NULL END AS temp_avg,
      ROUND(pressure_min, 1) AS pressure_min,
      ROUND(pressure_max, 1) AS pressure_max,
      CASE WHEN hum_out_cnt > 0 THEN ROUND(CAST(hum_out_sum AS REAL) / hum_out_cnt, 0) ELSE NULL END AS humidity_avg,
      ROUND(wind_gust_max, 1) AS wind_gust_max,
      ROUND(rain_total_max, 1) AS rain_max
    FROM daily_stats
    WHERE day >= ? AND temp_out_cnt > 0
    ORDER BY day ASC
  `).bind(minDay).all();

  return { count: rows.results.length, data: rows.results };
}

/** Zajišťuje existenci a jednorázovou inicializaci tabulky all_time_records (17 metrik). */
async function ensureRecordsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS all_time_records (
      metric TEXT PRIMARY KEY,
      value REAL,
      timestamp INTEGER
    )
  `).run();

  const existingRes = await db.prepare('SELECT metric FROM all_time_records').all();
  const existingMetrics = new Set((existingRes.results ?? []).map(r => r.metric));

  if (existingMetrics.size >= TOTAL_RECORD_METRICS) {
    return;
  }

  const metricSpecs = [
    { metric: 'outsideMax',     sql: 'SELECT temp_out AS value, timestamp FROM measurements WHERE temp_out IS NOT NULL ORDER BY temp_out DESC, timestamp ASC LIMIT 1', round: 1 },
    { metric: 'outsideMin',     sql: 'SELECT temp_out AS value, timestamp FROM measurements WHERE temp_out IS NOT NULL ORDER BY temp_out ASC, timestamp ASC LIMIT 1', round: 1 },
    { metric: 'feelsMax',       sql: 'SELECT feels_like AS value, timestamp FROM measurements WHERE feels_like IS NOT NULL ORDER BY feels_like DESC, timestamp ASC LIMIT 1', round: 1 },
    { metric: 'feelsMin',       sql: 'SELECT feels_like AS value, timestamp FROM measurements WHERE feels_like IS NOT NULL ORDER BY feels_like ASC, timestamp ASC LIMIT 1', round: 1 },
    { metric: 'dewMax',         sql: 'SELECT dew_point AS value, timestamp FROM measurements WHERE dew_point IS NOT NULL ORDER BY dew_point DESC, timestamp ASC LIMIT 1', round: 1 },
    { metric: 'dewMin',         sql: 'SELECT dew_point AS value, timestamp FROM measurements WHERE dew_point IS NOT NULL ORDER BY dew_point ASC, timestamp ASC LIMIT 1', round: 1 },
    { metric: 'insideMax',      sql: 'SELECT temp_in AS value, timestamp FROM measurements WHERE temp_in IS NOT NULL ORDER BY temp_in DESC, timestamp ASC LIMIT 1', round: 1 },
    { metric: 'insideMin',      sql: 'SELECT temp_in AS value, timestamp FROM measurements WHERE temp_in IS NOT NULL ORDER BY temp_in ASC, timestamp ASC LIMIT 1', round: 1 },
    { metric: 'humidityOutMax', sql: 'SELECT humidity_out AS value, timestamp FROM measurements WHERE humidity_out IS NOT NULL ORDER BY humidity_out DESC, timestamp ASC LIMIT 1', round: 0 },
    { metric: 'humidityOutMin', sql: 'SELECT humidity_out AS value, timestamp FROM measurements WHERE humidity_out IS NOT NULL ORDER BY humidity_out ASC, timestamp ASC LIMIT 1', round: 0 },
    { metric: 'humidityInMax',  sql: 'SELECT humidity_in AS value, timestamp FROM measurements WHERE humidity_in IS NOT NULL ORDER BY humidity_in DESC, timestamp ASC LIMIT 1', round: 0 },
    { metric: 'humidityInMin',  sql: 'SELECT humidity_in AS value, timestamp FROM measurements WHERE humidity_in IS NOT NULL ORDER BY humidity_in ASC, timestamp ASC LIMIT 1', round: 0 },
    { metric: 'windMax',        sql: 'SELECT wind_speed AS value, timestamp FROM measurements WHERE wind_speed IS NOT NULL ORDER BY wind_speed DESC, timestamp ASC LIMIT 1', round: 1 },
    { metric: 'gustMax',        sql: 'SELECT wind_gust AS value, timestamp FROM measurements WHERE wind_gust IS NOT NULL ORDER BY wind_gust DESC, timestamp ASC LIMIT 1', round: 1 },
    { metric: 'rainRateMax',    sql: 'SELECT rain_rate AS value, timestamp FROM measurements WHERE rain_rate IS NOT NULL ORDER BY rain_rate DESC, timestamp ASC LIMIT 1', round: 1 },
    {
      metric: 'rainHourMax',
      sql: `
        SELECT
          ROUND(MAX(rain_total) - MIN(rain_total), 1) AS value,
          MAX(timestamp) AS timestamp
        FROM measurements
        WHERE rain_total IS NOT NULL
        GROUP BY CAST(timestamp / 3600 AS INTEGER)
        ORDER BY value DESC, timestamp ASC
        LIMIT 1
      `,
      round: 1,
    },
    { metric: 'rainDayMax',     sql: 'SELECT rain_total AS value, timestamp FROM measurements WHERE rain_total IS NOT NULL ORDER BY rain_total DESC, timestamp ASC LIMIT 1', round: 1 },
  ];

  const missingSpecs = metricSpecs.filter(s => !existingMetrics.has(s.metric));
  if (missingSpecs.length === 0) return;

  const batchResults = await db.batch(missingSpecs.map(s => db.prepare(s.sql)));
  const inserts = missingSpecs.map((spec, idx) => {
    const row = batchResults[idx]?.results?.[0];
    const val = row?.value !== null && row?.value !== undefined ? roundTo(row.value, spec.round) : null;
    const ts = val !== null ? (row?.timestamp ?? null) : null;
    return db
      .prepare('INSERT OR REPLACE INTO all_time_records (metric, value, timestamp) VALUES (?, ?, ?)')
      .bind(spec.metric, val, ts);
  });

  if (inserts.length > 0) {
    await db.batch(inserts);
  }
}

/** Bleskově zkontroluje a případně zaktualizuje rekord při příchodu nového měření. */
async function checkRecordExtremes(db, r) {
  if (!r || !r.timestamp) return;
  const updates = [];
  if (r.temp_out != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'outsideMax' AND (? > value OR value IS NULL)").bind(r.temp_out, r.timestamp, r.temp_out));
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'outsideMin' AND (? < value OR value IS NULL)").bind(r.temp_out, r.timestamp, r.temp_out));
  }
  if (r.feels_like != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'feelsMax' AND (? > value OR value IS NULL)").bind(r.feels_like, r.timestamp, r.feels_like));
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'feelsMin' AND (? < value OR value IS NULL)").bind(r.feels_like, r.timestamp, r.feels_like));
  }
  if (r.dew_point != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'dewMax' AND (? > value OR value IS NULL)").bind(r.dew_point, r.timestamp, r.dew_point));
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'dewMin' AND (? < value OR value IS NULL)").bind(r.dew_point, r.timestamp, r.dew_point));
  }
  if (r.temp_in != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'insideMax' AND (? > value OR value IS NULL)").bind(r.temp_in, r.timestamp, r.temp_in));
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'insideMin' AND (? < value OR value IS NULL)").bind(r.temp_in, r.timestamp, r.temp_in));
  }
  if (r.humidity_out != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'humidityOutMax' AND (? > value OR value IS NULL)").bind(r.humidity_out, r.timestamp, r.humidity_out));
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'humidityOutMin' AND (? < value OR value IS NULL)").bind(r.humidity_out, r.timestamp, r.humidity_out));
  }
  if (r.humidity_in != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'humidityInMax' AND (? > value OR value IS NULL)").bind(r.humidity_in, r.timestamp, r.humidity_in));
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'humidityInMin' AND (? < value OR value IS NULL)").bind(r.humidity_in, r.timestamp, r.humidity_in));
  }
  if (r.wind_speed != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'windMax' AND (? > value OR value IS NULL)").bind(r.wind_speed, r.timestamp, r.wind_speed));
  }
  if (r.wind_gust != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'gustMax' AND (? > value OR value IS NULL)").bind(r.wind_gust, r.timestamp, r.wind_gust));
  }
  if (r.rain_rate != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'rainRateMax' AND (? > value OR value IS NULL)").bind(r.rain_rate, r.timestamp, r.rain_rate));
  }
  if (r.rain_hour != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'rainHourMax' AND (? > value OR value IS NULL)").bind(r.rain_hour, r.timestamp, r.rain_hour));
  }
  if (r.rain_total != null) {
    updates.push(db.prepare("UPDATE all_time_records SET value = ?, timestamp = ? WHERE metric = 'rainDayMax' AND (? > value OR value IS NULL)").bind(r.rain_total, r.timestamp, r.rain_total));
  }
  if (updates.length > 0) {
    try {
      await db.batch(updates);
    } catch (err) {
      console.warn('[RECORDS-UPDATE] Chyba aktualizace rekordu:', err.message);
    }
  }
}

/** GET /api/records — čte pouze 17 řádků z all_time_records + denní přehled z daily_stats (~200 řádků) */
async function getRecordsData(db) {
  await ensureDailyStatsTable(db);
  await ensureRecordsTable(db);

  const [recordsRes, dailyRes] = await Promise.all([
    db.prepare('SELECT metric, value, timestamp FROM all_time_records').all(),
    db.prepare('SELECT day, min_ts, max_ts, records_count, has_rain FROM daily_stats ORDER BY day ASC').all(),
  ]);

  const recordsMap = {};
  for (const r of recordsRes?.results ?? []) {
    recordsMap[r.metric] = { value: r.value, timestamp: r.timestamp };
  }

  const days = dailyRes?.results ?? [];
  let minTs = null;
  let maxTs = null;
  let totalRecords = 0;

  let max_dry_streak = 0;
  let currentDry = 0;

  for (const d of days) {
    if (d.min_ts != null) minTs = minNullable(minTs, d.min_ts);
    if (d.max_ts != null) maxTs = maxNullable(maxTs, d.max_ts);
    totalRecords += d.records_count ?? 0;

    if (d.has_rain === 0) {
      currentDry++;
      if (currentDry > max_dry_streak) max_dry_streak = currentDry;
    } else if (d.has_rain === 1) {
      currentDry = 0;
    }
  }

  let dry_streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].has_rain === 0) {
      dry_streak++;
    } else if (days[i].has_rain === 1) {
      break;
    }
  }

  const formatIsoUtc = (ts) => (ts != null ? new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ') : null);

  return {
    records: recordsMap,
    temp_max:             recordsMap.outsideMax?.value ?? null,
    temp_max_time:        recordsMap.outsideMax?.timestamp ?? null,
    temp_min:             recordsMap.outsideMin?.value ?? null,
    temp_min_time:        recordsMap.outsideMin?.timestamp ?? null,
    feels_like_max:       recordsMap.feelsMax?.value ?? null,
    feels_like_max_time:  recordsMap.feelsMax?.timestamp ?? null,
    feels_like_min:       recordsMap.feelsMin?.value ?? null,
    feels_like_min_time:  recordsMap.feelsMin?.timestamp ?? null,
    dew_point_max:        recordsMap.dewMax?.value ?? null,
    dew_point_max_time:   recordsMap.dewMax?.timestamp ?? null,
    dew_point_min:        recordsMap.dewMin?.value ?? null,
    dew_point_min_time:   recordsMap.dewMin?.timestamp ?? null,
    temp_in_max:          recordsMap.insideMax?.value ?? null,
    temp_in_max_time:     recordsMap.insideMax?.timestamp ?? null,
    temp_in_min:          recordsMap.insideMin?.value ?? null,
    temp_in_min_time:     recordsMap.insideMin?.timestamp ?? null,
    humidity_max:         recordsMap.humidityOutMax?.value ?? null,
    humidity_max_time:    recordsMap.humidityOutMax?.timestamp ?? null,
    humidity_min:         recordsMap.humidityOutMin?.value ?? null,
    humidity_min_time:    recordsMap.humidityOutMin?.timestamp ?? null,
    humidity_in_max:      recordsMap.humidityInMax?.value ?? null,
    humidity_in_max_time: recordsMap.humidityInMax?.timestamp ?? null,
    humidity_in_min:      recordsMap.humidityInMin?.value ?? null,
    humidity_in_min_time: recordsMap.humidityInMin?.timestamp ?? null,
    wind_speed_max:       recordsMap.windMax?.value ?? null,
    wind_speed_max_time:  recordsMap.windMax?.timestamp ?? null,
    wind_gust_max:        recordsMap.gustMax?.value ?? null,
    wind_gust_max_time:   recordsMap.gustMax?.timestamp ?? null,
    rain_rate_max:        recordsMap.rainRateMax?.value ?? null,
    rain_rate_max_time:   recordsMap.rainRateMax?.timestamp ?? null,
    rain_hour_max:        recordsMap.rainHourMax?.value ?? null,
    rain_hour_max_time:   recordsMap.rainHourMax?.timestamp ?? null,
    rain_total_max:       recordsMap.rainDayMax?.value ?? null,
    rain_total_max_time:  recordsMap.rainDayMax?.timestamp ?? null,
    max_dry_streak,
    dry_streak,
    oldest_record: formatIsoUtc(minTs),
    newest_record: formatIsoUtc(maxTs),
    total_records: totalRecords,
  };
}

function emptyAggBucket() {
  return {
    records: 0,
    temp_out_sum: 0, temp_out_cnt: 0, temp_out_min: null, temp_out_max: null,
    temp_in_sum: 0,  temp_in_cnt: 0,  temp_in_min: null,  temp_in_max: null,
    hum_out_sum: 0,  hum_out_cnt: 0,  hum_out_min: null,  hum_out_max: null,
    hum_in_sum: 0,   hum_in_cnt: 0,   hum_in_min: null,   hum_in_max: null,
    wind_gust_max: null,
    rain_total_max: null,
    rain_sum: 0,
    has_rain_val: false,
    rainy_days: 0,
    dry_days: 0,
    from_ts: null,
  };
}

function mergeDailyRowIntoBucket(b, d) {
  b.records += d.records_count ?? 0;
  b.temp_out_sum += d.temp_out_sum ?? 0;
  b.temp_out_cnt += d.temp_out_cnt ?? 0;
  b.temp_out_min = minNullable(b.temp_out_min, d.temp_out_min);
  b.temp_out_max = maxNullable(b.temp_out_max, d.temp_out_max);

  b.temp_in_sum += d.temp_in_sum ?? 0;
  b.temp_in_cnt += d.temp_in_cnt ?? 0;
  b.temp_in_min = minNullable(b.temp_in_min, d.temp_in_min);
  b.temp_in_max = maxNullable(b.temp_in_max, d.temp_in_max);

  b.hum_out_sum += d.hum_out_sum ?? 0;
  b.hum_out_cnt += d.hum_out_cnt ?? 0;
  b.hum_out_min = minNullable(b.hum_out_min, d.hum_out_min);
  b.hum_out_max = maxNullable(b.hum_out_max, d.hum_out_max);

  b.hum_in_sum += d.hum_in_sum ?? 0;
  b.hum_in_cnt += d.hum_in_cnt ?? 0;
  b.hum_in_min = minNullable(b.hum_in_min, d.hum_in_min);
  b.hum_in_max = maxNullable(b.hum_in_max, d.hum_in_max);

  b.wind_gust_max = maxNullable(b.wind_gust_max, d.wind_gust_max);
  b.rain_total_max = maxNullable(b.rain_total_max, d.rain_total_max);

  if (d.rain_total_max !== null && d.rain_total_max !== undefined) {
    b.rain_sum += d.rain_total_max;
    b.has_rain_val = true;
  }
  if (d.has_rain === 1) b.rainy_days++;
  else if (d.has_rain === 0) b.dry_days++;

  if (d.min_ts != null) b.from_ts = minNullable(b.from_ts, d.min_ts);
}

function finalizeStatsBucket(b, overrideTotalRain = null) {
  const totalRain = overrideTotalRain !== null ? overrideTotalRain : (b.has_rain_val ? roundTo(b.rain_sum, 1) : null);
  return {
    avg_temp:    b.temp_out_cnt > 0 ? roundTo(b.temp_out_sum / b.temp_out_cnt, 1) : null,
    max_temp:    roundTo(b.temp_out_max, 1),
    min_temp:    roundTo(b.temp_out_min, 1),
    avg_hum:     b.hum_out_cnt > 0 ? roundTo(b.hum_out_sum / b.hum_out_cnt, 0) : null,
    max_hum:     b.hum_out_max,
    min_hum:     b.hum_out_min,
    avg_temp_in: b.temp_in_cnt > 0 ? roundTo(b.temp_in_sum / b.temp_in_cnt, 1) : null,
    max_temp_in: roundTo(b.temp_in_max, 1),
    min_temp_in: roundTo(b.temp_in_min, 1),
    avg_hum_in:  b.hum_in_cnt > 0 ? roundTo(b.hum_in_sum / b.hum_in_cnt, 0) : null,
    max_hum_in:  b.hum_in_max,
    min_hum_in:  b.hum_in_min,
    max_gust:    roundTo(b.wind_gust_max, 1),
    max_rain:    roundTo(b.rain_total_max, 1),
    total_rain:  totalRain,
    records:     b.records ?? 0,
    rainy_days:  b.rainy_days,
    dry_days:    b.dry_days,
    from_ts:     b.from_ts,
  };
}

/** GET /api/stats — optimalizováno přes 30min snapshot v app_state + daily_stats (~3 000 řádků při přepočtu) */
async function getStatsData(db) {
  const now = Math.floor(Date.now() / 1000);
  const cachedSnap = await getAppState(db, 'stats_cache');
  if (cachedSnap?.value && (now - cachedSnap.updated_at) < CACHE_STATS_TTL) {
    try {
      return JSON.parse(cachedSnap.value);
    } catch (_) {}
  }

  await ensureDailyStatsTable(db);

  const c1h   = now - 3600;
  const c24h  = now - 86400;
  const c7d   = now - 7   * 86400;
  const c30d  = now - 30  * 86400;
  const c60d  = now - 60  * 86400;
  const c90d  = now - 90  * 86400;
  const c180d = now - 180 * 86400;
  const c365d = now - 365 * 86400;

  const today = getPragueDate(now);
  const todayStart = getPragueDayStartUnixFromDate(today);
  const c7dDay = getPragueDate(c7d);
  const c7dNextDay = addDaysToIsoDate(c7dDay, 1);
  const c7dNextDayStart = getPragueDayStartUnixFromDate(c7dNextDay);

  const selectWindowCols = (condSql, aliasSuffix) => `
    SUM(CASE WHEN ${condSql} AND temp_out IS NOT NULL THEN temp_out ELSE 0 END) AS temp_out_sum_${aliasSuffix},
    COUNT(CASE WHEN ${condSql} THEN temp_out END) AS temp_out_cnt_${aliasSuffix},
    MIN(CASE WHEN ${condSql} THEN temp_out END) AS temp_out_min_${aliasSuffix},
    MAX(CASE WHEN ${condSql} THEN temp_out END) AS temp_out_max_${aliasSuffix},
    SUM(CASE WHEN ${condSql} AND temp_in IS NOT NULL THEN temp_in ELSE 0 END) AS temp_in_sum_${aliasSuffix},
    COUNT(CASE WHEN ${condSql} THEN temp_in END) AS temp_in_cnt_${aliasSuffix},
    MIN(CASE WHEN ${condSql} THEN temp_in END) AS temp_in_min_${aliasSuffix},
    MAX(CASE WHEN ${condSql} THEN temp_in END) AS temp_in_max_${aliasSuffix},
    SUM(CASE WHEN ${condSql} AND humidity_out IS NOT NULL THEN humidity_out ELSE 0 END) AS hum_out_sum_${aliasSuffix},
    COUNT(CASE WHEN ${condSql} THEN humidity_out END) AS hum_out_cnt_${aliasSuffix},
    MIN(CASE WHEN ${condSql} THEN humidity_out END) AS hum_out_min_${aliasSuffix},
    MAX(CASE WHEN ${condSql} THEN humidity_out END) AS hum_out_max_${aliasSuffix},
    SUM(CASE WHEN ${condSql} AND humidity_in IS NOT NULL THEN humidity_in ELSE 0 END) AS hum_in_sum_${aliasSuffix},
    COUNT(CASE WHEN ${condSql} THEN humidity_in END) AS hum_in_cnt_${aliasSuffix},
    MIN(CASE WHEN ${condSql} THEN humidity_in END) AS hum_in_min_${aliasSuffix},
    MAX(CASE WHEN ${condSql} THEN humidity_in END) AS hum_in_max_${aliasSuffix},
    MAX(CASE WHEN ${condSql} THEN wind_gust END) AS wind_gust_max_${aliasSuffix},
    MAX(CASE WHEN ${condSql} THEN rain_total END) AS rain_total_max_${aliasSuffix},
    COUNT(CASE WHEN ${condSql} THEN 1 END) AS records_${aliasSuffix}
  `;

  // 1. Posledních 24h (obsahuje i 1h) — max ~1 440 řádků z measurements
  const recentPromise = db.prepare(`
    WITH bounds AS (
      SELECT ? AS c1h, ? AS c24h, ? AS today_start
    )
    SELECT
      ${selectWindowCols('timestamp >= bounds.c1h', '1h')},
      ${selectWindowCols('timestamp >= bounds.c24h', '24h')},
      MAX(CASE WHEN timestamp >= bounds.c1h AND timestamp >= bounds.today_start THEN rain_total END) AS rain_1h_today_max,
      MIN(CASE WHEN timestamp >= bounds.c1h AND timestamp >= bounds.today_start THEN rain_total END) AS rain_1h_today_min,
      MAX(CASE WHEN timestamp >= bounds.c24h AND timestamp >= bounds.today_start THEN rain_total END) AS rain_24h_today_max,
      MIN(CASE WHEN timestamp >= bounds.c24h AND timestamp >= bounds.today_start THEN rain_total END) AS rain_24h_today_min,
      (SELECT rain_total FROM measurements WHERE timestamp >= (SELECT c24h FROM bounds) ORDER BY timestamp DESC LIMIT 1) AS latest_rain_total,
      (SELECT MAX(timestamp) FROM measurements WHERE timestamp >= (SELECT c24h FROM bounds)) AS latest_ts
    FROM measurements
    CROSS JOIN bounds
    WHERE timestamp >= bounds.c24h
  `).bind(c1h, c24h, todayStart).first();

  // 2. Hraniční neúplný den pro přesné klouzavé okno 7d — max ~1 440 řádků z measurements
  const boundary7dPromise = db.prepare(`
    WITH bounds AS (
      SELECT ? AS start_ts, ? AS end_ts
    )
    SELECT
      ${selectWindowCols('timestamp >= bounds.start_ts AND timestamp < bounds.end_ts', '7db')},
      MIN(CASE WHEN timestamp >= bounds.start_ts AND timestamp < bounds.end_ts THEN rain_total END) AS rain_7db_min,
      MAX(CASE WHEN timestamp >= bounds.start_ts AND timestamp < bounds.end_ts THEN rain_total END) AS rain_7db_max
    FROM measurements
    CROSS JOIN bounds
    WHERE timestamp >= bounds.start_ts AND timestamp < bounds.end_ts
  `).bind(c7d, c7dNextDayStart).first();

  // 3. Všechny dny z daily_stats — ~200 řádků
  const dailyStatsPromise = db.prepare('SELECT * FROM daily_stats ORDER BY day ASC').all();

  const [recentRow, bound7dRow, dailyRes] = await Promise.all([
    recentPromise, boundary7dPromise, dailyStatsPromise,
  ]);
  const allDays = dailyRes?.results ?? [];

  function extractSqlBucket(src, suf) {
    const b = emptyAggBucket();
    if (!src) return b;
    b.records       = src[`records_${suf}`] ?? 0;
    b.temp_out_sum  = src[`temp_out_sum_${suf}`] ?? 0;
    b.temp_out_cnt  = src[`temp_out_cnt_${suf}`] ?? 0;
    b.temp_out_min  = src[`temp_out_min_${suf}`] ?? null;
    b.temp_out_max  = src[`temp_out_max_${suf}`] ?? null;
    b.temp_in_sum   = src[`temp_in_sum_${suf}`] ?? 0;
    b.temp_in_cnt   = src[`temp_in_cnt_${suf}`] ?? 0;
    b.temp_in_min   = src[`temp_in_min_${suf}`] ?? null;
    b.temp_in_max   = src[`temp_in_max_${suf}`] ?? null;
    b.hum_out_sum   = src[`hum_out_sum_${suf}`] ?? 0;
    b.hum_out_cnt   = src[`hum_out_cnt_${suf}`] ?? 0;
    b.hum_out_min   = src[`hum_out_min_${suf}`] ?? null;
    b.hum_out_max   = src[`hum_out_max_${suf}`] ?? null;
    b.hum_in_sum    = src[`hum_in_sum_${suf}`] ?? 0;
    b.hum_in_cnt    = src[`hum_in_cnt_${suf}`] ?? 0;
    b.hum_in_min    = src[`hum_in_min_${suf}`] ?? null;
    b.hum_in_max    = src[`hum_in_max_${suf}`] ?? null;
    b.wind_gust_max = src[`wind_gust_max_${suf}`] ?? null;
    b.rain_total_max = src[`rain_total_max_${suf}`] ?? null;
    return b;
  }

  function applyRainDayCounts(b, cutoff) {
    for (const d of allDays) {
      if (cutoff === 0 || d.max_ts >= cutoff) {
        if (d.has_rain === 1) b.rainy_days++;
        else if (d.has_rain === 0) b.dry_days++;
      }
    }
  }

  // 1h a 24h
  const b1h = extractSqlBucket(recentRow, '1h');
  const b24h = extractSqlBucket(recentRow, '24h');
  applyRainDayCounts(b1h, c1h);
  applyRainDayCounts(b24h, c24h);

  const endTs = recentRow?.latest_ts ?? now;
  const endRain = recentRow?.latest_rain_total ?? null;

  const rain1hPromise = b1h.records > 0
    ? computeRainWindowFromCounters(db, c1h, endTs, endRain, recentRow?.rain_1h_today_max, recentRow?.rain_1h_today_min)
    : Promise.resolve(null);
  const rain24hPromise = b24h.records > 0
    ? computeRainWindowFromCounters(db, c24h, endTs, endRain, recentRow?.rain_24h_today_max, recentRow?.rain_24h_today_min)
    : Promise.resolve(null);

  // 7d (hraniční den z measurements + kompletní dny >= c7dNextDay z daily_stats)
  const b7d = extractSqlBucket(bound7dRow, '7db');
  b7d.from_ts = c7d;
  for (const d of allDays) {
    if (d.day >= c7dNextDay) {
      mergeDailyRowIntoBucket(b7d, d);
    } else if (d.day === c7dDay) {
      if (d.has_rain === 1) b7d.rainy_days++;
      else if (d.has_rain === 0) b7d.dry_days++;
    }
  }

  let totalRain7d = null;
  const c7dStartUnix = getPragueDayStartUnixFromDate(c7dDay);
  const rainBefore7dPromise = (bound7dRow?.rain_7db_max ?? 0) > 0
    ? db.prepare(`
        SELECT rain_total FROM measurements
        WHERE timestamp >= ? AND timestamp <= ? AND rain_total IS NOT NULL
        ORDER BY timestamp DESC LIMIT 1
      `).bind(c7dStartUnix, c7d).first()
    : Promise.resolve(null);

  const [rain1h, rain24h, rainBefore7d] = await Promise.all([
    rain1hPromise, rain24hPromise, rainBefore7dPromise,
  ]);

  if (b7d.has_rain_val || bound7dRow?.rain_7db_max != null) {
    let boundPortion = 0;
    if (bound7dRow?.rain_7db_max != null) {
      const startDayStats = allDays.find(d => d.day === c7dDay);
      const startDayMax = startDayStats?.rain_total_max ?? bound7dRow.rain_7db_max;
      if (rainBefore7d) {
        boundPortion = Math.max(0, startDayMax - rainBefore7d.rain_total);
      } else {
        boundPortion = Math.max(0, bound7dRow.rain_7db_max - (bound7dRow.rain_7db_min ?? bound7dRow.rain_7db_max));
      }
    }
    totalRain7d = roundTo(b7d.rain_sum + boundPortion, 1);
  }

  // 30d, 60d, 90d, 180d, 365d, all z daily_stats
  const b30d = emptyAggBucket();
  const b60d = emptyAggBucket();
  const b90d = emptyAggBucket();
  const b180d = emptyAggBucket();
  const b365d = emptyAggBucket();
  const bAll = emptyAggBucket();

  for (const d of allDays) {
    mergeDailyRowIntoBucket(bAll, d);
    if (d.max_ts >= c365d) mergeDailyRowIntoBucket(b365d, d);
    if (d.max_ts >= c180d) mergeDailyRowIntoBucket(b180d, d);
    if (d.max_ts >= c90d)  mergeDailyRowIntoBucket(b90d, d);
    if (d.max_ts >= c60d)  mergeDailyRowIntoBucket(b60d, d);
    if (d.max_ts >= c30d)  mergeDailyRowIntoBucket(b30d, d);
  }

  const payload = {
    last_1h:   finalizeStatsBucket(b1h, rain1h),
    last_24h:  finalizeStatsBucket(b24h, rain24h),
    last_7d:   finalizeStatsBucket(b7d, totalRain7d),
    last_30d:  finalizeStatsBucket(b30d),
    last_60d:  finalizeStatsBucket(b60d),
    last_90d:  finalizeStatsBucket(b90d),
    last_180d: finalizeStatsBucket(b180d),
    last_365d: finalizeStatsBucket(b365d),
    all:       finalizeStatsBucket(bAll),
  };

  try {
    await setAppState(db, 'stats_cache', payload, now);
  } catch (err) {
    console.warn('[STATS-CACHE] Nelze uložit snapshot:', err.message);
  }

  return payload;
}

// ─── Hlavní fetch handler ─────────────────────────────────────────────────────

async function handleFetch(request, env, ctx) {
  const url           = new URL(request.url);
  const requestOrigin = request.headers.get('Origin') ?? '';
  const allowedOrigin = env.ALLOWED_ORIGIN ?? '';
  const corsHdrs      = corsHeaders(allowedOrigin, requestOrigin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...securityHeaders(), ...corsHdrs } });
  }

  if (request.method !== 'GET') {
    return errorResponse('Metoda není povolena', 405, corsHdrs);
  }

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const path  = url.pathname;

  try {
    if (path === '/api/current') {
      const cacheKey = new Request(`${url.origin}/api/current?v=2`, { method: 'GET' });
      return await handleCachedEndpoint(cache, cacheKey, CACHE_CURRENT_TTL, corsHdrs, ctx, () => getCurrentData(env.DB));
    }

    if (path === '/api/records') {
      const cacheKey = new Request(`${url.origin}/api/records?v=2`, { method: 'GET' });
      return await handleCachedEndpoint(cache, cacheKey, CACHE_RECORDS_TTL, corsHdrs, ctx, () => getRecordsData(env.DB));
    }

    if (path === '/api/stats') {
      const cacheKey = new Request(`${url.origin}/api/stats?v=2`, { method: 'GET' });
      return await handleCachedEndpoint(cache, cacheKey, CACHE_STATS_TTL, corsHdrs, ctx, () => getStatsData(env.DB));
    }

    if (path === '/api/history') {
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      const from = parseTimestamp(url.searchParams.get('from')) ?? 0;
      const to   = parseTimestamp(url.searchParams.get('to')) ?? 0;
      const diff = to - from;

      let ttl = CACHE_HISTORY_TTL;
      if (diff >= 50 * 86400) ttl = 86400;
      else if (diff >= 6 * 86400) ttl = 3600;
      else if (diff > 0 && diff <= 3600) ttl = CACHE_HISTORY_1H_TTL;

      return await handleCachedEndpoint(cache, cacheKey, ttl, corsHdrs, ctx, () => fetchHistoryData(env.DB, url));
    }

    if (path === '/api/daily') {
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      return await handleCachedEndpoint(cache, cacheKey, CACHE_DAILY_TTL, corsHdrs, ctx, () => fetchDailyData(env.DB, url));
    }

    if (path === '/api/test-wc') {
      return await handleTestWeathercloud(request, env, corsHdrs, cache, ctx);
    }

    return errorResponse('Endpoint neexistuje', 404, corsHdrs);
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return errorResponse(err.message, err.status, corsHdrs);
    }
    console.error('[FETCH] Interní chyba:', err.message);
    return errorResponse('Interní chyba serveru', 500, corsHdrs);
  }
}

// ─── Weathercloud indoor data ─────────────────────────────────────────────────

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

function parseWeathercloudValues(data) {
  const rawTempIn = data.tempin;
  const rawHumIn  = data.humin;

  let tempIn = null;
  if (rawTempIn !== null && rawTempIn !== '' && rawTempIn !== undefined) {
    const val = parseFloat(rawTempIn);
    if (Number.isFinite(val)) {
      tempIn = Math.abs(val) > 50 ? Math.round((val / 10) * 10) / 10 : Math.round(val * 10) / 10;
    }
  }

  let humIn = null;
  if (rawHumIn !== null && rawHumIn !== '' && rawHumIn !== undefined) {
    const parsedHum = parseInt(rawHumIn, 10);
    if (Number.isFinite(parsedHum)) humIn = parsedHum;
  }

  return { tempIn, humIn };
}

/**
 * Stáhne aktuální data ze Weathercloudu pomocí neoficiálního webového endpointu.
 * Sdíleno mezi cronem a diagnostickým endpointem /api/test-wc.
 */
async function fetchFromWeathercloud(deviceId, cookie, collectLog = false) {
  const cleanId = String(deviceId).trim().replace(/^d/i, '');
  const rawId   = String(deviceId).trim();
  const idsToTry = Array.from(new Set([cleanId, rawId]));

  let lastError = null;
  const diagnostics = [];
  let attempt = 0;

  for (const id of idsToTry) {
    attempt++;
    const url = `https://app.weathercloud.net/device/values?code=${id}`;
    try {
      const response = await fetch(url, {
        headers: {
          'Cookie'          : cookie,
          'Accept'          : 'application/json, text/javascript, */*',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer'         : `https://app.weathercloud.net/device/${id}`,
          'User-Agent'      : BROWSER_UA,
        },
        cf: { cacheTtl: 0 },
      });

      if (response.status === 401 || response.status === 403) {
        if (collectLog) {
          diagnostics.push({ attempt, status: response.status, isJson: false, hasIndoorFields: false });
        }
        throw new Error(`Weathercloud vrátil status ${response.status} (neplatná/vypršená session cookie nebo blokace)`);
      }
      if (!response.ok) {
        if (collectLog) {
          diagnostics.push({ attempt, status: response.status, isJson: false, hasIndoorFields: false });
        }
        throw new Error(`Weathercloud HTTP chyba: ${response.status}`);
      }

      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (_) {
        if (collectLog) {
          diagnostics.push({ attempt, status: response.status, isJson: false, hasIndoorFields: false });
        }
        throw new Error('Weathercloud nevrátil validní JSON (pravděpodobně vypršená session cookie)');
      }

      const hasIndoorFields = Boolean(data && (data.tempin !== undefined || data.humin !== undefined));
      if (collectLog) {
        diagnostics.push({ attempt, status: response.status, isJson: true, hasIndoorFields });
      }

      if (!hasIndoorFields) {
        continue;
      }

      const { tempIn, humIn } = parseWeathercloudValues(data);
      return { tempIn, humIn, usedId: id, diagnostics };
    } catch (err) {
      lastError = err;
      if (collectLog && !diagnostics.some(d => d.attempt === attempt)) {
        const safeMsg = err.message.startsWith('Weathercloud')
          ? err.message
          : 'Chyba spojení se službou Weathercloud';
        diagnostics.push({ attempt, error: safeMsg });
      }
    }
  }

  const err = lastError || new Error('Weathercloud: nepodařilo se načíst indoor data');
  err.diagnostics = diagnostics;
  throw err;
}

/**
 * Doplní indoor teplotu a vlhkost pouze do záznamů z posledních 2 hodin, které je ještě nemají (NULL),
 * a přesně o nově doplněné řádky navýší daily_stats + uloží latest_indoor do app_state.
 */
async function updateIndoorData(db, tempIn, humIn) {
  if (tempIn === null && humIn === null) {
    return { meta: { changes: 0 }, latestTimestamp: null };
  }

  await ensureDailyStatsTable(db);

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 2 * 3600;
  const today = getPragueDate(now);
  const todayStart = getPragueDayStartUnixFromDate(today);

  const segments = [];
  if (cutoff < todayStart) {
    segments.push({ day: getPragueDate(cutoff), start: cutoff, end: todayStart });
    segments.push({ day: today, start: todayStart, end: now + 60 });
  } else {
    segments.push({ day: today, start: cutoff, end: now + 60 });
  }

  let totalUpdated = 0;
  let latestUpdatedTs = null;

  for (const seg of segments) {
    const missing = await db.prepare(`
      SELECT
        COUNT(*) AS total_missing,
        COUNT(CASE WHEN temp_in IS NULL THEN 1 END) AS missing_ti,
        COUNT(CASE WHEN humidity_in IS NULL THEN 1 END) AS missing_hi,
        MAX(timestamp) AS max_ts
      FROM measurements
      WHERE source = 'wunderground'
        AND timestamp >= ? AND timestamp < ?
        AND (temp_in IS NULL OR humidity_in IS NULL)
    `).bind(seg.start, seg.end).first();

    const totalMissing = missing?.total_missing ?? 0;
    if (totalMissing === 0) continue;

    const addTiCnt = tempIn !== null ? (missing?.missing_ti ?? 0) : 0;
    const addHiCnt = humIn !== null ? (missing?.missing_hi ?? 0) : 0;

    if (addTiCnt === 0 && addHiCnt === 0) continue;

    const res = await db.prepare(`
      UPDATE measurements
      SET
        temp_in = COALESCE(temp_in, ?),
        humidity_in = COALESCE(humidity_in, ?)
      WHERE source = 'wunderground'
        AND timestamp >= ? AND timestamp < ?
        AND (temp_in IS NULL OR humidity_in IS NULL)
    `).bind(tempIn, humIn, seg.start, seg.end).run();

    totalUpdated += res.meta?.changes ?? 0;
    if (missing?.max_ts != null) {
      latestUpdatedTs = maxNullable(latestUpdatedTs, missing.max_ts);
    }

    await db.prepare(`
      UPDATE daily_stats
      SET
        temp_in_sum = temp_in_sum + ?,
        temp_in_cnt = temp_in_cnt + ?,
        temp_in_min = CASE
          WHEN ? IS NULL THEN temp_in_min
          WHEN temp_in_min IS NULL THEN ?
          ELSE MIN(temp_in_min, ?)
        END,
        temp_in_max = CASE
          WHEN ? IS NULL THEN temp_in_max
          WHEN temp_in_max IS NULL THEN ?
          ELSE MAX(temp_in_max, ?)
        END,
        hum_in_sum = hum_in_sum + ?,
        hum_in_cnt = hum_in_cnt + ?,
        hum_in_min = CASE
          WHEN ? IS NULL THEN hum_in_min
          WHEN hum_in_min IS NULL THEN ?
          ELSE MIN(hum_in_min, ?)
        END,
        hum_in_max = CASE
          WHEN ? IS NULL THEN hum_in_max
          WHEN hum_in_max IS NULL THEN ?
          ELSE MAX(hum_in_max, ?)
        END
      WHERE day = ?
    `).bind(
      tempIn !== null ? tempIn * addTiCnt : 0,
      addTiCnt,
      addTiCnt > 0 ? tempIn : null, addTiCnt > 0 ? tempIn : null, addTiCnt > 0 ? tempIn : null,
      addTiCnt > 0 ? tempIn : null, addTiCnt > 0 ? tempIn : null, addTiCnt > 0 ? tempIn : null,
      humIn !== null ? humIn * addHiCnt : 0,
      addHiCnt,
      addHiCnt > 0 ? humIn : null, addHiCnt > 0 ? humIn : null, addHiCnt > 0 ? humIn : null,
      addHiCnt > 0 ? humIn : null, addHiCnt > 0 ? humIn : null, addHiCnt > 0 ? humIn : null,
      seg.day
    ).run();
  }

  await setAppState(db, 'latest_indoor', {
    temp_in: tempIn,
    humidity_in: humIn,
    timestamp: latestUpdatedTs ?? now,
  }, now);

  return { meta: { changes: totalUpdated }, latestTimestamp: latestUpdatedTs };
}

async function handleWeathercloudCron(env) {
  if (!env.WC_DEVICE_ID || !env.WC_COOKIE) {
    console.error('[WC-CRON] Chybí WC_DEVICE_ID nebo WC_COOKIE secret!');
    return;
  }

  try {
    await ensureRecordsTable(env.DB);
    const { tempIn, humIn, usedId } = await fetchFromWeathercloud(env.WC_DEVICE_ID, env.WC_COOKIE, false);
    const result = await updateIndoorData(env.DB, tempIn, humIn);
    const updatedCount = result.meta?.changes ?? 0;
    console.log(`[WC-CRON] OK (${usedId}) — tempIn: ${tempIn}°C, humIn: ${humIn}% | aktualizováno: ${updatedCount} řádků`);

    if (updatedCount > 0 && result.latestTimestamp) {
      await checkRecordExtremes(env.DB, {
        temp_in: tempIn,
        humidity_in: humIn,
        timestamp: result.latestTimestamp,
      });
    }
  } catch (err) {
    console.error('[WC-CRON] Chyba:', err.message);
  }
}

/**
 * Diagnostický endpoint GET /api/test-wc pro otestování Weathercloud cookie.
 * - Pokud je nastaven secret TEST_WC_TOKEN, vyžaduje ?token=... nebo X-Admin-Token.
 * - Nevrací surové odpovědi Weathercloudu (žádný únik session HTML).
 * - Úspěšný výsledek cachuje na 30 s proti spamu (selhání necachuje pro okamžitý retest).
 */
async function handleTestWeathercloud(request, env, corsHdrs, cache, ctx) {
  const url = new URL(request.url);

  if (env.TEST_WC_TOKEN) {
    const provided = url.searchParams.get('token') ?? request.headers.get('X-Admin-Token') ?? '';
    if (!timingSafeEqual(provided, env.TEST_WC_TOKEN)) {
      return errorResponse('Přístup odepřen', 403, corsHdrs);
    }
  }

  const deviceId = env.WC_DEVICE_ID;
  const cookie   = env.WC_COOKIE;

  if (!deviceId || !cookie) {
    return jsonResponse({
      success: false,
      error: 'V Cloudflare chybí nastavené secrets!',
      has_WC_DEVICE_ID: Boolean(deviceId),
      has_WC_COOKIE: Boolean(cookie),
    }, 400, corsHdrs);
  }

  const cacheKey = new Request(`${url.origin}/api/test-wc?v=2`, { method: 'GET' });
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const body = await cached.json();
        return jsonResponse(body, 200, { ...corsHdrs, 'X-Cache': 'HIT' });
      }
    } catch (_) {}
  }

  try {
    await ensureRecordsTable(env.DB);
    const { tempIn, humIn, diagnostics } = await fetchFromWeathercloud(deviceId, cookie, true);

    let dbResult = null;
    if (tempIn !== null || humIn !== null) {
      const res = await updateIndoorData(env.DB, tempIn, humIn);
      dbResult = { rowsUpdated: res.meta?.changes ?? 0 };
      if ((res.meta?.changes ?? 0) > 0 && res.latestTimestamp) {
        await checkRecordExtremes(env.DB, {
          temp_in: tempIn,
          humidity_in: humIn,
          timestamp: res.latestTimestamp,
        });
      }
    }

    const payload = {
      success: true,
      message: 'Weathercloud spojení funguje a data byla uložena!',
      tempIn,
      humIn,
      dbResult,
      diagnostics,
    };

    const resp = jsonResponse(payload, 200, {
      ...corsHdrs,
      'Cache-Control': `public, max-age=${CACHE_TEST_WC_OK_TTL}`,
      'X-Cache': 'MISS',
    });

    if (cache) {
      const putPromise = cache.put(cacheKey, resp.clone());
      if (ctx?.waitUntil) ctx.waitUntil(putPromise);
      else await putPromise;
    }

    return resp;
  } catch (err) {
    return jsonResponse({
      success: false,
      message: 'Spojení selhalo. Zkontrolujte diagnostiku níže.',
      error: err.message,
      diagnostics: err.diagnostics ?? [],
    }, 200, corsHdrs);
  }
}

// ─── Export (Cloudflare Workers API) ─────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '* * * * *') {
      ctx.waitUntil(handleCron(env));
    } else if (event.cron === '*/10 * * * *') {
      ctx.waitUntil(handleWeathercloudCron(env));
    }
  },
};
