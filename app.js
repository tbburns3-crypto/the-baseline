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
  matches:       new Map(),   // event_key → match object
  rankIndex:     new Map(),   // player_key → {rank, points, league} built from loaded rankings
  playerDB:        [],
  playerDBLoaded:  false,
  playerDBLoading: false,
  lineupsTimer:    null,
  scoresTimer:     null,
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
      tennisFetch('get_standings', { event_type: 'ATP' }),
      tennisFetch('get_standings', { event_type: 'WTA' })
    ]);
    const atp = atpR.status === 'fulfilled' ? atpR.value : [];
    const wta = wtaR.status === 'fulfilled' ? wtaR.value : [];
    // Build rank index for cross-referencing in player search
    S.rankIndex.clear();
    for (const p of [...atp, ...wta]) {
      if (p.player_key) S.rankIndex.set(String(p.player_key), { rank: p.place, points: p.points, league: p.league || (atp.includes(p) ? 'ATP' : 'WTA') });
    }
    renderRankings(atp, wta);
    loadPlayerDatabase(); // start loading in background for search
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
    const cat = matchCategory(m.event_type_type || '');
    if (!catMap.has(cat)) catMap.set(cat, new Map());
    const tKey = m.tournament_name || m.league_name || m.event_type_type || 'Other';
    const tMap = catMap.get(cat);
    if (!tMap.has(tKey)) tMap.set(tKey, { name: tKey, surface: m.tournament_surface || '', type: m.event_type_type || '', matches: [] });
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
         onclick="${liteMode ? `jumpTo('${slugify(m.tournament_name||m.league_name||'')}')` : `toggleDetail('${key}')`}">
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
    const cat = matchCategory(m.event_type_type || '');
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
    const name = m.tournament_name || m.league_name || 'Unknown';
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
      <div class="ranking-header-row"><span>#</span><span>Player</span><span>Pts</span><span>Country</span></div>
      ${data.slice(0,100).map((p,i) => {
        const rank    = p.place ?? p.standing_place ?? p.ranking ?? (i+1);
        const name    = p.player || p.team_name || p.player_name || p.name || '—';
        const pts     = p.points ?? p.standing_points ?? p.ranking_points ?? '—';
        const country = p.country || p.player_country || p.nationality || '';
        const mov     = p.movement === 'up' ? '<span class="rank-up">▲</span>'
                      : p.movement === 'down' ? '<span class="rank-down">▼</span>'
                      : '<span class="rank-same">–</span>';
        return `
          <div class="ranking-row">
            <span class="rank-num">${esc(rank)}</span>
            <span class="rank-name">${esc(name)}</span>
            <span class="rank-pts">${esc(pts)}</span>
            <span class="rank-country">${mov} ${esc(country)}</span>
          </div>`;
      }).join('')}
    </div>`;
  };
  document.getElementById('rankings-area').innerHTML =
    `<div class="rankings-grid">${col(atp,'ATP Rankings')}${col(wta,'WTA Rankings')}</div>`;
}

// ── PLAYER DATABASE (Jeff Sackmann / tennis_atp + tennis_wta) ──
let _playerSearchTimer = null;

async function loadPlayerDatabase() {
  if (S.playerDBLoaded || S.playerDBLoading) return;
  S.playerDBLoading = true;

  const RAW = 'https://raw.githubusercontent.com/JeffSackmann';
  try {
    const [atpRankTxt, wtaRankTxt, atpPlayersTxt, wtaPlayersTxt] = await Promise.all([
      fetch(`${RAW}/tennis_atp/master/atp_rankings_current.csv`).then(r => r.text()),
      fetch(`${RAW}/tennis_wta/master/wta_rankings_current.csv`).then(r => r.text()),
      fetch(`${RAW}/tennis_atp/master/atp_players.csv`).then(r => r.text()),
      fetch(`${RAW}/tennis_wta/master/wta_players.csv`).then(r => r.text()),
    ]);

    // Parse players CSV → Map(id → {firstName, lastName, hand, dob, ioc})
    function parsePlayers(csv) {
      const m = new Map();
      for (const line of csv.split('\n')) {
        const p = line.split(',');
        if (p.length < 4 || !p[0].trim()) continue;
        // columns: player_id, name_first, name_last, hand, dob, ioc
        m.set(p[0].trim(), { firstName: p[1]?.trim() || '', lastName: p[2]?.trim() || '', hand: p[3]?.trim() || '', dob: p[4]?.trim() || '', ioc: p[5]?.trim() || '' });
      }
      return m;
    }

    // Parse rankings CSV → array, only the most-recent date
    function parseRankings(csv, playersMap, league) {
      const rows = csv.split('\n').map(l => l.split(',')).filter(p => p.length >= 4 && p[0]?.trim());
      if (!rows.length) return [];
      const latestDate = rows.reduce((best, p) => p[0].trim() > best ? p[0].trim() : best, '');
      const out = [];
      for (const p of rows) {
        if (p[0].trim() !== latestDate) continue;
        const id = p[2]?.trim();
        const pl = playersMap.get(id);
        if (!pl) continue;
        out.push({
          id,
          firstName: pl.firstName,
          lastName:  pl.lastName,
          fullName:  `${pl.firstName} ${pl.lastName}`.trim(),
          hand:      pl.hand,
          dob:       pl.dob,
          country:   pl.ioc,
          rank:      parseInt(p[1]),
          points:    parseInt(p[3]) || 0,
          league,
          rankDate:  latestDate,
        });
      }
      return out.sort((a, b) => a.rank - b.rank);
    }

    const atpPlayers = parsePlayers(atpPlayersTxt);
    const wtaPlayers = parsePlayers(wtaPlayersTxt);
    S.playerDB       = [...parseRankings(atpRankTxt, atpPlayers, 'ATP'), ...parseRankings(wtaRankTxt, wtaPlayers, 'WTA')];
    S.playerDBLoaded = true;
    S.playerDBLoading = false;
    console.log(`[PlayerDB] Loaded ${S.playerDB.length} ranked players`);
  } catch (err) {
    S.playerDBLoading = false;
    console.error('[PlayerDB] Failed:', err);
  }
}

function calcAge(dob) {
  if (!dob || dob.length < 8) return '';
  const y = parseInt(dob.slice(0,4)), mo = parseInt(dob.slice(4,6)) - 1, d = parseInt(dob.slice(6,8));
  const age = Math.floor((Date.now() - new Date(y, mo, d)) / (365.25 * 24 * 60 * 60 * 1000));
  return isNaN(age) || age < 1 ? '' : String(age);
}

function onPlayerSearch(q) {
  clearTimeout(_playerSearchTimer);
  const resultsEl  = document.getElementById('player-search-results');
  const rankingsEl = document.getElementById('rankings-area');
  if (!q.trim()) {
    resultsEl.style.display  = 'none';
    rankingsEl.style.display = '';
    return;
  }
  rankingsEl.style.display = 'none';
  resultsEl.style.display  = '';

  if (!S.playerDBLoaded) {
    resultsEl.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Loading player database…</p></div>';
    _playerSearchTimer = setTimeout(async () => {
      await loadPlayerDatabase();
      runPlayerSearch(q.trim());
    }, 300);
    return;
  }
  _playerSearchTimer = setTimeout(() => runPlayerSearch(q.trim()), 200);
}

function runPlayerSearch(q) {
  const qLow = q.toLowerCase();
  const hits = S.playerDB.filter(p =>
    p.firstName.toLowerCase().includes(qLow) ||
    p.lastName.toLowerCase().includes(qLow)  ||
    p.fullName.toLowerCase().includes(qLow)
  ).slice(0, 60);
  renderPlayerResults(hits, q);
}

function renderPlayerResults(players, q) {
  const resultsEl = document.getElementById('player-search-results');
  if (!players.length) {
    resultsEl.innerHTML = `<div class="empty-state">No players found for "<strong>${esc(q)}</strong>"</div>`;
    return;
  }
  const handLabel = h => h === 'R' ? 'Right-handed' : h === 'L' ? 'Left-handed' : '';
  resultsEl.innerHTML = `
    <div class="player-results-header">${players.length} player${players.length !== 1 ? 's' : ''} found</div>
    ${players.map(p => {
      const age  = calcAge(p.dob);
      const hand = handLabel(p.hand);
      return `<div class="player-result-row">
        <div class="player-result-name">${esc(p.fullName)}</div>
        <div class="player-result-meta">
          <span class="player-rank-badge">#${p.rank}</span>
          <span class="player-type-badge">${esc(p.league)}</span>
          ${p.country ? `<span class="player-country-tag">${esc(p.country)}</span>` : ''}
          ${p.points ? `<span class="player-pts-tag">${p.points.toLocaleString()} pts</span>` : ''}
          ${age  ? `<span class="player-age-tag">Age ${age}</span>` : ''}
          ${hand ? `<span class="player-hand-tag">${hand}</span>` : ''}
        </div>
      </div>`;
    }).join('')}
  `;
}

// ── OTHER SPORTS PLAYER SEARCH ──────────────────────────────
let _sportPlayerTimer = null;

function onSportPlayerSearch(q) {
  clearTimeout(_sportPlayerTimer);
  const resultsEl = document.getElementById('sport-player-results');
  if (!q.trim()) {
    resultsEl.innerHTML = '<div class="empty-state">Type a name to search players</div>';
    return;
  }
  resultsEl.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Searching…</p></div>';
  _sportPlayerTimer = setTimeout(() => doSportPlayerSearch(q.trim()), 400);
}

async function doSportPlayerSearch(q) {
  const resultsEl = document.getElementById('sport-player-results');
  try {
    const players = await fetchSportPlayers(S.sport, q);
    renderSportPlayerResults(players, q);
  } catch (err) {
    resultsEl.innerHTML = `<div class="error-state"><div class="error-icon">⚠</div><p>Search failed: ${esc(err.message)}</p></div>`;
  }
}

async function fetchSportPlayers(sport, q) {
  if (sport === 'nba')  return searchNBAPlayers(q);
  if (sport === 'mlb')  return searchMLBPlayers(q);
  if (sport === 'nhl')  return searchNHLPlayers(q);
  return searchESPNPlayers(sport, q);
}

async function searchNBAPlayers(q) {
  const res = await fetch(
    `${CFG.bdl.base}/players?search=${encodeURIComponent(q)}&per_page=30`,
    { headers: { Authorization: CFG.bdl.key } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).map(p => ({
    name:     `${p.first_name} ${p.last_name}`.trim(),
    team:     p.team?.full_name || p.team?.abbreviation || '—',
    position: p.position || '—',
    extra:    [
      p.height_feet != null ? `${p.height_feet}'${p.height_inches || 0}"` : '',
      p.weight_pounds ? `${p.weight_pounds} lbs` : '',
    ].filter(Boolean).join(' · '),
  }));
}

