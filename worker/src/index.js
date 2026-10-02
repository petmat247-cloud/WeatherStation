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

const WU_API_BASE = 'https://api.weather.com/v2/pws/observations/current';
const CACHE_TTL   = 60;   // sekund — cache pro /api/current
const MAX_LIMIT   = 2880; // max záznamů pro /api/history (2880 = 2 dny po minutě, pro delší rozsahy se vzorkuje)
const MAX_DAYS    = 365;  // max počet dní pro /api/daily

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

// ─── REST API handlery ────────────────────────────────────────────────────────

/** GET /api/current — poslední naměřený záznam */
async function handleCurrent(db, corsHdrs, cacheApi, cacheKey) {
  // Zkus načíst z cache
  const cached = await cacheApi.match(cacheKey);
  if (cached) {
    const body = await cached.json();
    return jsonResponse(body, 200, { ...corsHdrs, 'X-Cache': 'HIT' });
  }

  // Outdoor data z nejnovějšího záznamu.
  // Indoor data (temp_in, humidity_in) z posledního záznamu kde NEJSOU null —
  // WU API indoor hodnoty neposkytuje, doplňuje je Weathercloud cron každých 10 min.
  // Subquery zajistí, že karta nikdy nezobrazí '—' jen proto, že poslední minutový
  // WU záznam ještě nebyl aktualizován Weathercloud cronem.
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

  if (!row) return errorResponse('Žádná data', 404, corsHdrs);

  const resp = jsonResponse(row, 200, {
    ...corsHdrs,
    'Cache-Control': `public, max-age=${CACHE_TTL}`,
    'X-Cache': 'MISS',
  });

  // Ulož do cache
  await cacheApi.put(cacheKey, resp.clone());
  return resp;
}

/** GET /api/history?from=TS&to=TS&limit=N */
async function handleHistory(db, url, corsHdrs) {
  const params = url.searchParams;
  const now    = Math.floor(Date.now() / 1000);

  const from  = parseTimestamp(params.get('from')) ?? (now - 86400); // default: posledních 24h
  const to    = parseTimestamp(params.get('to'))   ?? now;
  const limit = parsePositiveInt(params.get('limit'), 144, MAX_LIMIT);

  if (limit === null) return errorResponse('Neplatný parametr limit', 400, corsHdrs);
  if (from > to)      return errorResponse('from musí být menší než to', 400, corsHdrs);
  if ((to - from) > 1825 * 86400) {
    return errorResponse('Maximální rozsah je 5 let', 400, corsHdrs);
  }

  // Výpočet kroku pro rovnoměrné vzorkování přes celý rozsah.
  // Bez vzorkování by LIMIT vrátil jen prvních N záznamů ze začátku rozsahu —
  // pro 90 dní dat by to bylo jen první 1–2 dny.
  const rangeSeconds = to - from;
  const targetPoints = limit;                             // kolik bodů chceme
  const rawStep      = rangeSeconds / targetPoints;       // ideální krok v sekundách
  // Zaokrouhlíme krok na celé minuty (60 s) — záznamy jsou ukládány každou minutu.
  const step = Math.max(60, Math.round(rawStep / 60) * 60);

  let rows;
  if (step <= 60) {
    // Krátký rozsah (≤ 24h při limitu 1440) — vrátíme všechny záznamy bez vzorkování.
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
    // Dlouhý rozsah — vzorkujeme: vezmeme vždy první záznam z každého časového bucketu.
    // (timestamp - from) / step = číslo bucketu; bucket * step + from = začátek bucketu.
    rows = await db
      .prepare(`
        SELECT * FROM measurements
        WHERE timestamp BETWEEN ? AND ?
          AND (timestamp - ?) % ? < 60
        ORDER BY timestamp ASC
        LIMIT ?
      `)
      .bind(from, to, from, step, limit)
      .all();
  }

  return jsonResponse({ count: rows.results.length, data: rows.results }, 200, corsHdrs);
}

/** GET /api/daily?days=N — denní min/max/avg za posledních N dní */
async function handleDaily(db, url, corsHdrs) {
  const params = url.searchParams;
  const days   = parsePositiveInt(params.get('days'), 30, MAX_DAYS);
  if (days === null) return errorResponse('Neplatný parametr days', 400, corsHdrs);

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

  return jsonResponse({ count: rows.results.length, data: rows.results }, 200, corsHdrs);
}

