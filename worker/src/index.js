/**
 * Cloudflare Worker — Meteorologický dashboard "Stanice"
 * ═══════════════════════════════════════════════════════
 *
 * Dělá dvě věci:
 *   1. CRON (každou minutu): stáhne aktuální data ze stanice přes WU API
 *      a uloží je do D1 databáze.
 *   2. HTTP API (fetch): poskytuje read-only REST API pro frontend.
 *
 * Secrets (nastavuje se příkazem: npx wrangler secret put <NÁZEV>):
 *   - WU_STATION_ID   Vaše ID stanice na Weather Underground (napr. IXXXXX12)
 *   - WU_API_KEY      API klíč z wunderground.com/member/api-keys
 *
 * Proměnné (nastaveno v wrangler.toml [vars]):
 *   - ALLOWED_ORIGIN  URL GitHub Pages frontendu (napr. https://petmat247.github.io)
 *
 * REST API endpointy (vše GET, read-only):
 *   GET /api/current          Poslední záznam
 *   GET /api/history          Záznamy v časovém rozsahu
 *                             ?from=UNIX_TS&to=UNIX_TS&limit=N (max 1440)
 *   GET /api/daily            Denní souhrny (min/max/avg) za posledních N dní
 *                             ?days=N (max 365)
 *   GET /api/records          Absolutní rekordy (nejvy., nejnižší, …)
 *   GET /api/stats            Statistiky za posledních 24h / 7 dní / 30 dní
 */

'use strict';

// ─── Konstanty ────────────────────────────────────────────────────────────────

const WU_API_BASE        = 'https://api.weather.com/v2/pws/observations/current';
const CACHE_CURRENT_TTL  = 60;   // 1 minuta — cache pro /api/current
const CACHE_RECORDS_TTL  = 3600; // 1 hodina — cache pro /api/records
const CACHE_STATS_TTL    = 1800; // 30 minut — cache pro /api/stats
const CACHE_HISTORY_TTL  = 300;  // 5 minut — cache pro /api/history
const CACHE_DAILY_TTL    = 1800; // 30 minut — cache pro /api/daily
const MAX_LIMIT          = 2880; // max záznamů pro /api/history
const MAX_DAYS           = 365;  // max počet dní pro /api/daily

// ─── Bezpečnostní hlavičky ────────────────────────────────────────────────────

/**
 * Přidá bezpečnostní HTTP hlavičky ke každé odpovědi.
 * Tyto hlavičky chrání frontend před XSS, clickjackingem atd.
 */
function securityHeaders() {
  return {
    'X-Content-Type-Options'  : 'nosniff',
    'X-Frame-Options'         : 'DENY',
    'Referrer-Policy'         : 'strict-origin-when-cross-origin',
    'Cache-Control'           : 'no-store',
  };
}

/**
 * Sestaví CORS hlavičky — povolí přístup POUZE z naší GitHub Pages domény.
 * Jakýkoliv jiný origin dostane zamítnutí.
 */
function corsHeaders(allowedOrigin, requestOrigin) {
  // Přísná kontrola originu — žádné wildcard '*'
  const origin = requestOrigin === allowedOrigin ? allowedOrigin : 'null';
  return {
    'Access-Control-Allow-Origin'  : origin,
    'Access-Control-Allow-Methods' : 'GET, OPTIONS',
    'Access-Control-Allow-Headers' : 'Content-Type',
    'Access-Control-Max-Age'       : '86400',
  };
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

/**
 * Chybová odpověď — NIKDY neobsahuje interní detaily (stack trace, SQL, atd.).
 * Interní chyba se pouze zaloguje do Cloudflare logů.
 */
function errorResponse(publicMessage, status = 500, extraHeaders = {}) {
  return jsonResponse({ error: publicMessage }, status, extraHeaders);
}

// ─── Validace vstupních parametrů ─────────────────────────────────────────────

/**
 * Ověří, zda je hodnota celé kladné číslo v daném rozsahu.
 * Chrání před SQL injection a neplatnými hodnotami.
 */
function parsePositiveInt(value, defaultVal, max) {
  if (value === null || value === undefined || value === '') return defaultVal;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return null; // neplatná hodnota
  return Math.min(n, max);
}

/**
 * Ověří Unix timestamp — musí být kladné číslo v rozumném rozsahu
 * (rok 2020 – rok 2100).
 */
function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1577836800 || n > 4102444800) return null;
  return n;
}

// ─── WU API stahování ─────────────────────────────────────────────────────────

/**
 * Stáhne aktuální data ze stanice přes Weather Underground API.
 * Vrátí strukturovaný objekt nebo vyhodí chybu.
 */
