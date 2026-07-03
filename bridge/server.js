'use strict';
/*
 * Nuvio Bridge - runs on your LAN server (e.g. NAS/Unraid), listens on :7070.
 * - Ściąga providery Nuvio z repozytorium (manifest.json) i uruchamia getStreams() w Node.
 * - Wystawia proste REST API dla starego telewizora Samsung (Tizen 2.3, UE55J6350).
 * - Proxuje TMDB (katalogi/szczegóły) oraz strumienie (dokłada nagłówki, których AVPlay nie ustawi).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---------- Konfiguracja ----------
const PORT = process.env.PORT || 7070;
const TMDB_KEY = process.env.TMDB_KEY || 'YOUR_TMDB_API_KEY';
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const REPOS = (process.env.NUVIO_REPOS ||
  'https://raw.githubusercontent.com/yoruix/nuvio-providers/main/manifest.json'
).split(',').map(s => s.trim()).filter(Boolean);
const PROVIDER_DIR = path.join(__dirname, 'providers');
const STREAM_TIMEOUT = 25000;
const LANG = process.env.TMDB_LANG || 'pl-PL';

if (!fs.existsSync(PROVIDER_DIR)) fs.mkdirSync(PROVIDER_DIR, { recursive: true });

// ---------- narzędzia HTTP ----------
function httpGet(u, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const lib = u.startsWith('https') ? https : http;
    const req = lib.get(u, { headers: opts.headers || {} }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, u).toString();
        res.resume();
        return resolve(httpGet(next, opts));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 20000, () => { req.destroy(new Error('timeout')); });
  });
}
async function getJSON(u, headers) {
  const r = await httpGet(u, { headers });
  return JSON.parse(r.body.toString('utf8'));
}
function withTimeout(p, ms, tag) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + (tag || ''))), ms))
  ]);
}

// ---------- Konto Nuvio (Supabase api.nuvio.tv) — cała robota po stronie bridge ----------
const SUPA = process.env.NUVIO_API || 'https://api.nuvio.tv';
const ANON_KEY = process.env.NUVIO_ANON_KEY || 'YOUR_NUVIO_SUPABASE_ANON_KEY';
const SESSION_FILE = path.join(__dirname, 'session.json');

let ACC = { access: null, refresh: null, profileId: null, user: null };
try { if (fs.existsSync(SESSION_FILE)) ACC = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch (e) {}
function saveSession() { try { fs.writeFileSync(SESSION_FILE, JSON.stringify(ACC)); } catch (e) {} }

// helper: request JSON z ciałem (POST/GET) do Supabase
function supaReq(method, urlPath, bodyObj, bearer) {
  return new Promise((resolve, reject) => {
    const data = bodyObj != null ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const url = new URL(urlPath.indexOf('http') === 0 ? urlPath : SUPA + urlPath);
    const opts = {
      method, hostname: url.hostname, path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'apikey': ANON_KEY,
        'Authorization': 'Bearer ' + (bearer || ANON_KEY)
      }
    };
    if (data) opts.headers['Content-Length'] = data.length;
    const r = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function jwtExpired(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return (Number(p.exp) || 0) <= Math.floor(Date.now() / 1000) + 30;
  } catch (e) { return true; }
}

// anon token do procesu logowania
async function anonAuth() {
  let r = await supaReq('POST', '/auth/v1/signup', { data: { tv_client: 'tizen' } });
  if (r.status >= 300 || !r.json || !r.json.access_token) {
    r = await supaReq('POST', '/auth/v1/token?grant_type=anonymous', {});
  }
  if (r.json && r.json.access_token) return r.json.access_token;
  throw new Error('anon auth: ' + (r.text || r.status));
}

async function refreshUserToken() {
  if (!ACC.refresh) return false;
  const r = await supaReq('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: ACC.refresh });
  if (r.json && r.json.access_token) {
    ACC.access = r.json.access_token; ACC.refresh = r.json.refresh_token || ACC.refresh; saveSession(); return true;
  }
  return false;
}
async function userToken() {
  if (!ACC.access) return null;
  if (jwtExpired(ACC.access)) { await refreshUserToken(); }
  return ACC.access;
}

// stan trwającej sesji logowania QR
let LOGIN = null; // { code, nonce, anon, url }

async function loginStart() {
  const anon = await anonAuth();
  const nonce = b64url(require('crypto').randomBytes(24));
  const r = await supaReq('POST', '/rest/v1/rpc/start_tv_login_session',
    { p_device_nonce: nonce, p_redirect_base_url: 'https://nuvio.tv/tv-login', p_device_name: 'Samsung TV (Tizen)' }, anon);
  const s = r.json && r.json[0];
  if (!s) throw new Error('start login: ' + (r.text || r.status));
  const url = s.qr_content || s.web_url || ('https://nuvio.tv/tv-login?code=' + s.code);
  LOGIN = { code: s.code, nonce, anon, url };
  return { code: s.code, url, pollInterval: Number(s.poll_interval_seconds || 3) };
}

async function loginPoll() {
  if (!LOGIN) return { status: 'none' };
  const r = await supaReq('POST', '/rest/v1/rpc/poll_tv_login_session',
    { p_code: LOGIN.code, p_device_nonce: LOGIN.nonce }, LOGIN.anon);
  const status = r.json && r.json[0] && r.json[0].status;
  if (status === 'approved' || status === 'authorized' || status === 'completed') {
    // wymiana na sesję użytkownika
    const ex = await supaReq('POST', '/functions/v1/tv-logins-exchange',
      { code: LOGIN.code, device_nonce: LOGIN.nonce }, LOGIN.anon);
    const tk = ex.json || {};
    const access = tk.access_token || (tk.session && tk.session.access_token);
    const refresh = tk.refresh_token || (tk.session && tk.session.refresh_token);
    if (access && refresh) {
      ACC.access = access; ACC.refresh = refresh; ACC.user = tk.user || (tk.session && tk.session.user) || null;
      LOGIN = null;
      await resolveProfile();
      saveSession();
      return { status: 'ok' };
    }
    return { status: 'exchange_failed', detail: ex.text };
  }
  return { status: status || 'pending' };
}

async function resolveProfile() {
  const tok = await userToken(); if (!tok) return null;
  let r = await supaReq('POST', '/rest/v1/rpc/sync_pull_profiles', {}, tok);
  let rows = r.json;
  if (!Array.isArray(rows)) {
    r = await supaReq('GET', '/rest/v1/tv_profiles?select=*', null, tok); rows = r.json;
  }
  if (Array.isArray(rows) && rows.length) {
    ACC.profiles = rows.map(x => ({ id: x.id, index: x.profile_index, name: x.name }));
    // wybrany profil: zapamiętany, inaczej pierwszy (profile_index 1)
    const chosen = rows.find(x => x.profile_index === ACC.profileIndex) || rows.find(x => x.profile_index === 1) || rows[0];
    ACC.profileId = chosen.id || null;
    ACC.profileIndex = chosen.profile_index != null ? chosen.profile_index : 1;
    ACC.profileName = chosen.name || 'Profil';
    saveSession();
  }
  return ACC.profileIndex;
}

// Continue watching z konta, wzbogacone o metadane TMDB
async function getContinue() {
  const tok = await userToken(); if (!tok) return [];
  if (ACC.profileIndex == null) await resolveProfile();
  const r = await supaReq('POST', '/rest/v1/rpc/sync_pull_watch_progress', { p_profile_id: ACC.profileIndex }, tok);
  const rows = Array.isArray(r.json) ? r.json : [];
  const items = [];
  for (const row of rows) {
    const cid = row.content_id || row.contentId || '';
    const ctype = (row.content_type || row.contentType || 'movie');
    const posMs = Number(row.position != null ? row.position : (row.position_ms || 0));
    const durMs = Number(row.duration != null ? row.duration : (row.duration_ms || 0));
    const pct = durMs > 0 ? Math.round(posMs / durMs * 100) : 0;
    if (pct >= 95) continue; // obejrzane
    items.push({
      contentId: cid, type: ctype === 'tv' || ctype === 'series' ? 'series' : 'movie',
      season: row.season != null ? Number(row.season) : null,
      episode: row.episode != null ? Number(row.episode) : null,
      positionMs: posMs, durationMs: durMs, pct: pct,
      updated: Number(row.last_watched || row.updated_at || 0)
    });
  }
  items.sort((a, b) => b.updated - a.updated);
  // wzbogać o TMDB (id może być tt... imdb lub tmdb numeric)
  const top = items.slice(0, 20);
  await Promise.all(top.map(async it => {
    try {
      let tmdbId = it.contentId, mt = it.type === 'series' ? 'tv' : 'movie';
      if (String(it.contentId).indexOf('tt') === 0) {
        const f = await getJSON(`${TMDB}/find/${it.contentId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=${LANG}`);
        const hit = (f.movie_results && f.movie_results[0]) || (f.tv_results && f.tv_results[0]);
        if (hit) { tmdbId = hit.id; mt = f.tv_results && f.tv_results[0] ? 'tv' : 'movie'; }
      } else if (String(it.contentId).indexOf('tmdb:') === 0) { tmdbId = it.contentId.split(':')[1]; }
      it.tmdbId = tmdbId; it.type = mt === 'tv' ? 'series' : 'movie';
      const d = await getJSON(`${TMDB}/${mt}/${tmdbId}?api_key=${TMDB_KEY}&language=${LANG}`);
      it.title = d.title || d.name || it.contentId;
      it.poster = d.poster_path ? IMG + '/w342' + d.poster_path : '';
    } catch (e) { it.title = it.contentId; it.poster = ''; }
  }));
  return top;
}

function jwtSub() {
  try { return JSON.parse(Buffer.from(ACC.access.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).sub; } catch (e) { return null; }
}
// Lista wtyczek zainstalowanych na koncie użytkownika
async function getUserPlugins() {
  const tok = await userToken(); if (!tok) return [];
  if (ACC.profileIndex == null) await resolveProfile();
  // wtyczki/źródła użytkownika są w tabeli `addons` (kolumny: url,name,enabled,sort_order,profile_id)
  let r = await supaReq('GET', `/rest/v1/addons?profile_id=eq.${ACC.profileIndex}&select=url,name,enabled,sort_order&order=sort_order.asc`, null, tok);
  let rows = Array.isArray(r.json) ? r.json : [];
  if (!rows.length) { // fallback: wszystkie addony usera (gdyby profile_id nie pasował)
    r = await supaReq('GET', '/rest/v1/addons?select=url,name,enabled,sort_order,profile_id&order=sort_order.asc', null, tok);
    rows = Array.isArray(r.json) ? r.json : [];
  }
  return rows.map(x => ({ name: x.name || 'Addon', url: x.url || '', enabled: x.enabled !== false }))
    .filter(x => x.url);
}

async function pushProgress(p) {
  const tok = await userToken(); if (!tok) return false;
  if (ACC.profileIndex == null) await resolveProfile();
  const isSeries = p.type === 'series' || p.type === 'tv';
  const ctype = isSeries ? 'series' : 'movie';
  // content_id MUSI być imdb tt (żeby wznawianie działało na innych urządzeniach)
  let imdb = String(p.contentId || '');
  if (imdb.indexOf('tt') !== 0) {
    if (imdb.indexOf('tmdb:') === 0) imdb = imdb.split(':')[1];
    const resolved = await tmdbToImdb(p.tmdbId || imdb, isSeries ? 'tv' : 'movie');
    if (resolved) imdb = resolved;
  }
  const s = p.season != null ? Number(p.season) : null;
  const e = p.episode != null ? Number(p.episode) : null;
  const videoId = isSeries ? `${imdb}:${s}:${e}` : imdb;
  const progressKey = isSeries ? `${imdb}_s${s}e${e}` : imdb;
  const entry = {
    content_id: imdb, content_type: ctype, video_id: videoId,
    season: isSeries ? s : null, episode: isSeries ? e : null,
    position: Math.max(0, Math.round(Number(p.positionMs) || 0)),
    duration: Math.max(0, Math.round(Number(p.durationMs) || 0)),
    last_watched: Date.now(),
    progress_key: progressKey
  };
  const r = await supaReq('POST', '/rest/v1/rpc/sync_push_watch_progress',
    { p_profile_id: ACC.profileIndex, p_entries: [entry] }, tok);
  console.log('[progress] push', progressKey, entry.position + '/' + entry.duration, '->', r.status);
  return r.status < 300;
}

// ---------- Ładowanie providerów Nuvio ----------
let PROVIDERS = []; // { id, name, mod, supportedTypes }

async function loadProviders() {
  const loaded = [];
  for (const repo of REPOS) {
    let manifest;
    try { manifest = await getJSON(repo); }
    catch (e) { console.log('[providers] nie mogę pobrać manifestu', repo, e.message); continue; }
    const base = repo.replace(/\/manifest\.json.*$/, '');
    const scrapers = manifest.scrapers || manifest.providers || [];
    for (const s of scrapers) {
      if (s.enabled === false) continue;
      const id = s.id || s.name;
      const fileUrl = base + '/' + (s.filename || ('providers/' + id + '.js'));
      const localPath = path.join(PROVIDER_DIR, id + '.js');
      try {
        const r = await httpGet(fileUrl);
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        fs.writeFileSync(localPath, r.body);
        delete require.cache[require.resolve(localPath)];
        const mod = require(localPath);
        if (typeof mod.getStreams !== 'function') throw new Error('brak getStreams');
        loaded.push({ id, name: s.name || id, mod, supportedTypes: s.supportedTypes || ['movie', 'tv'] });
        console.log('[providers] OK', id);
      } catch (e) {
        console.log('[providers] pominięto', id, '-', e.message);
      }
    }
  }
  PROVIDERS = loaded;
  console.log('[providers] załadowano', PROVIDERS.length);
}

// ---------- Addony Stremio z konta użytkownika ----------
let ADDONS_CACHE = { ts: 0, list: [] };
function addonBase(url) {
  // baza do zasobów: usuń końcowe /manifest.json (i ewentualny query)
  let u = url.split('#')[0];
  if (/\/manifest\.json(\?.*)?$/.test(u)) return u.replace(/\/manifest\.json(\?.*)?$/, '');
  if (/\/manifest(\/|\?|$)/.test(u)) return u.replace(/\/manifest.*$/, '');
  return u.replace(/\/$/, '');
}
function manifestUrl(url) {
  if (/manifest/.test(url)) return url;
  return url.replace(/\/$/, '') + '/manifest.json';
}
async function getUserAddons() {
  if (Date.now() - ADDONS_CACHE.ts < 300000 && ADDONS_CACHE.list.length) return ADDONS_CACHE.list;
  const raw = await getUserPlugins();
  const list = [];
  await Promise.all(raw.filter(a => a.enabled).map(async a => {
    try {
      const m = await getJSON(manifestUrl(a.url));
      const resources = (m.resources || []).map(r => typeof r === 'string' ? r : r.name);
      list.push({ name: a.name, base: addonBase(a.url), resources, types: m.types || [] });
    } catch (e) { console.log('[addon] manifest fail', a.name, e.message); }
  }));
  if (list.length) ADDONS_CACHE = { ts: Date.now(), list };
  return list;
}
async function tmdbToImdb(tmdbId, mt) {
  try { const j = await getJSON(`${TMDB}/${mt}/${tmdbId}/external_ids?api_key=${TMDB_KEY}`); return j.imdb_id || null; } catch (e) { return null; }
}
// Stary WebKit TV nie ma czcionki emoji -> flagi na [PL]/[EN], resztę emoji usuń
function cleanEmoji(t) {
  if (!t) return t;
  t = String(t);
  // pary regional indicators (flagi) -> kod literowy w nawiasach: 🇵🇱 -> [PL]
  t = t.replace(/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu, function (_, a, b) {
    var la = String.fromCharCode(65 + (a.codePointAt(0) - 0x1F1E6));
    var lb = String.fromCharCode(65 + (b.codePointAt(0) - 0x1F1E6));
    return '[' + la + lb + ']';
  });
  // usuń pozostałe emoji/symbole/piktogramy/variation-selectors/ZWJ
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '');
  // posprzątaj podwójne spacje / puste nawiasy po usunięciu
  t = t.replace(/\[\s*\]/g, '').replace(/[ \t]{2,}/g, ' ');
  return t;
}

function qualFromText(t) {
  t = String(t || '').toLowerCase();
  if (t.indexOf('2160') > -1 || t.indexOf('4k') > -1) return '2160p';
  if (t.indexOf('1080') > -1) return '1080p';
  if (t.indexOf('720') > -1) return '720p';
  if (t.indexOf('480') > -1) return '480p';
  return '';
}
async function addonStreams(type, tmdbId, season, episode) {
  const addons = await getUserAddons();
  const stType = (type === 'series' || type === 'tv') ? 'series' : 'movie';
  const imdb = await tmdbToImdb(tmdbId, stType === 'series' ? 'tv' : 'movie');
  if (!imdb) return [];
  const vid = stType === 'series' ? `${imdb}:${season}:${episode}` : imdb;
  const usable = addons.filter(a => a.resources.indexOf('stream') > -1 && (!a.types.length || a.types.indexOf(stType) > -1));
  const jobs = usable.map(async a => {
    try {
      const j = await withTimeout(getJSON(`${a.base}/stream/${stType}/${encodeURIComponent(vid)}.json`), 20000, a.name);
      return (j.streams || []).filter(s => s.url).map(s => {
        const ph = s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request;
        const desc = (s.description || s.title || s.name || '').toString();
        let sizeBytes = (s.behaviorHints && s.behaviorHints.videoSize) || 0;
        if (!sizeBytes) { const m = desc.match(/([\d.]+)\s?(GB|MB)/i); if (m) sizeBytes = parseFloat(m[1]) * (m[2].toUpperCase() === 'GB' ? 1073741824 : 1048576); }
        return {
          provider: a.name, name: (s.name || a.name).toString(), _addon: true,
          title: (s.name || a.name).toString().replace(/\n/g, ' '),
          desc: desc,                            // pełny opis (język, rozmiar, seedery) z zachowaniem \n
          size: sizeBytes || null,
          quality: qualFromText(desc + ' ' + (s.name || '')), url: s.url,
          headers: ph || s.headers || null
        };
      });
    } catch (e) { console.log('[addon-stream]', a.name, e.message); return []; }
  });
  const res = await Promise.all(jobs);
  return [].concat.apply([], res);
}

// Napisy z addonów Stremio (np. OpenSubtitles v3) — protokół subtitles
async function addonSubtitles(type, tmdbId, season, episode) {
  const addons = await getUserAddons();
  const stType = (type === 'series' || type === 'tv') ? 'series' : 'movie';
  const imdb = await tmdbToImdb(tmdbId, stType === 'series' ? 'tv' : 'movie');
  if (!imdb) return [];
  const vid = stType === 'series' ? `${imdb}:${season}:${episode}` : imdb;
  const usable = addons.filter(a => a.resources.indexOf('subtitles') > -1);
  const jobs = usable.map(async a => {
    try {
      const j = await withTimeout(getJSON(`${a.base}/subtitles/${stType}/${encodeURIComponent(vid)}.json`), 15000, a.name);
      return (j.subtitles || []).filter(s => s.url).map(s => ({ lang: (s.lang || s.language || '?'), url: s.url, id: s.id || '' }));
    } catch (e) { return []; }
  });
  const res = await Promise.all(jobs);
  let all = [].concat.apply([], res);
  // priorytet: polski, potem angielski
  const rank = l => { l = String(l).toLowerCase(); if (l.indexOf('pol') > -1 || l === 'pl') return 0; if (l.indexOf('eng') > -1 || l === 'en') return 1; return 2; };
  all.sort((a, b) => rank(a.lang) - rank(b.lang));
  // dedup po lang+url
  const seen = {}, out = [];
  for (const s of all) { const k = s.lang + '|' + s.url; if (!seen[k]) { seen[k] = 1; out.push(s); } }
  return out.slice(0, 25);
}

// Sprawdź czy link to realne wideo (a nie strona logowania/HTML) — pobierz nagłówki i przerwij.
function probeStream(streamUrl, hdrs) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let target = streamUrl, hops = 0;
    function go(t) {
      let url; try { url = new URL(t); } catch (e) { return finish({ ok: false }); }
      const lib = t.indexOf('https') === 0 ? https : http;
      const headers = Object.assign({ 'User-Agent': 'Mozilla/5.0 (SmartTV; Tizen) AppleWebKit/538.1', 'Range': 'bytes=0-1' }, hdrs || {});
      const rq = lib.request({ method: 'GET', hostname: url.hostname, path: url.pathname + url.search, headers }, resp => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && hops < 5) {
          hops++; resp.destroy(); return go(new URL(resp.headers.location, t).toString());
        }
        const ct = (resp.headers['content-type'] || '').toLowerCase();
        const ok = (resp.statusCode === 200 || resp.statusCode === 206) &&
          (ct.indexOf('video') > -1 || ct.indexOf('mpegurl') > -1 || ct.indexOf('octet-stream') > -1 || ct.indexOf('matroska') > -1 || ct.indexOf('mp4') > -1);
        resp.destroy();
        finish({ ok: ok, ctype: ct });
      });
      rq.on('error', () => finish({ ok: false }));
      rq.setTimeout(9000, () => { rq.destroy(); finish({ ok: false }); });
      rq.end();
    }
    go(target);
  });
}

function tvScore(s) {
  const q = String(s.quality || '').toLowerCase();
  const t = String(s.title || '').toLowerCase();
  let score = 0;
  // format przyjazny staremu TV
  if (t.indexOf('.mp4') > -1 || (s.ctype && s.ctype.indexOf('mp4') > -1)) score += 30;
  else if (s.ctype && s.ctype.indexOf('mpegurl') > -1) score += 22;
  else if (t.indexOf('.mkv') > -1 || (s.ctype && s.ctype.indexOf('matroska') > -1)) score += 18;
  else score += 10;
  // rozdzielczość: 1080/720 najlepsze, 4K słabo (TV to panel 1080 + brak HEVC)
  if (q.indexOf('1080') > -1) score += 20;
  else if (q.indexOf('720') > -1) score += 16;
  else if (q.indexOf('480') > -1) score += 8;
  else if (q.indexOf('2160') > -1 || q.indexOf('4k') > -1) score += 4;
  else score += 10;
  // HEVC/x265 kiepsko dekoduje na J-series
  if (t.indexOf('265') > -1 || t.indexOf('hevc') > -1) score -= 10;
  // Twoje własne addony Nuvio (AIOStreams itd.) mają priorytet nad zapasowymi providerami
  if (s._addon) score += 40;
  return score;
}

// ---------- Agregacja streamów ----------
async function gatherStreams(type, tmdbId, season, episode) {
  const mediaType = type === 'series' || type === 'tv' ? 'tv' : 'movie';
  const usable = PROVIDERS.filter(p => p.supportedTypes.indexOf(mediaType) !== -1);
  const jobs = usable.map(p =>
    withTimeout(Promise.resolve().then(() =>
      p.mod.getStreams(String(tmdbId), mediaType, season != null ? Number(season) : null, episode != null ? Number(episode) : null)
    ), STREAM_TIMEOUT, p.id)
      .then(list => (Array.isArray(list) ? list : []).map(s => Object.assign({ provider: p.name }, s)))
      .catch(e => { console.log('[stream]', p.id, 'błąd:', e.message); return []; })
  );
  const results = await Promise.all(jobs);
  const flat = [].concat.apply([], results).filter(s => s && s.url);
  const rank = q => { q = String(q || '').toLowerCase(); if (q.indexOf('2160') > -1 || q.indexOf('4k') > -1) return 4; if (q.indexOf('1080') > -1) return 3; if (q.indexOf('720') > -1) return 2; if (q.indexOf('cam') > -1) return 0; return 1; };
  flat.sort((a, b) => rank(b.quality) - rank(a.quality));
  return flat;
}

// ---------- Mapowanie TMDB -> proste obiekty dla TV ----------
function poster(p) { return p ? IMG + '/w342' + p : ''; }
function backdrop(p) { return p ? IMG + '/w780' + p : ''; }
function mapItem(x, forcedType) {
  const type = forcedType || x.media_type || (x.title ? 'movie' : 'tv');
  return {
    id: x.id,
    type: type === 'tv' ? 'series' : 'movie',
    title: x.title || x.name || '',
    year: (x.release_date || x.first_air_date || '').slice(0, 4),
    poster: poster(x.poster_path),
    rating: x.vote_average ? Math.round(x.vote_average * 10) / 10 : null
  };
}

// ---------- Router ----------
const CATEGORIES = {
  'trending-movie': `${TMDB}/trending/movie/week`,
  'trending-tv': `${TMDB}/trending/tv/week`,
  'popular-movie': `${TMDB}/movie/popular`,
  'top-movie': `${TMDB}/movie/top_rated`,
  'popular-tv': `${TMDB}/tv/popular`,
  'top-tv': `${TMDB}/tv/top_rated`
};

function send(res, code, obj, headers) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  }, headers || {}));
  res.end(body);
}

async function handleApi(req, res, u) {
  const parts = u.pathname.split('/').filter(Boolean); // ['api', ...]
  const seg = parts.slice(1);

  // /api/log?t= -> beacon diagnostyczny z telewizora
  if (seg[0] === 'log') {
    console.log('[TVLOG] ' + (u.searchParams.get('t') || ''));
    return send(res, 200, '');
  }

  // /api/health
  if (seg[0] === 'health') return send(res, 200, { ok: true, providers: PROVIDERS.map(p => p.id) });

  // /api/reload  -> przeładuj providery
  if (seg[0] === 'reload') { await loadProviders(); return send(res, 200, { ok: true, providers: PROVIDERS.length }); }

  // /api/catalog/:category
  if (seg[0] === 'catalog') {
    const cat = seg[1];
    const url = CATEGORIES[cat];
    if (!url) return send(res, 404, { error: 'nieznana kategoria' });
    const forced = cat.indexOf('tv') > -1 ? 'tv' : 'movie';
    const j = await getJSON(`${url}?api_key=${TMDB_KEY}&language=${LANG}`);
    return send(res, 200, { items: (j.results || []).map(x => mapItem(x, forced)) });
  }

  // /api/search?q=
  if (seg[0] === 'search') {
    const q = u.searchParams.get('q') || '';
    const j = await getJSON(`${TMDB}/search/multi?api_key=${TMDB_KEY}&language=${LANG}&query=${encodeURIComponent(q)}`);
    const items = (j.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv').map(x => mapItem(x));
    return send(res, 200, { items });
  }

  // /api/meta/:type/:id
  if (seg[0] === 'meta') {
    const type = seg[1] === 'series' ? 'tv' : 'movie';
    const id = seg[2];
    const j = await getJSON(`${TMDB}/${type}/${id}?api_key=${TMDB_KEY}&language=${LANG}`);
    const meta = {
      id: j.id, type: seg[1], title: j.title || j.name || '',
      overview: j.overview || '',
      year: (j.release_date || j.first_air_date || '').slice(0, 4),
      poster: poster(j.poster_path), backdrop: backdrop(j.backdrop_path),
      rating: j.vote_average ? Math.round(j.vote_average * 10) / 10 : null,
      runtime: j.runtime || (j.episode_run_time && j.episode_run_time[0]) || null,
      genres: (j.genres || []).map(g => g.name)
    };
    if (type === 'tv') {
      meta.seasons = (j.seasons || []).filter(s => s.season_number > 0)
        .map(s => ({ season: s.season_number, name: s.name, episodes: s.episode_count }));
    }
    return send(res, 200, meta);
  }

  // /api/episodes/:id/:season
  if (seg[0] === 'episodes') {
    const id = seg[1], season = seg[2];
    const j = await getJSON(`${TMDB}/tv/${id}/season/${season}?api_key=${TMDB_KEY}&language=${LANG}`);
    const eps = (j.episodes || []).map(e => ({
      episode: e.episode_number, name: e.name || ('Odcinek ' + e.episode_number),
      overview: e.overview || '', still: e.still_path ? IMG + '/w300' + e.still_path : ''
    }));
    return send(res, 200, { season: Number(season), episodes: eps });
  }

  // /api/streams/:type/:id?season=&episode=
  if (seg[0] === 'streams') {
    const type = seg[1], id = seg[2];
    const season = u.searchParams.get('season');
    const episode = u.searchParams.get('episode');
    // Strumienie z TWOICH addonów Nuvio (AIOStreams itd.) + zapasowo moje providery.
    const [fromAddons, fromProviders] = await Promise.all([
      addonStreams(type, id, season, episode).catch(() => []),
      gatherStreams(type, id, season, episode).catch(() => [])
    ]);
    // Addony pokazujemy 1:1 — w kolejności i z opisami dokładnie jak zwrócił dodatek (sam filtruje do najlepszych).
    // Tylko zapasowe providery sortujemy pod TV i walidujemy (czy realne wideo).
    let prov = fromProviders;
    prov.sort((a, b) => tvScore(b) - tvScore(a));
    const toCheck = prov.slice(0, 12);
    const checks = await Promise.all(toCheck.map(s => probeStream(s.url, s.headers).then(r => { s.ctype = r.ctype; s._ok = r.ok; return s; })));
    let provOk = checks.filter(s => s._ok);
    if (!provOk.length) provOk = toCheck;
    provOk.sort((a, b) => tvScore(b) - tvScore(a));
    let streams = fromAddons.concat(provOk);
    const host = req.headers.host;
    // ZAWSZE przez proxy — stary AVPlay nie robi nowoczesnego TLS ani nagłówków. TV gada tylko http z bridge.
    const out = streams.map(s => {
      const h = (s.headers && Object.keys(s.headers).length) ? Buffer.from(JSON.stringify(s.headers)).toString('base64') : '';
      const playUrl = `http://${host}/api/proxy?u=${encodeURIComponent(s.url)}` + (h ? `&h=${encodeURIComponent(h)}` : '');
      return {
        provider: cleanEmoji(s.provider || s.name || ''),
        title: cleanEmoji(s.title || s.name || 'Stream'),
        desc: cleanEmoji(s.desc || ''),
        size: s.size || null,
        quality: s.quality || '',
        url: playUrl,
        direct: s.url
      };
    });
    return send(res, 200, { streams: out });
  }

  // /api/subtitles/:type/:id?season=&episode=  -> napisy z addonów usera, URL przez proxy
  if (seg[0] === 'subtitles') {
    const type = seg[1], id = seg[2];
    const season = u.searchParams.get('season'), episode = u.searchParams.get('episode');
    const subs = await addonSubtitles(type, id, season, episode);
    const host = req.headers.host;
    const out = subs.map(s => ({ lang: s.lang, url: `http://${host}/api/proxy?u=${encodeURIComponent(s.url)}`, direct: s.url }));
    return send(res, 200, { subtitles: out });
  }

  // /api/proxy?u=&h=  -> przepuszcza strumień z nagłówkami
  if (seg[0] === 'proxy') {
    const target = u.searchParams.get('u');
    if (!target) return send(res, 400, { error: 'brak u' });
    let headers = {};
    const hb = u.searchParams.get('h');
    if (hb) { try { headers = JSON.parse(Buffer.from(hb, 'base64').toString('utf8')); } catch (e) {} }
    if (req.headers.range) headers['Range'] = req.headers.range;
    if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = 'Mozilla/5.0 (SmartTV; Tizen) AppleWebKit/538.1';
    // Podążaj za przekierowaniami po stronie serwera (AVPlay bywa kapryśny przy 302); potem streamuj finalną odpowiedź.
    function fwd(tgt, hops) {
      if (hops > 6) { if (!res.headersSent) send(res, 508, { error: 'za dużo przekierowań' }); return; }
      const lib = tgt.startsWith('https') ? https : http;
      const preq = lib.request(tgt, { headers }, pres => {
        if (pres.statusCode >= 300 && pres.statusCode < 400 && pres.headers.location) {
          const loc = new URL(pres.headers.location, tgt).toString();
          pres.resume();
          return fwd(loc, hops + 1);
        }
        const hh = {};
        ['content-type', 'content-length', 'accept-ranges', 'content-range'].forEach(k => { if (pres.headers[k]) hh[k] = pres.headers[k]; });
        if (!hh['content-type']) hh['content-type'] = 'video/mp4';
        hh['Access-Control-Allow-Origin'] = '*';
        res.writeHead(pres.statusCode, hh);
        pres.pipe(res);
      });
      preq.on('error', e => { console.log('[proxy-vid] błąd', e.message); if (!res.headersSent) send(res, 502, { error: e.message }); });
      preq.setTimeout(30000, () => preq.destroy(new Error('timeout')));
      preq.end();
    }
    fwd(target, 0);
    return;
  }

  return send(res, 404, { error: 'not found' });
}

// ---------- Serwer + statyczny hosting (opcjonalny) ----------
// Wspólny proxy do dowolnego celu https (stary WebKit TV nie dogaduje nowoczesnego TLS)
function proxyTo(req, res, target, reqHost) {
  const headers = {};
  for (const k in req.headers) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'connection' || lk === 'accept-encoding') continue;
    headers[k] = req.headers[k];
  }
  let targetHost;
  try { targetHost = new URL(target).host; } catch (e) { return send(res, 400, 'zły url'); }
  headers['host'] = targetHost;
  const proxyBase = 'http://' + (reqHost || 'localhost:' + PORT) + '/img?u=';
  // hosty grafik których stary WebKit TV nie ładuje po HTTPS (TLS) — przepisujemy na proxy /img
  const IMGHOSTS = /https:\/\/(images\.metahub\.space|image\.tmdb\.org|[a-z0-9-]+\.tmdb\.org|[a-z0-9-]+\.qrserver\.com|live\.metahub\.space)\/[^"'\\ )]+/g;
  const preq = https.request(target, { method: req.method, headers }, pres => {
    const rh = {};
    for (const k in pres.headers) rh[k] = pres.headers[k];
    rh['access-control-allow-origin'] = '*';
    rh['access-control-allow-headers'] = '*';
    rh['access-control-allow-methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
    const ct = (pres.headers['content-type'] || '').toLowerCase();
    if (/json|text|javascript/.test(ct)) {
      const chunks = [];
      pres.on('data', c => chunks.push(c));
      pres.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        body = body.replace(IMGHOSTS, m => proxyBase + encodeURIComponent(m));
        delete rh['content-length'];
        delete rh['content-encoding'];
        rh['content-length'] = Buffer.byteLength(body);
        res.writeHead(pres.statusCode, rh);
        res.end(body);
      });
    } else {
      res.writeHead(pres.statusCode, rh);
      pres.pipe(res);
    }
  });
  preq.on('error', e => { console.log('[proxy] błąd', target, e.message); if (!res.headersSent) send(res, 502, { error: 'proxy: ' + e.message }); });
  req.pipe(preq);
}

const server = http.createServer((req, res) => {
  __route(req, res);
});
function __route(req, res) {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  console.log('[req]', req.socket.remoteAddress, req.method, u.pathname);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }
  const reqHost = req.headers.host || ('localhost:' + PORT);
  // /sb/* -> https://api.nuvio.tv/*  (backend konta Nuvio)
  if (u.pathname === '/sb' || u.pathname.startsWith('/sb/')) {
    const upstreamPath = u.pathname.slice(3) || '/';
    return proxyTo(req, res, SUPA + upstreamPath + (u.search || ''), reqHost);
  }
  // /px?u=<https url> -> generyczny proxy dla WSZYSTKICH żądań https z apki (dodatki Stremio itd.)
  if (u.pathname === '/px') {
    const tgt = u.searchParams.get('u');
    if (!tgt) return send(res, 400, 'brak u');
    return proxyTo(req, res, tgt, reqHost);
  }
  // /img?u=<https url> -> pobiera obrazek (dla hostów które stary TLS TV odrzuca, np. api.qrserver.com)
  if (u.pathname === '/img') {
    const tgt = u.searchParams.get('u');
    if (!tgt) return send(res, 400, 'brak u');
    httpGet(tgt).then(r => {
      res.writeHead(r.status, {
        'Content-Type': r.headers['content-type'] || 'image/png',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(r.body);
    }).catch(e => send(res, 502, 'img: ' + e.message));
    return;
  }
  // ---- Konto Nuvio: /me/* ----
  if (u.pathname.startsWith('/me/')) {
    const p = u.pathname.slice(4);
    const done = obj => send(res, 200, obj);
    const fail = e => { console.log('[me] błąd', p, e && e.message); send(res, 500, { error: e && e.message }); };
    if (p === 'status') { return userToken().then(t => done({ loggedIn: !!t, profile: ACC.profileName || null })).catch(fail); }
    if (p === 'login/start') { return loginStart().then(done).catch(fail); }
    if (p === 'login/poll') { return loginPoll().then(done).catch(fail); }
    if (p === 'logout') { ACC = { access: null, refresh: null, profileId: null }; saveSession(); return done({ ok: true }); }
    if (p === 'continue') { return getContinue().then(list => done({ items: list })).catch(fail); }
    if (p === 'delprogress') {
      return (async () => {
        const tok = await userToken(); if (ACC.profileIndex == null) await resolveProfile();
        const key = u.searchParams.get('key');
        const r = await supaReq('POST', '/rest/v1/rpc/sync_delete_watch_progress', { p_profile_id: ACC.profileIndex, p_keys: [key] }, tok);
        done({ status: r.status, body: r.json });
      })().catch(fail);
    }
    if (p === 'plugins') { return getUserPlugins().then(list => done({ plugins: list })).catch(fail); }
    if (p === 'tables') {
      return (async () => {
        const tok = await userToken();
        const names = ['plugins', 'addons', 'repositories', 'plugin_repositories', 'plugin_repos', 'repos',
          'sources', 'user_plugins', 'tv_plugins', 'installed_addons', 'home_catalog_settings',
          'profile_settings', 'saved_library', 'library_items', 'collections', 'catalogs'];
        const out = {};
        for (const t of names) {
          const r = await supaReq('GET', `/rest/v1/${t}?select=*&limit=5`, null, tok);
          out[t] = { status: r.status, count: Array.isArray(r.json) ? r.json.length : null,
            sample: Array.isArray(r.json) && r.json.length ? Object.keys(r.json[0]) : (r.json && r.json.code ? r.json.code : null) };
        }
        done(out);
      })().catch(fail);
    }
    if (p === 'plugdebug') {
      return (async () => {
        const tok = await userToken();
        const uid = jwtSub();
        const rpc1 = await supaReq('POST', '/rest/v1/rpc/sync_pull_plugins', { p_profile_id: ACC.profileIndex }, tok);
        const rpc0 = await supaReq('POST', '/rest/v1/rpc/sync_pull_plugins', {}, tok);
        const tbl = await supaReq('GET', '/rest/v1/plugins?select=*', null, tok);
        const tblProf = await supaReq('GET', `/rest/v1/plugins?profile_id=eq.${ACC.profileIndex}&select=*`, null, tok);
        const addons = await supaReq('POST', '/rest/v1/rpc/sync_pull_addons', { p_profile_id: ACC.profileIndex }, tok);
        done({
          profileIndex: ACC.profileIndex,
          rpc1_status: rpc1.status, rpc1: rpc1.json, rpc1_text: (rpc1.text || '').slice(0, 200),
          rpc0_status: rpc0.status, rpc0: rpc0.json,
          tbl_status: tbl.status, tbl: tbl.json, tbl_text: (tbl.text || '').slice(0, 200),
          tblProf_status: tblProf.status, tblProf: tblProf.json,
          addons_status: addons.status, addons: addons.json, addons_text: (addons.text || '').slice(0, 200)
        });
      })().catch(fail);
    }
    if (p === 'debug') {
      return (async () => {
        const tok = await userToken();
        const prof = await supaReq('POST', '/rest/v1/rpc/sync_pull_profiles', {}, tok);
        const wp = await supaReq('POST', '/rest/v1/rpc/sync_pull_watch_progress', { p_profile_id: ACC.profileId }, tok);
        const wpNoProfile = await supaReq('POST', '/rest/v1/rpc/sync_pull_watch_progress', {}, tok);
        done({
          profileId: ACC.profileId, sub: jwtSub(),
          profiles: prof.json, profilesStatus: prof.status,
          watchStatus: wp.status, watchRaw: wp.json, watchText: wp.text ? wp.text.slice(0, 300) : null,
          watchNoProfileStatus: wpNoProfile.status, watchNoProfileRaw: wpNoProfile.json
        });
      })().catch(fail);
    }
    if (p === 'progress' && req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c));
      req.on('end', () => { let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {} pushProgress(b).then(ok => done({ ok })).catch(fail); });
      return;
    }
    return send(res, 404, { error: 'me: nieznane' });
  }
  if (u.pathname.startsWith('/api/')) {
    handleApi(req, res, u).catch(e => { console.log('[api] błąd', e); if (!res.headersSent) send(res, 500, { error: e.message }); });
    return;
  }
  send(res, 200, 'Nuvio Bridge działa. Użyj /api/health');
}

loadProviders().finally(() => {
  server.listen(PORT, () => console.log('[bridge] słucham na :' + PORT));
});
// odświeżaj providery co 6h
setInterval(() => loadProviders().catch(() => {}), 6 * 3600 * 1000);
