/* Nuvio TV — aplikacja dla Samsung UE55J6350 (Tizen 2.3, WebKit 2015). Czysty ES5. */
(function () {
'use strict';

var BRIDGE = (window.BRIDGE_URL || 'http://192.168.0.100:7070');

// Kody klawiszy pilota Samsung
var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, RETURN: 10009,
    BACK: 461, PLAY: 415, PAUSE: 19, STOP: 413, PLAYPAUSE: 10252,
    FF: 417, RW: 412, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, INFO: 457 };

var view = 'home';           // home | detail | streams | player | search
var homeRows = [];           // [{title, items, el, track}]
var homeStack = [];
var homeR = 0, homeC = 0;    // fokus na home
var detailFocus = [];        // lista fokusowalnych w detalu
var detailIdx = 0;
var currentMeta = null;
var currentSeason = 1;
var episodesCache = {};
var streams = [];
var streamIdx = 0;
var searchQuery = '';
var searchItems = [];
var searchIdx = 0;
var resumeMs = 0;            // pozycja wznowienia (żądana)
var pendingSeekMs = 0;       // przewinięcie do wykonania gdy odtwarzacz już gra
var playCtx = null;          // { contentId, type, season, episode } — do zapisu postępu
var progressTimer = null;

function $(id) { return document.getElementById(id); }
function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function show(v) {
    var ids = ['login', 'home', 'detail', 'streams', 'player', 'search'];
    for (var i = 0; i < ids.length; i++) $('view-' + ids[i]).className = 'view' + (ids[i] === v ? '' : ' hidden');
    view = v;
}
function loader(on, txt) { $('loader').className = on ? '' : 'hidden'; $('loader-text').innerHTML = txt || 'Loading...'; }

// ---------- HTTP (XHR, bo brak fetch na tym WebKicie) ----------
function get(url, cb, err) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.timeout = 45000;
    x.onreadystatechange = function () {
        if (x.readyState === 4) {
            if (x.status >= 200 && x.status < 300) {
                try { cb(JSON.parse(x.responseText)); } catch (e) { if (err) err(e); }
            } else if (err) err(new Error('HTTP ' + x.status));
        }
    };
    x.ontimeout = function () { if (err) err(new Error('timeout')); };
    x.onerror = function () { if (err) err(new Error('network')); };
    x.send();
}
function post(url, body, cb, err) {
    var x = new XMLHttpRequest();
    x.open('POST', url, true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.timeout = 20000;
    x.onreadystatechange = function () {
        if (x.readyState === 4) {
            if (x.status >= 200 && x.status < 300) { try { cb && cb(x.responseText ? JSON.parse(x.responseText) : {}); } catch (e) { cb && cb({}); } }
            else if (err) err(new Error('HTTP ' + x.status));
        }
    };
    x.onerror = function () { if (err) err(new Error('network')); };
    x.send(JSON.stringify(body || {}));
}

// ---------- Logowanie do konta Nuvio ----------
var loginTimer = null;
function startLogin() {
    show('login');
    $('login-status').innerHTML = 'Generating code...';
    $('login-qr-img').style.display = 'none';
    get(BRIDGE + '/me/login/start', function (d) {
        $('login-url').innerHTML = 'nuvio.tv/tv-login';
        $('login-code').innerHTML = 'Code: ' + d.code;
        $('login-status').innerHTML = 'Waiting for you to confirm sign-in on your phone...';
        var qr = BRIDGE + '/img?u=' + encodeURIComponent('https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=' + encodeURIComponent(d.url));
        var im = $('login-qr-img'); im.src = qr; im.style.display = 'block';
        pollLogin();
    }, function () { $('login-status').innerHTML = 'Could not connect to the server. Retrying...'; setTimeout(startLogin, 4000); });
}
function pollLogin() {
    if (loginTimer) clearTimeout(loginTimer);
    get(BRIDGE + '/me/login/poll', function (d) {
        if (d.status === 'ok') { $('login-status').innerHTML = 'Signed in! Loading your account...'; enterApp(); return; }
        loginTimer = setTimeout(pollLogin, 3000);
    }, function () { loginTimer = setTimeout(pollLogin, 4000); });
}
function enterApp() {
    show('home');
    loader(true, 'Loading your library...');
    buildHome();
}

// ---------- Strona główna ----------
var CATS = [
    { id: 'trending-movie', title: 'Trending movies' },
    { id: 'trending-tv', title: 'Trending TV shows' },
    { id: 'popular-movie', title: 'Popular movies' },
    { id: 'popular-tv', title: 'Popular TV shows' },
    { id: 'top-movie', title: 'Top-rated movies' },
    { id: 'top-tv', title: 'Top-rated TV shows' }
];

function buildHome() {
    homeStack = [];
    get(BRIDGE + '/me/shelves', function (data) {
        var defs = data.rows && data.rows.length ? data.rows : CATS;
        mountHomeRows([{ id: '__continue__', title: 'Continue watching' }].concat(defs));
    }, function () {
        loader(true, 'Your account shelves could not be loaded. Reopen Nuvio to retry.');
    });
}
function mountHomeRows(defs) {
    var container = $('rows'); container.innerHTML = '';
    homeRows = []; homeR = 0; homeC = 0;
    for (var i = 0; i < defs.length; i++) {
        var def = defs[i], rowEl = el('div', 'row' + (def.grid ? ' folder-grid' : ''));
        var heading = el('div', 'row-title'); heading.textContent = def.title;
        // Older TV engines support textContent; innerHTML is avoided for account titles.
        var track = el('div', 'row-track'); rowEl.appendChild(heading); rowEl.appendChild(track); container.appendChild(rowEl);
        var url = def.id === '__continue__' ? '/me/continue' : '/api/shelf/' + encodeURIComponent(def.id);
        for (var c = 0; c < CATS.length; c++) if (CATS[c].id === def.id) url = '/api/catalog/' + def.id;
        homeRows.push({ title: def.title, items: def.items || [], el: rowEl, track: track,
            continueRow: def.id === '__continue__', grid: !!def.grid, url: url, state: def.items ? 'loaded' : 'new', rendered: false });
    }
    loader(false); setHomeFocus(0, 0);
}
function loadHomeRow(index, retry) {
    var row = homeRows[index];
    if (!row || (row.state !== 'new' && !(retry && row.state === 'error'))) return;
    row.state = 'loading'; renderRow(index);
    var generation = homeRows;
    get(BRIDGE + row.url, function (data) {
        var items = data.items || [];
        if (row.continueRow) items = items.map(function (x) {
            return { id: x.tmdbId, type: x.type, title: x.title + (x.season ? '  S' + x.season + 'E' + x.episode : ''), poster: x.poster, rating: x.rating, pct: x.pct, resume: x };
        });
        row.items = items; row.state = 'loaded'; row.rendered = false;
        if (generation === homeRows) { renderRow(index); if (homeR === index) setHomeFocus(homeR, homeC); }
    }, function () {
        row.state = 'error'; row.rendered = false;
        if (generation === homeRows) renderRow(index);
    });
}
function openFolder(item) {
    var container = $('rows'), nodes = [];
    while (container.firstChild) { nodes.push(container.firstChild); container.removeChild(container.firstChild); }
    homeStack.push({ rows: homeRows, r: homeR, c: homeC, nodes: nodes });
    mountHomeRows([{ id: item.id, title: item.title, grid: true }]);
}
function backFromHome() {
    if (!homeStack.length) return exitApp();
    var saved = homeStack.pop(), container = $('rows'); container.innerHTML = '';
    for (var i = 0; i < saved.nodes.length; i++) container.appendChild(saved.nodes[i]);
    homeRows = saved.rows; homeR = saved.r; homeC = saved.c;
    setHomeFocus(homeR, homeC);
}

function loadPoster(image) {
    var poster = image.getAttribute('data-poster');
    if (poster && !image.getAttribute('data-requested')) {
        image.setAttribute('data-requested', '1');
        image.src = poster;
    }
}

function renderRow(r) {
    var row = homeRows[r];
    row.rendered = true;
    row.track.innerHTML = '';
    row.cards = row.grid ? el('div', 'grid-content') : row.track;
    if (row.grid) row.track.appendChild(row.cards);
    if (!row.items.length) {
        var message = row.state === 'error' ? 'Could not load this shelf. Press OK to retry.' : (row.state === 'loaded' ? 'No titles in this shelf.' : 'Loading...');
        row.track.appendChild(el('div', 'row-message', message));
        return;
    }
    for (var i = 0; i < row.items.length; i++) {
        var it = row.items[i];
        var card = el('div', 'card');
        if (it.poster) { var im = el('img'); im.setAttribute('data-poster', it.poster); if (i < 11) loadPoster(im); card.appendChild(im); }
        else { var fallback = el('div', 'noimg'); fallback.textContent = it.title; card.appendChild(fallback); }
        if (it.rating) card.appendChild(el('div', 'badge', it.rating));
        if (it.pct) { var pr = el('div', 'progress'); pr.style.width = it.pct + '%'; card.appendChild(pr); }
        var caption = el('div', 'cap'); caption.textContent = it.title; card.appendChild(caption);
        row.cards.appendChild(card);
    }
}

function focusHome() {
    loader(false);
    if (homeR >= homeRows.length) homeR = 0;
    setHomeFocus(homeR, homeC);
}

function clearFocusAll() {
    var f = document.querySelectorAll('.focused');
    for (var i = 0; i < f.length; i++) f[i].className = f[i].className.replace(' focused', '');
}

function setHomeFocus(r, c) {
    clearFocusAll();
    if (!homeRows[r]) return;
    if (c >= homeRows[r].items.length) c = Math.max(0, homeRows[r].items.length - 1);
    if (c < 0) c = 0;
    homeR = r; homeC = c;
    // The 1080p layout shows two full shelves and part of the third.
    var firstVisibleRow = Math.max(0, r - 1);
    for (var visibleRow = firstVisibleRow; visibleRow <= firstVisibleRow + 2 && visibleRow < homeRows.length; visibleRow++) {
        loadHomeRow(visibleRow);
        if (!homeRows[visibleRow].rendered) renderRow(visibleRow);
    }
    var row = homeRows[r], cards = row.cards.childNodes;
    if (cards[c] && homeRows[r].items.length) {
        cards[c].className = 'card focused';
        var start = row.grid ? Math.max(0, Math.floor(c / 8) - 1) * 8 : Math.max(0, c - 2);
        var end = row.grid ? start + 32 : c + 11;
        for (var n = start; n < Math.min(cards.length, end); n++) {
            var image = cards[n].childNodes[0];
            if (image && image.getAttribute) loadPoster(image);
        }
        // przewijanie w poziomie
        row.track.style.marginLeft = row.grid ? '0px' : (-c * 242) + 'px';
        if (row.grid) {
            var gridOffset = -Math.max(0, Math.floor(c / 8) - 1) * 328;
            row.cards.style.webkitTransform = 'translateY(' + gridOffset + 'px)';
            row.cards.style.transform = 'translateY(' + gridOffset + 'px)';
        }
        // przewijanie pionowe: przesuń rzędy tak by aktywny był widoczny
        $('rows').style.marginTop = (-Math.max(0, r) * 0) + 'px';
    }
    scrollRowsTo(r);
}

function scrollRowsTo(r) {
    var offset = r > 1 ? -(homeRows[r - 1].el.offsetTop - homeRows[0].el.offsetTop) : 0;
    $('rows').style.webkitTransform = 'translateY(' + offset + 'px)';
    $('rows').style.transform = 'translateY(' + offset + 'px)';
}

// ---------- Szczegóły ----------
function openDetail(item) {
    resumeMs = 0; pendingSeekMs = 0;   // świeży tytuł = odtwarzanie od początku (nie dziedzicz pozycji wznawiania)
    loader(true, 'Loading details...');
    get(BRIDGE + '/api/meta/' + item.type + '/' + encodeURIComponent(item.id), function (meta) {
        currentMeta = meta;
        currentSeason = 1;
        episodesCache = {};
        renderDetail();
        loader(false);
        show('detail');
    }, function () { loader(false); });
}

function renderDetail() {
    var m = currentMeta;
    $('detail-backdrop').style.backgroundImage = m.backdrop ? 'url(' + m.backdrop + ')' : 'none';
    $('detail-title').innerHTML = m.title;
    var meta = [];
    if (m.year) meta.push(m.year);
    if (m.rating) meta.push('★ ' + m.rating);
    if (m.runtime) meta.push(m.runtime + ' min');
    if (m.genres && m.genres.length) meta.push(m.genres.join(', '));
    $('detail-meta').innerHTML = meta.join('   •   ');
    $('detail-overview').innerHTML = m.overview || '';
    detailFocus = [];
    detailIdx = 0;

    var actions = $('detail-actions'); actions.innerHTML = '';
    var eps = $('detail-episodes'); eps.innerHTML = '';

    if (m.type === 'movie') {
        var btn = el('div', 'btn', 'Play');
        btn.onclick = function () { loadStreams('movie', m.id, null, null); };
        actions.appendChild(btn);
        detailFocus.push({ el: btn, action: function () { loadStreams('movie', m.id, null, null); } });
    } else {
        // Zakładki sezonów
        var tabs = el('div', 'season-tabs');
        var seasons = m.seasons || [];
        for (var s = 0; s < seasons.length; s++) {
            (function (sn) {
                var tab = el('div', 'season-tab' + (sn === currentSeason ? ' active' : ''), 'Season ' + sn);
                tab.onclick = function () { currentSeason = sn; renderDetail(); focusDetail(0); };
                tabs.appendChild(tab);
                detailFocus.push({ el: tab, action: function () { currentSeason = sn; renderDetail(); focusDetail(0); } });
            })(seasons[s].season);
        }
        eps.appendChild(tabs);
        renderEpisodes(eps);
    }
    focusDetail(detailIdx);
}

function renderEpisodes(container) {
    var m = currentMeta;
    var list = el('div', 'ep-list');
    container.appendChild(list);
    function draw(episodes) {
        for (var i = 0; i < episodes.length; i++) {
            (function (ep) {
                var row = el('div', 'ep', '<span class="epnum">E' + ep.episode + '</span>' + ep.name);
                row.onclick = function () { loadStreams('series', m.id, currentSeason, ep.episode); };
                list.appendChild(row);
                detailFocus.push({ el: row, action: function () { loadStreams('series', m.id, currentSeason, ep.episode); } });
            })(episodes[i]);
        }
        focusDetail(detailIdx);
    }
    if (episodesCache[currentSeason]) { draw(episodesCache[currentSeason]); return; }
    get(BRIDGE + '/api/episodes/' + m.id + '/' + currentSeason, function (data) {
        episodesCache[currentSeason] = data.episodes || [];
        draw(episodesCache[currentSeason]);
    });
}

function focusDetail(i) {
    clearFocusAll();
    if (i < 0) i = 0;
    if (i >= detailFocus.length) i = detailFocus.length - 1;
    detailIdx = i;
    if (detailFocus[i]) {
        var e = detailFocus[i].el;
        e.className += ' focused';
        if (e.scrollIntoView) { try { e.scrollIntoView(false); } catch (x) {} }
    }
}

// ---------- Źródła ----------
function loadStreams(type, id, season, episode) {
    loader(true, 'Finding sources in your add-ons...');
    // kontekst do zapisu postępu na koncie (tmdbId potrzebne do zamiany na imdb -> sync między urządzeniami)
    if (!playCtx || playCtx.tmdbId != id) {
        playCtx = {
            contentId: (currentMeta && currentMeta.imdb) ? currentMeta.imdb : ('tmdb:' + id),
            tmdbId: id, type: type, season: season, episode: episode
        };
    }
    var url = BRIDGE + '/api/streams/' + type + '/' + id;
    var q = [];
    if (season != null) q.push('season=' + season);
    if (episode != null) q.push('episode=' + episode);
    if (q.length) url += '?' + q.join('&');
    get(url, function (data) {
        streams = data.streams || [];
        streamIdx = 0;
        renderStreams();
        loader(false);
        show('streams');
    }, function () { loader(false); $('streams-list').innerHTML = 'Could not load sources.'; show('streams'); });
}

// Wznów z ekranu głównego: pobierz źródła i ustaw pozycję startową
function resumeItem(r) {
    resumeMs = Number(r.positionMs) || 0;
    playCtx = { contentId: r.contentId, tmdbId: r.tmdbId, type: r.type, season: r.season, episode: r.episode };
    currentMeta = { title: r.title, id: r.tmdbId, type: r.type };
    loadStreams(r.type, r.tmdbId, r.season, r.episode);
}

function fmtSize(b) {
    if (!b) return '';
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    return Math.round(b / 1048576) + ' MB';
}
function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderStreams() {
    var list = $('streams-list');
    list.innerHTML = '';
    if (!streams.length) { list.innerHTML = '<div style="font-size:30px;color:#9aa3b2">No sources available.</div>'; return; }
    for (var i = 0; i < streams.length; i++) {
        var s = streams[i];
        var sz = fmtSize(s.size);
        var html = '<div class="srow1">' +
            '<span class="q">' + esc(s.quality || '?') + '</span>' +
            '<span class="pv">' + esc(s.provider || '') + '</span>' +
            (sz ? '<span class="sz">' + esc(sz) + '</span>' : '') + '</div>';
        // pełny opis źródła 1:1 jak w dodatku (język, rozmiar, seedery)
        var desc = s.desc && s.desc !== s.title ? s.desc : (s.title || '');
        if (desc) html += '<div class="desc">' + esc(desc) + '</div>';
        list.appendChild(el('div', 'stream', html));
    }
    setStreamFocus(0);
}

function setStreamFocus(i) {
    clearFocusAll();
    var rows = $('streams-list').childNodes;
    if (i < 0) i = 0; if (i >= rows.length) i = rows.length - 1;
    streamIdx = i;
    if (rows[i] && rows[i].className !== undefined) {
        rows[i].className = 'stream focused';
        if (rows[i].scrollIntoView) { try { rows[i].scrollIntoView(false); } catch (x) {} }
    }
}

// ---------- Odtwarzacz (AVPlay) ----------
var player = null, playing = false, duration = 0;
var audioTracks = [], textTracks = [], extSubs = [];
var menuOpen = false, menuCol = 0, menuIdx = 0;
var hideTimer = null, subClearTimer = null;

function avplay() { return (window.webapis && window.webapis.avplay) ? window.webapis.avplay : null; }

// Wznowienie: przewiń do zapisanej pozycji dopiero gdy odtwarzacz gra (Tizen 2.3 nie przewija przed play)
function doPendingSeek() {
    if (pendingSeekMs <= 0) return;
    var target = Math.round(pendingSeekMs);
    pendingSeekMs = 0;                 // wyczyść przed przewinięciem, by uniknąć pętli
    var ap = avplay(); if (!ap) return;
    try { ap.seekTo(target); }
    catch (e) { try { ap.jumpForward(target); } catch (e2) {} }
    $('player-status').innerHTML = '';
}

function fmt(ms) {
    var s = Math.floor(ms / 1000); var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h > 0 ? h + ':' : '') + p(m) + ':' + p(s);
}

