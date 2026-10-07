/**
 * Stanice — Meteorologický dashboard
 * app.js — veškerá logika aplikace
 *
 * Komunikuje s Cloudflare Worker REST API:
 *   GET /api/current   — poslední naměřený záznam
 *   GET /api/history   — záznamy v časovém rozsahu (pro grafy)
 *   GET /api/stats     — statistiky za 1h / 24h / 7d / 30d / 60d / 90d / 180d / 365d / vše
 *   GET /api/records   — absolutní rekordy ze všech dat
 */

'use strict';

// ── Konfigurace ──────────────────────────────────────────────────────────────

const API        = 'https://stanice-worker.petmat247.workers.dev';
const REFRESH_MS = 60_000; // automatická obnova každou minutu

// ── Stav aplikace ────────────────────────────────────────────────────────────

let currentRange   = '24h';
let charts         = {};
let statsLoaded    = false;
let recordsLoaded  = false;
let chartsLoaded   = false;

// ── Formátovací pomocné funkce ───────────────────────────────────────────────

/** Formátuje číslo na daný počet desetinných míst, nebo vrátí '—'. */
function fmt(val, dec = 1) {
  if (val === null || val === undefined) return '—';
  return Number(val).toFixed(dec);
}

function fmt0(val) {
  return fmt(val, 0);
}

/** Vrátí textový popis světové strany pro stupně větru (0 = sever). */
function windDirText(deg) {
  if (deg === null || deg === undefined) return '—';
  const dirs = ['S','SSV','SV','VSV','V','VJV','JV','JJV','J','JJZ','JZ','ZJZ','Z','ZSZ','SZ','SSZ'];
  return dirs[Math.round(deg / 22.5) % 16];
}

/** CSS transform pro šipku větru (➤ ukazuje vpravo = 0°, sever = -90°). */
function windArrowRotation(deg) {
  return deg !== null && deg !== undefined ? `rotate(${deg - 90}deg)` : '';
}

/** Relativní čas "před X minutami". */
function relativeTime(unixTs) {
  const diff = Math.floor(Date.now() / 1000) - unixTs;
  if (diff < 5)   return 'právě teď';
  if (diff < 60)  return `před ${diff} s`;
  const m = Math.round(diff / 60);
  if (m < 60) return `před ${m} min`;
  return `před ${Math.round(m / 60)} h`;
}

/** Formátuje Unix timestamp jako lokální datum a čas. */
function fmtTime(unixTs) {
  const d = new Date(unixTs * 1000);
  return d.toLocaleString('cs-CZ', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Textový popis vlhkosti. */
function humDesc(val) {
  if (val === null || val === undefined) return '';
  if (val < 30) return '🏜️ Velmi suchý vzduch';
  if (val < 50) return '😊 Komfortní vlhkost';
  if (val < 70) return '🌿 Mírně vlhký vzduch';
  if (val < 85) return '💦 Vlhký vzduch';
  return '🌫️ Velmi vlhký vzduch';
}

/** Textový popis tlaku. */
function presDesc(val) {
  if (val === null || val === undefined) return '';
  if (val < 980)  return '⬇️ Nízký tlak – nestabilní počasí';
  if (val < 1010) return '↔️ Podprůměrný tlak';
  if (val < 1020) return '✅ Normální tlak';
  if (val < 1030) return '☀️ Nadprůměrný tlak';
  return '⬆️ Vysoký tlak – stabilní počasí';
}

// ── Stavové indikátory ───────────────────────────────────────────────────────

function setStatus(type, text) {
  document.getElementById('status-dot').className  = `status-dot ${type}`;
  document.getElementById('status-text').textContent = text;
}

function showError(id, message) {
  const el = document.getElementById(id);
  el.style.display  = 'block';
  el.textContent    = message;
}

function hideError(id) {
  document.getElementById(id).style.display = 'none';
}

// ── Aktuální data ────────────────────────────────────────────────────────────

async function loadCurrent() {
  try {
    const res  = await fetch(`${API}/api/current`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Timestamp
    document.getElementById('ts-display').textContent = fmtTime(data.timestamp);
    document.getElementById('ts-age').textContent     = relativeTime(data.timestamp);

    // Venkovní teplota
    document.getElementById('val-temp-out').textContent = fmt(data.temp_out);
    document.getElementById('val-feels').textContent    = fmt(data.feels_like);
    document.getElementById('val-dew').textContent      = fmt(data.dew_point);

    // Vnitřní teplota — WU API tato data neposkytuje (null pro live záznamy)
    // Historická data z Weathercloudu indoor hodnoty obsahují
    document.getElementById('val-temp-in').textContent = data.temp_in !== null ? fmt(data.temp_in) : '—';
    document.getElementById('val-hum-in').textContent  = data.humidity_in !== null ? fmt0(data.humidity_in) : '—';
    const humInDescEl = document.getElementById('hum-in-desc');
    if (humInDescEl) humInDescEl.textContent = humDesc(data.humidity_in);

    // Vlhkost
    document.getElementById('val-hum-out').textContent = fmt0(data.humidity_out);
    document.getElementById('hum-desc').textContent    = humDesc(data.humidity_out);

    // Tlak
    document.getElementById('val-pressure').textContent = fmt(data.pressure);
    document.getElementById('pres-desc').textContent    = presDesc(data.pressure);

    // Vítr
    document.getElementById('val-wind-speed').textContent      = fmt(data.wind_speed);
    document.getElementById('val-wind-gust').textContent       = fmt(data.wind_gust);
    document.getElementById('val-wind-dir-txt').textContent    = windDirText(data.wind_dir);
    document.getElementById('wind-arrow').style.transform      = windArrowRotation(data.wind_dir);

    // Srážky
    document.getElementById('val-rain-rate').textContent  = fmt(data.rain_rate);
    document.getElementById('val-rain-total').textContent = fmt(data.rain_total);

    setStatus('online', `Online · ${relativeTime(data.timestamp)}`);
    hideError('current-error');

    // Dní bez deště — načteme souběžně z /api/records (cachovano 5 min)
    fetch(`${API}/api/records`)
      .then(r => r.json())
      .then(rec => {
        const el = document.getElementById('val-dry-streak');
        if (el) el.textContent = rec.dry_streak ?? '—';
      })
      .catch(() => {}); // tiše ignorujeme chybu, hlavní data jsou důležitější
  } catch (e) {
    setStatus('error', 'Chyba připojení');
    showError('current-error', `Nepodařilo se načíst aktuální data: ${e.message}`);
  }
}

// ── Chart.js — společná konfigurace ─────────────────────────────────────────

function getChartColors() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    gridColor: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)',
    textColor: dark ? '#94a3b8' : '#64748b',
  };
}

