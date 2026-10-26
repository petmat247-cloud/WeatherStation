/**
 * WeatherStation — Liquid Glass API Adapter
 * Připojení na Cloudflare Worker REST API:
 *   GET /api/current   — aktuální měření stanice
 *   GET /api/history   — historická data pro grafy
 *   GET /api/stats     — souhrnné statistiky za časová období
 *   GET /api/records   — absolutní rekordy a série sucha
 */

'use strict';

(function () {
  const API_BASE = 'https://stanice-worker.petmat247.workers.dev';
  const REFRESH_INTERVAL_MS = 60_000; // 1 minuta

  let currentRangeCode = '24h';
  let statsLoaded = false;
  let recordsLoaded = false;
  let cachedDryDays = null;
  const historyMemoryCache = new Map();

  // ── Převody rozsahů ──────────────────────────────────────────────────────────

  function codeToSeconds(code) {
    const map = {
      '1h':   3600,
      '24h':  86400,
      '7d':   7 * 86400,
      '30d':  30 * 86400,
      '60d':  60 * 86400,
      '90d':  90 * 86400,
      '180d': 180 * 86400,
      '1y':   365 * 86400,
      'all':  1825 * 86400 // ~5 let
    };
    return map[code] ?? 86400;
  }

  function codeToLimit(code) {
    return code === '1h' ? 70 : 1440;
  }

  // ── Série sucha (načítá se samostatně 1× za hodinu, ne po minutách) ──────────

  async function fetchDryStreak() {
    try {
      const res = await fetch(`${API_BASE}/api/records`);
      if (!res.ok) return;
      const rec = await res.json();
      if (rec.dry_streak !== undefined && rec.dry_streak !== null) {
        cachedDryDays = rec.dry_streak;
      }
    } catch (_) {
      // Při chybě ponecháme stávající nebo 0
    }
  }

  // ── 1. Aktuální data (pouze lehký /api/current, 0 D1 scanů) ─────────────────

  async function fetchCurrentData() {
    try {
      window.WeatherStation?.setLoading();

      const resCurr = await fetch(`${API_BASE}/api/current`);
      if (!resCurr.ok) throw new Error(`HTTP ${resCurr.status}`);
      const curr = await resCurr.json();

      // Pokud právě prší, sucho je okamžitě 0
      const isRaining = (curr.rain_rate && curr.rain_rate > 0) || (curr.rain_total && curr.rain_total > 0);
      const dryDays = isRaining ? 0 : (cachedDryDays ?? 0);

      const payload = {
        timestamp: curr.timestamp,
        measuredAt: new Date(curr.timestamp * 1000).toISOString(),
        sourceUpdatedAt: new Date().toISOString(),
        outsideC: curr.temp_out,
        insideC: curr.temp_in,
        outsideHumidity: curr.humidity_out,
        insideHumidity: curr.humidity_in,
        pressureHpa: curr.pressure,
        pressureKind: 'seaLevel',
        speedMps: curr.wind_speed,
        directionDeg: curr.wind_dir,
        rainHour: curr.rain_rate,
        rainDay: curr.rain_total,
        dryDays,
        lastRainAt: null
      };

      window.WeatherStation?.accept(payload);
    } catch (err) {
      console.error('[API] Chyba načítání aktuálních dat:', err);
      window.WeatherStation?.setError(`Nepodařilo se načíst data: ${err.message}`);
    }
  }

  // ── 2. Historie (Grafy s paměťovou cache + Edge Cache) ──────────────────────

  async function fetchHistoryData(code) {
    currentRangeCode = code || currentRangeCode || '24h';

    // Kontrola paměťové mezipaměti v prohlížeči (zabraňuje opakovaným dotazům při klikání na záložky)
    const memCache = historyMemoryCache.get(currentRangeCode);
    const memTtlMs = ['60d', '90d', '180d', '1y', 'all'].includes(currentRangeCode) ? 3600_000 : 300_000;
    if (memCache && (Date.now() - memCache.time < memTtlMs)) {
      window.WeatherHistory?.accept(memCache.data);
      return;
    }

    try {
      window.WeatherHistory?.setLoading();

      const rangeSec = codeToSeconds(currentRangeCode);
      const limit = codeToLimit(currentRangeCode);

      // Časové zaokrouhlení pro efektivní Cloudflare Edge Cache
      let stepSec = 60;
      if (['7d', '30d'].includes(currentRangeCode)) stepSec = 3600;
      else if (['60d', '90d', '180d', '1y', 'all'].includes(currentRangeCode)) stepSec = 86400;

      const nowRaw = Math.floor(Date.now() / 1000);
      const now = Math.floor(nowRaw / stepSec) * stepSec;
      const from = now - rangeSec;

      const res = await fetch(`${API_BASE}/api/history?from=${from}&to=${now}&limit=${limit}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rows = json.data ?? [];

      if (!rows.length) {
        window.WeatherHistory?.setError('Pro vybrané období nejsou k dispozici žádná data.');
        return;
      }

      const series = {
        outsideC:        { points: rows.map(r => ({ t: r.timestamp * 1000, v: r.temp_out })) },
        feelsLikeC:      { points: rows.map(r => ({ t: r.timestamp * 1000, v: r.feels_like })) },
        dewPointC:       { points: rows.map(r => ({ t: r.timestamp * 1000, v: r.dew_point })) },
        insideC:         { points: rows.map(r => ({ t: r.timestamp * 1000, v: r.temp_in })) },
        outsideHumidity: { points: rows.map(r => ({ t: r.timestamp * 1000, v: r.humidity_out })) },
        insideHumidity:  { points: rows.map(r => ({ t: r.timestamp * 1000, v: r.humidity_in })) },
        pressureHpa:     { points: rows.map(r => ({ t: r.timestamp * 1000, v: r.pressure })) },
        windMps:         { points: rows.map(r => ({ t: r.timestamp * 1000, v: r.wind_speed })) },
        gustMps:         { points: rows.map(r => ({ t: r.timestamp * 1000, v: r.wind_gust })) },
        rainRateMmh:     { points: rows.map(r => ({ t: r.timestamp * 1000, v: r.rain_rate })) }
      };

      const historyData = {
        series,
        pressureKind: 'seaLevel'
      };

      historyMemoryCache.set(currentRangeCode, { time: Date.now(), data: historyData });
      window.WeatherHistory?.accept(historyData);
    } catch (err) {
      console.error('[API] Chyba načítání historie grafů:', err);
      window.WeatherHistory?.setError(`Nepodařilo se načíst grafy: ${err.message}`);
    }
  }

  // ── 3. Statistiky ────────────────────────────────────────────────────────────

  async function fetchStatisticsData(force = false) {
    if (statsLoaded && !force) return;
    try {
      window.WeatherStatistics?.setLoading();

      const res = await fetch(`${API_BASE}/api/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = await res.json();

      const periodMappings = [
        { code: '1h',   data: s.last_1h,   dur: 3600000 },
        { code: '24h',  data: s.last_24h,  dur: 86400000 },
        { code: '7d',   data: s.last_7d,   dur: 7 * 86400000 },
        { code: '30d',  data: s.last_30d,  dur: 30 * 86400000 },
        { code: '60d',  data: s.last_60d,  dur: 60 * 86400000 },
        { code: '90d',  data: s.last_90d,  dur: 90 * 86400000 },
        { code: '180d', data: s.last_180d, dur: 180 * 86400000 },
        { code: '1y',   data: s.last_365d, dur: 365 * 86400000 },
        { code: 'all',  data: s.all,       dur: null }
      ];

      const now = Date.now();
      const summaries = periodMappings.map(p => {
        const d = p.data || {};
        const from = p.dur ? now - p.dur : (now - 150 * 86400000);
        const to = now;
        const recCount = d.records ?? 0;
        return {
          code: p.code,
          from,
          to,
          metrics: {
            outsideC: {
              mean: d.avg_temp ?? null,
              max: d.max_temp ?? null,
              min: d.min_temp ?? null,
              n: recCount
            },
            insideC: {
              mean: d.avg_temp_in ?? null,
              max: d.max_temp_in ?? null,
              min: d.min_temp_in ?? null,
              n: recCount
            },
            outsideHumidity: {
              mean: d.avg_hum ?? null,
              max: null,
              min: null,
              n: recCount
            },
            insideHumidity: {
              mean: d.avg_hum_in ?? null,
              max: d.max_hum_in ?? null,
              min: d.min_hum_in ?? null,
              n: recCount
            }
          },
          gust: {
            value: d.max_gust ?? null,
            n: recCount
          },
          rain: {
            kind: 'counter',
            value: d.max_rain ?? null,
            from: from,
            to: to,
            unit: 'mm'
          },
          count: recCount,
          availableCount: recCount,
          full: true,
          countReliable: true
        };
      });

      window.WeatherStatistics?.accept({ summaries });
      statsLoaded = true;
    } catch (err) {
      console.error('[API] Chyba načítání statistik:', err);
      window.WeatherStatistics?.setError(`Nepodařilo se načíst statistiky: ${err.message}`);
    }
  }

  // ── 4. Rekordy ───────────────────────────────────────────────────────────────

  async function fetchRecordsData(force = false) {
    if (recordsLoaded && !force) return;
    try {
      window.WeatherRecords?.setLoading();

      const res = await fetch(`${API_BASE}/api/records`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json();

      const extremes = {
        outsideMax:     { value: r.temp_max, unit: '°C' },
        outsideMin:     { value: r.temp_min, unit: '°C' },
        feelsMax:       { value: r.feels_like_max, unit: '°C' },
        feelsMin:       { value: r.feels_like_min, unit: '°C' },
        dewMax:         { value: r.dew_point_max, unit: '°C' },
        dewMin:         { value: r.dew_point_min, unit: '°C' },
        insideMax:      { value: r.temp_in_max, unit: '°C' },
        insideMin:      { value: r.temp_in_min, unit: '°C' },
        humidityOutMax: { value: r.humidity_max, unit: '%' },
        humidityOutMin: { value: r.humidity_min, unit: '%' },
        humidityInMax:  { value: r.humidity_in_max, unit: '%' },
        humidityInMin:  { value: r.humidity_in_min, unit: '%' },
        gustMax:        { value: r.wind_gust_max, unit: 'm/s' },
        windMax:        { value: r.wind_speed_max, unit: 'm/s' },
        rainRateMax:    { value: r.rain_rate_max, unit: 'mm/h' },
        rainHourMax:    { value: r.rain_rate_max, unit: 'mm' },
        rainDayMax:     { value: r.rain_total_max, unit: 'mm' },
        dryLongest:     { value: r.max_dry_streak, unit: 'dní' }
      };

      window.WeatherRecords?.accept({
        extremes,
        total_records: r.total_records,
        oldest_record: r.oldest_record,
        newest_record: r.newest_record
      });
      recordsLoaded = true;
    } catch (err) {
      console.error('[API] Chyba načítání rekordů:', err);
      window.WeatherRecords?.setError();
    }
  }

  // ── Události a automatická obnova ──────────────────────────────────────────

  function onSectionChange() {
    const section = document.body.dataset.section;
    if (section === 'grafy') {
      fetchHistoryData(currentRangeCode);
    } else if (section === 'statistiky') {
      fetchStatisticsData();
    } else if (section === 'rekordy') {
      fetchRecordsData();
    }
  }

  function init() {
    // Malá prodleva pro zaručení, že controllery v script.js jsou plně inicializované
    setTimeout(function () {
      fetchDryStreak();
      fetchCurrentData();

      // Pokud byla načtena jiná sekce (např. přes URL hash nebo parametr)
      onSectionChange();

      // Sledování přepínání sekcí
      window.addEventListener('meteo:sectionchange', onSectionChange);

      // Sledování přepínání časových rozsahů
      window.addEventListener('meteo:timechange', function (e) {
        if (e.detail?.code) {
          currentRangeCode = e.detail.code;
          if (document.body.dataset.section === 'grafy') {
            fetchHistoryData(currentRangeCode);
          }
        }
      });

      // Pravidelná obnova každou minutu (pouze lehký /api/current, 0 D1 scanů)
      setInterval(function () {
        fetchCurrentData();
        if (document.body.dataset.section === 'grafy') {
          // Grafy obnovujeme pouze pro krátké rozsahy (1h, 24h), dlouhodobé grafy se nemění každou minutu
          if (['1h', '24h'].includes(currentRangeCode)) {
            fetchHistoryData(currentRangeCode);
          }
        }
      }, REFRESH_INTERVAL_MS);

      // Těžká data (série sucha, statistiky, rekordy) se obnovují pouze 1× za hodinu
      setInterval(function () {
        fetchDryStreak();
        fetchStatisticsData(true);
        fetchRecordsData(true);
      }, 3600_000);
    }, 30);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