// pokazywanie/ukrywanie kontrolek (pełny ekran)
function showControls() {
    $('view-player').className = 'view';
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { if (view === 'player' && !menuOpen) $('view-player').className = 'view controls-hidden'; }, 4000);
}
function hideControlsNow() { if (hideTimer) clearTimeout(hideTimer); $('view-player').className = 'view controls-hidden'; }

// odczyt ścieżek audio/napisów z pliku
function langName(code) {
    code = String(code || '').toLowerCase();
    var M = { pol: 'Polish', pl: 'Polish', eng: 'English', en: 'English', ger: 'German', deu: 'German',
        de: 'German', fre: 'French', fra: 'French', fr: 'French', spa: 'Spanish', es: 'Spanish',
        ita: 'Italian', it: 'Italian', rus: 'Russian', ru: 'Russian', jpn: 'Japanese', ja: 'Japanese',
        pob: 'Portuguese (BR)', por: 'Portuguese', cze: 'Czech', ukr: 'Ukrainian' };
    return M[code] || (code ? code.toUpperCase() : '');
}
function parseExtra(ei) {
    var o = {}; try { o = JSON.parse(ei); } catch (e) { return {}; }
    return o;
}
// Formatowanie tekstu napisów: <br>, \n, \N, bloki ASS {..}, tagi -> czyste nowe wiersze + kursywa
function fmtSub(text) {
    var t = String(text || '');
    t = t.replace(/\{[^}]*\}/g, '');                 // bloki ASS/SSA {\an8} itd.
    t = t.replace(/\\N/gi, '\n').replace(/\\n/g, '\n'); // twarde/miękkie łamania ASS
    t = t.replace(/<br\s*\/?>/gi, '\n');             // <br>, <br/>
    t = t.replace(/\r/g, '\n');
    t = t.replace(/<\s*\/?\s*font[^>]*>/gi, '');     // tagi font
    // zabezpiecz kursywę/pogrubienie, usuń resztę tagów
    t = t.replace(/<\s*i\s*>/gi, 'I').replace(/<\s*\/\s*i\s*>/gi, '/I');
    t = t.replace(/<\s*b\s*>/gi, 'B').replace(/<\s*\/\s*b\s*>/gi, '/B');
    t = t.replace(/<[^>]*>/g, '');
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    t = t.replace(/I/g, '<i>').replace(/\/I/g, '</i>')
         .replace(/B/g, '<b>').replace(/\/B/g, '</b>');
    t = t.replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '');
    t = t.replace(/\n/g, '<br>');
    return t;
}
function readTracks() {
    audioTracks = []; textTracks = [];
    var ap = avplay(); if (!ap || !ap.getTotalTrackInfo) return;
    var info;
    try { info = ap.getTotalTrackInfo(); } catch (e) { return; }
    for (var i = 0; i < info.length; i++) {
        var tr = info[i]; var ex = parseExtra(tr.extra_info);
        var lang = ex.language || ex.lang || ex.track_lang || ex.language_code || '';
        if (tr.type === 'AUDIO') audioTracks.push({ index: tr.index, lang: lang, label: langName(lang) || ('Track ' + (audioTracks.length + 1)) });
        else if (tr.type === 'TEXT') textTracks.push({ index: tr.index, lang: lang, label: langName(lang) || ('Subtitles ' + (textTracks.length + 1)) });
    }
}