async function fetchFromWU(stationId, apiKey) {
  const url = new URL(WU_API_BASE);
  url.searchParams.set('stationId', stationId);
  url.searchParams.set('format', 'json');
  url.searchParams.set('units', 'm');      // metrické jednotky
  url.searchParams.set('numericPrecision', 'decimal');
  url.searchParams.set('apiKey', apiKey);

  const response = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
    cf: { cacheTtl: 0 }, // nechceme cachovat WU odpověď
  });

  if (!response.ok) {
    throw new Error(`WU API vrátilo status ${response.status}`);
  }

  const data = await response.json();
  const obs = data?.observations?.[0];
  if (!obs) throw new Error('WU API: žádná data v odpovědi');

  const m = obs.metric;

  // Pocitová teplota: wind chill nebo heat index
  // WU je vrací ve zvláštních polích
  let feelsLike = m.temp; // fallback
  if (m.windChill !== null && m.windChill !== undefined && m.windChill < m.temp) {
    feelsLike = m.windChill;
  } else if (m.heatIndex !== null && m.heatIndex !== undefined && m.heatIndex > m.temp) {
    feelsLike = m.heatIndex;
  }

  return {
    timestamp   : obs.epoch,             // Unix UTC
    temp_out    : m.temp       ?? null,
    temp_in     : null,                  // WU API indoor data neposkytuje
    feels_like  : feelsLike    ?? null,
    dew_point   : m.dewpt      ?? null,
    humidity_out: obs.humidity ?? null,
    humidity_in : null,                  // WU API indoor data neposkytuje
    pressure    : m.pressure   ?? null,
    wind_speed  : m.windSpeed  ?? null,
    wind_gust   : m.windGust   ?? null,
    wind_dir    : obs.winddir  ?? null,
    rain_rate   : m.precipRate ?? null,
    rain_total  : m.precipTotal ?? null,
    source      : 'wunderground',
  };
}

/**
 * Uloží naměřená data do D1.
 * INSERT OR IGNORE — pokud záznam se stejným timestampem existuje, přeskočí se.
 */
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

// ─── Cron handler ─────────────────────────────────────────────────────────────

async function handleCron(env) {
  // Ověř, že secrets jsou nastaveny
  if (!env.WU_STATION_ID || !env.WU_API_KEY) {
    console.error('[CRON] Chybí WU_STATION_ID nebo WU_API_KEY secret!');
    return;
  }

  try {
    const record = await fetchFromWU(env.WU_STATION_ID, env.WU_API_KEY);
    const result = await saveToDB(env.DB, record);
    if (result.success) {
      console.log(`[CRON] OK — timestamp: ${record.timestamp}, temp: ${record.temp_out}°C`);
    }
  } catch (err) {
    // Logujeme interní chybu do Cloudflare logů, ale ven se nic neposílá
    console.error('[CRON] Chyba při stahování dat:', err.message);
  }
}

// ─── Cloudflare Edge Cache Helper ──────────────────────────────────────────

/**
 * Pomocná funkce pro obsluhu odpovědí s Cloudflare Edge Cache (caches.default).
 * 1. Zkusí najít odpověď v cache.
 * 2. Pokud najde (HIT), vrátí ji s patřičnými CORS hlavičkami a 'X-Cache': 'HIT'.
 * 3. Pokud nenajde (MISS), zavolá handler, sestaví odpověď, uloží ji do cache na pozadí
 *    a vrátí ji s 'X-Cache': 'MISS'.
 */
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

// ─── REST API handlery ────────────────────────────────────────────────────────

/** GET /api/current — data pro poslední naměřený záznam */
async function getCurrentData(db) {
  const row = await db
    .prepare(`
      SELECT
        m.*,
        COALESCE(m.temp_in,
          (SELECT temp_in FROM measurements
           WHERE temp_in IS NOT NULL ORDER BY timestamp DESC LIMIT 1)
        ) AS temp_in,
        COALESCE(m.humidity_in,
          (SELECT humidity_in FROM measurements
           WHERE humidity_in IS NOT NULL ORDER BY timestamp DESC LIMIT 1)
        ) AS humidity_in
      FROM measurements m
      ORDER BY m.timestamp DESC
      LIMIT 1
    `)
    .first();

  if (!row) {
    const err = new Error('Žádná data');
    err.status = 404;
    throw err;
  }
  return row;
}

