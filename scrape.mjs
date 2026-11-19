// Node 20+. Sin dependencias. Uso: node scrape.mjs
// Amable con Fightcade y a prueba de errores:
//  - pausas con variación aleatoria, y más largas si el servidor se queja
//  - respeta Retry-After en 429; se detiene ante 403 o muchos fallos seguidos
//  - timeout por solicitud; reintentos con espera creciente
//  - nunca pisa un archivo bueno con uno vacío, roto o mucho más pequeño
//  - si un juego se corta a mitad, guarda lo bajado solo si no empeora al anterior
//  - un juego que falla no tumba a los demás
//
// Formato de cada fila en data/<juego>.json:
//   [nombre, posición, rango(0-6), partidas, horas, país]
// y en el JSON, "ranges" con el rango de posiciones de cada letra (E..S).
import fs from 'node:fs';

const ENDPOINT = process.env.FC_ENDPOINT || 'https://web.fightcade.com/api/';
const LIMIT = 100;
const BASE_GAP = Number(process.env.FC_GAP_MS || 8000);   // pausa normal entre solicitudes (ms)
const REQ_TIMEOUT = Number(process.env.FC_TIMEOUT_MS || 45000);   // las páginas profundas tardan más en el servidor
const RETRY_BASE = Number(process.env.FC_RETRY_MS || 6000);
const MAX_RETRIES = 2;               // 3 intentos por página
const MAX_GAME_MS = Number(process.env.FC_GAME_MS || 40 * 60 * 1000);   // tope por juego
const MAX_RUN_MS = 300 * 60 * 1000;  // tope total de la ejecución (los juegos del final se omiten si se acaba)

// 0 = sin rango. 5 = A y 6 = S confirmados en la web; E, D, C, B por deducción.
const RANK_LETTER = ['-', 'E', 'D', 'C', 'B', 'A', 'S'];

const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.6));
const num = (v) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? n : null; };
const log = (m) => console.log(m);

let games;
try { games = JSON.parse(fs.readFileSync('games.json', 'utf8')); } catch (e) { console.error('games.json inválido:', e.message); process.exit(1); }
if (!Array.isArray(games) || !games.length) { console.error('games.json vacío'); process.exit(1); }
fs.mkdirSync('data', { recursive: true });

class Blocked extends Error {}

const extractRows = (j, d = 0) => {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object' || d > 3) return null;
  for (const k of ['results', 'rankings', 'ranking', 'users', 'players', 'data', 'items', 'rows']) {
    if (j[k] !== undefined) { const a = extractRows(j[k], d + 1); if (a) return a; }
  }
  return null;
};
// Respuesta real: { res:'OK', results:{ results:[...], count:N } }  (count no es un total fiable; no se usa)
const extractTotal = (j) => {
  const c = j && j.results && typeof j.results === 'object' ? num(j.results.count) : null;
  return c && c > 0 ? c : null;
};

let gap = BASE_GAP;                                   // se adapta: sube al haber quejas, baja despacio
const slower = () => { gap = Math.min(gap * 2, 60000); };
const faster = () => { gap = Math.max(BASE_GAP, Math.round(gap * 0.85)); };

async function fetchPage(gameid, page) {
  const body = { req: 'searchrankings', gameid, limit: LIMIT, offset: page * LIMIT, byElo: true, recent: true };
  let lastErr;
  for (let t = 0; t <= MAX_RETRIES; t++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'fc-ranking-mirror/1.0 (1 snapshot al dia)' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQ_TIMEOUT)
      });
      if (res.status === 403) throw new Blocked('403: acceso denegado (posible bloqueo de la IP)');
      if (res.status === 429 || res.status >= 500) {
        slower();
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 120000) : (t + 1) * 20000;
        log(`  ${gameid} pág ${page + 1}: HTTP ${res.status}, espero ${Math.round(wait / 1000)} s`);
        lastErr = new Error('HTTP ' + res.status);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (/^\s*</.test(text)) { slower(); throw new Error('respuesta HTML (¿Cloudflare?)'); }
      const json = JSON.parse(text);
      const rows = extractRows(json);
      if (!rows) throw new Error('respuesta sin lista de jugadores');
      faster();
      return { rows, total: extractTotal(json) };
    } catch (e) {
      if (e instanceof Blocked) throw e;
      lastErr = e;
      if (/timeout|aborted/i.test(e.message)) slower();       // el servidor va lento: no insistir más rápido
      log(`  ${gameid} pág ${page + 1}: intento ${t + 1} falló (${e.message})`);
      if (t < MAX_RETRIES) await sleep(jitter((t + 1) * RETRY_BASE));
    }
  }
  throw lastErr || new Error('falló');
}

const readOld = (id) => { try { return JSON.parse(fs.readFileSync(`data/${id}.json`, 'utf8')); } catch { return null; } };
const writeAtomic = (file, text) => { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); };