function commonChartOptions(yLabel) {
  const cc = getChartColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        labels: { color: cc.textColor, boxWidth: 12, font: { size: 12 } },
      },
      tooltip: { mode: 'index', intersect: false },
    },
    scales: {
      x: {
        type: 'time',
        time: {
          tooltipFormat: 'dd.MM. HH:mm',
          displayFormats: {
            millisecond: 'HH:mm:ss',
            second:      'HH:mm:ss',
            minute:      'HH:mm',
            hour:        'HH:mm',
            day:         'dd.MM.',
            week:        'dd.MM.',
            month:       'MM.yyyy',
            quarter:     'MM.yyyy',
            year:        'yyyy',
          },
        },
        adapters: {},
        grid:  { color: cc.gridColor },
        ticks: {
          color: cc.textColor,
          maxRotation: 0,
          maxTicksLimit: 8,
          // Vynucení 24h formátu bez ohledu na locale prohlížeče
          callback(value) {
            const d = new Date(value);
            const h  = String(d.getHours()).padStart(2, '0');
            const m  = String(d.getMinutes()).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const mo = String(d.getMonth() + 1).padStart(2, '0');
            // Pokud je krok denní nebo větší, zobraz datum; jinak jen čas
            const rangeActive = document.querySelector('.range-btn.active')?.dataset.range ?? '24h';
            const showDate = ['7d','30d','60d','90d','180d','365d','all'].includes(rangeActive);
            return showDate ? `${dd}.${mo}.` : `${h}:${m}`;
          },
        },
      },
      y: {
        title: { display: !!yLabel, text: yLabel, color: cc.textColor, font: { size: 11 } },
        grid:  { color: cc.gridColor },
        ticks: { color: cc.textColor },
      },
    },
  };
}

function createChart(id, datasets, yLabel) {
  const ctx = document.getElementById(id).getContext('2d');
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: commonChartOptions(yLabel),
  });
  return charts[id];
}

/** Znovu aplikuje barvy na všechny aktivní grafy po změně tématu. */
function refreshChartColors() {
  const cc = getChartColors();
  Object.values(charts).forEach(chart => {
    chart.options.scales.x.grid.color             = cc.gridColor;
    chart.options.scales.x.ticks.color            = cc.textColor;
    chart.options.scales.y.grid.color             = cc.gridColor;
    chart.options.scales.y.ticks.color            = cc.textColor;
    chart.options.plugins.legend.labels.color     = cc.textColor;
    chart.update();
  });
}