// napisy zewnętrzne z Twoich addonów (OpenSubtitles)
function loadExtSubs() {
    extSubs = [];
    if (!playCtx || !playCtx.tmdbId) return;
    var url = BRIDGE + '/api/subtitles/' + playCtx.type + '/' + playCtx.tmdbId;
    var q = [];
    if (playCtx.season != null) q.push('season=' + playCtx.season);
    if (playCtx.episode != null) q.push('episode=' + playCtx.episode);
    if (q.length) url += '?' + q.join('&');
    get(url, function (d) { extSubs = (d.subtitles || []).slice(0, 20); }, function () {});
}

function playStream(s) {
    var ap = avplay();
    show('player');
    $('subtitle-text').innerHTML = '';
    $('player-info').innerHTML = (currentMeta ? currentMeta.title : '') + '  —  ' + (s.quality || '');
    $('player-status').innerHTML = 'Buffering...';
    $('player-fill').style.width = '0%';
    showControls();
    if (!ap) { $('player-status').innerHTML = 'AVPlay is unavailable on this device.'; return; }
    loadExtSubs();
    try {
        try { ap.stop(); ap.close(); } catch (e0) {}
        ap.open(s.url);
        ap.setDisplayRect(0, 0, 1920, 1080);
        try { ap.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e1) {}
        ap.setListener({
            onbufferingstart: function () { $('player-status').innerHTML = 'Buffering...'; },
            onbufferingprogress: function (p) { $('player-status').innerHTML = 'Buffering ' + p + '%'; },
            onbufferingcomplete: function () {
                $('player-status').innerHTML = '';
                doPendingSeek();   // gdy bufor gotowy — przewiń do zapisanej pozycji
            },
            oncurrentplaytime: function (t) {
                if (!duration) { try { duration = ap.getDuration(); } catch (e) {} }
                // wznawianie: przewiń raz, gdy odtwarzacz faktycznie gra a jesteśmy na początku
                if (pendingSeekMs > 0 && t < pendingSeekMs - 4000) { doPendingSeek(); return; }
                if (duration > 0) $('player-fill').style.width = (t / duration * 100) + '%';
                $('player-time').innerHTML = fmt(t) + (duration ? ' / ' + fmt(duration) : '');
            },
            onsubtitlechange: function (dur, text) {
                var st = $('subtitle-text'); st.innerHTML = fmtSub(text);
                if (subClearTimer) clearTimeout(subClearTimer);
                var d = Number(dur) || 3000;
                subClearTimer = setTimeout(function () { st.innerHTML = ''; }, d > 0 ? d : 3000);
            },
            onstreamcompleted: function () { stopPlayback(); },
            onerror: function (e) { $('player-status').innerHTML = 'Playback error: ' + (e && e.name ? e.name : e); showControls(); }
        });
        ap.prepareAsync(function () {
            duration = 0;
            try { duration = ap.getDuration(); } catch (e) {}
            // NIE przewijamy przed play() (na Tizen 2.3 nie działa) — ustawiamy do zrobienia gdy gra
            pendingSeekMs = resumeMs > 3000 ? resumeMs : 0;
            ap.play();
            playing = true;
            $('player-status').innerHTML = pendingSeekMs ? 'Resuming at ' + fmt(pendingSeekMs) + '...' : '';
            readTracks();
            startProgressSync();
            showControls();
            if (pendingSeekMs) setTimeout(doPendingSeek, 1500); // zapas gdyby zdarzenia nie odpaliły
        }, function (e) { $('player-status').innerHTML = 'Could not prepare the stream.'; });
    } catch (ex) {
        $('player-status').innerHTML = 'Error: ' + ex.message;
    }
}