/** GET /api/records — absolutní rekordy ze všech dat */
async function handleRecords(db, corsHdrs) {
  const row = await db
    .prepare(`
      SELECT
        ROUND(MAX(temp_out), 1)         AS temp_max,
        ROUND(MIN(temp_out), 1)         AS temp_min,
        ROUND(MAX(temp_in), 1)          AS temp_in_max,
        ROUND(MIN(temp_in), 1)          AS temp_in_min,
        ROUND(MAX(pressure), 1)         AS pressure_max,
        ROUND(MIN(pressure), 1)         AS pressure_min,
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
    `)
    .first();

  return jsonResponse(row, 200, { ...corsHdrs, 'Cache-Control': 'public, max-age=300' });
}

/** GET /api/stats — statistiky za 24h / 7 dní / 30 dní */
async function handleStats(db, corsHdrs) {
  const now = Math.floor(Date.now() / 1000);

  const [d1, d7, d30] = await Promise.all([
    db.prepare(`
      SELECT ROUND(AVG(temp_out),1) avg_temp, ROUND(MAX(temp_out),1) max_temp,
             ROUND(MIN(temp_out),1) min_temp, ROUND(AVG(humidity_out),0) avg_hum,
             ROUND(AVG(temp_in),1) avg_temp_in, ROUND(MAX(temp_in),1) max_temp_in,
             ROUND(MIN(temp_in),1) min_temp_in, ROUND(AVG(humidity_in),0) avg_hum_in,
             ROUND(MAX(wind_gust),1) max_gust, COUNT(*) records
      FROM measurements WHERE timestamp >= ?
    `).bind(now - 86400).first(),
    db.prepare(`
      SELECT ROUND(AVG(temp_out),1) avg_temp, ROUND(MAX(temp_out),1) max_temp,
             ROUND(MIN(temp_out),1) min_temp, ROUND(AVG(humidity_out),0) avg_hum,
             ROUND(AVG(temp_in),1) avg_temp_in, ROUND(MAX(temp_in),1) max_temp_in,
             ROUND(MIN(temp_in),1) min_temp_in, ROUND(AVG(humidity_in),0) avg_hum_in,
             ROUND(MAX(wind_gust),1) max_gust, COUNT(*) records
      FROM measurements WHERE timestamp >= ?
    `).bind(now - 7 * 86400).first(),
    db.prepare(`
      SELECT ROUND(AVG(temp_out),1) avg_temp, ROUND(MAX(temp_out),1) max_temp,
             ROUND(MIN(temp_out),1) min_temp, ROUND(AVG(humidity_out),0) avg_hum,
             ROUND(AVG(temp_in),1) avg_temp_in, ROUND(MAX(temp_in),1) max_temp_in,
             ROUND(MIN(temp_in),1) min_temp_in, ROUND(AVG(humidity_in),0) avg_hum_in,
             ROUND(MAX(wind_gust),1) max_gust, COUNT(*) records
      FROM measurements WHERE timestamp >= ?
    `).bind(now - 30 * 86400).first(),
  ]);

  return jsonResponse(
    { last_24h: d1, last_7d: d7, last_30d: d30 },
    200,
    { ...corsHdrs, 'Cache-Control': 'public, max-age=120' },
  );
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

  // Cache API pro /api/current
  const cache    = caches.default;
  const cacheKey = new Request(`${url.origin}/api/current`, request);

  const path = url.pathname;

  try {
    if (path === '/api/current') return await handleCurrent(env.DB, corsHdrs, cache, cacheKey);
    if (path === '/api/history') return await handleHistory(env.DB, url, corsHdrs);
    if (path === '/api/daily')   return await handleDaily(env.DB, url, corsHdrs);
    if (path === '/api/records') return await handleRecords(env.DB, corsHdrs);
    if (path === '/api/stats')   return await handleStats(env.DB, corsHdrs);
    if (path === '/api/test-wc') return await handleTestWeathercloud(env, corsHdrs);

    return errorResponse('Endpoint neexistuje', 404, corsHdrs);
  } catch (err) {
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