async function searchMLBPlayers(q) {
  const res = await fetch(
    `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(q)}&sportId=1&hydrate=currentTeam,position`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.people || []).map(p => ({
    name:     p.fullName || '—',
    team:     p.currentTeam?.name || '—',
    position: p.primaryPosition?.abbreviation || p.primaryPosition?.name || '—',
    extra:    [
      p.batSide?.description ? `Bats ${p.batSide.description}` : '',
      p.pitchHand?.description ? `Throws ${p.pitchHand.description}` : '',
    ].filter(Boolean).join(' · '),
    mlbId:    p.id,
  }));
}

async function searchNHLPlayers(q) {
  const res = await fetch(
    `https://api-web.nhle.com/v1/player-search/player?q=${encodeURIComponent(q)}&culture=en-us`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.players || []).map(p => ({
    name:     `${p.firstName?.default || ''} ${p.lastName?.default || ''}`.trim(),
    team:     p.currentTeamAbbrev || '—',
    position: p.positionCode || '—',
    extra:    [
      p.sweaterNumber ? `#${p.sweaterNumber}` : '',
      p.birthCountry  ? p.birthCountry : '',
    ].filter(Boolean).join(' · '),
  }));
}

async function searchESPNPlayers(sport, q) {
  // ESPN athletes endpoint — load active roster and filter client-side
  const paths = { wnba: 'basketball/wnba', nfl: 'football/nfl' };
  const path  = paths[sport];
  if (!path) throw new Error('Unsupported sport');
  const res = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/${path}/athletes?limit=1000&active=true`
  );
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const json = await res.json();
  const qLow = q.toLowerCase();
  const all  = json.athletes || json.items || [];
  return all
    .filter(a => (a.fullName || a.displayName || '').toLowerCase().includes(qLow))
    .slice(0, 40)
    .map(a => ({
      name:     a.fullName || a.displayName || '—',
      team:     a.team?.displayName || a.team?.abbreviation || '—',
      position: a.position?.abbreviation || a.position?.name || '—',
      extra:    [a.jersey ? `#${a.jersey}` : ''].filter(Boolean).join(''),
    }));
}

function renderSportPlayerResults(players, q) {
  const resultsEl = document.getElementById('sport-player-results');
  if (!players.length) {
    resultsEl.innerHTML = `<div class="empty-state">No players found for "<strong>${esc(q)}</strong>"</div>`;
    return;
  }
  const isMLB = S.sport === 'mlb';
  resultsEl.innerHTML = `
    <div class="player-results-header">${players.length} player${players.length !== 1 ? 's' : ''} found${isMLB ? ' — click for 2025 stats' : ''}</div>
    ${players.map((p, i) => `
      <div class="player-result-row ${isMLB && p.mlbId ? 'clickable' : ''}" id="spr-${i}"
           ${isMLB && p.mlbId ? `onclick="loadMLBPlayerStats(${p.mlbId}, '${esc(p.name).replace(/'/g,"\\'")}', this)"` : ''}>
        <div class="player-result-name">${esc(p.name)}${isMLB && p.mlbId ? ' <span class="stats-hint">▸ Stats</span>' : ''}</div>
        <div class="player-result-meta">
          <span class="player-type-badge">${esc(p.position)}</span>
          <span class="player-country-tag">${esc(p.team)}</span>
          ${p.extra ? `<span class="player-age-tag">${esc(p.extra)}</span>` : ''}
        </div>
      </div>`).join('')}
  `;
}

