/**
 * Stanice — Meteorologický dashboard
 * app.js — veškerá logika aplikace
 *
 * Komunikuje s Cloudflare Worker REST API:
 *   GET /api/current   — poslední naměřený záznam
 *   GET /api/history   — záznamy v časovém rozsahu (pro grafy)
 *   GET /api/stats     — statistiky za 24h / 7d / 30d
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
          displayFormats: { hour: 'HH:mm', day: 'dd.MM.' },
        },
        grid:  { color: cc.gridColor },
        ticks: { color: cc.textColor, maxRotation: 0, maxTicksLimit: 8 },
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
  return { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 }[range] ?? 86400;
}

/** Vrátí maximální počet záznamů pro daný rozsah. */
function rangeToLimit(range) {
  // 24h po minutě = 1440, 7d po ~10min = 1008, 30d = 1440
  return { '24h': 1440, '7d': 1008, '30d': 1440 }[range] ?? 1440;
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

    // Teplota — 3 křivky: venkovní, pocitová, rosný bod
    createChart('chart-temp', [
      lineDataset(rows, 'temp_out',   'Venkovní (°C)',  'rgba(239,68,68,1)'),
      lineDataset(rows, 'feels_like', 'Pocitová (°C)',  'rgba(249,115,22,0.8)'),
      lineDataset(rows, 'dew_point',  'Rosný bod (°C)', 'rgba(59,130,246,0.7)'),
    ], '°C');

    // Vlhkost
    createChart('chart-hum', [
      lineDataset(rows, 'humidity_out', 'Venkovní vlhkost (%)', 'rgba(34,197,94,1)'),
    ], '%');

    // Tlak
    createChart('chart-pres', [
      lineDataset(rows, 'pressure', 'Tlak (hPa)', 'rgba(59,130,246,1)'),
    ], 'hPa');

    // Vítr — průměrná rychlost + nárazy
    createChart('chart-wind', [
      lineDataset(rows, 'wind_speed', 'Průměrná rychlost (m/s)', 'rgba(168,85,247,1)'),
      lineDataset(rows, 'wind_gust',  'Nárazy (m/s)',            'rgba(249,115,22,0.8)'),
    ], 'm/s');

    // Srážky — plná plocha
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
        <span class="label">Průměrná teplota</span>
        <span class="value">${fmt(period.avg_temp)} °C</span>
      </div>
      <div class="stat-row">
        <span class="label">Max. teplota</span>
        <span class="value hot">${fmt(period.max_temp)} °C</span>
      </div>
      <div class="stat-row">
        <span class="label">Min. teplota</span>
        <span class="value cold">${fmt(period.min_temp)} °C</span>
      </div>
      <div class="stat-row">
        <span class="label">Průměrná vlhkost</span>
        <span class="value">${fmt0(period.avg_hum)} %</span>
      </div>
      <div class="stat-row">
        <span class="label">Max. náraz větru</span>
        <span class="value wind">${fmt(period.max_gust)} m/s</span>
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

    grid.innerHTML = buildStatCard('📅 Posledních 24 hodin', s.last_24h)
                   + buildStatCard('📅 Posledních 7 dní',    s.last_7d)
                   + buildStatCard('📅 Posledních 30 dní',   s.last_30d);

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
        <div class="record-label">Nejvyšší teplota</div>
        <div class="record-value hot">${fmt(r.temp_max)} °C</div>
      </div>
      <div class="record-card">
        <div class="record-icon">🥶</div>
        <div class="record-label">Nejnižší teplota</div>
        <div class="record-value cold">${fmt(r.temp_min)} °C</div>
      </div>
      <div class="record-card">
        <div class="record-icon">💨</div>
        <div class="record-label">Nejsilnější náraz větru</div>
        <div class="record-value wind">${fmt(r.wind_gust_max)} m/s</div>
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
        <div class="record-icon">⬆️</div>
        <div class="record-label">Nejvyšší tlak</div>
        <div class="record-value pres">${fmt(r.pressure_max)} hPa</div>
      </div>
      <div class="record-card">
        <div class="record-icon">⬇️</div>
        <div class="record-label">Nejnižší tlak</div>
        <div class="record-value pres">${fmt(r.pressure_min)} hPa</div>
      </div>
      <div class="record-card">
        <div class="record-icon">💧</div>
        <div class="record-label">Nejvyšší vlhkost</div>
        <div class="record-value" style="color:var(--chart-hum)">${fmt0(r.humidity_max)} %</div>
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
