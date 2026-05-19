/* ============================================================
   THE BASELINE — app.js
   Live tennis & sports scoreboard for GitHub Pages
   ============================================================ */

// ── CONFIG ──────────────────────────────────────────────────
const CFG = {
  tennis: {
    base:  'https://api.api-tennis.com/tennis/',
    ws:    'wss://wss.api-tennis.com/live',
    key:   'cd7c6c012ab1258a9586729e58a45a320e4839f8076f31bcb74647e7207e50cc',
    proxy: 'https://corsproxy.io/?'
  },
  bdl: {
    base: 'https://api.balldontlie.io/v1',
    key:  'd8f3404b-a7dd-4d13-b910-a1ea6dc70944'
  },
  apisports: {
    nba: 'https://v2.nba.api-sports.io',
    mlb: 'https://v1.baseball.api-sports.io',
    nfl: 'https://v1.american-football.api-sports.io',
    key: 'a036eab03fed9a1c3ddc3164bc3a4592'
  }
};

// ── STATE ───────────────────────────────────────────────────
const S = {
  sport:       'tennis',
  view:        'scores',
  dateOffset:  0,
  filter:      'all',
  matches:     new Map(),   // event_key → match object
  ws:          null,
  wsRetries:   0,
  wsMax:       3,
  wsTimer:     null,
  pollTimer:   null,
  usePoll:     false,
  lastUpdate:  null
};

// ── UTILITIES ───────────────────────────────────────────────
function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
}