// ── FILTER ───────────────────────────────────────────────────
function filterPasses(m) {
  if (S.filter === 'all') return true;
  return matchCategory(m.event_type_type || '') === S.filter;
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
function stopScoresTimer() {
  if (S.scoresTimer) { clearInterval(S.scoresTimer); S.scoresTimer = null; }
}

function startScoresTimer(sport) {
  stopScoresTimer();
  S.scoresTimer = setInterval(() => {
    if (S.sport === sport && S.view === 'scores') loadOtherScores(sport);
  }, 30000);
}

function switchSport(sport) {
  S.sport = sport;
  document.querySelectorAll('.sport-tab').forEach(t => t.classList.toggle('active', t.dataset.sport === sport));

  const isTennis = sport === 'tennis';
  document.querySelectorAll('.tennis-only').forEach(el => el.style.display = isTennis ? '' : 'none');

  const secTab      = document.getElementById('secondary-tab');
  const playersTab  = document.getElementById('players-tab');
  const lineupsTab  = document.getElementById('lineups-tab');
  if (S.lineupsTimer) { clearInterval(S.lineupsTimer); S.lineupsTimer = null; }
  stopScoresTimer();
  if (isTennis) {
    secTab.textContent = 'Rankings'; secTab.dataset.view = 'secondary';
    playersTab.style.display  = 'none';
    lineupsTab.style.display  = 'none';
  } else {
    secTab.textContent = 'Standings'; secTab.dataset.view = 'secondary';
    playersTab.style.display  = '';
    lineupsTab.style.display  = sport === 'mlb' ? '' : 'none';
  }

  switchView('scores');

  if (isTennis) {
    wsDisconnect(); wsConnect();
    loadFixtures(S.dateOffset);
  } else {
    wsDisconnect();
    setConn('disconnected', `${sport.toUpperCase()} — updating every 30s`);
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
      startScoresTimer(S.sport);
    } else if (view === 'lineups') {
      stopScoresTimer();
      document.getElementById('view-mlb-lineups').classList.add('active');
      loadMLBLineups();
      if (S.lineupsTimer) clearInterval(S.lineupsTimer);
      S.lineupsTimer = setInterval(loadMLBLineups, 5 * 60 * 1000);
    } else if (view === 'players') {
      stopScoresTimer();
      document.getElementById('view-sport-players').classList.add('active');
      document.getElementById('sport-player-search-input').value = '';
      document.getElementById('sport-player-results').innerHTML = '<div class="empty-state">Type a name to search players</div>';
    } else {
      stopScoresTimer();
      document.getElementById('view-other-standings').classList.add('active');
      if (S.sport === 'mlb') loadMLBFullStandings();
      else loadOtherStandings(S.sport);
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
    const t = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    setConn('connected', `${sport.toUpperCase()} — updated ${t} · refreshes every 30s`);
  } catch (err) {
    setConn('disconnected', `${sport.toUpperCase()} — update failed, retrying…`);
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
  const live = /^(Q[1-4]|OT)\s+\d/i.test(st)
    || /^(Top|Bot|Mid)\s+\d/i.test(st)
    || /^(In.Progress|live|ongoing|H[1-2])$/i.test(st)
    || /^\d+(st|nd|rd|th)\s*(quarter|period|inning)/i.test(st);
  const fin  = /^Final/i.test(st) || /^F(\/|$)/i.test(st) || ['FT','Finished','Complete'].includes(st);
  const periodLabel = g.period ? `${g.period}${ordinal(+g.period || 0)}` : '';
  return `
    <div class="other-match-row ${live?'live':''}" id="og-${esc(g.id)}" onclick="toggleGamePreview('${esc(g.id)}')">
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

  // Cache game objects for click preview
  _otherGamesMap.clear();
  for (const g of games) _otherGamesMap.set(String(g.id), g);

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

// ── GAME PREVIEW CLICK HANDLER ───────────────────────────────
async function toggleGamePreview(gameId) {
  const rowEl = document.getElementById(`og-${gameId}`);
  if (!rowEl) return;
  const existing = rowEl.nextElementSibling;
  if (existing?.classList.contains('game-preview-panel')) {
    existing.remove();
    rowEl.classList.remove('gp-expanded');
    return;
  }
  rowEl.classList.add('gp-expanded');
  const panel = document.createElement('div');
  panel.className = 'game-preview-panel';
  panel.innerHTML = '<div class="loading-spinner" style="padding:16px"><div class="spinner"></div></div>';
  rowEl.after(panel);
  const game = _otherGamesMap.get(gameId);
  if (!game) { panel.innerHTML = '<div class="pp-empty" style="padding:12px">No data</div>'; return; }
  if (game.sport === 'mlb') {
    await renderMLBGamePreview(game, panel);
  } else {
    await renderESPNGamePreview(game, panel);
  }
}

async function renderMLBGamePreview(espnGame, panel) {
  try {
    const games = await getMLBSchedule();
    const nameMatch = (mlbFull, espnShort) => {
      const f = mlbFull.toLowerCase(), s = espnShort.toLowerCase();
      return f === s || f.endsWith(' ' + s) || f.endsWith(s) || f.includes(s);
    };
    const mlbGame = games.find(g =>
      nameMatch(g.teams.away.team?.name || '', espnGame.awayTeam) &&
      nameMatch(g.teams.home.team?.name || '', espnGame.homeTeam)
    );
    if (!mlbGame) {
      panel.innerHTML = '<div class="pp-empty" style="padding:12px">Game preview not available yet — check back closer to game time</div>';
      return;
    }
    const away        = mlbGame.teams.away, home = mlbGame.teams.home;
    const awayLineup  = mlbGame.lineups?.awayPlayers || [];
    const homeLineup  = mlbGame.lineups?.homePlayers || [];
    const awayPId     = away.probablePitcher?.id;
    const homePId     = home.probablePitcher?.id;
    const awayPName   = away.probablePitcher?.fullName || 'TBD';
    const homePName   = home.probablePitcher?.fullName || 'TBD';
    const awayAbbr    = away.team?.abbreviation || away.team?.name?.slice(0,3).toUpperCase() || 'AWY';
    const homeAbbr    = home.team?.abbreviation || home.team?.name?.slice(0,3).toUpperCase() || 'HME';

    // Fetch pitcher stats + all batter stats in parallel
    await Promise.allSettled([
      awayPId && fetchPitcherPreview(awayPId),
      homePId && fetchPitcherPreview(homePId),
      ...[...awayLineup, ...homeLineup].map(p => fetchBatterPreview(p.id))
    ]);

    const awayPD   = awayPId ? _pitcherCache.get(awayPId) : null;
    const homePD   = homePId ? _pitcherCache.get(homePId) : null;
    const awayHand = awayPD?.pitchHand || null;  // away pitcher hand
    const homeHand = homePD?.pitchHand || null;  // home pitcher hand

    // Build batter objects with watch scores
    // Away batters face HOME pitcher; home batters face AWAY pitcher
    const makeBatters = (players, oppHand, teamAbbr) => players.map((p, i) => {
      const st = _batterCache.get(p.id) || {};
      const favorable = st.batSide === 'S' ||
        (st.batSide && oppHand && st.batSide !== oppHand);
      const hr  = parseInt(st.homeRuns || 0);
      const h   = parseInt(st.hits     || 0);
      const r   = parseInt(st.runs     || 0);
      const rbi = parseInt(st.rbi      || 0);
      const ops = parseFloat(st.ops    || 0);
      const ab  = parseInt(st.atBats   || 0);
      // Position weight: 3-hole and 4-hole cleanup carry most run-production weight
      const posW = [0,1.1,1.0,1.4,1.5,1.2,1.0,0.9,0.8,0.7][i+1] || 1.0;
      return { name: p.fullName, id: p.id, pos: i+1, stat: st, batSide: st.batSide,
               favorable, team: teamAbbr, hr, h, r, rbi, ops, ab,
               babip: calcBABIP(st),
               prodScore: (h + r + rbi) * posW,
               watchScore: (ops * 500 + hr * 4 + rbi * 0.6) * posW };
    }).filter(b => b.ab >= 10);

    const awayBatters = makeBatters(awayLineup, homeHand, awayAbbr);
    const homeBatters = makeBatters(homeLineup, awayHand, homeAbbr);
    const allBatters  = [...awayBatters, ...homeBatters];

    const hrThreats   = [...allBatters].filter(b => b.hr > 0).sort((a, b) => b.hr - a.hr).slice(0, 5);
    const topProd     = [...allBatters].sort((a, b) => b.prodScore - a.prodScore).slice(0, 5);
    const dueForHits  = [...allBatters].filter(b => b.babip !== null && b.babip < 0.270)
                          .sort((a, b) => a.babip - b.babip).slice(0, 4);
    const topHitters  = [...allBatters].filter(b => b.ab >= 50 && parseFloat(b.stat.avg || 0) > 0)
                          .sort((a, b) => parseFloat(b.stat.avg) - parseFloat(a.stat.avg)).slice(0, 5);

    const handTag = (batSide, favorable, oppHand) => {
      if (!batSide) return '';
      const vs  = oppHand ? ` vs ${oppHand}HP` : '';
      const cls = favorable ? 'gp-hand gp-fav' : 'gp-hand gp-unfav';
      return `<span class="${cls}" title="${batSide}${vs}">${batSide}</span>`;
    };
    const posTag = pos => {
      const labels = {3:'3-Hole',4:'Cleanup',5:'5-Spot',1:'Leadoff',2:'2-Hole'};
      return `<span class="gp-pos ${labels[pos]?'gp-pos-key':''}">#${pos}${labels[pos] ? ` <span class="gp-pos-lbl">${labels[pos]}</span>` : ''}</span>`;
    };

    const hrRow = b => `
      <div class="gp-player-row">
        ${posTag(b.pos)}
        ${handTag(b.batSide, b.favorable, b.team === awayAbbr ? homeHand : awayHand)}
        <span class="gp-pname">${esc(b.name.split(' ').slice(-1)[0])}</span>
        <span class="gp-team">${esc(b.team)}</span>
        <span class="gp-stats">
          <span class="gp-hr-val">${b.hr}HR</span>
          <span class="gp-muted">${b.stat.ops || '—'} OPS</span>
          <span class="gp-muted">${b.stat.avg || '.---'}</span>
        </span>
      </div>`;

    const prodRow = b => `
      <div class="gp-player-row">
        ${posTag(b.pos)}
        ${handTag(b.batSide, b.favorable, b.team === awayAbbr ? homeHand : awayHand)}
        <span class="gp-pname">${esc(b.name.split(' ').slice(-1)[0])}</span>
        <span class="gp-team">${esc(b.team)}</span>
        <span class="gp-stats">
          <span class="gp-h-val">${b.h}H</span>
          <span class="gp-r-val">${b.r}R</span>
          <span class="gp-rbi-val">${b.rbi}RBI</span>
        </span>
      </div>`;

    const hitRow = b => `
      <div class="gp-player-row">
        ${posTag(b.pos)}
        ${handTag(b.batSide, b.favorable, b.team === awayAbbr ? homeHand : awayHand)}
        <span class="gp-pname">${esc(b.name.split(' ').slice(-1)[0])}</span>
        <span class="gp-team">${esc(b.team)}</span>
        <span class="gp-stats">
          <span class="gp-avg-val">${b.stat.avg}</span>
          ${babipTag(b.babip)}
          ${xbaTag(b.id, b.stat.avg)}
          <span class="gp-muted">${b.stat.ops || '—'} OPS</span>
        </span>
      </div>`;

    const dueRow = b => `
      <div class="gp-player-row">
        ${posTag(b.pos)}
        ${handTag(b.batSide, b.favorable, b.team === awayAbbr ? homeHand : awayHand)}
        <span class="gp-pname">${esc(b.name.split(' ').slice(-1)[0])}</span>
        <span class="gp-team">${esc(b.team)}</span>
        <span class="gp-stats">
          <span class="gp-avg-val">${b.stat.avg}</span>
          ${babipTag(b.babip)}
          ${xbaTag(b.id, b.stat.avg)}
          <span class="gp-muted">${b.stat.ops || '—'} OPS</span>
        </span>
      </div>`;

    const pdSlot = (pid, pname, pd) => {
      const s  = pd?.season;
      const lh = pd?.pitchHand ? pd.pitchHand + 'HP' : '';
      const lastName = pname !== 'TBD' ? pname.split(' ').slice(1).join(' ') || pname : 'TBD';
      return `<div class="gp-pd-slot">
        <div class="gp-pd-hand">${lh}</div>
        <div class="gp-pd-name">${esc(lastName)}</div>
        <div class="gp-pd-era ${!s?'pd-tbd':''}">${s?.era || '—'}</div>
        <div class="gp-pd-era-lbl">ERA</div>
        ${s ? `<div class="gp-pd-sub">${s.wins??0}-${s.losses??0} &nbsp;·&nbsp; ${s.whip||'—'} WHIP &nbsp;·&nbsp; ${s.strikeOuts??0}K</div>` : ''}
      </div>`;
    };

    const noLineup = allBatters.length === 0;

    panel.innerHTML = `
      <div class="gp-inner">
        <div class="gp-duel">
          ${pdSlot(awayPId, awayPName, awayPD)}
          <div class="gp-duel-vs">VS</div>
          ${pdSlot(homePId, homePName, homePD)}
        </div>
        ${noLineup
          ? `<div class="gp-no-lineup">Lineups not posted yet — only pitcher preview available</div>`
          : `
          <div class="gp-hand-legend"><span class="gp-hand gp-fav">L/R/S</span> = favorable matchup &nbsp;·&nbsp; <span class="gp-babip gp-babip-due">BABIP .240 ↑</span> = unlucky, hits coming &nbsp;·&nbsp; <span class="gp-babip gp-babip-hot">BABIP .360 ↓</span> = running hot</div>
          ${dueForHits.length ? `<div class="gp-section"><div class="gp-section-hdr">🍀 Due for Hits <span style="font-size:.65rem;font-weight:400;color:var(--text-muted)">— low BABIP = getting unlucky</span></div>${dueForHits.map(dueRow).join('')}</div>` : ''}
          ${hrThreats.length ? `<div class="gp-section"><div class="gp-section-hdr">💣 HR Threats</div>${hrThreats.map(hrRow).join('')}</div>` : ''}
          ${topProd.length  ? `<div class="gp-section"><div class="gp-section-hdr">⚡ H + R + RBI Leaders</div>${topProd.map(prodRow).join('')}</div>` : ''}
          ${topHitters.length ? `<div class="gp-section"><div class="gp-section-hdr">🎯 Best Hitters by AVG</div>${topHitters.map(hitRow).join('')}</div>` : ''}
        `}
      </div>`;
  } catch (err) {
    panel.innerHTML = `<div class="pp-error" style="padding:12px">Could not load: ${esc(err.message)}</div>`;
  }
}