// ---------- Menu ścieżek: dźwięk + napisy ----------
function openTrackMenu() {
    if (!audioTracks.length) readTracks();
    menuOpen = true; menuCol = 0; menuIdx = 0;
    $('track-menu').className = '';
    $('view-player').className = 'view';
    if (hideTimer) clearTimeout(hideTimer);
    renderTrackMenu();
}
function closeTrackMenu() { menuOpen = false; $('track-menu').className = 'hidden'; showControls(); }
function subItems() {
    var arr = [{ kind: 'off', label: 'Off' }];
    for (var i = 0; i < textTracks.length; i++) arr.push({ kind: 'embed', label: textTracks[i].label + ' (embedded)', index: textTracks[i].index });
    for (var j = 0; j < extSubs.length; j++) arr.push({ kind: 'ext', label: (langName(extSubs[j].lang) || extSubs[j].lang) + ' (online)', url: extSubs[j].url });
    return arr;
}
function renderTrackMenu() {
    var aL = $('tm-audio-list'); aL.innerHTML = '';
    for (var i = 0; i < audioTracks.length; i++) {
        var cls = 'tm-item' + (menuCol === 0 && menuIdx === i ? ' focused' : '') + (curAudioIndex === audioTracks[i].index ? ' active' : '');
        aL.appendChild(el('div', cls, esc(audioTracks[i].label)));
    }
    if (!audioTracks.length) aL.appendChild(el('div', 'tm-item', 'Single track'));
    var sItems = subItems(); var sL = $('tm-subs-list'); sL.innerHTML = '';
    for (var j = 0; j < sItems.length; j++) {
        var act = (curSubKey === sItems[j].kind + (sItems[j].index != null ? sItems[j].index : sItems[j].url || ''));
        var cls2 = 'tm-item' + (menuCol === 1 && menuIdx === j ? ' focused' : '') + (act ? ' active' : '');
        sL.appendChild(el('div', cls2, esc(sItems[j].label)));
    }
}
var curAudioIndex = -1, curSubKey = 'off';
function menuLen(col) { return col === 0 ? Math.max(1, audioTracks.length) : subItems().length; }
function keyMenu(k) {
    if (k === KEY.RETURN || k === KEY.BACK) return closeTrackMenu();
    if (k === KEY.LEFT) { menuCol = 0; menuIdx = Math.min(menuIdx, menuLen(0) - 1); renderTrackMenu(); }
    else if (k === KEY.RIGHT) { menuCol = 1; menuIdx = Math.min(menuIdx, menuLen(1) - 1); renderTrackMenu(); }
    else if (k === KEY.UP) { menuIdx = menuIdx > 0 ? menuIdx - 1 : 0; renderTrackMenu(); }
    else if (k === KEY.DOWN) { menuIdx = menuIdx < menuLen(menuCol) - 1 ? menuIdx + 1 : menuIdx; renderTrackMenu(); }
    else if (k === KEY.ENTER) { menuCol === 0 ? selectAudio(menuIdx) : selectSub(menuIdx); }
}
function selectAudio(i) {
    var t = audioTracks[i]; if (!t) return;
    var ap = avplay();
    try { ap.setSelectTrack('AUDIO', t.index); curAudioIndex = t.index; } catch (e) {}
    renderTrackMenu();
}
function selectSub(i) {
    var it = subItems()[i]; if (!it) return;
    var ap = avplay();
    $('subtitle-text').innerHTML = '';
    if (it.kind === 'off') {
        try { ap.setSilentSubtitle ? ap.setSilentSubtitle(true) : null; } catch (e) {}
        curSubKey = 'off';
    } else if (it.kind === 'embed') {
        try { if (ap.setSilentSubtitle) ap.setSilentSubtitle(false); ap.setSelectTrack('TEXT', it.index); } catch (e) {}
        curSubKey = 'embed' + it.index;
    } else if (it.kind === 'ext') {
        applyExternalSub(it.url);
        curSubKey = 'ext' + it.url;
    }
    renderTrackMenu();
    closeTrackMenu();
}
// pobierz napisy online i wczytaj do AVPlay (zapis do pliku lokalnego)
function applyExternalSub(url) {
    $('player-status').innerHTML = 'Loading subtitles...';
    var x = new XMLHttpRequest();
    x.open('GET', url, true); x.timeout = 20000;
    x.onreadystatechange = function () {
        if (x.readyState === 4) {
            $('player-status').innerHTML = '';
            if (x.status >= 200 && x.status < 300 && x.responseText) {
                saveSubFile(x.responseText, function (path) {
                    if (!path) { $('subtitle-text').innerHTML = '(could not load subtitles)'; return; }
                    var ap = avplay();
                    try { if (ap.setSilentSubtitle) ap.setSilentSubtitle(false); } catch (e) {}
                    try { ap.setExternalSubtitlePath(path); } catch (e) { $('player-status').innerHTML = 'Subtitles: ' + e.message; }
                });
            } else { $('subtitle-text').innerHTML = '(subtitle error)'; }
        }
    };
    x.onerror = function () { $('player-status').innerHTML = ''; };
    x.send();
}
function saveSubFile(text, cb) {
    try {
        if (!window.tizen || !tizen.filesystem) return cb(null);
        tizen.filesystem.resolve('wgt-private-tmp', function (dir) {
            try {
                var f = dir.createFile('sub_' + Date.now() + '.srt');
                f.openStream('w', function (stream) { stream.write(text); stream.close(); cb(f.fullPath); },
                    function () { cb(null); }, 'UTF-8');
            } catch (e) { cb(null); }
        }, function () { cb(null); }, 'rw');
    } catch (e) { cb(null); }
}