/** GET /api/history?from=TS&to=TS&limit=N */
async function fetchHistoryData(db, url) {
  const params = url.searchParams;
  const now    = Math.floor(Date.now() / 1000);

  const from  = parseTimestamp(params.get('from')) ?? (now - 86400); // default: posledních 24h
  const to    = parseTimestamp(params.get('to'))   ?? now;
  const limit = parsePositiveInt(params.get('limit'), 144, MAX_LIMIT);

  if (limit === null) {
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
  const targetPoints = limit;
  const rawStep      = rangeSeconds / targetPoints;
  const step = Math.max(60, Math.round(rawStep / 60) * 60);

  let rows;
  if (step <= 60) {
    rows = await db
      .prepare(`
        SELECT * FROM measurements
        WHERE timestamp BETWEEN ? AND ?
        ORDER BY timestamp ASC
        LIMIT ?
      `)
      .bind(from, to, limit)
      .all();
  } else {
    rows = await db
      .prepare(`
        SELECT * FROM measurements
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

/** GET /api/daily?days=N — denní min/max/avg za posledních N dní */
async function fetchDailyData(db, url) {
  const params = url.searchParams;
  const days   = parsePositiveInt(params.get('days'), 30, MAX_DAYS);
  if (days === null) {
    const err = new Error('Neplatný parametr days');
    err.status = 400;
    throw err;
  }

  const from = Math.floor(Date.now() / 1000) - days * 86400;

  const rows = await db
    .prepare(`
      SELECT
        date(timestamp, 'unixepoch', '+1 hour') AS day,
        ROUND(MIN(temp_out), 1)      AS temp_min,
        ROUND(MAX(temp_out), 1)      AS temp_max,
        ROUND(AVG(temp_out), 1)      AS temp_avg,
        ROUND(MIN(pressure), 1)      AS pressure_min,
        ROUND(MAX(pressure), 1)      AS pressure_max,
        ROUND(AVG(humidity_out), 0)  AS humidity_avg,
        ROUND(MAX(wind_gust), 1)     AS wind_gust_max,
        ROUND(MAX(rain_total), 1)    AS rain_max
      FROM measurements
      WHERE timestamp >= ? AND temp_out IS NOT NULL
      GROUP BY day
      ORDER BY day ASC
    `)
    .bind(from)
    .all();

  return { count: rows.results.length, data: rows.results };
}

/** GET /api/records — absolutní rekordy ze všech dat (optimalizováno) */
async function getRecordsData(db) {
  // 1. Základní rekordy
  const basicRecordsPromise = db.prepare(`
    SELECT
      ROUND(MAX(temp_out), 1)         AS temp_max,
      ROUND(MIN(temp_out), 1)         AS temp_min,
      ROUND(MAX(feels_like), 1)       AS feels_like_max,
      ROUND(MIN(feels_like), 1)       AS feels_like_min,
      ROUND(MAX(dew_point), 1)        AS dew_point_max,
      ROUND(MIN(dew_point), 1)        AS dew_point_min,
      ROUND(MAX(temp_in), 1)          AS temp_in_max,
      ROUND(MIN(temp_in), 1)          AS temp_in_min,
      ROUND(MAX(pressure), 1)         AS pressure_max,
      ROUND(MIN(pressure), 1)         AS pressure_min,
      ROUND(MAX(wind_speed), 1)       AS wind_speed_max,
      ROUND(MAX(wind_gust), 1)        AS wind_gust_max,
      ROUND(MAX(rain_rate), 1)        AS rain_rate_max,
      ROUND(MAX(rain_total), 1)       AS rain_total_max,
      MIN(humidity_out)               AS humidity_min,
      MAX(humidity_out)               AS humidity_max,
      MIN(humidity_in)                AS humidity_in_min,
      MAX(humidity_in)                AS humidity_in_max,
      datetime(MIN(timestamp), 'unixepoch') AS oldest_record,
      datetime(MAX(timestamp), 'unixepoch') AS newest_record,
      COUNT(*)                        AS total_records
    FROM measurements
  `).first();

  // 2. Denní přehled pro výpočet sérií sucha v paměti (0 dodatečných SQL dotazů)
  const dailyRainPromise = db.prepare(`
    SELECT date(timestamp, 'unixepoch', '+1 hour') AS day,
           MAX(rain_rate) AS max_rain
    FROM measurements
    GROUP BY day
    ORDER BY day ASC
  `).all();

  const [row, dailyRainRes] = await Promise.all([basicRecordsPromise, dailyRainPromise]);
  const days = dailyRainRes?.results ?? [];

  // Nejdelší série sucha (v paměti)
  let max_dry_streak = 0;
  let currentDry = 0;
  for (const d of days) {
    if (d.max_rain === 0) {
      currentDry++;
      if (currentDry > max_dry_streak) max_dry_streak = currentDry;
    } else {
      currentDry = 0;
    }
  }

  // Aktuální série sucha (dny od posledního deště do dneška)
  let dry_streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].max_rain === 0) {
      dry_streak++;
    } else {
      break;
    }
  }

  return {
    ...row,
    max_dry_streak,
    dry_streak,
  };
}

/** GET /api/stats — statistiky za všechna časová okna (optimalizováno do 2 dotazů) */
async function getStatsData(db) {
  const now = Math.floor(Date.now() / 1000);

  const c1h   = now - 3600;
  const c24h  = now - 86400;
  const c7d   = now - 7   * 86400;
  const c30d  = now - 30  * 86400;
  const c60d  = now - 60  * 86400;
  const c90d  = now - 90  * 86400;
  const c180d = now - 180 * 86400;
  const c365d = now - 365 * 86400;

  // 1. Jediný SQL dotaz pro všech 9 časových oken pomocí podmíněných agregací.
  // Projde celou tabulku measurements POUZE JEDNOU místo dřívějších 9 samostatných průchodů.
  const statsPromise = db.prepare(`
    SELECT
      -- 1h (?1)
      ROUND(AVG(CASE WHEN timestamp >= ?1 THEN temp_out END),1) avg_temp_1h,
      ROUND(MAX(CASE WHEN timestamp >= ?1 THEN temp_out END),1) max_temp_1h,
      ROUND(MIN(CASE WHEN timestamp >= ?1 THEN temp_out END),1) min_temp_1h,
      ROUND(AVG(CASE WHEN timestamp >= ?1 THEN humidity_out END),0) avg_hum_1h,
      ROUND(AVG(CASE WHEN timestamp >= ?1 THEN temp_in END),1) avg_temp_in_1h,
      ROUND(MAX(CASE WHEN timestamp >= ?1 THEN temp_in END),1) max_temp_in_1h,
      ROUND(MIN(CASE WHEN timestamp >= ?1 THEN temp_in END),1) min_temp_in_1h,
      ROUND(AVG(CASE WHEN timestamp >= ?1 THEN humidity_in END),0) avg_hum_in_1h,
      MAX(CASE WHEN timestamp >= ?1 THEN humidity_in END) max_hum_in_1h,
      MIN(CASE WHEN timestamp >= ?1 THEN humidity_in END) min_hum_in_1h,
      ROUND(MAX(CASE WHEN timestamp >= ?1 THEN wind_gust END),1) max_gust_1h,
      ROUND(MAX(CASE WHEN timestamp >= ?1 THEN rain_total END),1) max_rain_1h,
      COUNT(CASE WHEN timestamp >= ?1 THEN 1 END) records_1h,

      -- 24h (?2)
      ROUND(AVG(CASE WHEN timestamp >= ?2 THEN temp_out END),1) avg_temp_24h,
      ROUND(MAX(CASE WHEN timestamp >= ?2 THEN temp_out END),1) max_temp_24h,
      ROUND(MIN(CASE WHEN timestamp >= ?2 THEN temp_out END),1) min_temp_24h,
      ROUND(AVG(CASE WHEN timestamp >= ?2 THEN humidity_out END),0) avg_hum_24h,
      ROUND(AVG(CASE WHEN timestamp >= ?2 THEN temp_in END),1) avg_temp_in_24h,
      ROUND(MAX(CASE WHEN timestamp >= ?2 THEN temp_in END),1) max_temp_in_24h,
      ROUND(MIN(CASE WHEN timestamp >= ?2 THEN temp_in END),1) min_temp_in_24h,
      ROUND(AVG(CASE WHEN timestamp >= ?2 THEN humidity_in END),0) avg_hum_in_24h,
      MAX(CASE WHEN timestamp >= ?2 THEN humidity_in END) max_hum_in_24h,
      MIN(CASE WHEN timestamp >= ?2 THEN humidity_in END) min_hum_in_24h,
      ROUND(MAX(CASE WHEN timestamp >= ?2 THEN wind_gust END),1) max_gust_24h,
      ROUND(MAX(CASE WHEN timestamp >= ?2 THEN rain_total END),1) max_rain_24h,
      COUNT(CASE WHEN timestamp >= ?2 THEN 1 END) records_24h,

      -- 7d (?3)
      ROUND(AVG(CASE WHEN timestamp >= ?3 THEN temp_out END),1) avg_temp_7d,
      ROUND(MAX(CASE WHEN timestamp >= ?3 THEN temp_out END),1) max_temp_7d,
      ROUND(MIN(CASE WHEN timestamp >= ?3 THEN temp_out END),1) min_temp_7d,
      ROUND(AVG(CASE WHEN timestamp >= ?3 THEN humidity_out END),0) avg_hum_7d,
      ROUND(AVG(CASE WHEN timestamp >= ?3 THEN temp_in END),1) avg_temp_in_7d,
      ROUND(MAX(CASE WHEN timestamp >= ?3 THEN temp_in END),1) max_temp_in_7d,
      ROUND(MIN(CASE WHEN timestamp >= ?3 THEN temp_in END),1) min_temp_in_7d,
      ROUND(AVG(CASE WHEN timestamp >= ?3 THEN humidity_in END),0) avg_hum_in_7d,
      MAX(CASE WHEN timestamp >= ?3 THEN humidity_in END) max_hum_in_7d,
      MIN(CASE WHEN timestamp >= ?3 THEN humidity_in END) min_hum_in_7d,
      ROUND(MAX(CASE WHEN timestamp >= ?3 THEN wind_gust END),1) max_gust_7d,
      ROUND(MAX(CASE WHEN timestamp >= ?3 THEN rain_total END),1) max_rain_7d,
      COUNT(CASE WHEN timestamp >= ?3 THEN 1 END) records_7d,

      -- 30d (?4)
      ROUND(AVG(CASE WHEN timestamp >= ?4 THEN temp_out END),1) avg_temp_30d,
      ROUND(MAX(CASE WHEN timestamp >= ?4 THEN temp_out END),1) max_temp_30d,
      ROUND(MIN(CASE WHEN timestamp >= ?4 THEN temp_out END),1) min_temp_30d,
      ROUND(AVG(CASE WHEN timestamp >= ?4 THEN humidity_out END),0) avg_hum_30d,
      ROUND(AVG(CASE WHEN timestamp >= ?4 THEN temp_in END),1) avg_temp_in_30d,
      ROUND(MAX(CASE WHEN timestamp >= ?4 THEN temp_in END),1) max_temp_in_30d,
      ROUND(MIN(CASE WHEN timestamp >= ?4 THEN temp_in END),1) min_temp_in_30d,
      ROUND(AVG(CASE WHEN timestamp >= ?4 THEN humidity_in END),0) avg_hum_in_30d,
      MAX(CASE WHEN timestamp >= ?4 THEN humidity_in END) max_hum_in_30d,
      MIN(CASE WHEN timestamp >= ?4 THEN humidity_in END) min_hum_in_30d,
      ROUND(MAX(CASE WHEN timestamp >= ?4 THEN wind_gust END),1) max_gust_30d,
      ROUND(MAX(CASE WHEN timestamp >= ?4 THEN rain_total END),1) max_rain_30d,
      COUNT(CASE WHEN timestamp >= ?4 THEN 1 END) records_30d,

      -- 60d (?5)
      ROUND(AVG(CASE WHEN timestamp >= ?5 THEN temp_out END),1) avg_temp_60d,
      ROUND(MAX(CASE WHEN timestamp >= ?5 THEN temp_out END),1) max_temp_60d,
      ROUND(MIN(CASE WHEN timestamp >= ?5 THEN temp_out END),1) min_temp_60d,
      ROUND(AVG(CASE WHEN timestamp >= ?5 THEN humidity_out END),0) avg_hum_60d,
      ROUND(AVG(CASE WHEN timestamp >= ?5 THEN temp_in END),1) avg_temp_in_60d,
      ROUND(MAX(CASE WHEN timestamp >= ?5 THEN temp_in END),1) max_temp_in_60d,
      ROUND(MIN(CASE WHEN timestamp >= ?5 THEN temp_in END),1) min_temp_in_60d,
      ROUND(AVG(CASE WHEN timestamp >= ?5 THEN humidity_in END),0) avg_hum_in_60d,
      MAX(CASE WHEN timestamp >= ?5 THEN humidity_in END) max_hum_in_60d,
      MIN(CASE WHEN timestamp >= ?5 THEN humidity_in END) min_hum_in_60d,
      ROUND(MAX(CASE WHEN timestamp >= ?5 THEN wind_gust END),1) max_gust_60d,
      ROUND(MAX(CASE WHEN timestamp >= ?5 THEN rain_total END),1) max_rain_60d,
      COUNT(CASE WHEN timestamp >= ?5 THEN 1 END) records_60d,

      -- 90d (?6)
      ROUND(AVG(CASE WHEN timestamp >= ?6 THEN temp_out END),1) avg_temp_90d,
      ROUND(MAX(CASE WHEN timestamp >= ?6 THEN temp_out END),1) max_temp_90d,
      ROUND(MIN(CASE WHEN timestamp >= ?6 THEN temp_out END),1) min_temp_90d,
      ROUND(AVG(CASE WHEN timestamp >= ?6 THEN humidity_out END),0) avg_hum_90d,
      ROUND(AVG(CASE WHEN timestamp >= ?6 THEN temp_in END),1) avg_temp_in_90d,
      ROUND(MAX(CASE WHEN timestamp >= ?6 THEN temp_in END),1) max_temp_in_90d,
      ROUND(MIN(CASE WHEN timestamp >= ?6 THEN temp_in END),1) min_temp_in_90d,
      ROUND(AVG(CASE WHEN timestamp >= ?6 THEN humidity_in END),0) avg_hum_in_90d,
      MAX(CASE WHEN timestamp >= ?6 THEN humidity_in END) max_hum_in_90d,
      MIN(CASE WHEN timestamp >= ?6 THEN humidity_in END) min_hum_in_90d,
      ROUND(MAX(CASE WHEN timestamp >= ?6 THEN wind_gust END),1) max_gust_90d,
      ROUND(MAX(CASE WHEN timestamp >= ?6 THEN rain_total END),1) max_rain_90d,
      COUNT(CASE WHEN timestamp >= ?6 THEN 1 END) records_90d,

      -- 180d (?7)
      ROUND(AVG(CASE WHEN timestamp >= ?7 THEN temp_out END),1) avg_temp_180d,
      ROUND(MAX(CASE WHEN timestamp >= ?7 THEN temp_out END),1) max_temp_180d,
      ROUND(MIN(CASE WHEN timestamp >= ?7 THEN temp_out END),1) min_temp_180d,
      ROUND(AVG(CASE WHEN timestamp >= ?7 THEN humidity_out END),0) avg_hum_180d,
      ROUND(AVG(CASE WHEN timestamp >= ?7 THEN temp_in END),1) avg_temp_in_180d,
      ROUND(MAX(CASE WHEN timestamp >= ?7 THEN temp_in END),1) max_temp_in_180d,
      ROUND(MIN(CASE WHEN timestamp >= ?7 THEN temp_in END),1) min_temp_in_180d,
      ROUND(AVG(CASE WHEN timestamp >= ?7 THEN humidity_in END),0) avg_hum_in_180d,
      MAX(CASE WHEN timestamp >= ?7 THEN humidity_in END) max_hum_in_180d,
      MIN(CASE WHEN timestamp >= ?7 THEN humidity_in END) min_hum_in_180d,
      ROUND(MAX(CASE WHEN timestamp >= ?7 THEN wind_gust END),1) max_gust_180d,
      ROUND(MAX(CASE WHEN timestamp >= ?7 THEN rain_total END),1) max_rain_180d,
      COUNT(CASE WHEN timestamp >= ?7 THEN 1 END) records_180d,

      -- 365d (?8)
      ROUND(AVG(CASE WHEN timestamp >= ?8 THEN temp_out END),1) avg_temp_365d,
      ROUND(MAX(CASE WHEN timestamp >= ?8 THEN temp_out END),1) max_temp_365d,
      ROUND(MIN(CASE WHEN timestamp >= ?8 THEN temp_out END),1) min_temp_365d,
      ROUND(AVG(CASE WHEN timestamp >= ?8 THEN humidity_out END),0) avg_hum_365d,
      ROUND(AVG(CASE WHEN timestamp >= ?8 THEN temp_in END),1) avg_temp_in_365d,
      ROUND(MAX(CASE WHEN timestamp >= ?8 THEN temp_in END),1) max_temp_in_365d,
      ROUND(MIN(CASE WHEN timestamp >= ?8 THEN temp_in END),1) min_temp_in_365d,
      ROUND(AVG(CASE WHEN timestamp >= ?8 THEN humidity_in END),0) avg_hum_in_365d,
      MAX(CASE WHEN timestamp >= ?8 THEN humidity_in END) max_hum_in_365d,
      MIN(CASE WHEN timestamp >= ?8 THEN humidity_in END) min_hum_in_365d,
      ROUND(MAX(CASE WHEN timestamp >= ?8 THEN wind_gust END),1) max_gust_365d,
      ROUND(MAX(CASE WHEN timestamp >= ?8 THEN rain_total END),1) max_rain_365d,
      COUNT(CASE WHEN timestamp >= ?8 THEN 1 END) records_365d,

      -- all (celá historie)
      ROUND(AVG(temp_out),1) avg_temp_all,
      ROUND(MAX(temp_out),1) max_temp_all,
      ROUND(MIN(temp_out),1) min_temp_all,
      ROUND(AVG(humidity_out),0) avg_hum_all,
      ROUND(AVG(temp_in),1) avg_temp_in_all,
      ROUND(MAX(temp_in),1) max_temp_in_all,
      ROUND(MIN(temp_in),1) min_temp_in_all,
      ROUND(AVG(humidity_in),0) avg_hum_in_all,
      MAX(humidity_in) max_hum_in_all,
      MIN(humidity_in) min_hum_in_all,
      ROUND(MAX(wind_gust),1) max_gust_all,
      ROUND(MAX(rain_total),1) max_rain_all,
      COUNT(*) records_all
    FROM measurements
  `).bind(c1h, c24h, c7d, c30d, c60d, c90d, c180d, c365d).first();

  // 2. Denní přehled pro deštivé / suché dny v paměti (nahrazuje 9 samostatných SQL dotazů)
  const daysPromise = db.prepare(`
    SELECT date(timestamp, 'unixepoch', '+1 hour') AS day,
           MIN(timestamp) AS start_ts,
           MAX(timestamp) AS end_ts,
           MAX(rain_rate) AS max_rain
    FROM measurements
    GROUP BY day
    ORDER BY day ASC
  `).all();

  const [row, daysRes] = await Promise.all([statsPromise, daysPromise]);
  const days = daysRes?.results ?? [];

  // Výpočet dešťových dnů pro daný časový limit v paměti (0 D1 row reads)
  function getRainStats(cutoff) {
    let rainy = 0;
    let dry = 0;
    for (const d of days) {
      if (cutoff === 0 || d.end_ts >= cutoff) {
        if (d.max_rain > 0) {
          rainy++;
        } else {
          dry++;
        }
      }
    }
    return { rainy_days: rainy, dry_days: dry };
  }

  function extractPeriod(suf, rain) {
    return {
      avg_temp:    row?.[`avg_temp_${suf}`] ?? null,
      max_temp:    row?.[`max_temp_${suf}`] ?? null,
      min_temp:    row?.[`min_temp_${suf}`] ?? null,
      avg_hum:     row?.[`avg_hum_${suf}`] ?? null,
      avg_temp_in: row?.[`avg_temp_in_${suf}`] ?? null,
      max_temp_in: row?.[`max_temp_in_${suf}`] ?? null,
      min_temp_in: row?.[`min_temp_in_${suf}`] ?? null,
      avg_hum_in:  row?.[`avg_hum_in_${suf}`] ?? null,
      max_hum_in:  row?.[`max_hum_in_${suf}`] ?? null,
      min_hum_in:  row?.[`min_hum_in_${suf}`] ?? null,
      max_gust:    row?.[`max_gust_${suf}`] ?? null,
      max_rain:    row?.[`max_rain_${suf}`] ?? null,
      records:     row?.[`records_${suf}`] ?? 0,
      rainy_days:  rain.rainy_days,
      dry_days:    rain.dry_days,
    };
  }

  return {
    last_1h:   extractPeriod('1h',   getRainStats(c1h)),
    last_24h:  extractPeriod('24h',  getRainStats(c24h)),
    last_7d:   extractPeriod('7d',   getRainStats(c7d)),
    last_30d:  extractPeriod('30d',  getRainStats(c30d)),
    last_60d:  extractPeriod('60d',  getRainStats(c60d)),
    last_90d:  extractPeriod('90d',  getRainStats(c90d)),
    last_180d: extractPeriod('180d', getRainStats(c180d)),
    last_365d: extractPeriod('365d', getRainStats(c365d)),
    all:       extractPeriod('all',  getRainStats(0)),
  };
}

// ─── Hlavní fetch handler ─────────────────────────────────────────────────────

async function handleFetch(request, env, ctx) {
  const url            = new URL(request.url);
  const requestOrigin  = request.headers.get('Origin') ?? '';
  const allowedOrigin  = env.ALLOWED_ORIGIN ?? '';
  const corsHdrs       = corsHeaders(allowedOrigin, requestOrigin);

  // Zpracuj CORS preflight (OPTIONS) — nutné pro prohlížečové requesty
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...securityHeaders(), ...corsHdrs } });
  }

  // Povolujeme pouze GET požadavky
  if (request.method !== 'GET') {
    return errorResponse('Metoda není povolena', 405, corsHdrs);
  }

  // Cache API
  const cache = caches.default;
  const path  = url.pathname;

  try {
    if (path === '/api/current') {
      const cacheKey = new Request(`${url.origin}/api/current`, { method: 'GET' });
      return await handleCachedEndpoint(cache, cacheKey, CACHE_CURRENT_TTL, corsHdrs, ctx, () => getCurrentData(env.DB));
    }

    if (path === '/api/records') {
      const cacheKey = new Request(`${url.origin}/api/records`, { method: 'GET' });
      return await handleCachedEndpoint(cache, cacheKey, CACHE_RECORDS_TTL, corsHdrs, ctx, () => getRecordsData(env.DB));
    }

    if (path === '/api/stats') {
      const cacheKey = new Request(`${url.origin}/api/stats`, { method: 'GET' });
      return await handleCachedEndpoint(cache, cacheKey, CACHE_STATS_TTL, corsHdrs, ctx, () => getStatsData(env.DB));
    }

    if (path === '/api/history') {
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      return await handleCachedEndpoint(cache, cacheKey, CACHE_HISTORY_TTL, corsHdrs, ctx, () => fetchHistoryData(env.DB, url));
    }

    if (path === '/api/daily') {
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      return await handleCachedEndpoint(cache, cacheKey, CACHE_DAILY_TTL, corsHdrs, ctx, () => fetchDailyData(env.DB, url));
    }

    if (path === '/api/test-wc') {
      return await handleTestWeathercloud(env, corsHdrs);
    }

    return errorResponse('Endpoint neexistuje', 404, corsHdrs);
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return errorResponse(err.message, err.status, corsHdrs);
    }
    // Interní chyba — logujeme detaily, uživateli pošleme jen obecnou zprávu
    console.error('[FETCH] Interní chyba:', err.message);
    return errorResponse('Interní chyba serveru', 500, corsHdrs);
  }
}


// ─── Weathercloud indoor data ─────────────────────────────────────────────────

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

/**
 * Stáhne aktuální data ze Weathercloudu pomocí neoficiálního webového endpointu.
 * Zkouší ID jak v čisté číselné podobě, tak případně s prefixem 'd'.
 */
async function fetchFromWeathercloud(deviceId, cookie) {
  const cleanId = String(deviceId).trim().replace(/^d/i, '');
  const rawId   = String(deviceId).trim();
  const idsToTry = Array.from(new Set([cleanId, rawId]));

  let lastError = null;

  for (const id of idsToTry) {
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
        throw new Error(`Weathercloud vrátil status ${response.status} (neplatná/vypršená session cookie nebo blokace)`);
      }
      if (!response.ok) {
        throw new Error(`Weathercloud HTTP chyba: ${response.status}`);
      }

      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        throw new Error(`Weathercloud nevrátil JSON: ${text.slice(0, 150)}`);
      }

      if (!data || (data.tempin === undefined && data.humin === undefined)) {
        continue; // zkus další formát ID
      }

      const rawTempIn = data.tempin;
      const rawHumIn  = data.humin;

      let tempIn = null;
      if (rawTempIn !== null && rawTempIn !== '' && rawTempIn !== undefined) {
        const val = parseFloat(rawTempIn);
        tempIn = Math.abs(val) > 50 ? Math.round((val / 10) * 10) / 10 : Math.round(val * 10) / 10;
      }

      const humIn = (rawHumIn !== null && rawHumIn !== '' && rawHumIn !== undefined)
        ? parseInt(rawHumIn, 10)
        : null;

      return { tempIn, humIn, usedId: id };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Weathercloud: nepodařilo se načíst indoor data');
}

/**
 * Doplní (UPDATE) indoor teplotu a vlhkost do záznamů v D1.
 * Aktualizuje záznamy z posledních 2 hodin.
 */
async function updateIndoorData(db, tempIn, humIn) {
  const cutoff = Math.floor(Date.now() / 1000) - 2 * 3600; // posledních 2 hodiny

  const result = await db.prepare(`
    UPDATE measurements
    SET    temp_in = ?, humidity_in = ?
    WHERE  source = 'wunderground'
      AND  timestamp >= ?
  `).bind(tempIn, humIn, cutoff).run();

  return result;
}

/**
 * Cron handler pro Weathercloud (spouští se každých 10 minut).
 */
async function handleWeathercloudCron(env) {
  if (!env.WC_DEVICE_ID || !env.WC_COOKIE) {
    console.error('[WC-CRON] Chybí WC_DEVICE_ID nebo WC_COOKIE secret!');
    return;
  }

  try {
    const { tempIn, humIn, usedId } = await fetchFromWeathercloud(env.WC_DEVICE_ID, env.WC_COOKIE);
    const result = await updateIndoorData(env.DB, tempIn, humIn);
    console.log(`[WC-CRON] OK (${usedId}) — tempIn: ${tempIn}°C, humIn: ${humIn}% | aktualizováno: ${result.meta?.changes ?? 0} řádků`);
  } catch (err) {
    console.error('[WC-CRON] Chyba:', err.message);
  }
}

/**
 * Diagnostický endpoint GET /api/test-wc pro okamžité otestování přímo v prohlížeči
 */
async function handleTestWeathercloud(env, corsHdrs) {
  const deviceId = env.WC_DEVICE_ID;
  const cookie   = env.WC_COOKIE;

  if (!deviceId || !cookie) {
    return jsonResponse({
      success: false,
      error: 'V Cloudflare chybí nastavené secrets!',
      has_WC_DEVICE_ID: !!deviceId,
      has_WC_COOKIE: !!cookie,
    }, 400, corsHdrs);
  }

  const cleanId = String(deviceId).trim().replace(/^d/i, '');
  const rawId   = String(deviceId).trim();
  const idsToTry = Array.from(new Set([cleanId, rawId]));
  const log = [];

  for (const id of idsToTry) {
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

      const text = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) {}

      log.push({
        id,
        status: response.status,
        responseSample: text.slice(0, 300),
        isJson: !!parsed,
      });

      if (parsed && (parsed.tempin !== undefined || parsed.humin !== undefined)) {
        const rawTempIn = parsed.tempin;
        const rawHumIn  = parsed.humin;
        let tempIn = null;
        if (rawTempIn !== null && rawTempIn !== '' && rawTempIn !== undefined) {
          const val = parseFloat(rawTempIn);
          tempIn = Math.abs(val) > 50 ? Math.round((val / 10) * 10) / 10 : Math.round(val * 10) / 10;
        }
        const humIn = (rawHumIn !== null && rawHumIn !== '' && rawHumIn !== undefined)
          ? parseInt(rawHumIn, 10) : null;

        let dbResult = null;
        if (tempIn !== null || humIn !== null) {
          const res = await updateIndoorData(env.DB, tempIn, humIn);
          dbResult = { rowsUpdated: res.meta?.changes ?? 0 };
        }

        return jsonResponse({
          success: true,
          message: 'Weathercloud spojení funguje a data byla uložena!',
          usedId: id,
          tempIn,
          humIn,
          dbResult,
          diagnostics: log,
        }, 200, corsHdrs);
      }
    } catch (err) {
      log.push({ id, error: err.message });
    }
  }

  return jsonResponse({
    success: false,
    message: 'Spojení selhalo. Zkontrolujte diagnostiku níže.',
    diagnostics: log,
  }, 200, corsHdrs);
}

// ─── Export (Cloudflare Workers API) ─────────────────────────────────────────

export default {
  // HTTP požadavky (frontend API)
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },

  // Cron triggery — rozlišujeme podle výrazu
  async scheduled(event, env, ctx) {
    if (event.cron === '* * * * *') {
      // Každou minutu: WU API → D1
      ctx.waitUntil(handleCron(env));
    } else if (event.cron === '*/10 * * * *') {
      // Každých 10 minut: Weathercloud → UPDATE indoor dat v D1
      ctx.waitUntil(handleWeathercloudCron(env));
    }
  },
};
