#!/usr/bin/env node
/**
 * import_weathercloud.js
 * ─────────────────────
 * Importuje historická CSV data z Weathercloudu do Cloudflare D1 databáze.
 *
 * Použití:
 *   node scripts/import_weathercloud.js
 *
 * Předpoklady:
 *   - npx wrangler musí být dostupný (npm install -g wrangler nebo local devDep)
 *   - Musíte být přihlášeni: npx wrangler login
 *   - Proměnné DB_NAME a ACCOUNT_ID musí odpovídat vašemu Cloudflare účtu
 *     (nebo je nastavte jako env proměnné: WC_DB_NAME, WC_ACCOUNT_ID)
 *
 * Formát vstupního CSV:
 *   - Kódování: UTF-16LE s BOM
 *   - Oddělovač: středník (;)
 *   - Datum: DD/MM/YYYY HH:MM:SS (časová zóna Europe/Prague = UTC+1/+2)
 *   - Tlak: anglický formát s čárkou jako oddělovačem tisíců (1,012.7 → 1012.7)
 *   - Prázdné hodnoty: prázdný string mezi středníky
 *
 * Sloupce (pořadí záhlaví):
 *   0:  Date (Europe/Prague)
 *   1:  Inside temperature (°C)       → temp_in
 *   2:  Temperature (°C)              → temp_out
 *   3:  Wind chill (°C)               → wind_chill (součást feels_like)
 *   4:  Inside dew point (°C)         → ignorováno
 *   5:  Dew point (°C)               → dew_point
 *   6:  Inside heat index (°C)        → ignorováno
 *   7:  Heat index (°C)              → heat_index (součást feels_like)
 *   8:  Inside humidity (%)           → humidity_in
 *   9:  Humidity (%)                 → humidity_out
 *   10: Wind gust (m/s)              → wind_gust
 *   11: Average wind speed (m/s)     → wind_speed
 *   12: Average wind direction (°)   → wind_dir
 *   13: Atmospheric pressure (hPa)   → pressure
 *   14: Rain (mm)                    → rain_total
 *   15: Rain rate (mm/h)             → rain_rate
 *   16: Solar radiation (W/m²)       → ignorováno (stanice nemá senzor)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os   = require('os');

// ─── Konfigurace ──────────────────────────────────────────────────────────────

// Název D1 databáze (jak ji máte pojmenovanou v Cloudflare dashboardu / wrangler.toml)
const DB_NAME    = process.env.WC_DB_NAME    || 'stanice-db';
// Account ID – najdete na hlavní stránce Cloudflare dashboardu (pravý sloupec)
const ACCOUNT_ID = process.env.WC_ACCOUNT_ID || '';
// Složka s CSV soubory (relativně ke kořenu projektu)
const CSV_DIR    = path.resolve(__dirname, '..', 'Tabulky');
// Velikost dávky pro jeden wrangler d1 execute (max ~1000 řádků kvůli CLI limitu)
const BATCH_SIZE = 500;

// ─── Pomocné funkce ───────────────────────────────────────────────────────────

/**
 * Převede řetězec DD/MM/YYYY HH:MM:SS (Europe/Prague) na Unix timestamp UTC.
 * Explicitně zpracuje letní čas: CET (UTC+1) / CEST (UTC+2).
 * Hranice letního času 2026: 29.3. 02:00 → 31.10. 03:00
 */
function pragueToUnix(dateStr) {
  const m = dateStr.match(
    /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/
  );
  if (!m) return null;
  const [, dd, mm, yyyy, HH, MM, SS] = m;
  const day   = parseInt(dd, 10);
  const month = parseInt(mm, 10);  // 1-based
  const year  = parseInt(yyyy, 10);
  const hour  = parseInt(HH, 10);
  const min   = parseInt(MM, 10);
  const sec   = parseInt(SS, 10);

  // Je to CEST (UTC+2)? Platí přibližně 29.3.–31.10.
  // Pro přesnost použijeme heuristiku: duben–říjen = CEST.
  // (Okrajové dny v březnu/říjnu jsou velmi řídká data a mírná chyba 1h nevadí.)
  let offsetHours = 1; // CET (zima)
  if (month > 3 && month < 10) {
    offsetHours = 2; // CEST (léto)
  } else if (month === 3 && day >= 29 && hour >= 2) {
    offsetHours = 2; // CEST od poslední neděle v březnu 02:00
  } else if (month === 10 && (day < 25 || (day === 25 && hour < 3))) {
    offsetHours = 2; // CEST do poslední neděle v říjnu 03:00
  }

  // Sestavíme ISO string jako UTC převodem
  const utcMs = Date.UTC(year, month - 1, day, hour - offsetHours, min, sec);
  return Math.floor(utcMs / 1000);
}

/**
 * Odstraní anglické oddělovače tisíců z čísla (1,012.7 → 1012.7)
 * a převede na float. Vrátí null pro prázdný string.
 */
