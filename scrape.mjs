// Node 20+. Sin dependencias. Uso: node scrape.mjs
import fs from 'node:fs';

const ENDPOINT = 'https://web.fightcade.com/api/';
const LIMIT = 100;
const MIN_GAP_MS = 2500;      // pausa mínima entre páginas
const MAX_GAP_MS = 5500;      // pausa máxima entre páginas
const GAME_GAP_MS = 8000;     // pausa extra al terminar un juego
const MAX_RETRIES = 3;
const TTL_HOURS = 18;         // no re-scrapear juegos actualizados hace menos de X horas

const games = JSON.parse(fs.readFileSync('games.json', 'utf8'));
fs.mkdirSync('data', { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomGap = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
  'Origin': 'https://www.fightcade.com',
  'Referer': 'https://www.fightcade.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

const extractRows = (j) => {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return null;
  for (const k of ['results', 'rankings', 'ranking', 'users', 'players', 'data', 'items', 'rows']) {
    if (j[k] !== undefined) { const a = extractRows(j[k]); if (a) return a; }
  }
  return null;
};

async function fetchPage(gameid, page) {
  const body = { req: 'searchrankings', gameid, limit: LIMIT, offset: page * LIMIT, byElo: true, recent: true };
  for (let t = 0; t <= MAX_RETRIES; t++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body)
      });
      if (res.status === 429 || res.status >= 500) {
        const wait = (t + 1) * 20000 + randomGap(1000, 5000);
        console.warn(`[${gameid}] HTTP ${res.status}, esperando ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
        continue;
      }
      if (res.status === 403) throw new Error('403: IP bloqueada (Cloudflare)');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = extractRows(await res.json());
      if (!rows) throw new Error('respuesta sin lista de jugadores');
      return rows;
    } catch (e) {
      if (/^403/.test(e.message) || t === MAX_RETRIES) throw e;
      await sleep((t + 1) * 7000 + randomGap(500, 2500));
    }
  }
}

const index = { updated: Date.now(), games: {} };
try { Object.assign(index.games, JSON.parse(fs.readFileSync('data/index.json', 'utf8')).games || {}); } catch {}

let failed = 0;
const now = Date.now();

for (const g of games) {
  // Saltar si ya se actualizó recientemente (útil si reintentas tras un fallo)
  const prev = index.games[g.id];
  if (prev && (now - prev.at) < TTL_HOURS * 3600 * 1000 && fs.existsSync(`data/${g.id}.json`)) {
    console.log(`[${g.id}] omitido (actualizado hace ${((now - prev.at) / 3600000).toFixed(1)}h)`);
    continue;
  }

  const out = [];
  let lastFirst = null, error = null;
  try {
    for (let p = 0; p < g.pages; p++) {
      const rows = await fetchPage(g.id, p);
      if (!rows.length) break;
      const first = String(rows[0].name ?? rows[0].username ?? '');
      if (first && first === lastFirst) break;
      lastFirst = first;
      rows.forEach((r, i) => out.push([
        String(r.name ?? r.username ?? '').trim(),
        p * LIMIT + i + 1,
        num(r.rank), num(r.matches), num(r.hours),
        r.cc ?? r.country_code ?? (r.country && (r.country.iso_code || r.country.cc)) ?? null,
        num(r.elo)
      ]));
      if (rows.length < LIMIT) break;
      await sleep(randomGap(MIN_GAP_MS, MAX_GAP_MS));
    }
  } catch (e) { error = e.message; }

  if (error || !out.length) {
    console.error(`[${g.id}] falló: ${error || 'sin datos'} (se conserva el anterior)`);
    failed++;
    if (error && /^403/.test(error)) break;
    continue;
  }

  fs.writeFileSync(`data/${g.id}.json`, JSON.stringify({ v: 1, game: g.id, at: Date.now(), count: out.length, rows: out }));
  index.games[g.id] = { at: Date.now(), count: out.length };
  // Guardar index.json progresivamente por si se corta a mitad de ejecución
  fs.writeFileSync('data/index.json', JSON.stringify(index));
  console.log(`[${g.id}] ${out.length} jugadores`);
  
  await sleep(GAME_GAP_MS + randomGap(1000, 4000));
}

index.updated = Date.now();
fs.writeFileSync('data/index.json', JSON.stringify(index));
if (failed === games.length) process.exit(1);