// Zapis postępu na konto Nuvio (co 15 s, przy pauzie i zatrzymaniu) — kompatybilny między urządzeniami
function currentPos() { var ap = avplay(); try { return ap ? ap.getCurrentTime() : 0; } catch (e) { return 0; } }
function saveProgress() {
    if (!playCtx) return;
    var pos = currentPos();
    if (!pos || !duration) return;
    post(BRIDGE + '/me/progress', {
        contentId: playCtx.contentId, tmdbId: playCtx.tmdbId, type: playCtx.type,
        season: playCtx.season, episode: playCtx.episode,
        positionMs: pos, durationMs: duration
    });
}
function startProgressSync() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(saveProgress, 15000);
}

function stopPlayback() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    saveProgress();
    menuOpen = false; $('track-menu').className = 'hidden';
    $('subtitle-text').innerHTML = '';
    var ap = avplay();
    if (ap) { try { ap.stop(); ap.close(); } catch (e) {} }
    playing = false; duration = 0; resumeMs = 0;
    show('streams');
}

function togglePause() {
    var ap = avplay(); if (!ap) return;
    try {
        if (playing) { ap.pause(); playing = false; $('player-status').innerHTML = 'Paused'; showControls(); saveProgress(); }
        else { ap.play(); playing = true; $('player-status').innerHTML = ''; showControls(); }
    } catch (e) {}
}