// ── Grafy ────────────────────────────────────────────────────────────────────

/** Vrátí počet sekund pro daný rozsah. */
function rangeToSeconds(range) {
  return {
    '1h'  : 3600,
    '24h' : 86400,
    '7d'  : 7   * 86400,
    '30d' : 30  * 86400,
    '60d' : 60  * 86400,
    '90d' : 90  * 86400,
    '180d': 180 * 86400,
    '365d': 365 * 86400,
    'all' : 1825 * 86400,  // ~5 let — pokryje celou historii i budoucí data
  }[range] ?? 86400;
}

/** Vrátí maximální počet záznamů pro daný rozsah.
 *  API limit je 1440 — pro delší rozsahy Worker automaticky proředí vzorkování. */
function rangeToLimit(range) {
  return {
    '1h'  : 70,    // každou minutu = max 60 bodů, trochu rezervy
    '24h' : 1440,
    '7d'  : 1008,
    '30d' : 1440,
    '60d' : 1440,
    '90d' : 1440,
    '180d': 1440,
    '365d': 1440,
    'all' : 1440,
  }[range] ?? 1440;
}

/** Pomocná funkce pro definici datasetu grafu. */
function lineDataset(rows, key, label, color, filled = false) {
  return {
    label,
    data: rows.map(r => ({ x: r.timestamp * 1000, y: r[key] })),
    borderColor: color,
    backgroundColor: color.replace(/[\d.]+\)$/, '0.12)'),
    borderWidth: 1.8,
    pointRadius: 0,
    tension: 0.3,
    fill: filled,
    spanGaps: true, // Propojí body i přes chybějící minuty
  };
}