async function renderESPNGamePreview(game, panel) {
  const paths = { nba:'basketball/nba', wnba:'basketball/wnba', nfl:'football/nfl', nhl:'hockey/nhl' };
  const path  = paths[game.sport];
  if (!path) { panel.innerHTML = '<div class="pp-empty" style="padding:12px">No preview available</div>'; return; }

  // Sport config: which categories to highlight (pre-game) + which labels to show (live)
  const SPORT_CFG = {
    nba:  { cats: ['Points','Rebounds','Assists'],
            live: { sort:'PTS', show:['PTS','REB','AST','BLK','STL'] }, icon:'🏀' },
    wnba: { cats: ['Points','Rebounds','Assists'],
            live: { sort:'PTS', show:['PTS','REB','AST'] }, icon:'🏀' },
    nfl:  { cats: ['Passing Yards','Rushing Yards','Receiving Yards','Sacks'],
            live: { sort:'YDS', show:['YDS','TD','INT'] }, icon:'🏈' },
    nhl:  { cats: ['Points','Goals','Assists','Save Percentage'],
            live: { sort:'PTS', show:['G','A','PTS','+/-'] }, icon:'🏒' }
  };
  const cfg = SPORT_CFG[game.sport] || { cats:[], live:{ sort:'', show:[] }, icon:'' };

  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${game.id}`);
    const j   = await res.json();
    const comp   = j.header?.competitions?.[0];
    const state  = comp?.status?.type?.state || '';
    const awayC  = comp?.competitors?.find(c => c.homeAway === 'away');
    const homeC  = comp?.competitors?.find(c => c.homeAway === 'home');
    const awayRec = awayC?.record?.[0]?.summary || '';
    const homeRec = homeC?.record?.[0]?.summary || '';

    let html = '';

    // Records header
    if (awayRec || homeRec) {
      html += `<div class="gp-records">
        ${esc(game.awayTeam)}${awayRec ? ` <span class="gp-muted">(${awayRec})</span>` : ''}
        <span class="gp-at">@</span>
        ${esc(game.homeTeam)}${homeRec ? ` <span class="gp-muted">(${homeRec})</span>` : ''}
      </div>`;
    }

    // ── PRE-GAME: season leaders per team ──
    if (state === 'pre' || !state) {
      const teamLeaders = j.leaders || [];
      const catMap = {};
      for (const tl of teamLeaders) {
        const tAbbr = tl.team?.abbreviation || tl.team?.shortDisplayName || '';
        for (const cat of (tl.leaders || [])) {
          const cName = cat.displayName || cat.shortDisplayName || '';
          const matches = cfg.cats.some(c => cName.toLowerCase().includes(c.toLowerCase()));
          if (cfg.cats.length && !matches) continue;
          if (!catMap[cName]) catMap[cName] = [];
          for (const l of (cat.leaders || []).slice(0, 1)) {
            catMap[cName].push({
              team: tAbbr,
              name: l.athlete?.shortName || l.athlete?.displayName || '—',
              val:  l.displayValue || String(l.value ?? '—')
            });
          }
        }
      }

      const catKeys = Object.keys(catMap);
      if (catKeys.length) {
        let catHTML = '';
        for (const [cat, players] of Object.entries(catMap)) {
          catHTML += `<div class="gp-stat-cat">
            <div class="gp-cat-lbl">${esc(cat)}</div>
            ${players.map(p =>
              `<div class="gp-player-row">
                <span class="gp-team">${esc(p.team)}</span>
                <span class="gp-pname">${esc(p.name)}</span>
                <span class="gp-avg-val">${esc(p.val)}</span>
              </div>`
            ).join('')}
          </div>`;
        }
        html += `<div class="gp-section"><div class="gp-section-hdr">${cfg.icon} Key Players to Watch</div>${catHTML}</div>`;
      } else {
        html += `<div class="gp-no-lineup">Pre-game stats not available yet — check back closer to tip-off / puck drop / kickoff</div>`;
      }
    }

    // ── LIVE / FINAL: box score top performers ──
    if (state === 'in' || state === 'post') {
      const { sort, show } = cfg.live;
      let performers = '';
      for (const teamBox of (j.boxscore?.players || [])) {
        const tName = teamBox.team?.abbreviation || '';
        for (const grp of (teamBox.statistics || [])) {
          const labels  = grp.labels || [];
          const sortIdx = labels.indexOf(sort);
          if (sortIdx < 0 && show.length) continue;
          const showIdxs = show.map(k => labels.indexOf(k)).filter(i => i >= 0);
          if (!showIdxs.length) continue;
          const sorted = (grp.athletes || [])
            .map(a => ({ a, sv: parseFloat(a.stats?.[sortIdx] ?? '0') || 0 }))
            .filter(x => x.sv > 0)
            .sort((x, y) => y.sv - x.sv)
            .slice(0, 4);
          for (const { a } of sorted) {
            const statStr = showIdxs
              .map(i => `<span class="gp-muted">${esc(labels[i])} <b>${esc(a.stats[i] || '—')}</b></span>`)
              .join('');
            performers += `<div class="gp-player-row">
              <span class="gp-team">${esc(tName)}</span>
              <span class="gp-pname">${esc(a.athlete?.shortName || a.athlete?.displayName || '—')}</span>
              <span class="gp-stats" style="gap:6px;flex-wrap:wrap">${statStr}</span>
            </div>`;
          }
        }
      }
      if (performers) {
        html += `<div class="gp-section"><div class="gp-section-hdr">${cfg.icon} Top Performers</div>${performers}</div>`;
      }
    }

    panel.innerHTML = `<div class="gp-inner">${html || '<div class="gp-no-lineup">No preview data available</div>'}</div>`;
  } catch (err) {
    panel.innerHTML = `<div class="pp-error" style="padding:12px">Could not load: ${esc(err.message)}</div>`;
  }
}

// ── GAME PREVIEW DATA ────────────────────────────────────────
const _pitcherCache   = new Map();
const _batterCache    = new Map();
const _otherGamesMap  = new Map(); // espn event id → game object
let   _mlbSchedCache  = null;
let   _mlbSchedDate   = null;

async function fetchPitcherPreview(pitcherId) {
  if (!pitcherId) return null;
  if (_pitcherCache.has(pitcherId)) return _pitcherCache.get(pitcherId);
  try {
    const [r1, r2] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season,gameLog&season=2025&group=pitching&limit=1`).then(r => r.json()),
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}?fields=people,id,pitchHand`).then(r => r.json())
    ]);
    const result = {
      season:    r1.stats?.find(s => s.type?.displayName === 'season')?.splits?.[0]?.stat || null,
      lastStart: r1.stats?.find(s => s.type?.displayName === 'gameLog')?.splits?.[0] || null,
      pitchHand: r2.people?.[0]?.pitchHand?.code || null
    };
    _pitcherCache.set(pitcherId, result);
    return result;
  } catch { _pitcherCache.set(pitcherId, null); return null; }
}

async function fetchBatterPreview(batterId) {
  if (_batterCache.has(batterId)) return _batterCache.get(batterId);
  try {
    const [r1, r2] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=season&season=2025&group=hitting`).then(r => r.json()),
      fetch(`https://statsapi.mlb.com/api/v1/people/${batterId}?fields=people,id,batSide`).then(r => r.json())
    ]);
    const stat    = r1.stats?.[0]?.splits?.[0]?.stat || null;
    const batSide = r2.people?.[0]?.batSide?.code || null;
    const result  = stat ? { ...stat, batSide } : { batSide };
    _batterCache.set(batterId, result);
    return result;
  } catch { _batterCache.set(batterId, null); return null; }
}