function fmtDateShort(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtTime12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ampm}`;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function ordinal(n) {
  const v = n % 100;
  return ['th','st','nd','rd'][(v - 20) % 10] || ['th','st','nd','rd'][v] || 'th';
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── MATCH STATUS HELPERS ─────────────────────────────────────
function isLive(status = '') {
  const s = status.toLowerCase().trim();
  return s.includes('set') || s === 'live' || s === 'in progress' ||
    /^\d+(st|nd|rd|th)\s+set/i.test(status) || s === 'break' || s === 'tiebreak';
}

function isFinished(status = '') {
  const s = status.toLowerCase().trim();
  return ['finished','fin','aot','retired','walkover','w/o','cancelled','postponed','abandoned'].includes(s) ||
    s === 'after overtime';
}

function matchCategory(eventType = '') {
  const t = eventType.toLowerCase();
  if (t.includes('double')) return 'doubles';
  if (t.includes('atp'))    return 'atp';
  if (t.includes('wta'))    return 'wta';
  if (t.includes('challenger') && t.includes('women')) return 'challenger-w';
  if (t.includes('challenger')) return 'challenger-m';
  if (t.includes('itf') && t.includes('women')) return 'itf-w';
  if (t.includes('itf')) return 'itf-m';
  return 'other';
}

function surfaceClass(surface = '') {
  const s = surface.toLowerCase();
  if (s.includes('clay'))   return 'clay';
  if (s.includes('grass'))  return 'grass';
  if (s.includes('indoor') || s.includes('carpet')) return 'indoor';
  return 'hard';
}

function cleanScore(s) {
  // Strip tiebreak notation "(4)" and any decimals — show only the whole number
  return String(s ?? '').replace(/\(.*?\)/g, '').split('.')[0].trim();
}

function parseSets(m) {
  const sets = [];
  if (m.scores && typeof m.scores === 'object') {
    const keys = Object.keys(m.scores).map(Number).filter(k => !isNaN(k)).sort((a,b)=>a-b);
    for (const k of keys) {
      const s = m.scores[k];
      if (s && (s.score_first !== undefined)) {
        sets.push({ p1: cleanScore(s.score_first), p2: cleanScore(s.score_second) });
      }
    }
  }
  if (sets.length === 0 && m.event_final_result) {
    for (const part of m.event_final_result.split(',')) {
      const halves = part.trim().split('-');
      if (halves.length >= 2) sets.push({ p1: cleanScore(halves[0]), p2: cleanScore(halves[1]) });
    }
  }
  return sets;
}

// ── CONNECTION UI ────────────────────────────────────────────
function setConn(status, msg) {
  const bar   = document.getElementById('conn-bar');
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  const msgEl = document.getElementById('conn-msg');
  bar.className   = `conn-${status}`;
  dot.className   = `conn-dot conn-${status}`;
  label.textContent = status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline';
  msgEl.textContent = msg;
  if (status === 'connected') { S.lastUpdate = new Date(); refreshLastUpdated(); }
}

function refreshLastUpdated() {
  const el = document.getElementById('last-update-time');
  if (!el || !S.lastUpdate) return;
  const sec = Math.round((Date.now() - S.lastUpdate) / 1000);
  el.textContent = sec < 5 ? 'Updated just now'
    : sec < 60 ? `Updated ${sec}s ago`
    : `Updated ${Math.round(sec / 60)}m ago`;
}
setInterval(refreshLastUpdated, 10000);

// ── TENNIS REST API ──────────────────────────────────────────
async function tennisFetch(method, params = {}) {
  const url = new URL(CFG.tennis.base);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', CFG.tennis.key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // api-tennis.com sends Access-Control-Allow-Origin: * so no proxy needed
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.success === 0) throw new Error(json.errors || 'API error');
  return json.result || [];
}

async function loadFixtures(offset = 0) {
  showLoading('matches-area', 'Loading matches…');
  try {
    const d = dateStr(offset);
    const results = await tennisFetch('get_fixtures', { date_start: d, date_stop: d });
    for (const m of results) S.matches.set(m.event_key, m);
    renderMatches(results);
    renderOverview(results);
    renderSidebar(results);
  } catch (err) {
    console.error('Fixtures error:', err);
    showError('matches-area', `Could not load matches — ${err.message}`, `loadFixtures(${offset})`);
  }
}

async function loadLivescores() {
  try {
    const results = await tennisFetch('get_livescore');
    for (const m of results) {
      S.matches.set(m.event_key, m);
      patchRow(m);
    }
    setConn('connected', `Polling — ${results.length} live match${results.length !== 1 ? 'es' : ''}`);
  } catch (err) {
    console.warn('Livescore poll error:', err);
  }
}

async function loadRankings() {
  showLoading('rankings-area', 'Loading rankings…');
  try {
    const [atpR, wtaR] = await Promise.allSettled([
      tennisFetch('get_standings', { event_type: 'ATP Singles' }),
      tennisFetch('get_standings', { event_type: 'WTA Singles' })
    ]);
    renderRankings(
      atpR.status === 'fulfilled' ? atpR.value : [],
      wtaR.status === 'fulfilled' ? wtaR.value : []
    );
  } catch (err) {
    showError('rankings-area', `Could not load rankings — ${err.message}`, 'loadRankings()');
  }
}

// ── WEBSOCKET ────────────────────────────────────────────────
function wsConnect() {
  if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
  setConn('connecting', 'Connecting to live updates…');

  try {
    S.ws = new WebSocket(`${CFG.tennis.ws}?APIkey=${CFG.tennis.key}`);

    S.ws.onopen = () => {
      S.wsRetries = 0; S.usePoll = false;
      if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
      setConn('connected', 'Live updates active');
      // Some APIs want key sent as first message
      try { S.ws.send(JSON.stringify({ action: 'subscribe', APIkey: CFG.tennis.key })); } catch {}
    };

    S.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        const updates = Array.isArray(data) ? data : [data];
        let count = 0;
        for (const u of updates) {
          if (!u.event_key) continue;
          const merged = { ...(S.matches.get(u.event_key) || {}), ...u };
          S.matches.set(u.event_key, merged);
          patchRow(merged);
          count++;
        }
        if (count > 0) { S.lastUpdate = new Date(); refreshLastUpdated(); }
      } catch {}
    };

    S.ws.onerror = () => {};

    S.ws.onclose = () => {
      S.ws = null;
      setConn('disconnected', 'Live updates disconnected');
      if (S.wsRetries < S.wsMax) {
        S.wsRetries++;
        setConn('connecting', `Reconnecting… (${S.wsRetries}/${S.wsMax})`);
        S.wsTimer = setTimeout(wsConnect, 15000);
      } else {
        startPoll();
      }
    };
  } catch {
    startPoll();
  }
}

function startPoll() {
  S.usePoll = true;
  setConn('disconnected', 'Live mode unavailable — polling every 30s');
  if (!S.pollTimer) {
    loadLivescores();
    S.pollTimer = setInterval(loadLivescores, 30000);
  }
}

function wsDisconnect() {
  if (S.ws)     { S.ws.onclose = null; S.ws.close(); S.ws = null; }
  if (S.wsTimer)  { clearTimeout(S.wsTimer);   S.wsTimer = null; }
  if (S.pollTimer){ clearInterval(S.pollTimer); S.pollTimer = null; }
}

// ── TENNIS RENDERING ─────────────────────────────────────────
function renderMatches(all) {
  const area = document.getElementById('matches-area');
  const filtered = all.filter(m => filterPasses(m));

  if (!filtered.length) {
    area.innerHTML = '<div class="empty-state">No matches found for this date or filter.</div>';
    return;
  }

  // ── LIVE NOW section ──
  const liveMatches = filtered.filter(m => isLive(m.event_status));
  let html = '';
  if (liveMatches.length) {
    html += `
      <div class="live-now-section">
        <div class="live-now-header">
          <span class="live-now-dot">●</span>
          LIVE NOW
          <span class="live-now-count">${liveMatches.length} match${liveMatches.length !== 1 ? 'es' : ''}</span>
        </div>
        ${liveMatches.map(m => buildMatchRow(m, true)).join('')}
      </div>`;
  }

  // ── Category sections → tournament groups ──
  const CATS = [
    { key: 'atp',          label: 'ATP Singles' },
    { key: 'wta',          label: 'WTA Singles' },
    { key: 'doubles',      label: 'Doubles' },
    { key: 'challenger-m', label: 'Challenger Men' },
    { key: 'challenger-w', label: 'Challenger Women' },
    { key: 'itf-m',        label: 'ITF Men' },
    { key: 'itf-w',        label: 'ITF Women' },
    { key: 'other',        label: 'Other' },
  ];

  // Group by category then tournament
  const catMap = new Map();
  for (const m of filtered) {
    const cat = matchCategory(m.event_type || '');
    if (!catMap.has(cat)) catMap.set(cat, new Map());
    const tKey = m.league_name || m.tournament_name || m.event_type || 'Other';
    const tMap = catMap.get(cat);
    if (!tMap.has(tKey)) tMap.set(tKey, { name: tKey, surface: m.tournament_surface || '', type: m.event_type || '', matches: [] });
    tMap.get(tKey).matches.push(m);
  }

  for (const { key, label } of CATS) {
    const tMap = catMap.get(key);
    if (!tMap) continue;
    const hasLive = [...tMap.values()].some(g => g.matches.some(m => isLive(m.event_status)));
    const sortedGroups = [...tMap.values()].sort((a, b) => {
      const al = a.matches.some(m => isLive(m.event_status)) ? 0 : 1;
      const bl = b.matches.some(m => isLive(m.event_status)) ? 0 : 1;
      return al - bl;
    });
    html += `
      <div class="category-section">
        <div class="category-section-header" data-cat="${key}">
          ${label}
          ${hasLive ? '<span class="live-badge pulse">LIVE</span>' : ''}
        </div>
        ${sortedGroups.map(g => buildGroup(g)).join('')}
      </div>`;
  }

  area.innerHTML = html;
}

function buildGroup(g) {
  const hasLive = g.matches.some(m => isLive(m.event_status));
  const sc = surfaceClass(g.surface);
  const sortedM = [...g.matches].sort((a, b) => {
    const al = isLive(a.event_status) ? 0 : 1;
    const bl = isLive(b.event_status) ? 0 : 1;
    if (al !== bl) return al - bl;
    return (a.event_time || '').localeCompare(b.event_time || '');
  });

  return `
    <div class="tournament-group" id="tg-${slugify(g.name)}" data-expanded="true">
      <div class="tournament-header" onclick="toggleGroup(this)">
        <span class="surface-dot ${sc}" title="${esc(g.surface || 'hard')}"></span>
        <span class="tournament-name">${esc(g.name)}</span>
        <span class="category-badge">${esc(g.type)}</span>
        ${hasLive ? '<span class="live-badge">LIVE</span>' : ''}
        <span class="collapse-icon">▾</span>
      </div>
      <div class="tournament-matches">
        ${sortedM.map(m => buildMatchRow(m)).join('')}
      </div>
    </div>`;
}

function buildMatchRow(m, liteMode = false) {
  const live     = isLive(m.event_status);
  const finished = isFinished(m.event_status);
  const sets     = parseSets(m);
  const serve    = m.event_serve;

  const statusHTML = live
    ? `<span class="status live-status">● LIVE</span>`
    : finished
    ? `<span class="status fin-status">FIN</span>`
    : `<span class="status time-status">${esc(fmtTime12(m.event_time))}</span>`;

  const setsHTML = sets.map((s, i) => {
    const cur = live && i === sets.length - 1;
    return `<span class="set-score ${cur ? 'current-set' : ''}">${esc(s.p1)}<br>${esc(s.p2)}</span>`;
  }).join('');

  const gameHTML = live && m.event_game_result
    ? `<span class="game-score">${esc(m.event_game_result).replace('-','<br>')}</span>`
    : '';

  const p1serve = serve === '1' ? '<span class="serve-dot">▶</span>' : '';
  const p2serve = serve === '2' ? '<span class="serve-dot">▶</span>' : '';

  const key = esc(m.event_key);

  const detailPanel = liteMode ? '' : `
    <div class="match-detail" id="md-${key}" style="display:none">
      <div class="detail-inner">
        <div class="detail-header">
          <span class="detail-player">${esc(m.event_first_player||'—')}</span>
          <span class="detail-vs">vs</span>
          <span class="detail-player">${esc(m.event_second_player||'—')}</span>
        </div>
        <div class="detail-sets" id="ds-${key}">${buildDetailSets(sets)}</div>
        <div class="detail-game" id="dg-${key}" style="${live?'':'display:none'}">
          Current game: ${esc(m.event_game_result||'—')}
        </div>
        <div class="detail-status">Status: ${esc(m.event_status||'Unknown')}</div>
      </div>
    </div>`;

  return `
    <div class="match-row ${live?'live':''} ${finished?'finished':''}"
         data-key="${key}"
         onclick="${liteMode ? `jumpTo('${slugify(m.league_name||m.tournament_name||'')}')` : `toggleDetail('${key}')`}">
      <div class="match-status">${statusHTML}</div>
      <div class="match-players">
        <div class="player p1 ${serve==='1'?'serving':''}">
          <span class="player-name">${esc(m.event_first_player||'—')}</span>${p1serve}
        </div>
        <div class="player p2 ${serve==='2'?'serving':''}">
          <span class="player-name">${esc(m.event_second_player||'—')}</span>${p2serve}
        </div>
      </div>
      <div class="match-scores">
        <div class="sets-area">${setsHTML}</div>
        ${gameHTML}
      </div>
    </div>${detailPanel}`;
}

function buildDetailSets(sets) {
  if (!sets.length) return '<span style="color:var(--text-muted);font-size:.8rem">No set data yet</span>';
  return sets.map((s, i) => `
    <div class="detail-set">
      <div class="detail-set-label">Set ${i+1}</div>
      <div class="detail-set-scores">${esc(s.p1)} — ${esc(s.p2)}</div>
    </div>`).join('');
}

// Patch all instances of a match row (live section + main section)
function patchRow(m) {
  const rows = document.querySelectorAll(`.match-row[data-key="${m.event_key}"]`);
  if (!rows.length) return;
  rows.forEach(row => patchSingleRow(row, m));
}

function patchSingleRow(row, m) {

  const live     = isLive(m.event_status);
  const finished = isFinished(m.event_status);
  const sets     = parseSets(m);
  const serve    = m.event_serve;

  row.className = `match-row ${live?'live':''} ${finished?'finished':''}`;

  // Status
  const statusEl = row.querySelector('.match-status');
  if (statusEl) {
    statusEl.innerHTML = live
      ? `<span class="status live-status">● LIVE</span>`
      : finished
      ? `<span class="status fin-status">FIN</span>`
      : `<span class="status time-status">${esc(fmtTime12(m.event_time))}</span>`;
  }

  // Sets
  const setsArea = row.querySelector('.sets-area');
  if (setsArea) {
    setsArea.innerHTML = sets.map((s, i) => {
      const cur = live && i === sets.length - 1;
      return `<span class="set-score ${cur?'current-set':''}">${esc(s.p1)}<br>${esc(s.p2)}</span>`;
    }).join('');
  }

  // Game score
  const scoresDiv = row.querySelector('.match-scores');
  let gameEl = row.querySelector('.game-score');
  if (live && m.event_game_result) {
    if (!gameEl && scoresDiv) {
      gameEl = document.createElement('span');
      gameEl.className = 'game-score';
      scoresDiv.appendChild(gameEl);
    }
    if (gameEl) gameEl.innerHTML = esc(m.event_game_result).replace('-','<br>');
  } else if (gameEl) {
    gameEl.remove();
  }

  // Serve indicator
  patchServe(row.querySelector('.player.p1'), serve === '1');
  patchServe(row.querySelector('.player.p2'), serve === '2');

  // Detail panel (if open)
  const dsEl = document.getElementById(`ds-${m.event_key}`);
  if (dsEl) dsEl.innerHTML = buildDetailSets(sets);
  const dgEl = document.getElementById(`dg-${m.event_key}`);
  if (dgEl) {
    dgEl.style.display = live ? '' : 'none';
    dgEl.textContent = `Current game: ${m.event_game_result || '—'}`;
  }
}

function patchServe(el, isServing) {
  if (!el) return;
  el.classList.toggle('serving', isServing);
  let dot = el.querySelector('.serve-dot');
  if (isServing && !dot) {
    dot = document.createElement('span');
    dot.className = 'serve-dot';
    dot.textContent = '▶';
    el.appendChild(dot);
  } else if (!isServing && dot) {
    dot.remove();
  }
}

function renderOverview(matches) {
  const counts = { atp:0, wta:0, chal:0, itf:0 };
  const lives  = { atp:0, wta:0, chal:0, itf:0 };
  for (const m of matches) {
    const cat = matchCategory(m.event_type || '');
    const live = isLive(m.event_status);
    if (cat === 'atp' || cat === 'doubles') { counts.atp++; if (live) lives.atp++; }
    else if (cat === 'wta')        { counts.wta++; if (live) lives.wta++; }
    else if (cat.startsWith('challenger')) { counts.chal++; if (live) lives.chal++; }
    else if (cat.startsWith('itf'))        { counts.itf++;  if (live) lives.itf++;  }
  }
  for (const [k, cnt] of Object.entries(counts)) {
    const cEl = document.getElementById(`ov-${k}-count`);
    const lEl = document.getElementById(`ov-${k}-live`);
    if (cEl) cEl.textContent = cnt;
    if (lEl) lEl.innerHTML = lives[k] > 0
      ? `<span class="live-badge pulse">${lives[k]} live</span>` : '';
  }
}

function renderSidebar(matches) {
  const groups = new Map();
  for (const m of matches) {
    const name = m.league_name || m.tournament_name || 'Unknown';
    if (!groups.has(name)) groups.set(name, { name, surface: m.tournament_surface || '', count: 0, live: 0 });
    const g = groups.get(name);
    g.count++;
    if (isLive(m.event_status)) g.live++;
  }
  const list = document.getElementById('tournament-list');
  if (!groups.size) { list.innerHTML = '<div class="sidebar-empty">No tournaments</div>'; return; }
  list.innerHTML = [...groups.values()].map(g => `
    <div class="sidebar-tournament" onclick="jumpTo('${slugify(g.name)}')">
      <span class="surface-dot ${surfaceClass(g.surface)}"></span>
      <span class="sidebar-t-name">${esc(g.name)}</span>
      <span class="sidebar-t-count">${g.count}${g.live > 0 ? ` <span class="live-badge-sm">🔴${g.live}</span>` : ''}</span>
    </div>`).join('');
}

function renderRankings(atp, wta) {
  const col = (data, title) => {
    if (!data.length) return `<div class="rankings-col"><h3>${title}</h3><div class="empty-state">No data available</div></div>`;
    return `<div class="rankings-col">
      <h3>${title}</h3>
      <div class="ranking-header"><span>Rank</span><span>Player</span><span>Points</span></div>
      ${data.slice(0,20).map((p,i) => `
        <div class="ranking-row">
          <span class="rank-num">${esc(p.standing_place||i+1)}</span>
          <span class="rank-name">${esc(p.team_name||p.player_name||'—')}</span>
          <span class="rank-pts">${esc(p.points||'—')}</span>
        </div>`).join('')}
    </div>`;
  };
  document.getElementById('rankings-area').innerHTML =
    `<div class="rankings-grid">${col(atp,'ATP Rankings')}${col(wta,'WTA Rankings')}</div>`;
}

// ── FILTER ───────────────────────────────────────────────────
function filterPasses(m) {
  if (S.filter === 'all') return true;
  return matchCategory(m.event_type || '') === S.filter;
}

function applyFilter(filter) {
  S.filter = filter;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.filter === filter));
  renderMatches([...S.matches.values()]);
}

// ── DATE BAR ─────────────────────────────────────────────────
function renderDateBar() {
  const labels  = ['Yesterday','Today','Tomorrow','+2','+3'];
  const offsets = [-1, 0, 1, 2, 3];
  document.getElementById('date-tabs-container').innerHTML = offsets.map((off, i) =>
    `<button class="date-tab ${off===S.dateOffset?'active':''}" onclick="pickDate(${off})">
       <span class="date-label">${labels[i]}</span>
       <span class="date-value">${fmtDateShort(dateStr(off))}</span>
     </button>`).join('');
}

function pickDate(offset) {
  S.dateOffset = offset;
  S.matches.clear();
  renderDateBar();
  loadFixtures(offset);
}

// ── SPORT / VIEW SWITCHING ───────────────────────────────────
function switchSport(sport) {
  S.sport = sport;
  document.querySelectorAll('.sport-tab').forEach(t => t.classList.toggle('active', t.dataset.sport === sport));

  const isTennis = sport === 'tennis';
  document.querySelectorAll('.tennis-only').forEach(el => el.style.display = isTennis ? '' : 'none');

  const secTab = document.getElementById('secondary-tab');
  if (isTennis) {
    secTab.textContent = 'Rankings'; secTab.dataset.view = 'secondary';
  } else {
    secTab.textContent = 'Standings'; secTab.dataset.view = 'secondary';
  }

  switchView('scores');

  if (isTennis) {
    wsDisconnect(); wsConnect();
    loadFixtures(S.dateOffset);
  } else {
    wsDisconnect();
    setConn('disconnected', `${sport.toUpperCase()} scores — no live connection needed`);
    loadOtherScores(sport);
  }
}

function switchView(view) {
  S.view = view;
  document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));

  if (S.sport === 'tennis') {
    if (view === 'scores') {
      document.getElementById('view-tennis-scores').classList.add('active');
    } else {
      document.getElementById('view-tennis-rankings').classList.add('active');
      loadRankings();
    }
  } else {
    if (view === 'scores') {
      document.getElementById('view-other-scores').classList.add('active');
      loadOtherScores(S.sport);
    } else {
      document.getElementById('view-other-standings').classList.add('active');
      loadOtherStandings(S.sport);
    }
  }
}

// ── OTHER SPORTS (ESPN primary, BDL + API-Sports fallback) ────
async function loadOtherScores(sport) {
  showLoading('other-scores-area', `Loading ${sport.toUpperCase()} games…`);
  try {
    let games = []; let src = 'ESPN';
    try {
      games = await espnGames(sport);
    } catch (e) {
      console.warn('ESPN failed:', e.message, '— trying BallDontLie');
      src = 'BallDontLie';
      try {
        games = await bdlGames(sport, dateStr(0));
      } catch (e2) {
        console.warn('BDL failed:', e2.message, '— trying API-Sports');
        src = 'API-Sports';
        games = await apiSportsGames(sport, dateStr(0));
      }
    }
    renderOtherScores(games, sport, src);
  } catch (err) {
    showError('other-scores-area', `Could not load ${sport.toUpperCase()} — ${err.message}`, `loadOtherScores('${sport}')`);
  }
}

async function espnGames(sport) {
  const paths = {
    nba:  'basketball/nba',
    wnba: 'basketball/wnba',
    mlb:  'baseball/mlb',
    nfl:  'football/nfl',
    nhl:  'hockey/nhl'
  };
  if (!paths[sport]) throw new Error('unknown sport');
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${paths[sport]}/scoreboard`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  return (d.events || []).map(ev => {
    const comp = ev.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === 'home') || comp.competitors[0];
    const away = comp.competitors.find(c => c.homeAway === 'away') || comp.competitors[1];
    const st   = comp.status || ev.status || {};
    const state = st.type?.state || '';
    return {
      id: ev.id,
      league: sport.toUpperCase(),
      homeTeam: home?.team?.shortDisplayName || home?.team?.name || '—',
      awayTeam: away?.team?.shortDisplayName || away?.team?.name || '—',
      homeScore: state !== 'pre' ? (home?.score ?? '') : '',
      awayScore: state !== 'pre' ? (away?.score ?? '') : '',
      status: st.type?.shortDetail || st.type?.description || '—',
      period: st.period || '',
      time: st.displayClock || '',
      sport
    };
  });
}