async function loadCharts(range) {
  const now  = Math.floor(Date.now() / 1000);
  const from = now - rangeToSeconds(range);
  const lim  = rangeToLimit(range);

  try {
    const res = await fetch(`${API}/api/history?from=${from}&to=${now}&limit=${lim}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = json.data ?? [];

    if (!rows.length) {
      showError('charts-error', 'Žádná historická data pro tento rozsah.');
      return;
    }
    hideError('charts-error');

    // 1. Teplota venkovní — venkovní, pocitová, rosný bod
    createChart('chart-temp', [
      lineDataset(rows, 'temp_out',   'Venkovní (°C)',  'rgba(239,68,68,1)'),
      lineDataset(rows, 'feels_like', 'Pocitová (°C)',  'rgba(249,115,22,0.8)'),
      lineDataset(rows, 'dew_point',  'Rosný bod (°C)', 'rgba(59,130,246,0.7)'),
    ], '°C');

    // 2. Vnitřní teplota doma
    createChart('chart-temp-in', [
      lineDataset(rows, 'temp_in', 'Vnitřní teplota doma (°C)', 'rgba(245,158,11,1)', true),
    ], '°C');

    // 3. Vlhkost venkovní
    createChart('chart-hum', [
      lineDataset(rows, 'humidity_out', 'Venkovní vlhkost (%)', 'rgba(34,197,94,1)'),
    ], '%');

    // 4. Vnitřní vlhkost doma
    createChart('chart-hum-in', [
      lineDataset(rows, 'humidity_in', 'Vnitřní vlhkost doma (%)', 'rgba(13,148,136,1)', true),
    ], '%');

    // 5. Tlak
    createChart('chart-pres', [
      lineDataset(rows, 'pressure', 'Tlak (hPa)', 'rgba(59,130,246,1)'),
    ], 'hPa');

    // 6. Vítr — průměrná rychlost + nárazy
    createChart('chart-wind', [
      lineDataset(rows, 'wind_speed', 'Průměrná rychlost (m/s)', 'rgba(168,85,247,1)'),
      lineDataset(rows, 'wind_gust',  'Nárazy (m/s)',            'rgba(249,115,22,0.8)'),
    ], 'm/s');

    // 7. Srážky — plná plocha
    createChart('chart-rain', [
      {
        label: 'Intenzita srážek (mm/h)',
        data: rows.map(r => ({ x: r.timestamp * 1000, y: r.rain_rate })),
        borderColor:     'rgba(6,182,212,1)',
        backgroundColor: 'rgba(6,182,212,0.25)',
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: 0.2,
      },
    ], 'mm/h');

    chartsLoaded = true;
  } catch (e) {
    showError('charts-error', `Nepodařilo se načíst data pro grafy: ${e.message}`);
  }
}

// ── Statistiky ───────────────────────────────────────────────────────────────

/** Vytvoří HTML kartu statistik pro dané časové období. */
function buildStatCard(title, period) {
  if (!period) return '';
  return `
    <div class="stat-card">
      <h3>${title}</h3>
      <div class="stat-row">
        <span class="label">Průměrná teplota venku</span>
        <span class="value">${fmt(period.avg_temp)} °C</span>
      </div>
      <div class="stat-row">
        <span class="label">Max. teplota venku</span>
        <span class="value hot">${fmt(period.max_temp)} °C</span>
      </div>
      <div class="stat-row">
        <span class="label">Min. teplota venku</span>
        <span class="value cold">${fmt(period.min_temp)} °C</span>
      </div>
      <div class="stat-row">
        <span class="label">Průměrná vnitřní teplota</span>
        <span class="value home-temp">${fmt(period.avg_temp_in)} °C</span>
      </div>
      <div class="stat-row">
        <span class="label">Max. vnitřní teplota</span>
        <span class="value home-temp">${fmt(period.max_temp_in)} °C</span>
      </div>
      <div class="stat-row">
        <span class="label">Min. vnitřní teplota</span>
        <span class="value home-temp">${fmt(period.min_temp_in)} °C</span>
      </div>
      <div class="stat-row">
        <span class="label">Průměrná vnitřní vlhkost</span>
        <span class="value home-hum">${fmt0(period.avg_hum_in)} %</span>
      </div>
      <div class="stat-row">
        <span class="label">Max. vnitřní vlhkost</span>
        <span class="value home-hum">${fmt0(period.max_hum_in)} %</span>
      </div>
      <div class="stat-row">
        <span class="label">Min. vnitřní vlhkost</span>
        <span class="value home-hum">${fmt0(period.min_hum_in)} %</span>
      </div>
      <div class="stat-row">
        <span class="label">Průměrná vlhkost venku</span>
        <span class="value">${fmt0(period.avg_hum)} %</span>
      </div>
      <div class="stat-row">
        <span class="label">Max. náraz větru</span>
        <span class="value wind">${fmt(period.max_gust)} m/s</span>
      </div>
      <div class="stat-row">
        <span class="label">Max. srážky</span>
        <span class="value rain">${fmt(period.max_rain)} mm</span>
      </div>
      <div class="stat-row">
        <span class="label">☔ Dní s deštěm</span>
        <span class="value rain">${period.rainy_days ?? '—'}</span>
      </div>
      <div class="stat-row">
        <span class="label">☀️ Dní bez deště</span>
        <span class="value" style="color:#f59e0b">${period.dry_days ?? '—'}</span>
      </div>
      <div class="stat-row">
        <span class="label">Počet záznamů</span>
        <span class="value">${period.records}</span>
      </div>
    </div>`;
}

async function loadStats() {
  const grid = document.getElementById('stats-grid');
  try {
    const res = await fetch(`${API}/api/stats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();

    grid.innerHTML =
      buildStatCard('⏱️ Poslední hodina',    s.last_1h)
    + buildStatCard('📅 Posledních 24 hodin', s.last_24h)
    + buildStatCard('📅 Posledních 7 dní',    s.last_7d)
    + buildStatCard('📅 Posledních 30 dní',   s.last_30d)
    + buildStatCard('📅 Posledních 60 dní',   s.last_60d)
    + buildStatCard('📅 Posledních 90 dní',   s.last_90d)
    + buildStatCard('📅 Posledních 180 dní',  s.last_180d)
    + buildStatCard('📅 Posledních 365 dní',  s.last_365d)
    + buildStatCard('📚 Celá historia',        s.all);

    hideError('stats-error');
    statsLoaded = true;
  } catch (e) {
    grid.innerHTML = '';
    showError('stats-error', `Nepodařilo se načíst statistiky: ${e.message}`);
  }
}

// ── Rekordy ──────────────────────────────────────────────────────────────────

async function loadRecords() {
  const grid = document.getElementById('records-grid');
  try {
    const res = await fetch(`${API}/api/records`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();

    grid.innerHTML = `
      <div class="record-card">
        <div class="record-icon">🌡️</div>
        <div class="record-label">Nejvyšší teplota venku</div>
        <div class="record-value hot">${fmt(r.temp_max)} °C</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🥶</div>
        <div class="record-label">Nejnižší teplota venku</div>
        <div class="record-value cold">${fmt(r.temp_min)} °C</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🔥</div>
        <div class="record-label">Max. pocitová teplota</div>
        <div class="record-value hot">${fmt(r.feels_like_max)} °C</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🧊</div>
        <div class="record-label">Min. pocitová teplota</div>
        <div class="record-value cold">${fmt(r.feels_like_min)} °C</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🌫️</div>
        <div class="record-label">Max. rosný bod</div>
        <div class="record-value" style="color:#0284c7">${fmt(r.dew_point_max)} °C</div>
      </div>
      <div class="record-card">
        <div class="record-icon">❄️</div>
        <div class="record-label">Min. rosný bod</div>
        <div class="record-value" style="color:#38bdf8">${fmt(r.dew_point_min)} °C</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🏠🌡️</div>
        <div class="record-label">Max. teplota doma</div>
        <div class="record-value" style="color:var(--warn)">${fmt(r.temp_in_max)} °C</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🏠❄️</div>
        <div class="record-label">Min. teplota doma</div>
        <div class="record-value" style="color:#0ea5e9">${fmt(r.temp_in_min)} °C</div>
      </div>
      <div class="record-card">
        <div class="record-icon">💧</div>
        <div class="record-label">Nejvyšší vlhkost venku</div>
        <div class="record-value" style="color:var(--chart-hum)">${fmt0(r.humidity_max)} %</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🌵</div>
        <div class="record-label">Nejnižší vlhkost venku</div>
        <div class="record-value" style="color:var(--chart-hum)">${fmt0(r.humidity_min)} %</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🏠💧</div>
        <div class="record-label">Max. vlhkost doma</div>
        <div class="record-value home-hum">${fmt0(r.humidity_in_max)} %</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🏜️</div>
        <div class="record-label">Min. vlhkost doma</div>
        <div class="record-value home-hum">${fmt0(r.humidity_in_min)} %</div>
      </div>
      <div class="record-card">
        <div class="record-icon">💨</div>
        <div class="record-label">Nejsilnější náraz větru</div>
        <div class="record-value wind">${fmt(r.wind_gust_max)} m/s</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🌪️</div>
        <div class="record-label">Max. rychlost větru</div>
        <div class="record-value wind">${fmt(r.wind_speed_max)} m/s</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🌧️</div>
        <div class="record-label">Max. intenzita srážek</div>
        <div class="record-value rain">${fmt(r.rain_rate_max)} mm/h</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🌊</div>
        <div class="record-label">Max. celkové srážky</div>
        <div class="record-value rain">${fmt(r.rain_total_max)} mm</div>
      </div>
      <div class="record-card">
        <div class="record-icon">☀️</div>
        <div class="record-label">Nejdelší série sucha</div>
        <div class="record-value" style="color:#f59e0b">${r.max_dry_streak ?? '—'} dní</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🌵</div>
        <div class="record-label">Aktuální série sucha</div>
        <div class="record-value" style="color:#d97706">${r.dry_streak ?? '—'} dní</div>
      </div>
      <div class="record-card" style="grid-column: 1 / -1; text-align:center; background:var(--surface2);">
        <div class="record-icon">📚</div>
        <div class="record-label">Celkový počet záznamů</div>
        <div class="record-value" style="font-size:1.6rem; color:var(--accent)">
          ${r.total_records?.toLocaleString('cs-CZ') ?? '—'}
        </div>
        <div class="record-count">
          Data od ${r.oldest_record ? r.oldest_record.slice(0, 10) : '?'}
          do ${r.newest_record ? r.newest_record.slice(0, 10) : '?'} (UTC)
        </div>
      </div>`;

    hideError('records-error');
    recordsLoaded = true;
  } catch (e) {
    grid.innerHTML = '';
    showError('records-error', `Nepodařilo se načíst rekordy: ${e.message}`);
  }
}

// ── Tmavý / světlý režim ─────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('theme', theme);
  refreshChartColors();
}

function initTheme() {
  const saved       = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved ?? (prefersDark ? 'dark' : 'light'));
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ── Záložky (tabs) ───────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${tab}`).classList.add('active');

    // Lazy load — načte data až při prvním zobrazení záložky
    if (tab === 'charts'     && !chartsLoaded)  loadCharts(currentRange);
    if (tab === 'statistics' && !statsLoaded)   loadStats();
    if (tab === 'records'    && !recordsLoaded) loadRecords();
  });
});

// ── Přepínání rozsahu grafů ──────────────────────────────────────────────────

document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    chartsLoaded = false;
    loadCharts(currentRange);
  });
});

// ── Automatická obnova ───────────────────────────────────────────────────────

function startAutoRefresh() {
  setInterval(() => {
    // Vždy obnovuj aktuální data
    loadCurrent();

    // Obnov grafy, pokud je záložka aktivní
    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (activeTab === 'charts') {
      chartsLoaded = false;
      loadCharts(currentRange);
    }
  }, REFRESH_MS);
}

// ── Inicializace aplikace ────────────────────────────────────────────────────

initTheme();
loadCurrent();
startAutoRefresh();