let index = { games: {} };
try { index = JSON.parse(fs.readFileSync('data/index.json', 'utf8')); if (!index.games) index.games = {}; } catch { index = { games: {} }; }

let okGames = 0, blocked = false;
for (const g of games) {
  if (blocked) break;
  if (Date.now() - t0 > MAX_RUN_MS) { log('Tope de tiempo alcanzado: se omiten los juegos restantes'); break; }
  const id = String(g.id || '').trim();
  if (!/^[A-Za-z0-9_.\-]{1,48}$/.test(id)) { log(`ID inválido: ${g.id}`); continue; }
  const pages = Math.max(1, Math.min(Number(g.pages) || 1, 100));
  const out = [];
  const seen = new Set();            // la paginación a veces repite al jugador del borde entre páginas
  let lastFirst = null, note = '', total = null;
  const tGame = Date.now();
  log(`== ${id} (hasta ${pages} páginas)`);

  for (let p = 0; p < pages; p++) {
    if (Date.now() - t0 > MAX_RUN_MS) { note = 'tope de tiempo'; break; }
    if (Date.now() - tGame > MAX_GAME_MS) { note = 'tope de tiempo del juego'; break; }
    let rows;
    try { ({ rows, total } = await fetchPage(id, p)); }
    catch (e) {
      if (e instanceof Blocked) { blocked = true; note = e.message; break; }
      note = `se detuvo en la pág ${p + 1} (${e.message}); se guarda lo bajado hasta ahí`;   // sin saltar páginas: no se dejan huecos
      break;
    }
    if (!rows.length) break;
    if (p === 0) log('  muestra: ' + JSON.stringify(rows[0]));
    const first = String(rows[0].name ?? rows[0].username ?? '');
    if (first && first === lastFirst) { note = 'la API repite la página: no hay más'; break; }
    lastFirst = first;
    for (const r of rows) {
      const name = String(r.name ?? r.username ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      // Los datos del juego vienen anidados: gameinfo.<juego>.{rank, num_matches, time_played(segundos)}
      const gi = (r.gameinfo && (r.gameinfo[id] ?? Object.values(r.gameinfo)[0])) || {};
      const secs = num(gi.time_played);
      out.push([
        name,
        out.length + 1,                                          // posición real, sin huecos ni duplicados
        num(gi.rank),                                            // 0-6 (ver RANK_LETTER)
        num(gi.num_matches),
        secs == null ? null : Math.round(secs / 36) / 100,       // horas con 2 decimales
        r.country?.iso_code ?? r.cc ?? r.country_code ?? null
      ]);
    }
    log(`  ${id} pág ${p + 1} OK (${out.length} jugadores)`);
    if (rows.length < LIMIT) break;
    await sleep(jitter(gap));
  }

  // Rango de posiciones de cada letra
  const ranges = {};
  for (const [, pos, rank] of out) {
    if (rank == null) continue;
    const r = (ranges[rank] ??= { letter: RANK_LETTER[rank] ?? String(rank), n: 0, minPos: pos, maxPos: pos });
    r.n++; r.minPos = Math.min(r.minPos, pos); r.maxPos = Math.max(r.maxPos, pos);
  }

  const old = readOld(id);
  const oldCount = old && Array.isArray(old.rows) ? old.rows.length : 0;
  if (!out.length) { log(`[${id}] sin datos nuevos${note ? ' - ' + note : ''}; se conserva el anterior (${oldCount})`); continue; }
  // Si la descarga se cortó y quedó más corta que la anterior, se conserva la anterior.
  // Si llegó hasta el final (sin nota), se guarda el nuevo aunque tenga menos jugadores.
  if (note && oldCount && out.length < oldCount) {
    log(`[${id}] ejecución incompleta (${note}): ${out.length} frente a ${oldCount}; se conserva el anterior`); continue;
  }
  writeAtomic(`data/${id}.json`, JSON.stringify({ v: 2, game: id, at: Date.now(), count: out.length, complete: !note, ranges, rows: out }));
  index.games[id] = { at: Date.now(), count: out.length };
  okGames++;
  log(`[${id}] guardado: ${out.length} jugadores${note ? ' (parcial: ' + note + ')' : ''}`);
  log(`[${id}] rangos: ` + (Object.values(ranges).map((r) => `${r.letter}: pos ${r.minPos}-${r.maxPos} (${r.n})`).join(' | ') || 'ninguno'));
  await sleep(jitter(gap));
}

index.updated = Date.now();
writeAtomic('data/index.json', JSON.stringify(index));
log(`Listo: ${okGames}/${games.length} juegos actualizados en ${Math.round((Date.now() - t0) / 1000)} s`);
// Siempre sale en 0: un día malo no debe marcar error ni borrar nada; los datos viejos se mantienen.