async function getMLBSchedule() {
  const today = dateStr(0);
  if (_mlbSchedCache && _mlbSchedDate === today) return _mlbSchedCache;
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=lineups,probablePitcher,team,linescore`);
    const j   = await res.json();
    _mlbSchedCache = j.dates?.[0]?.games || [];
    _mlbSchedDate  = today;
  } catch { _mlbSchedCache = []; }
  return _mlbSchedCache;
}

async function loadBatterStatsForCard(game) {
  const gamePk = game.gamePk;
  const sides  = [game.lineups?.awayPlayers || [], game.lineups?.homePlayers || []];
  for (const players of sides) {
    if (!players.length) continue;
    const results = await Promise.allSettled(players.map(p => fetchBatterPreview(p.id)));
    players.forEach((p, i) => {
      const st = results[i].status === 'fulfilled' ? results[i].value : null;
      const el = document.getElementById(`bstat-${p.id}-${gamePk}`);
      if (!el) return;
      el.innerHTML = st
        ? `<span class="bi-avg">${st.avg || '.---'}</span><span class="bi-hr">${st.homeRuns ?? 0}HR</span><span class="bi-rbi">${st.rbi ?? 0}RBI</span>`
        : '';
    });
  }
}

async function loadMLBLineups() {
  showLoading('mlb-lineups-area', 'Loading today\'s lineups…');
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr(0)}&hydrate=lineups,probablePitcher,team,linescore`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json  = await res.json();
    const games = json.dates?.[0]?.games || [];

    // Pre-fetch all pitcher stats in parallel before rendering
    const pitcherIds = [];
    for (const g of games) {
      if (g.teams.away.probablePitcher?.id) pitcherIds.push(g.teams.away.probablePitcher.id);
      if (g.teams.home.probablePitcher?.id) pitcherIds.push(g.teams.home.probablePitcher.id);
    }
    await Promise.allSettled(pitcherIds.map(id => fetchPitcherPreview(id)));

    renderMLBLineups(games);
  } catch (err) {
    showError('mlb-lineups-area', `Could not load lineups — ${err.message}`, 'loadMLBLineups()');
  }
}

function renderMLBLineups(games) {
  const area = document.getElementById('mlb-lineups-area');
  if (!games.length) { area.innerHTML = '<div class="empty-state">No games scheduled today</div>'; return; }

  const renderOrder = (players, pitcherName, oppPitcherId, oppPitcherName, gamePk) => {
    const pitcherRow = `<div class="lineup-pitcher-row"><span class="lineup-pos-tag">SP</span><span class="lineup-name">${esc(pitcherName)}</span></div>`;
    if (!players.length) return pitcherRow + `<div class="lineup-tbd">Lineup not yet posted</div>`;
    const canMatchup = oppPitcherId && oppPitcherName && oppPitcherName !== 'TBD';
    return pitcherRow + players.map((p, i) => {
      const bid   = p.id;
      const key   = `${bid}-${gamePk}`;
      const hint  = canMatchup ? ` <span class="matchup-hint">vs ${esc(oppPitcherName.split(' ').pop())}</span>` : '';
      const click = canMatchup ? `onclick="toggleMatchup(${bid},${oppPitcherId},'${esc(p.fullName||'').replace(/'/g,"\\'")}','${esc(oppPitcherName).replace(/'/g,"\\'")}','${gamePk}')"` : '';
      return `<div class="lineup-player-row${canMatchup?' matchup-clickable':''}" data-batter-key="${key}" ${click}>
        <span class="lineup-order">${i+1}</span>
        <span class="lineup-pos-tag">${esc(p.position?.abbreviation || '—')}</span>
        <span class="lineup-name">${esc(p.fullName || '—')}${hint}</span>
        <span class="batter-inline-stats" id="bstat-${bid}-${gamePk}"><span class="bi-loading">…</span></span>
      </div>`;
    }).join('');
  };

  const renderPitcherDuel = (awayId, awayName, homeId, homeName) => {
    const slot = (id, name) => {
      const d = id ? _pitcherCache.get(id) : null;
      const s = d?.season;
      const ls = d?.lastStart;
      const lastName = (name && name !== 'TBD') ? name.split(' ').slice(1).join(' ') || name : 'TBD';
      const lastLine = ls
        ? `${ls.stat?.inningsPitched || '?'}IP · ${ls.stat?.earnedRuns ?? '?'}ER · ${ls.stat?.strikeOuts ?? 0}K`
        : null;
      const lastOpp = ls?.opponent?.abbreviation ? `vs ${ls.opponent.abbreviation}` : '';
      return `<div class="pd-slot">
        <div class="pd-name">${esc(lastName)}</div>
        <div class="pd-era ${!s ? 'pd-tbd' : ''}">${s ? (s.era || '—') : '—'}</div>
        <div class="pd-era-lbl">ERA</div>
        ${s ? `
          <div class="pd-secondary">
            <span>${s.wins ?? 0}-${s.losses ?? 0}</span>
            <span>${s.whip || '—'} WHIP</span>
            <span>${s.strikeOuts ?? 0}K</span>
          </div>
          ${lastLine ? `<div class="pd-last-start">Last: ${esc(lastLine)} ${esc(lastOpp)}</div>` : ''}
        ` : `<div class="pd-secondary pd-tbd">No stats yet</div>`}
      </div>`;
    };
    return `<div class="pitcher-duel">
      ${slot(awayId, awayName)}
      <div class="pd-vs">VS</div>
      ${slot(homeId, homeName)}
    </div>`;
  };

  area.innerHTML = games.map(g => {
    const away = g.teams.away, home = g.teams.home;
    const awayName      = away.team?.name || '—';
    const homeName      = home.team?.name || '—';
    const awayAbbr      = away.team?.abbreviation || awayName.slice(0,3).toUpperCase();
    const homeAbbr      = home.team?.abbreviation || homeName.slice(0,3).toUpperCase();
    const awayPitcher   = away.probablePitcher?.fullName || 'TBD';
    const homePitcher   = home.probablePitcher?.fullName || 'TBD';
    const awayPitcherId = away.probablePitcher?.id || null;
    const homePitcherId = home.probablePitcher?.id || null;
    const awayRec       = away.leagueRecord;
    const homeRec       = home.leagueRecord;
    const awayRecStr    = awayRec ? `${awayRec.wins}-${awayRec.losses}` : '';
    const homeRecStr    = homeRec ? `${homeRec.wins}-${homeRec.losses}` : '';
    const gamePk        = g.gamePk || '';
    const awayLineup    = g.lineups?.awayPlayers || [];
    const homeLineup    = g.lineups?.homePlayers || [];
    const isLiveGame    = g.status?.abstractGameState === 'Live';
    const isFinal       = g.status?.abstractGameState === 'Final';
    const gameTime      = g.gameDate ? new Date(g.gameDate).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZoneName:'short' }) : '—';
    const inning        = g.linescore?.currentInning ? `${g.linescore.inningHalf || ''} ${g.linescore.currentInning}` : '';
    const statusBadge   = isLiveGame ? `<span class="live-badge pulse">LIVE ${esc(inning)}</span>`
                        : isFinal   ? `<span class="fin-badge">FINAL</span>`
                        :             `<span class="lineup-time">${esc(gameTime)}</span>`;
    const score         = (isLiveGame || isFinal) ? `<span class="lineup-score">${away.score ?? 0}–${home.score ?? 0}</span>` : '';
    const lineupStatus  = awayLineup.length ? '<span class="lineup-confirmed">✓ Lineups In</span>' : '<span class="lineup-pending">Probable Pitchers</span>';

    return `
      <div class="lineup-card">
        <div class="lineup-card-header">
          <div class="matchup-teams">
            <span class="matchup-team-name">${esc(awayAbbr)}${awayRecStr ? ` <span class="team-record">${awayRecStr}</span>` : ''}</span>
            <span class="matchup-at">@</span>
            <span class="matchup-team-name">${esc(homeAbbr)}${homeRecStr ? ` <span class="team-record">${homeRecStr}</span>` : ''}</span>
          </div>
          <div class="matchup-meta">
            ${score}
            ${statusBadge}
            ${lineupStatus}
          </div>
        </div>
        ${renderPitcherDuel(awayPitcherId, awayPitcher, homePitcherId, homePitcher)}
        <div class="lineup-grid">
          <div class="lineup-col">
            <div class="lineup-col-header">${esc(awayName)}</div>
            ${renderOrder(awayLineup, awayPitcher, homePitcherId, homePitcher, gamePk)}
          </div>
          <div class="lineup-col">
            <div class="lineup-col-header">${esc(homeName)}</div>
            ${renderOrder(homeLineup, homePitcher, awayPitcherId, awayPitcher, gamePk)}
          </div>
        </div>
      </div>`;
  }).join('');

  // Auto-load batter stats for any confirmed lineups
  for (const g of games) {
    if ((g.lineups?.awayPlayers?.length || 0) + (g.lineups?.homePlayers?.length || 0) > 0) {
      loadBatterStatsForCard(g);
    }
  }
}