function parseNum(str) {
  if (!str || str.trim() === '') return null;
  const cleaned = str.trim().replace(/,/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Celé číslo nebo null.
 */
function parseInt2(str) {
  if (!str || str.trim() === '') return null;
  const n = parseInt(str.trim(), 10);
  return isNaN(n) ? null : n;
}

/**
 * Pocitová teplota: wind_chill má přednost (chladné počasí), jinak heat_index.
 * Pokud ani jedno není k dispozici, vrátí temp_out.
 */
function feelsLike(windChill, heatIndex, tempOut) {
  if (windChill !== null) return windChill;
  if (heatIndex  !== null) return heatIndex;
  return tempOut;
}

/**
 * Escapuje hodnotu pro SQL — vrátí NULL nebo quoted string / číslo.
 */
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ─── Parsování CSV ────────────────────────────────────────────────────────────

/**
 * Načte jeden CSV soubor (UTF-16LE) a vrátí pole SQL value-tuples.
 */
function parseCSV(filePath) {
  // Přečteme buffer a dekódujeme UTF-16LE (odstraníme BOM pokud existuje)
  const buf = fs.readFileSync(filePath);
  let text = buf.toString('utf16le');
  // Odstraníme BOM (U+FEFF) pokud je na začátku
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const lines = text.split(/\r?\n/);
  const tuples = [];

  // Přeskočíme záhlaví (první řádek)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(';');
    // Minimálně 16 sloupců nutných (0–15), poslední solar radiation = index 16
    if (cols.length < 14) continue;

    const timestamp = pragueToUnix(cols[0]);
    if (timestamp === null) continue;

    const temp_in    = parseNum(cols[1]);
    const temp_out   = parseNum(cols[2]);
    const wind_chill = parseNum(cols[3]);
    // cols[4] = inside dew point → ignorujeme
    const dew_point  = parseNum(cols[5]);
    // cols[6] = inside heat index → ignorujeme
    const heat_index = parseNum(cols[7]);
    const humidity_in  = parseInt2(cols[8]);
    const humidity_out = parseInt2(cols[9]);
    const wind_gust    = parseNum(cols[10]);
    const wind_speed   = parseNum(cols[11]);
    const wind_dir     = parseInt2(cols[12]);
    const pressure     = parseNum(cols[13]);
    const rain_total   = parseNum(cols[14]);
    const rain_rate    = parseNum(cols[15]);
    // cols[16] = solar radiation → ignorujeme (stanice nemá senzor)

    // Přeskočíme řádky, kde jsou všechny měřené hodnoty null (stanice offline)
    const hasData = [temp_out, temp_in, humidity_out, pressure, wind_speed]
      .some(v => v !== null);
    if (!hasData) continue;

    const feels = feelsLike(wind_chill, heat_index, temp_out);

    tuples.push(
      `(${[
        timestamp,
        sqlVal(temp_out),
        sqlVal(temp_in),
        sqlVal(feels),
        sqlVal(dew_point),
        sqlVal(humidity_out),
        sqlVal(humidity_in),
        sqlVal(pressure),
        sqlVal(wind_speed),
        sqlVal(wind_gust),
        sqlVal(wind_dir),
        sqlVal(rain_rate),
        sqlVal(rain_total),
        "'weathercloud'",
      ].join(',')})`
    );
  }

  return tuples;
}

// ─── Hlavní logika ────────────────────────────────────────────────────────────

/**
 * Spustí wrangler d1 execute s SQL obsahem uloženým v dočasném souboru.
 * Používá soubor místo --command, aby se vyhnul limitům délky argumentu shellu.
 * Poznámka: --account-id není v novějších verzích Wrangleru podporován,
 * účet se bere automaticky z OAuth přihlášení (wrangler login).
 */
function wranglerExecute(sql, label) {
  const tmpFile = path.join(os.tmpdir(), `wc_import_${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf8');
  const cmd = `npx wrangler d1 execute ${DB_NAME} --remote --file "${tmpFile}"`;
  try {
    console.log(`  ↳ Spouštím wrangler pro ${label}…`);
    execSync(cmd, { stdio: 'inherit' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Weathercloud CSV → Cloudflare D1 Import');
  console.log('═══════════════════════════════════════════════════════');

  // 1. Načteme seznam CSV souborů
  const files = fs.readdirSync(CSV_DIR)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .sort()
    .map(f => path.join(CSV_DIR, f));

  if (files.length === 0) {
    console.error(`Žádné CSV soubory nenalezeny v: ${CSV_DIR}`);
    process.exit(1);
  }
  console.log(`\nNalezeno ${files.length} CSV soubor(ů):`);
  files.forEach(f => console.log('  •', path.basename(f)));

  // 2. Parsujeme všechny soubory
  let allTuples = [];
  for (const file of files) {
    console.log(`\nParsování: ${path.basename(file)}`);
    const tuples = parseCSV(file);
    console.log(`  → ${tuples.length} platných záznamů`);
    allTuples = allTuples.concat(tuples);
  }

  console.log(`\nCelkem záznamů k importu: ${allTuples.length}`);
  if (allTuples.length === 0) {
    console.log('Nic k importu. Konec.');
    return;
  }

  // 3. Odesíláme do D1 v dávkách
  const INSERT_PREFIX = `INSERT OR IGNORE INTO measurements
  (timestamp,temp_out,temp_in,feels_like,dew_point,
   humidity_out,humidity_in,pressure,wind_speed,wind_gust,
   wind_dir,rain_rate,rain_total,source)
VALUES\n`;

  const totalBatches = Math.ceil(allTuples.length / BATCH_SIZE);
  console.log(`\nOdesílám do D1 (${totalBatches} dávek po max. ${BATCH_SIZE} řádcích)…\n`);

  for (let i = 0; i < totalBatches; i++) {
    const batch = allTuples.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const sql   = INSERT_PREFIX + batch.join(',\n') + ';';
    const label = `dávka ${i + 1}/${totalBatches} (${batch.length} řádků)`;
    wranglerExecute(sql, label);
  }

  console.log('\n✅ Import dokončen!');
  console.log('   Pro ověření spusťte:');
  console.log(`   npx wrangler d1 execute ${DB_NAME} --remote --command "SELECT COUNT(*) FROM measurements;"`);
}

main().catch(err => {
  console.error('\n❌ Chyba:', err.message);
  process.exit(1);
});