async function bdlGames(sport, date) {
  const paths = { nba: '/games', mlb: '/baseball/games', nfl: '/nfl/games' };
  if (!paths[sport]) throw new Error('unknown sport');
  const url = `${CFG.bdl.base}${paths[sport]}?start_date=${date}&end_date=${date}&per_page=100`;
  const res = await fetch(url, { headers: { Authorization: CFG.bdl.key } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  // BallDontLie only covers the major US league for each sport
  const leagueName = sport === 'nba' ? 'NBA' : sport === 'mlb' ? 'MLB' : 'NFL';
  return (d.data || []).map(g => ({
    id: g.id,
    league: leagueName,
    homeTeam: g.home_team?.full_name || g.home_team?.name || '—',
    awayTeam: g.visitor_team?.full_name || g.visitor_team?.name || '—',
    homeScore: g.home_team_score ?? '',
    awayScore: g.visitor_team_score ?? '',
    status: g.status || '',
    period: g.period || '',
    time: g.time || '',
    sport
  }));
}

async function apiSportsGames(sport, date) {
  const base = CFG.apisports[sport];
  if (!base) throw new Error('unknown sport');
  // Filter MLB to league 1 (MLB only) to exclude NPB, KBO, etc.
  const leagueParam = sport === 'mlb' ? '&league=1' : '';
  const season = new Date().getFullYear();
  const res = await fetch(`${base}/games?date=${date}${leagueParam}&season=${season}`, {
    headers: { 'x-apisports-key': CFG.apisports.key }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  return (d.response || []).map(g => ({
    id: g.id,
    league: g.league?.name || sport.toUpperCase(),
    homeTeam: g.teams?.home?.name || '—',
    awayTeam: (g.teams?.visitors || g.teams?.away)?.name || '—',
    homeScore: g.scores?.home?.points ?? g.scores?.home?.total ?? '',
    awayScore: (g.scores?.visitors || g.scores?.away)?.points ?? (g.scores?.visitors || g.scores?.away)?.total ?? '',
    status: g.status?.long || g.status?.short || '—',
    period: g.periods?.current || g.quarter || '',
    time: g.status?.clock || '',
    sport
  }));
}

function buildOtherRow(g) {
  const st = g.status || '';
  // ESPN live: "Q3 5:32", "OT 1:15", "Bot 7th", "Top 3rd", "Mid 5th"
  // BDL/APS live: "In Progress", "Q1", "H1"
  const live = /^(Q[1-4]|OT)\s+\d/i.test(st)
    || /^(Top|Bot|Mid)\s+\d/i.test(st)
    || /^(In.Progress|live|ongoing|H[1-2])$/i.test(st)
    || /^\d+(st|nd|rd|th)\s*(quarter|period|inning)/i.test(st);
  // ESPN final: "Final", "Final/OT", "F/OT"  BDL: "Final"
  const fin  = /^Final/i.test(st) || /^F(\/|$)/i.test(st) || ['FT','Finished','Complete'].includes(st);
  const periodLabel = g.period ? `${g.period}${ordinal(+g.period || 0)}` : '';
  return `
    <div class="other-match-row ${live?'live':''}">
      <div class="other-status">
        ${live ? '<span class="live-badge">LIVE</span>' : fin ? '<span class="fin-badge">FIN</span>' : `<span style="font-size:.78rem;color:var(--text-muted)">${esc(g.status)}</span>`}
      </div>
      <div class="other-teams">
        <div class="other-team away">${esc(g.awayTeam)}</div>
        <div class="other-team home">${esc(g.homeTeam)}</div>
      </div>
      <div class="other-scores">
        <div class="other-score">${g.awayScore !== '' ? esc(g.awayScore) : '—'}</div>
        <div class="other-score">${g.homeScore !== '' ? esc(g.homeScore) : '—'}</div>
      </div>
      ${live && (periodLabel || g.time) ? `<div class="other-period">${esc(periodLabel)} ${esc(g.time)}</div>` : '<div></div>'}
    </div>`;
}

function renderOtherScores(games, sport, src) {
  const area = document.getElementById('other-scores-area');
  if (!games.length) {
    const offMsg = sport === 'nfl' ? '<p class="muted">The NFL season runs September–February.</p>' : '';
    area.innerHTML = `<div class="empty-state"><p>No ${sport.toUpperCase()} games today.</p>${offMsg}</div>`;
    return;
  }

  // Group by league so MLB doesn't bleed into NPB/KBO etc.
  const groups = new Map();
  for (const g of games) {
    const key = g.league || sport.toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }

  let html = `<div class="source-badge">Source: ${esc(src)}</div>`;
  for (const [league, leagueGames] of groups) {
    html += `
      <div class="league-group">
        <div class="league-header">${esc(league)}</div>
        <div class="other-games-list">${leagueGames.map(g => buildOtherRow(g)).join('')}</div>
      </div>`;
  }
  area.innerHTML = html;
}

async function loadOtherStandings(sport) {
  showLoading('other-standings-area', 'Loading standings…');
  try {
    // ESPN standings (covers all sports we need)
    const espnPaths = {
      nba:  'basketball/nba',
      wnba: 'basketball/wnba',
      nhl:  'hockey/nhl',
      mlb:  'baseball/mlb',
      nfl:  'football/nfl'
    };
    const path = espnPaths[sport];
    if (path) {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/standings`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      renderESPNStandings(j, sport);
      return;
    }
    // Fallback: BDL/API-Sports for any unhandled sport
    throw new Error('No standings source for this sport');
  } catch (err) {
    showError('other-standings-area', `Could not load standings — ${err.message}`, `loadOtherStandings('${sport}')`);
  }
}

function renderESPNStandings(data, sport) {
  const area = document.getElementById('other-standings-area');
  const groups = data.children || data.standings?.entries ? [data] : (data.children || []);

  if (!groups.length && !data.standings) {
    area.innerHTML = '<div class="empty-state">No standings data available.</div>';
    return;
  }

  let html = '<div class="source-badge">Source: ESPN</div>';

  // ESPN wraps standings in conference/division groups
  const sections = data.children?.length ? data.children : [data];
  for (const section of sections) {
    const name = section.name || section.abbreviation || '';
    const entries = section.standings?.entries || [];
    if (!entries.length) continue;
    html += `<div class="league-group"><div class="league-header">${esc(name)}</div><div class="standings-list">`;
    entries.forEach((entry, i) => {
      const team = entry.team?.shortDisplayName || entry.team?.name || '—';
      const stats = {};
      (entry.stats || []).forEach(s => { stats[s.name] = s.displayValue; });
      const w = stats.wins || stats.W || '—';
      const l = stats.losses || stats.L || '—';
      const pct = stats.winPercent || stats.PCT || '';
      html += `<div class="standing-row">
        <span class="standing-rank">${i + 1}</span>
        <span class="standing-team">${esc(team)}</span>
        <span class="standing-record">${w}–${l}${pct ? ` (${pct})` : ''}</span>
      </div>`;
    });
    html += '</div></div>';
  }
  area.innerHTML = html || '<div class="empty-state">No standings data available.</div>';
}

function renderOtherStandings(data, sport, src) {
  const area = document.getElementById('other-standings-area');
  if (!data.length) { area.innerHTML = '<div class="empty-state">No standings data available.</div>'; return; }
  const rows = data.slice(0,40).map((item, i) => {
    const name = item.team?.name || item.name || item.team || '—';
    const wins   = item.wins   ?? item.won  ?? item.w   ?? '—';
    const losses = item.losses ?? item.lost ?? item.l   ?? '—';
    const pct    = item.win_pct ?? item.percentage ?? '';
    const pctFmt = pct !== '' ? ` (${typeof pct === 'number' ? pct.toFixed(3) : pct})` : '';
    return `<div class="standing-row">
      <span class="standing-rank">${i+1}</span>
      <span class="standing-team">${esc(name)}</span>
      <span class="standing-record">${wins}–${losses}${pctFmt}</span>
    </div>`;
  }).join('');
  area.innerHTML = `<div class="source-badge">Source: ${esc(src)}</div><div class="standings-list">${rows}</div>`;
}

// ── UI HELPERS ───────────────────────────────────────────────
function showLoading(id, msg) {
  document.getElementById(id).innerHTML =
    `<div class="loading-spinner"><div class="spinner"></div><p>${esc(msg)}</p></div>`;
}

function showError(id, msg, retryCall) {
  // retryCall is a plain JS string like "loadFixtures(0)" — avoids closure issues
  const btn = retryCall ? `<button class="retry-btn" onclick="${retryCall}">Retry</button>` : '';
  document.getElementById(id).innerHTML =
    `<div class="error-state"><div class="error-icon">⚠</div><p>${esc(msg)}</p>${btn}</div>`;
}

function toggleGroup(header) {
  const group = header.parentElement;
  const expanded = group.dataset.expanded === 'true';
  group.dataset.expanded = expanded ? 'false' : 'true';
}

function toggleDetail(key) {
  const el = document.getElementById(`md-${key}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function jumpTo(slug) {
  const el = document.getElementById(`tg-${slug}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function filterSidebar(q) {
  const qLow = q.toLowerCase();
  document.querySelectorAll('.sidebar-tournament').forEach(el => {
    const name = el.querySelector('.sidebar-t-name')?.textContent.toLowerCase() || '';
    el.style.display = name.includes(qLow) ? '' : 'none';
  });
}

// ── REFRESH ──────────────────────────────────────────────────
async function refresh() {
  const btn = document.getElementById('refresh-btn');
  btn.style.transform = 'rotate(360deg)';
  btn.style.transition = 'transform 0.5s';
  setTimeout(() => { btn.style.transform = ''; btn.style.transition = ''; }, 500);

  S.matches.clear();
  if (S.sport === 'tennis') {
    await loadFixtures(S.dateOffset);
    wsDisconnect(); wsConnect();
  } else {
    if (S.view === 'scores') loadOtherScores(S.sport);
    else loadOtherStandings(S.sport);
  }
}

// ── EVENT LISTENERS ──────────────────────────────────────────
document.querySelectorAll('.sport-tab').forEach(t =>
  t.addEventListener('click', () => switchSport(t.dataset.sport)));

document.querySelectorAll('.view-tab').forEach(t =>
  t.addEventListener('click', () => switchView(t.dataset.view)));

document.querySelectorAll('.chip').forEach(c =>
  c.addEventListener('click', () => applyFilter(c.dataset.filter)));

document.getElementById('refresh-btn').addEventListener('click', refresh);

document.getElementById('tournament-search').addEventListener('input', e => filterSidebar(e.target.value));

// Overview card clicks → apply filter
document.querySelectorAll('.overview-card').forEach(card => {
  card.addEventListener('click', () => {
    const map = { atp:'atp', wta:'wta', challenger:'challenger-m', itf:'itf-m' };
    const f = map[card.dataset.cat] || 'all';
    applyFilter(f);
  });
});

// ── INIT ─────────────────────────────────────────────────────
function init() {
  renderDateBar();
  switchSport('tennis');
}

init();