function seek(deltaMs) {
    var ap = avplay(); if (!ap) return;
    showControls();
    try {
        if (deltaMs > 0) ap.jumpForward(Math.abs(deltaMs));
        else ap.jumpBackward(Math.abs(deltaMs));
    } catch (e) {}
}

// ---------- Wyszukiwarka ----------
function openSearch() { searchQuery = ''; searchItems = []; searchIdx = 0; renderSearch(); show('search'); }
function renderSearch() {
    $('search-query').innerHTML = searchQuery;
    var box = $('search-results'); box.innerHTML = '';
    for (var i = 0; i < searchItems.length; i++) {
        var it = searchItems[i];
        var card = el('div', 'card');
        if (it.poster) { var im = el('img'); im.src = it.poster; card.appendChild(im); }
        else card.appendChild(el('div', 'noimg', it.title));
        card.appendChild(el('div', 'cap', it.title));
        box.appendChild(card);
    }
    if (searchItems.length) setSearchFocus(0);
}
function setSearchFocus(i) {
    clearFocusAll();
    var rows = $('search-results').childNodes;
    if (i < 0) i = 0; if (i >= rows.length) i = rows.length - 1;
    searchIdx = i;
    if (rows[i]) { rows[i].className = 'card focused'; $('search-results').style.marginLeft = (-i * 242) + 'px'; }
}
function doSearch() {
    if (!searchQuery) return;
    loader(true, 'Searching...');
    get(BRIDGE + '/api/search?q=' + encodeURIComponent(searchQuery), function (data) {
        searchItems = data.items || []; loader(false); renderSearch();
    }, function () { loader(false); });
}