// ── MLB FULL STANDINGS + STAT LEADERS ───────────────────────
let _mlbStandData = null;
let _mlbLeadData  = null;

async function loadMLBFullStandings() {
  showLoading('other-standings-area', 'Loading MLB standings…');
  try {
    const [standRes, leadRes] = await Promise.all([
      fetch('https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2025&standingsTypes=regularSeason&hydrate=division,team,record'),
      fetch('https://statsapi.mlb.com/api/v1/stats/leaders?leaderCategories=homeRuns,battingAverage,rbi,stolenBases,hits,earnedRunAverage,strikeouts,wins,saves&season=2025&sportId=1&limit=10&hydrate=person,team')
    ]);
    if (!standRes.ok) throw new Error(`HTTP ${standRes.status}`);
    if (!leadRes.ok)  throw new Error(`HTTP ${leadRes.status}`);
    _mlbStandData = await standRes.json();
    _mlbLeadData  = await leadRes.json();
    renderMLBStandingsView('standings');
  } catch (err) {
    showError('other-standings-area', `Could not load MLB stats — ${err.message}`, 'loadMLBFullStandings()');
  }
}

const MLB_CHIPS = [
  { key: 'standings',       label: 'Standings' },
  { key: 'homeRuns',        label: 'Home Runs' },
  { key: 'battingAverage',  label: 'Avg' },
  { key: 'hits',            label: 'Hits' },
  { key: 'rbi',             label: 'RBI' },
  { key: 'stolenBases',     label: 'SB' },
  { key: 'earnedRunAverage',label: 'ERA' },
  { key: 'strikeouts',      label: 'K (P)' },
  { key: 'wins',            label: 'Wins' },
  { key: 'saves',           label: 'Saves' },
];

function renderMLBStandingsView(activeKey) {
  const area = document.getElementById('other-standings-area');

  const chips = `<div class="mlb-chips">
    ${MLB_CHIPS.map(c => `<button class="mlb-chip ${c.key === activeKey ? 'active' : ''}" onclick="renderMLBStandingsView('${c.key}')">${esc(c.label)}</button>`).join('')}
  </div>`;

  let content = '';

  if (activeKey === 'standings') {
    const divOrder = [
      'American League East','American League Central','American League West',
      'National League East','National League Central','National League West'
    ];
    const byDiv = {};
    for (const rec of (_mlbStandData?.records || [])) {
      byDiv[rec.division?.name || 'Other'] = rec.teamRecords || [];
    }
    for (const divName of divOrder) {
      const teams = byDiv[divName];
      if (!teams?.length) continue;
      content += `
        <div class="league-group">
          <div class="league-header">${esc(divName)}</div>
          <div class="standings-list">
            <div class="standing-row standing-head"><span>#</span><span>Team</span><span>W–L</span><span>GB</span><span>Str</span></div>
            ${teams.map((t, i) => `
              <div class="standing-row">
                <span class="standing-rank">${i+1}</span>
                <span class="standing-team">${esc(t.team?.name || '—')}</span>
                <span class="standing-record">${t.wins}–${t.losses}</span>
                <span class="standing-gb">${esc(t.gamesBack || '—')}</span>
                <span class="standing-streak">${esc(t.streak?.streakCode || '—')}</span>
              </div>`).join('')}
          </div>
        </div>`;
    }
  } else {
    const cat = (_mlbLeadData?.leagueLeaders || []).find(c => c.leaderCategory === activeKey);
    const label = MLB_CHIPS.find(c => c.key === activeKey)?.label || activeKey;
    if (!cat?.leaders?.length) {
      content = `<div class="empty-state">No data available for ${esc(label)}</div>`;
    } else {
      content = `
        <div class="leader-list">
          <div class="leader-row leader-head"><span>#</span><span>Player</span><span>Team</span><span>${esc(label)}</span></div>
          ${cat.leaders.slice(0, 10).map(l => `
            <div class="leader-row">
              <span class="leader-rank">${l.rank}</span>
              <span class="leader-name">${esc(l.person?.fullName || '—')}</span>
              <span class="leader-team">${esc(l.team?.abbreviation || '—')}</span>
              <span class="leader-val">${esc(l.value)}</span>
            </div>`).join('')}
        </div>`;
    }
  }

  area.innerHTML = chips + content;
}

// ── MLB PLAYER STATS ─────────────────────────────────────────
const _ppCache = new Map(); // `${playerId}_${view}` → data

async function loadMLBPlayerStats(playerId, playerName, rowEl) {
  const existing = rowEl.nextElementSibling;
  if (existing?.classList.contains('mlb-stats-panel')) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.className = 'mlb-stats-panel';
  panel.id = `pp-${playerId}`;
  panel.innerHTML = `
    <div class="pp-header">
      <span class="pp-name">${esc(playerName)}</span>
      <span class="pp-season">2025</span>
    </div>
    <div class="pp-chips" id="ppc-${playerId}">
      <button class="pp-chip active"  onclick="ppView(${playerId},'season',this)">Season</button>
      <button class="pp-chip"         onclick="ppView(${playerId},'last30',this)">Last 30</button>
      <button class="pp-chip"         onclick="ppView(${playerId},'last14',this)">Last 14</button>
      <button class="pp-chip"         onclick="ppView(${playerId},'last7',this)">Last 7</button>
      <button class="pp-chip"         onclick="ppView(${playerId},'log',this)">Game Log</button>
      <button class="pp-chip"         onclick="ppView(${playerId},'vsP',this)">vs Pitcher</button>
      <button class="pp-chip"         onclick="ppView(${playerId},'statcast',this)">Statcast</button>
    </div>
    <div class="pp-content" id="ppcontent-${playerId}">
      <div class="loading-spinner" style="padding:14px"><div class="spinner"></div></div>
    </div>`;
  rowEl.after(panel);
  ppView(playerId, 'season');
}