// ---------- Obsługa klawiszy ----------
function onKey(e) {
    var k = e.keyCode;
    if (view === 'login') { if (k === KEY.RETURN || k === KEY.BACK) exitApp(); return; }
    if (view === 'home') return keyHome(k);
    if (view === 'detail') return keyDetail(k);
    if (view === 'streams') return keyStreams(k);
    if (view === 'player') return keyPlayer(k);
    if (view === 'search') return keySearch(k);
}

function keyHome(k) {
    var row = homeRows[homeR];
    if (row && row.grid && (k === KEY.LEFT || k === KEY.RIGHT || k === KEY.UP || k === KEY.DOWN)) {
        var target = homeC;
        if (k === KEY.LEFT && homeC % 8 > 0) target--;
        if (k === KEY.RIGHT && homeC % 8 < 7 && homeC + 1 < row.items.length) target++;
        if (k === KEY.UP && homeC >= 8) target -= 8;
        if (k === KEY.DOWN && Math.floor(homeC / 8) < Math.floor((row.items.length - 1) / 8)) target = Math.min(homeC + 8, row.items.length - 1);
        setHomeFocus(homeR, target);
        return;
    }
    if (k === KEY.RIGHT) setHomeFocus(homeR, homeC + 1);
    else if (k === KEY.LEFT) {
        if (homeC === 0) openSearch(); else setHomeFocus(homeR, homeC - 1);
    }
    else if (k === KEY.DOWN) setHomeFocus(homeR + 1 < homeRows.length ? homeR + 1 : homeR, homeC);
    else if (k === KEY.UP) setHomeFocus(homeR > 0 ? homeR - 1 : 0, homeC);
    else if (k === KEY.ENTER) {
        var it = homeRows[homeR] && homeRows[homeR].items[homeC];
        if (homeRows[homeR] && homeRows[homeR].state === 'error') return loadHomeRow(homeR, true);
        if (it && it.type === 'folder') openFolder(it);
        else if (it && it.resume) resumeItem(it.resume);
        else if (it) openDetail(it);
    }
    else if (k === KEY.RETURN || k === KEY.BACK) backFromHome();
}

function keyDetail(k) {
    if (k === KEY.DOWN) focusDetail(detailIdx + 1);
    else if (k === KEY.UP) focusDetail(detailIdx - 1);
    else if (k === KEY.RIGHT) focusDetail(detailIdx + 1);
    else if (k === KEY.LEFT) focusDetail(detailIdx - 1);
    else if (k === KEY.ENTER) { if (detailFocus[detailIdx]) detailFocus[detailIdx].action(); }
    else if (k === KEY.RETURN || k === KEY.BACK) { show('home'); setHomeFocus(homeR, homeC); }
}

function keyStreams(k) {
    if (k === KEY.DOWN) setStreamFocus(streamIdx + 1);
    else if (k === KEY.UP) setStreamFocus(streamIdx - 1);
    else if (k === KEY.ENTER) { if (streams[streamIdx]) playStream(streams[streamIdx]); }
    else if (k === KEY.RETURN || k === KEY.BACK) show('detail');
}

function keyPlayer(k) {
    if (menuOpen) return keyMenu(k);
    if (k === KEY.RETURN || k === KEY.BACK || k === KEY.STOP) stopPlayback();
    else if (k === KEY.UP || k === KEY.YELLOW || k === KEY.GREEN) openTrackMenu();
    else if (k === KEY.ENTER || k === KEY.PLAYPAUSE || k === KEY.PLAY || k === KEY.PAUSE) togglePause();
    else if (k === KEY.RIGHT || k === KEY.FF) seek(30000);
    else if (k === KEY.LEFT || k === KEY.RW) seek(-15000);
    else if (k === KEY.DOWN) showControls();
}

function keySearch(k) {
    if (k >= 48 && k <= 57) { searchQuery += String.fromCharCode(k); renderSearch(); }
    else if (k >= 65 && k <= 90) { searchQuery += String.fromCharCode(k + 32); renderSearch(); }
    else if (k === 8 || k === 65376) { searchQuery = searchQuery.slice(0, -1); renderSearch(); }
    else if (k === KEY.ENTER) {
        if ($('search-results').childNodes.length && document.querySelector('#search-results .focused')) {
            if (searchItems[searchIdx]) return openDetail(searchItems[searchIdx]);
        }
        doSearch();
    }
    else if (k === KEY.RIGHT) setSearchFocus(searchIdx + 1);
    else if (k === KEY.LEFT) setSearchFocus(searchIdx - 1);
    else if (k === 32) { searchQuery += ' '; renderSearch(); }
    else if (k === KEY.RETURN || k === KEY.BACK) show('home');
}

function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* przeglądarka */ }
}

// ---------- Zegar ----------
function tickClock() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    $('clock').innerHTML = p(d.getHours()) + ':' + p(d.getMinutes());
}

// ---------- Start ----------
function registerKeys() {
    if (window.tizen && tizen.tvinputdevice) {
        var keys = ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop',
            'MediaFastForward', 'MediaRewind', 'ColorF0Red', 'ColorF1Green',
            'ColorF2Yellow', 'ColorF3Blue', 'Info'];
        for (var i = 0; i < keys.length; i++) { try { tizen.tvinputdevice.registerKey(keys[i]); } catch (e) {} }
    }
}

// Dopasuj warstwę UI do realnego rozmiaru ekranu (viewport bywa 1280 lub 1920)
// SAFE < 1 = margines na overscan starych TV (panel obcina brzegi). Interfejs wyśrodkowany.
var SAFE = 0.985;
function fitScreen() {
    var w = window.innerWidth || document.documentElement.clientWidth || 1920;
    var h = window.innerHeight || document.documentElement.clientHeight || 1080;
    var s = Math.min(w / 1920, h / 1080) * SAFE;
    var tx = Math.round((w - 1920 * s) / 2), ty = Math.round((h - 1080 * s) / 2);
    var appEl = $('app');
    var tr = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    appEl.style.webkitTransform = tr;
    appEl.style.transform = tr;
}

function init() {
    fitScreen();
    window.addEventListener('resize', fitScreen);
    registerKeys();
    document.addEventListener('keydown', onKey);
    tickClock(); setInterval(tickClock, 15000);
    show('login');
    $('login-status').innerHTML = 'Connecting to your account...';
    get(BRIDGE + '/me/status', function (s) {
        if (s.loggedIn) enterApp();
        else startLogin();
    }, function () { $('login-status').innerHTML = 'Could not connect to the Nuvio bridge. Retrying...'; setTimeout(init, 4000); });
}

window.onload = init;
})();