async function ppView(playerId, view, chipEl) {
  if (chipEl) {
    document.querySelectorAll(`#ppc-${playerId} .pp-chip`).forEach(c => c.classList.remove('active'));
    chipEl.classList.add('active');
  }
  const contentEl = document.getElementById(`ppcontent-${playerId}`);
  if (!contentEl) return;

  // vs Pitcher: interactive, no fetch until pitcher selected
  if (view === 'vsP') {
    contentEl.innerHTML = `
      <div class="vsp-area">
        <div class="vsp-prompt">Search a pitcher to see career matchup stats:</div>
        <input type="text" class="vsp-input" id="vsp-input-${playerId}"
               placeholder="Pitcher name…" oninput="searchVsPitcher(this,${playerId})" autocomplete="off">
        <div class="vsp-results"  id="vsp-results-${playerId}"></div>
        <div class="vsp-matchup"  id="vsp-matchup-${playerId}"></div>
      </div>`;
    setTimeout(() => document.getElementById(`vsp-input-${playerId}`)?.focus(), 60);
    return;
  }

  const key = `${playerId}_${view}`;
  if (_ppCache.has(key)) { renderPPContent(contentEl, _ppCache.get(key), view); return; }

  contentEl.innerHTML = '<div class="loading-spinner" style="padding:14px"><div class="spinner"></div></div>';
  try {
    let data;
    if (view === 'season') {
      const r = await fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}?hydrate=stats(group=[hitting,pitching],type=season,season=2025),currentTeam,position`);
      const j = await r.json();
      const p = j.people?.[0];
      const all = p?.stats || [];
      data = {
        info:    { team: p?.currentTeam?.name, pos: p?.primaryPosition?.abbreviation, jersey: p?.primaryNumber },
        hitting: all.find(s => s.group?.displayName === 'hitting')?.splits?.[0]?.stat,
        pitching:all.find(s => s.group?.displayName === 'pitching')?.splits?.[0]?.stat,
      };
    } else if (view === 'log') {
      const [hr, pr] = await Promise.allSettled([
        fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=2025&group=hitting&limit=20`).then(r=>r.json()),
        fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=2025&group=pitching&limit=20`).then(r=>r.json()),
      ]);
      data = {
        hLog: hr.status==='fulfilled' ? hr.value?.stats?.[0]?.splits||[] : [],
        pLog: pr.status==='fulfilled' ? pr.value?.stats?.[0]?.splits||[] : [],
      };
    } else if (view === 'statcast') {
      data = await fetchStatcast(playerId);
    } else {
      const days  = view==='last7' ? 7 : view==='last14' ? 14 : 30;
      const start = dateStr(-days), end = dateStr(0);
      const [hr, pr] = await Promise.allSettled([
        fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=byDateRange&startDate=${start}&endDate=${end}&group=hitting&season=2025`).then(r=>r.json()),
        fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=byDateRange&startDate=${start}&endDate=${end}&group=pitching&season=2025`).then(r=>r.json()),
      ]);
      data = {
        hitting: hr.status==='fulfilled' ? hr.value?.stats?.[0]?.splits?.[0]?.stat : null,
        pitching:pr.status==='fulfilled' ? pr.value?.stats?.[0]?.splits?.[0]?.stat : null,
      };
    }
    _ppCache.set(key, data);
    renderPPContent(contentEl, data, view);
  } catch (err) {
    contentEl.innerHTML = `<div class="pp-error">Could not load: ${esc(err.message)}</div>`;
  }
}

function renderPPContent(el, data, view) {
  if (view === 'log') { el.innerHTML = renderGameLog(data.hLog, data.pLog); return; }
  if (view === 'statcast') {
    if (!data) { el.innerHTML = '<div class="pp-empty">No Statcast data available — player may not qualify or Baseball Savant is unavailable</div>'; return; }
    const f = (v, d=1) => (v && !isNaN(parseFloat(v))) ? parseFloat(v).toFixed(d) : '—';
    const isPitcher = data.playerType === 'pitcher';
    el.innerHTML = renderStatBlock(isPitcher ? 'Statcast (Pitching)' : 'Statcast (Hitting)', [
      [['xBA', f(data.estimated_ba_using_speedangle,3)], ['xSLG', f(data.estimated_slg_using_speedangle,3)], ['xwOBA', f(data.estimated_woba_using_speedangle,3)]],
      [['Exit Velo', f(data.exit_velocity_avg)+'mph'], ['Hard Hit%', f(data.hard_hit_percent,1)+'%'], ['Barrel%', f(data.barrel_batted_rate,1)+'%'], ['Launch°', f(data.launch_angle_avg)]],
      ...(data.sprint_speed && !isPitcher ? [[['Sprint', f(data.sprint_speed,1)+' ft/s']]] : []),
    ]);
    return;
  }
  const { hitting, pitching } = data;
  let html = '';
  if (hitting) html += renderStatBlock('Batting', [
    [['AVG',hitting.avg],['OBP',hitting.obp],['SLG',hitting.slg],['OPS',hitting.ops]],
    [['HR',hitting.homeRuns],['RBI',hitting.rbi],['H',hitting.hits],['R',hitting.runs],['2B',hitting.doubles],['3B',hitting.triples]],
    [['BB',hitting.baseOnBalls],['K',hitting.strikeOuts],['SB',hitting.stolenBases],['AB',hitting.atBats],['G',hitting.gamesPlayed]],
  ]);
  if (pitching) html += renderStatBlock('Pitching', [
    [['ERA',pitching.era],['WHIP',pitching.whip],['W',pitching.wins],['L',pitching.losses]],
    [['IP',pitching.inningsPitched],['K',pitching.strikeOuts],['BB',pitching.baseOnBalls],['H',pitching.hits],['HR',pitching.homeRuns]],
    [['G',pitching.gamesPlayed],['GS',pitching.gamesStarted],['SV',pitching.saves],['HLD',pitching.holds]],
  ]);
  if (!hitting && !pitching) html = '<div class="pp-empty">No stats available for this period</div>';
  el.innerHTML = html;
}

function renderStatBlock(label, rows) {
  return `<div class="pp-block">
    <div class="pp-block-label">${label}</div>
    ${rows.map((row, i) => `
      <div class="pp-stat-row ${i===0?'pp-stat-row-primary':''}">
        ${row.map(([lbl, val]) => `
          <div class="pp-stat-cell">
            <div class="pp-stat-val">${val != null ? esc(String(val)) : '—'}</div>
            <div class="pp-stat-lbl">${lbl}</div>
          </div>`).join('')}
      </div>`).join('')}
  </div>`;
}

// ── HIT PREDICTOR HELPERS ────────────────────────────────────
function calcBABIP(stat) {
  const h  = parseInt(stat?.hits       || 0);
  const hr = parseInt(stat?.homeRuns   || 0);
  const ab = parseInt(stat?.atBats     || 0);
  const k  = parseInt(stat?.strikeOuts || 0);
  const sf = parseInt(stat?.sacFlies   || 0);
  const denom = ab - k - hr + sf;
  return denom > 0 ? (h - hr) / denom : null;
}

function babipTag(babip) {
  if (babip === null) return '';
  const val = babip.toFixed(3);
  if (babip < 0.265) return `<span class="gp-babip gp-babip-due" title="BABIP ${val} — below avg, hits should come">BABIP ${val} ↑</span>`;
  if (babip > 0.340) return `<span class="gp-babip gp-babip-hot" title="BABIP ${val} — above avg, may cool off">BABIP ${val} ↓</span>`;
  return                    `<span class="gp-babip gp-babip-avg" title="BABIP ${val} — about average">${val}</span>`;
}

function xbaTag(playerId, actualAvg) {
  const cached = _ppCache.get(`${playerId}_statcast`);
  if (!cached) return '';
  const xba = parseFloat(cached.estimated_ba_using_speedangle || 0);
  const ba  = parseFloat(actualAvg || 0);
  if (!xba || !ba) return '';
  const gap = xba - ba;
  if (gap >=  0.020) return `<span class="gp-xba-up"   title="xBA ${xba.toFixed(3)} vs AVG ${ba.toFixed(3)} — contact quality says more hits coming">xBA↑</span>`;
  if (gap <= -0.020) return `<span class="gp-xba-down" title="xBA ${xba.toFixed(3)} vs AVG ${ba.toFixed(3)} — outperforming contact quality, may cool off">xBA↓</span>`;
  return '';
}

function renderGameLog(hLog, pLog) {
  const log = hLog.length ? hLog : pLog;
  const isBatter = hLog.length > 0;
  if (!log.length) return '<div class="pp-empty">No game log available</div>';

  const fmt = (d) => {
    if (!d) return '—';
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { month:'short', day:'numeric' });
  };

  const head = isBatter
    ? ['Date','Opp','AB','H','HR','RBI','BB','K','AVG']
    : ['Date','Opp','Dec','IP','H','R','ER','BB','K','ERA'];

  const rows = log.slice(0, 15).map(s => {
    const opp   = (s.isHome ? '' : '@') + (s.opponent?.abbreviation || '—');
    const d     = fmt(s.date);
    const st    = s.stat;
    if (isBatter) {
      const hasHit = (st.hits || 0) > 0;
      const hasHR  = (st.homeRuns || 0) > 0;
      return `<div class="gl-row ${hasHR?'gl-hr':hasHit?'gl-hit':''}">
        <span>${d}</span><span>${opp}</span><span>${st.atBats??'—'}</span>
        <span>${st.hits??'—'}</span><span>${st.homeRuns??'—'}</span><span>${st.rbi??'—'}</span>
        <span>${st.baseOnBalls??'—'}</span><span>${st.strikeOuts??'—'}</span>
        <span class="gl-avg">${st.avg??'—'}</span>
      </div>`;
    } else {
      const dec = s.stat.wins ? 'W' : s.stat.losses ? 'L' : s.stat.saves ? 'SV' : '—';
      return `<div class="gl-row ${dec==='W'?'gl-hit':dec==='L'?'gl-loss':''}">
        <span>${d}</span><span>${opp}</span><span class="gl-dec">${dec}</span>
        <span>${st.inningsPitched??'—'}</span><span>${st.hits??'—'}</span>
        <span>${st.runs??'—'}</span><span>${st.earnedRuns??'—'}</span>
        <span>${st.baseOnBalls??'—'}</span><span>${st.strikeOuts??'—'}</span>
        <span class="gl-avg">${st.era??'—'}</span>
      </div>`;
    }
  });

  return `<div class="gl-table">
    <div class="gl-head">${head.map(h=>`<span>${h}</span>`).join('')}</div>
    ${rows.join('')}
  </div>`;
}

// ── STATCAST ────────────────────────────────────────────────
async function fetchStatcast(playerId) {
  const BASE   = 'https://baseballsavant.mlb.com/statcast_search/csv';
  const PARAMS = 'hfGT=R%7C&hfSea=2025%7C&group_by=name&sort_col=pitches&sort_order=desc&min_results=0&type=details';
  for (const type of ['batter', 'pitcher']) {
    try {
      const res = await fetch(`${BASE}?${PARAMS}&player_type=${type}&player_id=${playerId}`);
      if (!res.ok) continue;
      const text = await res.text();
      if (text.startsWith('<!')) continue;
      const lines = text.trim().split('\n').filter(Boolean);
      if (lines.length < 2) continue;
      const headers = parseCSVLine(lines[0]);
      const values  = parseCSVLine(lines[1]);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = values[i] || ''; });
      if (obj.player_id) return { ...obj, playerType: type };
    } catch {}
  }
  return null;
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"')             inQ = !inQ;
    else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else                         cur += ch;
  }
  result.push(cur.trim());
  return result;
}

// ── VS PITCHER SEARCH ────────────────────────────────────────
let _vspTimer = null;
function searchVsPitcher(inputEl, batterId) {
  clearTimeout(_vspTimer);
  const q = inputEl.value.trim();
  const resultsEl = document.getElementById(`vsp-results-${batterId}`);
  if (!q) { resultsEl.innerHTML = ''; return; }
  _vspTimer = setTimeout(async () => {
    try {
      const res = await fetch(`https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(q)}&sportId=1&hydrate=currentTeam,position`);
      const json = await res.json();
      const pitchers = (json.people || []).filter(p => ['P','SP','RP','CL'].includes(p.primaryPosition?.abbreviation));
      resultsEl.innerHTML = pitchers.slice(0, 5).map(p =>
        `<div class="vsp-pitcher-option" onclick="loadVsPitcher(${batterId},${p.id},'${esc(p.fullName||'').replace(/'/g,"\\'")}')">
          <span>${esc(p.fullName)}</span>
          <span style="color:var(--text-muted);font-size:.78rem">${esc(p.currentTeam?.name||'')}</span>
        </div>`
      ).join('') || '<div class="vsp-no-results">No pitchers found</div>';
    } catch { resultsEl.innerHTML = '<div class="vsp-no-results">Search failed</div>'; }
  }, 400);
}

async function loadVsPitcher(batterId, pitcherId, pitcherName) {
  document.getElementById(`vsp-results-${batterId}`).innerHTML = '';
  document.getElementById(`vsp-input-${batterId}`).value = pitcherName;
  const matchupEl = document.getElementById(`vsp-matchup-${batterId}`);
  matchupEl.innerHTML = '<div class="loading-spinner" style="padding:8px"><div class="spinner"></div></div>';
  const cacheKey = `mu_${batterId}_${pitcherId}`;
  let stat;
  if (_ppCache.has(cacheKey)) {
    stat = _ppCache.get(cacheKey);
  } else {
    try {
      const res  = await fetch(`https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting`);
      const json = await res.json();
      stat = json.stats?.[0]?.splits?.[0]?.stat || null;
      _ppCache.set(cacheKey, stat);
    } catch (err) {
      matchupEl.innerHTML = `<div class="pp-error">Failed: ${esc(err.message)}</div>`;
      return;
    }
  }
  if (!stat || !stat.atBats) {
    matchupEl.innerHTML = `<div class="pp-empty">No career matchup history vs ${esc(pitcherName)}</div>`;
    return;
  }
  matchupEl.innerHTML = renderStatBlock(`Career vs ${esc(pitcherName)}`, [
    [['AB',stat.atBats],['H',stat.hits],['HR',stat.homeRuns],['RBI',stat.rbi]],
    [['BB',stat.baseOnBalls],['K',stat.strikeOuts],['AVG',stat.avg],['OPS',stat.ops]],
  ]);
}

// ── LINEUP MATCHUP (inline toggle) ──────────────────────────
async function toggleMatchup(batterId, pitcherId, batterName, pitcherName, gamePk) {
  const row = document.querySelector(`[data-batter-key="${batterId}-${gamePk}"]`);
  if (!row) return;
  const existing = row.nextElementSibling;
  if (existing?.classList.contains('matchup-inline')) { existing.remove(); return; }

  const div = document.createElement('div');
  div.className = 'matchup-inline';
  div.innerHTML = `<div class="matchup-vs">${esc(batterName)} vs ${esc(pitcherName)}</div>
    <div class="loading-spinner" style="padding:6px"><div class="spinner"></div></div>`;
  row.after(div);

  const cacheKey = `mu_${batterId}_${pitcherId}`;
  let stat;
  if (_ppCache.has(cacheKey)) {
    stat = _ppCache.get(cacheKey);
  } else {
    try {
      const res  = await fetch(`https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting`);
      const json = await res.json();
      stat = json.stats?.[0]?.splits?.[0]?.stat || null;
      _ppCache.set(cacheKey, stat);
    } catch (err) {
      div.innerHTML = `<div class="matchup-vs">${esc(batterName)} vs ${esc(pitcherName)}</div>
        <div class="matchup-no-history">Failed: ${esc(err.message)}</div>`;
      return;
    }
  }
  renderMatchupData(div, stat, batterName, pitcherName);
}

function renderMatchupData(div, stat, batterName, pitcherName) {
  if (!stat || !stat.atBats) {
    div.innerHTML = `<div class="matchup-vs">${esc(batterName)} vs ${esc(pitcherName)}</div>
      <div class="matchup-no-history">No career matchup history</div>`;
    return;
  }
  div.innerHTML = `<div class="matchup-vs">${esc(batterName)} vs ${esc(pitcherName)}</div>
    <div class="matchup-stats-row">
      ${[['AB',stat.atBats],['H',stat.hits],['HR',stat.homeRuns],['RBI',stat.rbi],['BB',stat.baseOnBalls],['K',stat.strikeOuts],['AVG',stat.avg],['OPS',stat.ops]]
        .map(([l,v]) => `<div class="matchup-stat"><div class="matchup-val">${v??'—'}</div><div class="matchup-lbl">${l}</div></div>`).join('')}
    </div>`;
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
