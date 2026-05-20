/* ============================================================
   THE BASELINE - app.js
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
  otherDateOffset: 0,
  picksDateOffset: 0,
  ws:          null,
  wsRetries:   0,
  wsMax:       3,
  wsTimer:     null,
  pollTimer:   null,
  usePoll:     false,
  lastUpdate:  null
};

const _detailLoaded = new Set();

// ── FAVORITES ────────────────────────────────────────────────
const _FAV_KEY = 'burnsideFavs';
function getFavs() { try { return JSON.parse(localStorage.getItem(_FAV_KEY) || '{}'); } catch { return {}; } }
function saveFavs(obj) { try { localStorage.setItem(_FAV_KEY, JSON.stringify(obj)); } catch {} }
function isFav(type, id) { return !!getFavs()[`${type}:${id}`]; }
function toggleFav(type, id, label) {
  const favs = getFavs();
  const k = `${type}:${id}`;
  if (favs[k]) delete favs[k];
  else favs[k] = { type, id, label, added: Date.now() };
  saveFavs(favs);
  document.querySelectorAll(`.star-btn[data-fav-id="${k}"]`).forEach(btn => {
    btn.classList.toggle('fav-on', !!favs[k]);
    btn.title = favs[k] ? 'Remove from favorites' : 'Add to favorites';
  });
  if (S.view === 'favorites') renderFavoritesView();
}

function toggleFavBtn(btn) {
  const [type, id] = btn.dataset.favId.split(':');
  toggleFav(type, id, btn.dataset.favLabel || '');
}

// ── PREDICTION ACCURACY TRACKER ──────────────────────────────
const _PICKS_KEY = 'baselinePicks';
function getPicks()     { try { return JSON.parse(localStorage.getItem(_PICKS_KEY) || '{}'); } catch { return {}; } }
function savePicks(obj) { try { localStorage.setItem(_PICKS_KEY, JSON.stringify(obj)); } catch {} }

function recordPick(gameId, pickedTeam, matchup = '', sport = '') {
  const picks = getPicks();
  if (picks[gameId]) return;
  picks[gameId] = { team: pickedTeam, date: new Date().toISOString().slice(0,10), result: null, matchup, sport };
  savePicks(picks);
}

function recordPlayerPick(pickKey, sport, playerName, prop, stat, gameMatchup, gamePk) {
  const picks = getPicks();
  if (picks[pickKey]) return;
  picks[pickKey] = { type: 'player', sport, player: playerName, prop, stat, gameMatchup, gamePk: gamePk || null, date: new Date().toISOString().slice(0,10), result: null };
  savePicks(picks);
}

async function resolvePlayerPicksForGame(espnGameId, gamePk) {
  if (!gamePk) return;
  const picks = getPicks();
  const prefix = `plr_${espnGameId}_`;
  const pending = Object.entries(picks).filter(([k, p]) => p.type === 'player' && p.result === null && k.startsWith(prefix));
  if (!pending.length) return;
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
    const box  = await res.json();
    const statMap = new Map();
    for (const side of ['away', 'home']) {
      for (const pid of (box.teams?.[side]?.batters || [])) {
        const ps = box.teams[side].players[`ID${pid}`];
        if (ps) statMap.set(String(pid), ps.stats?.batting || {});
      }
    }
    let changed = false;
    for (const [k, p] of pending) {
      const pid = k.split('_')[2];
      const st  = statMap.get(pid);
      if (!st) continue;
      const win =
        p.prop === 'Hit'  ? parseInt(st.hits         || 0) > 0 :
        p.prop === 'HR'   ? parseInt(st.homeRuns      || 0) > 0 :
        p.prop === 'RBI'  ? parseInt(st.rbi           || 0) > 0 :
        p.prop === 'Walk' ? parseInt(st.baseOnBalls   || 0) > 0 :
        p.prop === 'SB'   ? parseInt(st.stolenBases   || 0) > 0 : false;
      picks[k].result = win ? 'win' : 'loss';
      changed = true;
    }
    if (changed) { savePicks(picks); updatePicksDisplay(); }
  } catch {}
}

function showPicksHistory() {
  document.getElementById('picks-history-modal')?.remove();
  const picks    = getPicks();
  const allVals  = Object.values(picks);
  const pending  = allVals.filter(p => p.result === null);
  const resolved = allVals
    .filter(p => p.result !== null)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const SPORT_LABEL = { tennis:'🎾 Tennis', mlb:'⚾ MLB', nba:'🏀 NBA', wnba:'🏀 WNBA', nfl:'🏈 NFL', nhl:'🏒 NHL', soccer:'⚽ Soccer', golf:'⛳ Golf' };

  // Separate game picks from player picks
  const allValsTyped = Object.values(picks);
  const gamePicks    = allValsTyped.filter(p => p.type !== 'player');
  const playerPicks  = allValsTyped.filter(p => p.type === 'player')
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const makeRow = p => {
    const win = p.result === 'win';
    return `<div class="ph-row ${win ? 'ph-win' : 'ph-loss'}">
      <span class="ph-icon">${win ? '✓' : '✗'}</span>
      <span class="ph-date">${esc(p.date)}</span>
      <span class="ph-matchup">${esc(p.matchup || p.team)}</span>
      <span class="ph-pick">→ ${esc(p.team)}</span>
    </div>`;
  };

  const makePendingRow = p => `<div class="ph-row ph-pending-row">
    <span class="ph-icon">⏳</span>
    <span class="ph-date">${esc(p.date)}</span>
    <span class="ph-matchup">${esc(p.matchup || p.team)}</span>
    <span class="ph-pick">→ ${esc(p.team)}</span>
  </div>`;

  const makePlayerRow = p => {
    const win  = p.result === 'win';
    const icon = p.result === null ? '⏳' : (win ? '✓' : '✗');
    const cls  = p.result === null ? 'ph-pending-row' : (win ? 'ph-win' : 'ph-loss');
    const PROP_ICON = { Hit:'🎯', HR:'💣', RBI:'⚡', Walk:'🚶', SB:'🏃' };
    return `<div class="ph-row ph-player-row ${cls}">
      <span class="ph-icon">${icon}</span>
      <span class="ph-date">${esc(p.date)}</span>
      <span class="ph-matchup"><span class="ph-prop-badge">${PROP_ICON[p.prop]||''} ${esc(p.prop)}</span> ${esc(lastName(p.player || ''))}</span>
      <span class="ph-pick">${esc(p.gameMatchup || '')}</span>
    </div>`;
  };

  // Group ALL picks by sport (game picks + player picks together)
  const groups     = new Map();
  const pendingMap = new Map();
  for (const p of resolved) {
    const sp = p.sport || (p.matchup?.includes(' vs ') ? 'tennis' : 'other');
    if (!groups.has(sp)) groups.set(sp, []);
    groups.get(sp).push(p);
  }
  for (const p of pending) {
    const sp = p.sport || 'other';
    if (!pendingMap.has(sp)) pendingMap.set(sp, []);
    pendingMap.get(sp).push(p);
  }

  // Use the right renderer based on pick type
  const renderRow  = p => p.type === 'player' ? makePlayerRow(p) : makeRow(p);
  const renderPend = p => p.type === 'player' ? makePlayerRow(p) : makePendingRow(p);

  const renderTabContent = sp => {
    if (sp === 'players') {
      if (!playerPicks.length) return '<div class="ph-empty">No player picks yet — visit the MLB Picks tab to generate them.</div>';
      const pPend = playerPicks.filter(p => p.result === null);
      const pRes  = playerPicks.filter(p => p.result !== null);
      const PROP_ICON = { Hit:'🎯', HR:'💣', RBI:'⚡', Walk:'🚶', SB:'🏃' };
      const cats = {};
      for (const p of pRes) {
        if (!cats[p.prop]) cats[p.prop] = { w:0, l:0 };
        if (p.result === 'win') cats[p.prop].w++; else cats[p.prop].l++;
      }
      const catSummary = Object.entries(cats).length
        ? `<div class="ph-cat-summary">${Object.entries(cats).map(([prop, r]) => {
            const tot = r.w + r.l;
            const pct = Math.round(r.w / tot * 100);
            return `<span class="ph-cat-chip ph-cat-${pct >= 55 ? 'good' : pct <= 40 ? 'bad' : 'avg'}">${PROP_ICON[prop]||''} ${prop} ${r.w}–${r.l}</span>`;
          }).join('')}</div>` : '';
      let html = catSummary;
      if (pPend.length) {
        html += `<div class="ph-sport-hdr ph-pending-hdr">Pending (${pPend.length})</div>`;
        html += pPend.map(makePlayerRow).join('');
      }
      if (pRes.length) {
        const w = pRes.filter(p => p.result === 'win').length;
        html += `<div class="ph-sport-hdr">Results — ${w}W ${pRes.length - w}L</div>`;
        html += pRes.map(makePlayerRow).join('');
      }
      return html || '<div class="ph-empty">No player picks yet.</div>';
    }
    const items = sp === 'all' ? resolved : (groups.get(sp) || []);
    const pend  = sp === 'all' ? pending  : (pendingMap.get(sp) || []);
    if (!items.length && !pend.length) return '<div class="ph-empty">No picks for this sport yet.</div>';
    let html = items.length
      ? items.map(renderRow).join('')
      : '<div class="ph-empty">No resolved picks yet — results come in after games finish.</div>';
    if (pend.length) {
      html += `<div class="ph-sport-hdr ph-pending-hdr">Pending (${pend.length})</div>`;
      html += pend.map(renderPend).join('');
    }
    return html;
  };

  // All sports that have any game picks
  const allSports = [...new Set([...groups.keys(), ...pendingMap.keys()])];
  const playerResolved = playerPicks.filter(p => p.result !== null);
  const playerWins = playerResolved.filter(p => p.result === 'win').length;
  const playerRec  = playerResolved.length ? `<span class="ph-tab-rec">${playerWins}–${playerResolved.length - playerWins}</span>` : '';

  const tabsHTML = [
    `<button class="ph-tab ph-tab-active" data-ph-tab="all">All</button>`,
    ...allSports.map(sp => {
      const label = SPORT_LABEL[sp] || sp.toUpperCase();
      const wins  = (groups.get(sp) || []).filter(p => p.result === 'win').length;
      const total = (groups.get(sp) || []).length;
      const rec   = total ? `<span class="ph-tab-rec">${wins}–${total - wins}</span>` : '';
      return `<button class="ph-tab" data-ph-tab="${esc(sp)}">${esc(label)}${rec}</button>`;
    }),
    `<button class="ph-tab" data-ph-tab="players">🎯 Players${playerRec}</button>`
  ].join('');

  const modal = document.createElement('div');
  modal.id    = 'picks-history-modal';
  modal.className = 'ph-modal';
  modal.innerHTML = `<div class="ph-panel">
    <div class="ph-hdr">
      <span class="ph-title">Pick History</span>
      <span class="ph-sub">last 14 days</span>
      <button class="ph-close" onclick="document.getElementById('picks-history-modal').remove()">✕</button>
    </div>
    <div class="ph-tabs">${tabsHTML}</div>
    <div class="ph-list" id="ph-list-content">${renderTabContent('all')}</div>
  </div>`;

  modal.querySelector('.ph-tabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-ph-tab]');
    if (!btn) return;
    modal.querySelectorAll('.ph-tab').forEach(b => b.classList.remove('ph-tab-active'));
    btn.classList.add('ph-tab-active');
    modal.querySelector('#ph-list-content').innerHTML = renderTabContent(btn.dataset.phTab);
  });

  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

function resolvePick(gameId, winnerFull) {
  const picks = getPicks();
  const p = picks[gameId];
  if (!p || p.result !== null) return;
  const pickLow   = p.team.toLowerCase();
  const winnerLow = (winnerFull || '').toLowerCase();
  p.result = (winnerLow === pickLow || winnerLow.endsWith(' ' + pickLow) || winnerLow.includes(pickLow)) ? 'win' : 'loss';
  savePicks(picks);
  updatePicksDisplay();
}

function updatePicksDisplay() {
  const allPicks   = getPicks();
  const allVals    = Object.values(allPicks);
  const sport      = S.sport;

  // Sport-specific
  const sportPicks = allVals.filter(p => (p.sport || 'tennis') === sport);
  const sportRes   = sportPicks.filter(p => p.result !== null);
  const sportPend  = sportPicks.filter(p => p.result === null);
  const sWins      = sportRes.filter(p => p.result === 'win').length;
  const sLosses    = sportRes.length - sWins;
  const sPct       = sportRes.length ? Math.round((sWins / sportRes.length) * 100) : 0;

  // Overall (all sports combined)
  const allRes     = allVals.filter(p => p.result !== null);
  const allPend    = allVals.filter(p => p.result === null);
  const allWins    = allRes.filter(p => p.result === 'win').length;
  const allLosses  = allRes.length - allWins;
  const allPct     = allRes.length ? Math.round((allWins / allRes.length) * 100) : 0;

  // Small topbar badge — sport-specific resolved picks only
  const badge = document.getElementById('picks-accuracy');
  if (badge) {
    if (!sportRes.length) { badge.textContent = ''; badge.classList.remove('has-picks'); }
    else {
      badge.textContent = `${sWins}W-${sLosses}L (${sPct}%)`;
      badge.title = `${sWins} correct, ${sLosses} wrong`;
      badge.classList.add('has-picks');
    }
  }

  // Banner — show whenever ANY picks exist in the system (any sport)
  const banner  = document.getElementById('picks-banner');
  const pbWins  = document.getElementById('pb-wins');
  const pbLoss  = document.getElementById('pb-losses');
  const pbPct   = document.getElementById('pb-pct');
  const pbBreak = document.getElementById('pb-breakdown');
  if (!banner || !pbWins || !pbLoss || !pbPct) return;

  banner.style.display = ''; // always visible

  if (!allVals.length) {
    pbWins.textContent = '0';
    pbLoss.textContent = '0';
    pbPct.textContent  = 'making picks…';
    if (pbBreak) pbBreak.textContent = '';
    banner.className = '';
    return;
  }

  if (sportRes.length) {
    // Sport has resolved picks — show sport record
    pbWins.textContent = sWins;
    pbLoss.textContent = sLosses;
    pbPct.textContent  = `(${sPct}%)`;
    if (pbBreak) pbBreak.textContent = sportPend.length ? `+${sportPend.length} active` : '';
    banner.className = sPct >= 55 ? 'pb-hot' : sPct <= 40 ? 'pb-cold' : '';
  } else if (allRes.length) {
    // Current sport has no resolved picks but other sports do — show overall
    pbWins.textContent = allWins;
    pbLoss.textContent = allLosses;
    pbPct.textContent  = `(${allPct}%)`;
    if (pbBreak) pbBreak.textContent = 'all sports';
    banner.className = allPct >= 55 ? 'pb-hot' : allPct <= 40 ? 'pb-cold' : '';
  } else {
    // All picks still pending — no resolved games yet
    pbWins.textContent = '—';
    pbLoss.textContent = '—';
    pbPct.textContent  = `${allPend.length} picks active`;
    if (pbBreak) pbBreak.textContent = '';
    banner.className = '';
  }
}

function clearOldPicks() {
  const picks  = getPicks();
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14);
  const cutStr = cutoff.toISOString().slice(0,10);
  let changed  = false;
  for (const [k, p] of Object.entries(picks)) {
    if (p.date < cutStr) { delete picks[k]; changed = true; }
  }
  if (changed) savePicks(picks);
}

function renderFavoritesView() {
  const panel = document.getElementById('view-favorites');
  if (!panel) return;
  const favs = getFavs();
  const entries = Object.values(favs).sort((a, b) => b.added - a.added);
  if (!entries.length) {
    panel.innerHTML = '<div class="empty-state">No favorites yet.<div class="muted">Tap ★ on any tennis match to save it here.</div></div>';
    return;
  }
  const matchFavs = entries.filter(e => e.type === 'match');
  let html = '';
  if (matchFavs.length) {
    html += '<div class="fav-section"><div class="fav-section-hdr">Starred Matches</div>';
    for (const fav of matchFavs) {
      const m = S.matches.get(fav.id);
      if (m) {
        html += buildMatchRow(m);
      } else {
        html += `<div class="fav-stale-row">
          <span class="fav-stale-label">${esc(fav.label)}</span>
          <span class="fav-stale-meta">Go to Tennis tab to load live data</span>
          <button class="fav-remove-btn" onclick="toggleFav('match','${esc(fav.id)}','')">✕</button>
        </div>`;
      }
    }
    html += '</div>';
  }
  panel.innerHTML = html || '<div class="empty-state">No favorites yet.</div>';
}

// ── UTILITIES ───────────────────────────────────────────────
function dateStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

const CURRENT_SEASON = new Date().getFullYear();

const _SUFFIXES = new Set(['jr','jr.','sr','sr.','ii','iii','iv']);
function lastName(fullName) {
  if (!fullName) return '-';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1].toLowerCase();
  if (_SUFFIXES.has(last) && parts.length > 2) return parts[parts.length - 2];
  return parts[parts.length - 1];
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

// api-tennis.com does not return tournament_surface; infer from name/location
function inferSurface(name = '') {
  const n = name.toLowerCase();

  if (/indoor|carpet/.test(n)) return 'Indoor Hard';

  // Explicit grass tournaments
  if (/wimbledon|queen.?s.club|eastbourne|halle|hertogenbosch|'s-hertogenbosch|birmingham|nottingham|mallorca|rosmalen/.test(n)) return 'Grass';

  // Explicit ATP/WTA clay events
  if (/roland.garros|french.open/.test(n)) return 'Clay';

  // Clay-surface cities/tournaments (ATP, WTA, Challenger, ITF)
  const clayNames = [
    'hamburg','rome','madrid','barcelona','monte.carlo','monte carlo',
    'lyon','geneva','geneve','istanbul','marrakech','munich','belgrade',
    'gstaad','bastad','båstad','kitzbühel','kitzbuhel','umag','estoril',
    'buenos.aires','buenos aires','rio open','cordoba','bogota','santiago',
    'strasbourg','rabat','prague','warsaw','varsovie','budapest',
    'bucharest','sofia','palermo','lausanne','lausanne',
    'portoroz','portorož','klagenfurt','bol ','cervia','bologna',
    'parma','florence','firenze','napoli','naples','verona','venezia',
    'cagliari','palermo','ravenna','torino','genova',
    'marbella','benalmadena','seville','sevilla','valencia','mallorca open',
    'estepona','alicante','gran canaria','tenerife','gijon','vigo',
    'casablanca','tunis','cairo','sousse',
    'mataro','manacor','granollers','saint-gaudens','croissy',
    'deauville','rouen','saint-brieuc','chartres','rennes',
    'prostejov','brno','ostrava','pilsen',
    'bastad','vilamoura','estoril',
    'zagreb','split','dubrovnik','rijeka','varazdin',
    'kayseri','ankara','antalya','izmir',
    'luan','shenzhen clay','chengdu clay',
    'lima','bogota','medellin','guayaquil','quito',
    'belgrade','novi sad','nis',
    'poznan','warsaw','gdynia',
    'plovdiv','sofia','varna',
    'aix-en-provence','nice','cannes',
    'roland garros','paris clay',
  ];
  if (clayNames.some(c => n.includes(c))) return 'Clay';

  // Country-based clay inference for ITF/Challenger events:
  // Countries where outdoor tournaments are almost always clay
  if (/\b(italy|italia|spain|espana|spain\)|france|turkey|croatia|argentina|chile|brazil|brasil|colombia|peru|ecuador|mexico|morocco|tunisia|egypt|algeria|portugal|serbia|bulgaria|romania|czech|slovakia|austria|switzerland|slovenia|poland|hungary|greece|cyprus)\b/.test(n)) return 'Clay';

  return 'Hard';
}

function cleanScore(s) {
  // Strip tiebreak notation "(4)" and any decimals - show only the whole number
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
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.success === 0) throw new Error(json.errors || 'API error');
    return json.result || [];
  } catch (err) {
    clearTimeout(tid);
    throw err.name === 'AbortError' ? new Error('Request timed out') : err;
  }
}

async function loadFixtures(offset = 0) {
  showLoading('matches-area', 'Loading matches…');
  try {
    const d = dateStr(offset);
    const results = await tennisFetch('get_fixtures', { date_start: d, date_stop: d });
    for (const m of results) S.matches.set(String(m.event_key), m);
    renderMatches(results);
    renderOverview(results);
    renderSidebar(results);
  } catch (err) {
    console.error('Fixtures error:', err);
    showError('matches-area', `Could not load matches - ${err.message}`, `loadFixtures(${offset})`);
  }
}

async function loadLivescores() {
  try {
    const results = await tennisFetch('get_livescore');
    for (const m of results) {
      S.matches.set(String(m.event_key), m);
      patchRow(m);
    }
    setConn('connected', `Polling - ${results.length} live match${results.length !== 1 ? 'es' : ''}`);
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

    // Build rank index for pick algorithm cross-referencing
    S.rankIndex.clear();
    for (const p of [...atp, ...wta]) {
      if (p.player_key) S.rankIndex.set(String(p.player_key), {
        rank:    p.place ?? p.standing_place ?? p.ranking ?? 999,
        points:  p.points ?? p.standing_points ?? 0,
        league:  p.league || (atp.includes(p) ? 'ATP' : 'WTA')
      });
    }

    // Build playerDB directly from API data (always fresh, no external CSV needed)
    S.playerDB = [...atp.map(p => ({ ...p, _league: 'ATP' })), ...wta.map(p => ({ ...p, _league: 'WTA' }))]
      .map(p => {
        const name = (p.player || p.player_name || p.team_name || '').trim();
        if (!name) return null;
        const parts = name.split(' ');
        return {
          id:        String(p.player_key || ''),
          firstName: parts[0] || '',
          lastName:  parts.slice(1).join(' ') || '',
          fullName:  name,
          rank:      p.place ?? p.standing_place ?? p.ranking ?? 0,
          points:    p.points ?? p.standing_points ?? 0,
          league:    p._league,
          country:   p.country || p.player_country || p.nationality || '',
          hand:      '',
          dob:       '',
        };
      })
      .filter(Boolean);
    S.playerDBLoaded  = true;
    S.playerDBLoading = false;

    renderRankings(atp, wta);
  } catch (err) {
    showError('rankings-area', `Could not load rankings - ${err.message}`, 'loadRankings()');
  }
}

// ── WEBSOCKET ────────────────────────────────────────────────
function wsConnect() {
  if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
  if (S.wsTimer) { clearTimeout(S.wsTimer); S.wsTimer = null; }
  setConn('connecting', 'Connecting to live updates…');

  // If the WebSocket hasn't opened within 10 seconds, give up and poll instead
  const wsTimeout = setTimeout(() => {
    if (S.ws && S.ws.readyState !== WebSocket.OPEN) {
      S.ws.onclose = null;
      S.ws.close();
      S.ws = null;
      startPoll();
    }
  }, 10000);

  try {
    S.ws = new WebSocket(`${CFG.tennis.ws}?APIkey=${CFG.tennis.key}`);

    S.ws.onopen = () => {
      clearTimeout(wsTimeout);
      S.wsRetries = 0; S.usePoll = false;
      if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
      setConn('connected', 'Live updates active');
      try { S.ws.send(JSON.stringify({ action: 'subscribe', APIkey: CFG.tennis.key })); } catch {}
    };

    S.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        const updates = Array.isArray(data) ? data : [data];
        let count = 0;
        for (const u of updates) {
          if (!u.event_key) continue;
          const merged = { ...(S.matches.get(String(u.event_key)) || {}), ...u };
          S.matches.set(String(u.event_key), merged);
          patchRow(merged);
          count++;
        }
        if (count > 0) { S.lastUpdate = new Date(); refreshLastUpdated(); }
      } catch {}
    };

    S.ws.onerror = () => {};

    S.ws.onclose = () => {
      clearTimeout(wsTimeout);
      S.ws = null;
      if (S.wsRetries < S.wsMax) {
        S.wsRetries++;
        setConn('connecting', `Reconnecting… (${S.wsRetries}/${S.wsMax})`);
        S.wsTimer = setTimeout(wsConnect, 15000);
      } else {
        startPoll();
      }
    };
  } catch {
    clearTimeout(wsTimeout);
    startPoll();
  }
}

function startPoll() {
  S.usePoll = true;
  setConn('disconnected', 'Live mode unavailable - polling every 30s');
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
  const liveMatches  = filtered.filter(m => isLive(m.event_status));
  const liveSingles  = liveMatches.filter(m => matchCategory(m.event_type_type || '') !== 'doubles');
  const liveDoubles  = liveMatches.filter(m => matchCategory(m.event_type_type || '') === 'doubles');
  let html = '';
  if (liveMatches.length) {
    const singlesBlock = liveSingles.length
      ? `<div class="live-sub-hdr">Singles</div>${liveSingles.map(m => buildMatchRow(m, 'live')).join('')}`
      : '';
    const doublesBlock = liveDoubles.length
      ? `<div class="live-sub-hdr live-sub-doubles">Doubles</div>${liveDoubles.map(m => buildMatchRow(m, 'live')).join('')}`
      : '';
    html += `
      <div class="live-now-section">
        <div class="live-now-header">
          <span class="live-now-dot">●</span>
          LIVE NOW
          <span class="live-now-count">${liveMatches.length} match${liveMatches.length !== 1 ? 'es' : ''}</span>
        </div>
        ${singlesBlock}${doublesBlock}
      </div>`;
  }

  // ── Category sections → tournament groups ──
  const CATS = [
    { key: 'atp',          label: 'ATP Singles' },
    { key: 'wta',          label: 'WTA Singles' },
    { key: 'challenger-m', label: 'Challenger Men' },
    { key: 'challenger-w', label: 'Challenger Women' },
    { key: 'itf-m',        label: 'ITF Men' },
    { key: 'itf-w',        label: 'ITF Women' },
    { key: 'doubles',      label: 'Doubles' },
    { key: 'other',        label: 'Other' },
  ];

  // Group by category then tournament
  const catMap = new Map();
  for (const m of filtered) {
    const cat = matchCategory(m.event_type_type || '');
    if (!catMap.has(cat)) catMap.set(cat, new Map());
    const tKey = m.tournament_name || m.league_name || m.event_type_type || 'Other';
    const tMap = catMap.get(cat);
    if (!tMap.has(tKey)) tMap.set(tKey, { name: tKey, surface: m.tournament_surface || inferSurface(tKey), type: m.event_type_type || '', matches: [] });
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
  updatePicksDisplay();
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

function inlineTennisPick(m) {
  // Don't generate picks for future-dated matches — record them when their day arrives
  if (m.event_date && m.event_date > dateStr(0)) return '';

  const pickId  = 'tn_' + m.event_key;
  const surface = m.event_surface ? ` (${m.event_surface})` : '';
  const matchup = `${lastName(m.event_first_player||'')} vs ${lastName(m.event_second_player||'')}${surface}`;
  const s1 = parseInt(m.event_first_player_seed) || 0;
  const s2 = parseInt(m.event_second_player_seed) || 0;
  if (s1 || s2) {
    let pick = '';
    if (s1 && !s2)      pick = lastName(m.event_first_player || '');
    else if (s2 && !s1) pick = lastName(m.event_second_player || '');
    else if (s1 < s2)   pick = lastName(m.event_first_player || '');
    else if (s2 < s1)   pick = lastName(m.event_second_player || '');
    if (pick && pick !== '-') { recordPick(pickId, pick, matchup, 'tennis'); return `<span class="match-pick-inline" title="Pick based on seeding (click match for full H2H + ranking analysis)">→ ${esc(pick)}</span>`; }
  }
  const r1 = S.rankIndex.get(String(m.first_player_key  || ''));
  const r2 = S.rankIndex.get(String(m.second_player_key || ''));
  if (r1 && r2 && r1.rank !== r2.rank) {
    const pick = r1.rank < r2.rank ? lastName(m.event_first_player || '') : lastName(m.event_second_player || '');
    if (pick && pick !== '-') { recordPick(pickId, pick, matchup, 'tennis'); return `<span class="match-pick-inline" title="Pick based on live ranking: #${r1.rank} vs #${r2.rank} (click for full H2H + form analysis)">→ ${esc(pick)} #${Math.min(r1.rank, r2.rank)}</span>`; }
  }
  return '';
}

// idSuffix: when provided (e.g. 'live'), creates a unique panel ID so the same
// match can have an independent expandable panel in the LIVE NOW section and the
// category section simultaneously without duplicate IDs.
function buildMatchRow(m, idSuffix = '') {
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
  const pid = idSuffix ? `${key}-${idSuffix}` : key;

  const _pickResult = inlineTennisPick(m); // always call — records pick as side effect (idempotent)
  const pickHTML    = (!live && !finished) ? _pickResult : ''; // only display for upcoming
  // Resolve stored pick once result is known
  if (finished && m.event_winner) {
    let winnerLN = '';
    if (m.event_winner === 'First Player')       winnerLN = lastName(m.event_first_player  || '');
    else if (m.event_winner === 'Second Player') winnerLN = lastName(m.event_second_player || '');
    else                                          winnerLN = lastName(m.event_winner);
    if (winnerLN) resolvePick('tn_' + m.event_key, winnerLN);
  }
  const favOn = isFav('match', m.event_key);
  const favLabel = esc((m.event_first_player||'') + ' vs ' + (m.event_second_player||''));
  const starBtn = `<button class="star-btn${favOn?' fav-on':''}" data-fav-id="match:${key}" data-fav-label="${favLabel}" title="${favOn?'Remove from favorites':'Add to favorites'}" onclick="event.stopPropagation();toggleFavBtn(this)">★</button>`;

  const detailPanel = `
    <div class="match-detail" id="md-${pid}" style="display:none">
      <div class="detail-inner" id="di-${pid}">
        <div class="td-loading"><div class="spinner"></div> Loading match stats…</div>
      </div>
    </div>`;

  return `
    <div class="match-row ${live?'live':''} ${finished?'finished':''}"
         data-key="${key}"
         onclick="toggleDetail('${pid}','${key}')">
      <div class="match-status">${statusHTML}</div>
      <div class="match-players">
        <div class="player p1 ${serve==='1'?'serving':''}">
          <span class="player-name">${esc(m.event_first_player||'-')}</span>${p1serve}
        </div>
        <div class="player p2 ${serve==='2'?'serving':''}">
          <span class="player-name">${esc(m.event_second_player||'-')}</span>${p2serve}
        </div>
      </div>
      <div class="match-scores">
        <div class="sets-area">${setsHTML}</div>
        ${gameHTML}${pickHTML}${starBtn}
      </div>
    </div>${detailPanel}`;
}

function buildDetailSets(sets) {
  if (!sets.length) return '<span style="color:var(--text-muted);font-size:.8rem">No set data yet</span>';
  return sets.map((s, i) => `
    <div class="detail-set">
      <div class="detail-set-label">Set ${i+1}</div>
      <div class="detail-set-scores">${esc(s.p1)} - ${esc(s.p2)}</div>
    </div>`).join('');
}

async function loadTennisMatchDetail(key, container, m) {
  try {
    const surface = m.tournament_surface || inferSurface(m.tournament_name);
    let h2h = [], p1Recent = [], p2Recent = [];
    if (m.first_player_key && m.second_player_key) {
      try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 8000);
        const url  = new URL(CFG.tennis.base);
        url.searchParams.set('method', 'get_H2H');
        url.searchParams.set('APIkey', CFG.tennis.key);
        url.searchParams.set('first_player_key',  m.first_player_key);
        url.searchParams.set('second_player_key', m.second_player_key);
        const res  = await fetch(url.toString(), { signal: ctrl.signal });
        clearTimeout(tid);
        if (res.ok) {
          const json = await res.json();
          if (json.success === 1) {
            const raw = json.result || {};
            h2h      = Array.isArray(raw.H2H)                ? raw.H2H                : [];
            p1Recent = Array.isArray(raw.firstPlayerResults)  ? raw.firstPlayerResults.slice(0, 5)  : [];
            p2Recent = Array.isArray(raw.secondPlayerResults) ? raw.secondPlayerResults.slice(0, 5) : [];
          }
        }
      } catch {}
    }
    container.innerHTML = buildTennisDetailHTML(m, h2h, surface, p1Recent, p2Recent);
  } catch (err) {
    container.innerHTML = `<div class="td-error">Could not load - ${esc(err.message)}</div>`;
  }
}

function buildTennisDetailHTML(m, h2h, surface, p1Recent = [], p2Recent = []) {
  const p1Name = m.event_first_player || '-';
  const p2Name = m.event_second_player || '-';
  const p1key  = String(m.first_player_key  || '');
  const p2key  = String(m.second_player_key || '');
  const s1tag  = m.event_first_player_seed  ? ` <span class="td-seed">[${m.event_first_player_seed}]</span>`  : '';
  const s2tag  = m.event_second_player_seed ? `<span class="td-seed">[${m.event_second_player_seed}]</span> ` : '';
  const scLow  = surfaceClass(surface);
  const surfLabel = surface || 'Hard';

  // Filter H2H by surface - infer surface of each past match from tournament name
  const surfLow = surfLabel.toLowerCase();
  const onSurface = h2h.filter(g => {
    const gs = inferSurface(g.tournament_name).toLowerCase();
    if (surfLow.includes('clay'))  return gs.includes('clay');
    if (surfLow.includes('grass')) return gs.includes('grass');
    if (surfLow.includes('indoor')) return gs.includes('indoor');
    return gs === 'hard';
  });

  // Count wins using API's "First Player" / "Second Player" convention + player keys
  function countWins(games) {
    let w1 = 0, w2 = 0;
    for (const g of games) {
      const winner = g.event_winner;
      if (!winner) continue;
      const gp1key = String(g.first_player_key || '');
      if (winner === 'First Player')  { if (gp1key === p1key) w1++; else w2++; }
      else if (winner === 'Second Player') { if (gp1key === p1key) w2++; else w1++; }
    }
    return { w1, w2 };
  }

  const { w1: aw1, w2: aw2 } = countWins(h2h);
  const { w1: sw1, w2: sw2 } = countWins(onSurface);

  const sets = parseSets(m);
  const live = isLive(m.event_status);

  // H2H match rows
  const recentHTML = h2h.length
    ? h2h.slice(0, 6).map(g => {
        const winner   = g.event_winner || '';
        const gp1key   = String(g.first_player_key || '');
        const isP1     = (winner === 'First Player' && gp1key === p1key) ||
                         (winner === 'Second Player' && gp1key === p2key);
        const winName  = isP1 ? esc(lastName(p1Name)) : esc(lastName(p2Name));
        const surf     = inferSurface(g.tournament_name);
        const date     = g.event_date ? fmtDateShort(g.event_date) : '';
        return `<div class="td-h2h-row">
          <span class="td-h2h-winner ${isP1?'td-p1-win':'td-p2-win'}">${winName}</span>
          <span class="td-h2h-result">${esc(g.event_final_result || '')}</span>
          <span class="td-h2h-meta">${esc(g.tournament_name || '')} · ${esc(surf)}${date ? ' · '+date : ''}</span>
        </div>`;
      }).join('')
    : '<div class="td-h2h-empty">No previous meetings found</div>';

  // Recent form dots for each player
  const formDots = (games, pkey) => games.map(g => {
    const winner  = g.event_winner;
    const gp1key  = String(g.first_player_key || '');
    const won     = (winner === 'First Player'  && gp1key === pkey) ||
                    (winner === 'Second Player' && gp1key !== pkey);
    const opp     = gp1key === pkey ? esc(lastName(g.event_second_player || '')) : esc(lastName(g.event_first_player || ''));
    const result  = g.event_final_result || '';
    return `<span class="td-form-dot ${won?'td-form-w':'td-form-l'}" title="${won?'W':'L'} vs ${opp} ${esc(result)}">${won?'W':'L'}</span>`;
  }).join('');

  const formHTML = (p1Recent.length || p2Recent.length) ? `
    <div class="td-section">
      <div class="td-section-hdr">Recent Form (last 5)</div>
      <div class="td-form-row"><span class="td-form-name">${esc(lastName(p1Name))}</span>${formDots(p1Recent, p1key)}</div>
      <div class="td-form-row"><span class="td-form-name">${esc(lastName(p2Name))}</span>${formDots(p2Recent, p2key)}</div>
    </div>` : '';

  const predHTML = buildTennisPrediction(m, h2h, onSurface, aw1, aw2, sw1, sw2, surfLabel, p1Recent, p2Recent, p1key, p2key);

  return `<div class="td-panel">
    <div class="td-header">
      <div class="td-player">${esc(p1Name)}${s1tag}</div>
      <div class="td-vs">VS</div>
      <div class="td-player td-p2-name">${s2tag}${esc(p2Name)}</div>
    </div>
    <div class="td-surface-row">
      <span class="surface-dot ${scLow}"></span>
      ${esc(surfLabel)} · ${esc(m.event_type_type || '')}
      ${m.event_status ? `<span class="td-status-txt">· ${esc(m.event_status)}</span>` : ''}
    </div>
    ${live && m.event_game_result ? `<div class="td-game-score">Game: ${esc(m.event_game_result)}</div>` : ''}
    <div class="td-sets">${buildDetailSets(sets)}</div>
    ${predHTML}
    ${formHTML}
    <div class="td-section">
      <div class="td-section-hdr">Head to Head${h2h.length ? ` (${h2h.length} matches)` : ''}</div>
      <div class="td-h2h-summary">
        <span class="td-h2h-count td-p1-win">${aw1}</span>
        <span class="td-h2h-label">${esc(lastName(p1Name))} vs ${esc(lastName(p2Name))}</span>
        <span class="td-h2h-count td-p2-win">${aw2}</span>
      </div>
      ${onSurface.length ? `<div class="td-h2h-summary td-h2h-surface">
        <span class="td-h2h-count td-p1-win">${sw1}</span>
        <span class="td-h2h-label">${esc(surfLabel)} only (${onSurface.length})</span>
        <span class="td-h2h-count td-p2-win">${sw2}</span>
      </div>` : ''}
      ${recentHTML}
    </div>
  </div>`;
}

function buildTennisPrediction(m, h2hAll, h2hSurf, aw1, aw2, sw1, sw2, surfLabel, p1Recent = [], p2Recent = [], p1key = '', p2key = '') {
  const p1Name = m.event_first_player || '-';
  const p2Name = m.event_second_player || '-';
  const s1 = parseInt(m.event_first_player_seed) || 0;
  const s2 = parseInt(m.event_second_player_seed) || 0;
  const l1 = esc(lastName(p1Name));
  const l2 = esc(lastName(p2Name));

  const factors = [];
  let p1Score = 0, p2Score = 0;

  // Seeds
  if (s1 && s2) {
    if (s1 < s2)      { p1Score += 2; factors.push({ win: true, label: 'Seeding', detail: `${l1} [${s1}] vs [${s2}]`, side: 1 }); }
    else if (s2 < s1) { p2Score += 2; factors.push({ win: true, label: 'Seeding', detail: `${l2} [${s2}] vs [${s1}]`, side: 2 }); }
    else               {               factors.push({ win: null, label: 'Seeding', detail: 'Equal seeds', side: 0 }); }
  } else if (s1) {
    p1Score += 1;
    factors.push({ win: true, label: 'Seeding', detail: `${l1} seeded [${s1}], ${l2} unseeded`, side: 1 });
  } else if (s2) {
    p2Score += 1;
    factors.push({ win: true, label: 'Seeding', detail: `${l2} seeded [${s2}], ${l1} unseeded`, side: 2 });
  }

  // Rankings (if loaded and no seeds)
  if (!s1 && !s2) {
    const r1 = S.rankIndex.get(p1key);
    const r2 = S.rankIndex.get(p2key);
    if (r1 && r2 && r1.rank !== r2.rank) {
      if (r1.rank < r2.rank) { p1Score += 2; factors.push({ win: true, label: 'Ranking', detail: `${l1} #${r1.rank} vs ${l2} #${r2.rank}`, side: 1 }); }
      else                   { p2Score += 2; factors.push({ win: true, label: 'Ranking', detail: `${l2} #${r2.rank} vs ${l1} #${r1.rank}`, side: 2 }); }
    }
  }

  // H2H overall
  if (h2hAll.length >= 2) {
    if (aw1 > aw2)      { p1Score += 2; factors.push({ win: true, label: 'H2H overall', detail: `${l1} leads ${aw1}–${aw2}`, side: 1 }); }
    else if (aw2 > aw1) { p2Score += 2; factors.push({ win: true, label: 'H2H overall', detail: `${l2} leads ${aw2}–${aw1}`, side: 2 }); }
    else                 {               factors.push({ win: null, label: 'H2H overall', detail: `Even ${aw1}–${aw2}`, side: 0 }); }
  }

  // H2H on this surface
  if (h2hSurf.length >= 2) {
    if (sw1 > sw2)      { p1Score += 3; factors.push({ win: true, label: `On ${esc(surfLabel)}`, detail: `${l1} leads ${sw1}–${sw2}`, side: 1 }); }
    else if (sw2 > sw1) { p2Score += 3; factors.push({ win: true, label: `On ${esc(surfLabel)}`, detail: `${l2} leads ${sw2}–${sw1}`, side: 2 }); }
    else                 {               factors.push({ win: null, label: `On ${esc(surfLabel)}`, detail: `Even ${sw1}–${sw2}`, side: 0 }); }
  }

  // Recent form (last 5 matches)
  const formWins = (games, pkey) => {
    let w = 0;
    for (const g of games) {
      const winner = g.event_winner;
      const gp1key = String(g.first_player_key || '');
      if ((winner === 'First Player'  && gp1key === pkey) ||
          (winner === 'Second Player' && gp1key !== pkey)) w++;
    }
    return w;
  };
  const fw1 = p1Recent.length ? formWins(p1Recent, p1key) : -1;
  const fw2 = p2Recent.length ? formWins(p2Recent, p2key) : -1;
  if (fw1 >= 0 && fw2 >= 0 && fw1 !== fw2) {
    if (fw1 > fw2) { p1Score += 2; factors.push({ win: true, label: 'Recent form', detail: `${l1} ${fw1}/5 vs ${l2} ${fw2}/5`, side: 1 }); }
    else           { p2Score += 2; factors.push({ win: true, label: 'Recent form', detail: `${l2} ${fw2}/5 vs ${l1} ${fw1}/5`, side: 2 }); }
  }

  if (!factors.length) return '';

  let verdictHTML = '';
  if (p1Score > p2Score) {
    const pct = Math.round((p1Score / (p1Score + p2Score)) * 100);
    verdictHTML = `<div class="gp-pick-verdict"><span class="gp-pick-team">${esc(p1Name)}</span> likely to win <span class="gp-pick-count">(${pct}% of factors)</span></div>`;
  } else if (p2Score > p1Score) {
    const pct = Math.round((p2Score / (p1Score + p2Score)) * 100);
    verdictHTML = `<div class="gp-pick-verdict"><span class="gp-pick-team">${esc(p2Name)}</span> likely to win <span class="gp-pick-count">(${pct}% of factors)</span></div>`;
  } else {
    verdictHTML = `<div class="gp-pick-verdict gp-verdict-toss">Even matchup - too close to call</div>`;
  }

  const factorsHTML = factors.map(f => {
    const cls  = f.win === true ? 'gp-pf-win' : 'gp-pf-tie';
    const icon = f.win === true ? '↑' : '=';
    return `<div class="gp-pfactor ${cls}">
      <span class="gp-pf-icon">${icon}</span>
      <span class="gp-pf-label">${f.label}</span>
      <span class="gp-pf-detail">${f.detail}</span>
    </div>`;
  }).join('');

  const factorNames = factors.map(f => f.label).join(', ');
  return `<div class="td-section">
    <div class="td-section-hdr">Match Prediction <span class="td-pick-basis">based on: ${esc(factorNames)}</span></div>
    <div class="gp-pick-box">${verdictHTML}<div class="gp-pick-factors">${factorsHTML}</div></div>
  </div>`;
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
    dgEl.textContent = `Current game: ${m.event_game_result || '-'}`;
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
    if (!groups.has(name)) groups.set(name, { name, surface: m.tournament_surface || inferSurface(name), count: 0, live: 0 });
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
        const name    = p.player || p.team_name || p.player_name || p.name || '-';
        const pts     = p.points ?? p.standing_points ?? p.ranking_points ?? '-';
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
    resultsEl.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Loading rankings…</p></div>';
    _playerSearchTimer = setTimeout(async () => {
      await loadRankings();
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
    team:     p.team?.full_name || p.team?.abbreviation || '-',
    position: p.position || '-',
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
    name:     p.fullName || '-',
    team:     p.currentTeam?.name || '-',
    position: p.primaryPosition?.abbreviation || p.primaryPosition?.name || '-',
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
    team:     p.currentTeamAbbrev || '-',
    position: p.positionCode || '-',
    extra:    [
      p.sweaterNumber ? `#${p.sweaterNumber}` : '',
      p.birthCountry  ? p.birthCountry : '',
    ].filter(Boolean).join(' · '),
  }));
}

async function searchESPNPlayers(sport, q) {
  // ESPN athletes endpoint - load active roster and filter client-side
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
      name:     a.fullName || a.displayName || '-',
      team:     a.team?.displayName || a.team?.abbreviation || '-',
      position: a.position?.abbreviation || a.position?.name || '-',
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
    <div class="player-results-header">${players.length} player${players.length !== 1 ? 's' : ''} found${isMLB ? ` - click for ${CURRENT_SEASON} stats` : ''}</div>
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

function loadSportScores(sport) {
  if (sport === 'soccer') loadSoccerScores();
  else if (sport === 'golf') loadGolfLeaderboard();
  else loadOtherScores(sport);
}

function startScoresTimer(sport) {
  stopScoresTimer();
  S.scoresTimer = setInterval(() => {
    if (S.sport === sport && S.view === 'scores') loadSportScores(sport);
  }, 30000);
}

function switchSport(sport) {
  S.sport = sport;
  S.otherDateOffset = 0;
  document.querySelectorAll('.sport-tab').forEach(t => t.classList.toggle('active', t.dataset.sport === sport));

  const isTennis = sport === 'tennis';
  document.querySelectorAll('.tennis-only').forEach(el => el.style.display = isTennis ? '' : 'none');

  const secTab      = document.getElementById('secondary-tab');
  const playersTab  = document.getElementById('players-tab');
  const lineupsTab  = document.getElementById('lineups-tab');
  const picksTab    = document.getElementById('picks-tab');
  if (S.lineupsTimer) { clearInterval(S.lineupsTimer); S.lineupsTimer = null; }
  stopScoresTimer();
  if (isTennis) {
    secTab.textContent = 'Rankings'; secTab.dataset.view = 'secondary';
    secTab.style.display   = '';
    playersTab.style.display  = 'none';
    lineupsTab.style.display  = 'none';
    picksTab.style.display    = '';
  } else if (sport === 'golf') {
    secTab.style.display   = 'none';
    playersTab.style.display  = 'none';
    lineupsTab.style.display  = 'none';
    picksTab.style.display    = 'none';
  } else if (sport === 'soccer') {
    secTab.textContent = 'Tables'; secTab.dataset.view = 'secondary';
    secTab.style.display   = '';
    playersTab.style.display  = '';
    lineupsTab.style.display  = 'none';
    picksTab.style.display    = 'none';
  } else {
    secTab.textContent = 'Standings'; secTab.dataset.view = 'secondary';
    secTab.style.display   = '';
    playersTab.style.display  = '';
    lineupsTab.style.display  = sport === 'mlb' ? '' : 'none';
    picksTab.style.display    = ['mlb','nba','nfl','nhl','wnba'].includes(sport) ? '' : 'none';
  }

  S.picksDateOffset = 0;
  switchView('scores');
  updatePicksDisplay();

  if (isTennis) {
    wsDisconnect(); wsConnect();
    loadFixtures(S.dateOffset);
  } else {
    wsDisconnect();
    setConn('disconnected', `${sport.toUpperCase()} - updating every 30s`);
    loadSportScores(sport);
  }
}

function switchView(view) {
  S.view = view;
  document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));

  if (view === 'favorites') {
    document.getElementById('view-favorites').classList.add('active');
    renderFavoritesView();
    return;
  }

  if (S.sport === 'tennis') {
    if (view === 'scores') {
      document.getElementById('view-tennis-scores').classList.add('active');
    } else if (view === 'picks') {
      document.getElementById('view-mlb-picks').classList.add('active');
      loadTennisPicksPage();
    } else {
      document.getElementById('view-tennis-rankings').classList.add('active');
      loadRankings();
    }
  } else {
    if (view === 'scores') {
      const panelId = S.sport === 'golf' ? 'view-golf-leaderboard' : 'view-other-scores';
      document.getElementById(panelId).classList.add('active');
      loadSportScores(S.sport);
      startScoresTimer(S.sport);
    } else if (view === 'lineups') {
      stopScoresTimer();
      document.getElementById('view-mlb-lineups').classList.add('active');
      loadMLBLineups();
      if (S.lineupsTimer) clearInterval(S.lineupsTimer);
      S.lineupsTimer = setInterval(loadMLBLineups, 5 * 60 * 1000);
    } else if (view === 'picks') {
      stopScoresTimer();
      document.getElementById('view-mlb-picks').classList.add('active');
      if (S.sport === 'mlb') loadMLBPicksPage();
      else loadOtherPicksPage(S.sport);
    } else if (view === 'players') {
      stopScoresTimer();
      document.getElementById('view-sport-players').classList.add('active');
      document.getElementById('sport-player-search-input').value = '';
      document.getElementById('sport-player-results').innerHTML = '<div class="empty-state">Type a name to search players</div>';
    } else {
      stopScoresTimer();
      document.getElementById('view-other-standings').classList.add('active');
      if (S.sport === 'mlb') loadMLBFullStandings();
      else if (S.sport === 'soccer') loadSoccerTables();
      else loadOtherStandings(S.sport);
    }
  }
}

// ── OTHER SPORTS DATE NAV ────────────────────────────────────
function otherDateNavHTML() {
  const off  = S.otherDateOffset;
  const d    = new Date();
  d.setDate(d.getDate() + off);
  const label = off === 0
    ? 'Today'
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: off > 180 || off < -30 ? 'numeric' : undefined });
  const dateVal = dateStr(off);
  const isNFL   = S.sport === 'nfl';
  return `<div class="other-date-nav">
    ${isNFL ? `<button class="odn-btn odn-wk" onclick="otherDateNav(-7)" title="Previous week">&#171; Week</button>` : ''}
    <button class="odn-btn" onclick="otherDateNav(-1)" title="Previous day">&#8249;</button>
    <label class="odn-date-label" title="Pick a date">
      <input type="date" class="odn-date-input" value="${dateVal}" onchange="otherDatePickerChange(this.value)">
      <span class="odn-date-text">${esc(label)}</span>
    </label>
    <button class="odn-btn" onclick="otherDateNav(1)" title="Next day">&#8250;</button>
    ${isNFL ? `<button class="odn-btn odn-wk" onclick="otherDateNav(7)" title="Next week">Week &#187;</button>` : ''}
    ${off !== 0 ? `<button class="odn-today" onclick="otherDateReset()">Today</button>` : ''}
  </div>`;
}

function otherDateNav(delta) {
  S.otherDateOffset += delta;
  loadOtherScores(S.sport);
}

function otherDateReset() {
  S.otherDateOffset = 0;
  loadOtherScores(S.sport);
}

function otherDatePickerChange(val) {
  const today  = new Date(); today.setHours(0, 0, 0, 0);
  const picked = new Date(val + 'T12:00:00');
  S.otherDateOffset = Math.round((picked - today) / 86400000);
  loadOtherScores(S.sport);
}

// ── OTHER SPORTS (ESPN primary, BDL + API-Sports fallback) ────
async function loadOtherScores(sport) {
  showLoading('other-scores-area', `Loading ${sport.toUpperCase()} games…`);
  try {
    const off = S.otherDateOffset;
    let games = []; let src = 'ESPN';
    try {
      games = await espnGames(sport, off);
    } catch (e) {
      console.warn('ESPN failed:', e.message, '- trying BallDontLie');
      src = 'BallDontLie';
      try {
        games = await bdlGames(sport, dateStr(off));
      } catch (e2) {
        console.warn('BDL failed:', e2.message, '- trying API-Sports');
        src = 'API-Sports';
        games = await apiSportsGames(sport, dateStr(off));
      }
    }
    renderOtherScores(games, sport, src);
    const t = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    setConn('connected', `${sport.toUpperCase()} - updated ${t} · refreshes every 30s`);
  } catch (err) {
    setConn('disconnected', `${sport.toUpperCase()} - update failed, retrying…`);
    showError('other-scores-area', `Could not load ${sport.toUpperCase()} - ${err.message}`, `loadOtherScores('${sport}')`);
  }
}

async function espnGames(sport, dateOffset = 0) {
  const paths = {
    nba:  'basketball/nba',
    wnba: 'basketball/wnba',
    mlb:  'baseball/mlb',
    nfl:  'football/nfl',
    nhl:  'hockey/nhl'
  };
  if (!paths[sport]) throw new Error('unknown sport');
  const d = dateStr(dateOffset).replace(/-/g, '');
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${paths[sport]}/scoreboard?dates=${d}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.events || []).map(ev => {
    const comp = ev.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === 'home') || comp.competitors[0];
    const away = comp.competitors.find(c => c.homeAway === 'away') || comp.competitors[1];
    const st   = comp.status || ev.status || {};
    const state = st.type?.state || '';
    return {
      id: ev.id,
      league: sport.toUpperCase(),
      homeTeam: home?.team?.shortDisplayName || home?.team?.name || '-',
      awayTeam: away?.team?.shortDisplayName || away?.team?.name || '-',
      homeAbbr: home?.team?.abbreviation || '',
      awayAbbr: away?.team?.abbreviation || '',
      homeRec: ((home?.records || home?.record || []).find(r => r.type === 'total') || (home?.records || home?.record || [])[0])?.summary || '',
      awayRec: ((away?.records || away?.record || []).find(r => r.type === 'total') || (away?.records || away?.record || [])[0])?.summary || '',
      series: comp.series ? { summary: comp.series.summary || '', title: comp.series.title || '' } : null,
      homeScore: state !== 'pre' ? (home?.score ?? '') : '',
      awayScore: state !== 'pre' ? (away?.score ?? '') : '',
      status: st.type?.shortDetail || st.type?.description || '-',
      period: st.period || '',
      time: st.displayClock || '',
      sport,
      odds: (() => { const o = comp.odds?.[0]; return o ? { spread: o.details || '', overUnder: o.overUnder || null } : null; })()
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
    homeTeam: g.home_team?.full_name || g.home_team?.name || '-',
    awayTeam: g.visitor_team?.full_name || g.visitor_team?.name || '-',
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
    homeTeam: g.teams?.home?.name || '-',
    awayTeam: (g.teams?.visitors || g.teams?.away)?.name || '-',
    homeScore: g.scores?.home?.points ?? g.scores?.home?.total ?? '',
    awayScore: (g.scores?.visitors || g.scores?.away)?.points ?? (g.scores?.visitors || g.scores?.away)?.total ?? '',
    status: g.status?.long || g.status?.short || '-',
    period: g.periods?.current || g.quarter || '',
    time: g.status?.clock || '',
    sport
  }));
}

function gameRowState(g) {
  const st = g.status || '';
  const live = /^(Q[1-4]|OT)\s+\d/i.test(st)
    || /^(Top|Bot|Mid)\s+\d/i.test(st)
    || /^(In.Progress|live|ongoing|H[1-2])$/i.test(st)
    || /^\d+(st|nd|rd|th)\s*(quarter|period|inning)/i.test(st)
    || /^\d+['′]/.test(st)                               // soccer: "45'"
    || /^(Halftime|HT|Half Time|Extra Time|ET)$/i.test(st); // soccer periods
  const fin  = /^Final/i.test(st) || /^F(\/|$)/i.test(st) || ['FT','Finished','Complete','Full Time','AET'].includes(st);
  const periodLabel = g.period ? `${g.period}${ordinal(+g.period || 0)}` : '';
  return { live, fin, periodLabel };
}

// Returns HTML for the best pick for an MLB game row — player prop if available, else game winner if confident.
function getGameBestPickHTML(espnGameId, g) {
  const picks     = getPicks();
  const gid       = String(espnGameId);
  const PROP_ORDER = ['HR', 'SB', 'Hit', 'RBI', 'Walk'];
  const PROP_ICON  = { HR:'💣', SB:'🏃', Hit:'🎯', RBI:'⚡', Walk:'🚶' };

  // Best player prop pick for this game (priority: HR > SB > Hit > RBI > Walk)
  const plrPicks = Object.entries(picks)
    .filter(([k]) => k.startsWith(`plr_${gid}_`))
    .map(([, p]) => p)
    .sort((a, b) => PROP_ORDER.indexOf(a.prop) - PROP_ORDER.indexOf(b.prop));

  if (plrPicks.length) {
    const best   = plrPicks[0];
    const lname  = lastName(best.player || '');
    const icon   = best.result === 'win' ? '✓' : best.result === 'loss' ? '✗' : (PROP_ICON[best.prop] || '🎯');
    const resCls = best.result === 'win' ? 'potd-win' : best.result === 'loss' ? 'potd-loss' : '';
    const tip    = best.stat ? ` title="${esc(best.stat)}"` : '';
    return `<span class="potd-label ${resCls}"${tip}>${icon} <strong>${esc(lname)}</strong> for a ${esc(best.prop)}</span>`;
  }

  // Fall back to game winner when margin is convincing (≥10%) and no player props loaded yet
  const gamePick = picks[gid];
  if (gamePick?.team && (g.awayRec || g.homeRec)) {
    const awayWP  = parseWinPct(g.awayRec), homeWP = parseWinPct(g.homeRec);
    const rawHome = homeWP * 1.03, total = awayWP + rawHome;
    const homePct = Math.round((rawHome / total) * 100);
    const margin  = Math.abs(homePct - 50);
    const pct     = Math.max(homePct, 100 - homePct);
    if (margin >= 10) {
      const { fin } = gameRowState(g);
      if (fin && gamePick.result !== null) {
        const icon   = gamePick.result === 'win' ? '✓' : '✗';
        const resCls = gamePick.result === 'win' ? 'potd-win' : 'potd-loss';
        return `<span class="potd-label ${resCls}">${icon} <strong>${esc(gamePick.team)}</strong> to win</span>`;
      }
      if (!fin) {
        return `<span class="potd-label" title="${esc(g.awayRec||'?')} vs ${esc(g.homeRec||'?')}">🎯 <strong>${esc(gamePick.team)}</strong> <span class="potd-stat">${pct}%</span></span>`;
      }
    }
  }
  return '';
}

// Records pick + immediately resolves if game is finished. Safe to call multiple times.
function autoRecordAndResolvePick(g) {
  if (!g.awayRec && !g.homeRec) return;
  const { fin } = gameRowState(g);
  const awayWP  = parseWinPct(g.awayRec), homeWP = parseWinPct(g.homeRec);
  const rawHome = homeWP * 1.03, total = awayWP + rawHome;
  const homePct = Math.round((rawHome / total) * 100);
  const short   = (homePct >= 50 ? g.homeTeam : g.awayTeam).split(' ').pop();
  recordPick(String(g.id), short, `${g.awayTeam} @ ${g.homeTeam}`, g.sport || '');
  if (fin && g.awayScore !== '' && g.homeScore !== '') {
    const aS = parseFloat(g.awayScore) || 0, hS = parseFloat(g.homeScore) || 0;
    if (aS !== hS) resolvePick(String(g.id), aS > hS ? g.awayTeam.split(' ').pop() : g.homeTeam.split(' ').pop());
  }
}

function inlineGamePick(g) {
  if (!g.awayRec && !g.homeRec) return '';
  const { fin } = gameRowState(g);
  const awayWP  = parseWinPct(g.awayRec), homeWP = parseWinPct(g.homeRec);
  const rawHome = homeWP * 1.03, total = awayWP + rawHome;
  const homePct = Math.round((rawHome / total) * 100);
  const awayPct = 100 - homePct;
  const margin  = Math.abs(homePct - 50);
  const favTeam = homePct > awayPct ? g.homeTeam : g.awayTeam;
  const pct     = Math.max(homePct, awayPct);
  const short   = favTeam.split(' ').pop();
  const stored  = getPicks()[String(g.id)];
  if (fin) {
    if (!stored || stored.result === null) return '';
    return stored.result === 'win'
      ? `<span class="game-pick-inline pick-win" title="Pick correct">✓ ${esc(short)}</span>`
      : `<span class="game-pick-inline pick-loss" title="Pick wrong">✗ ${esc(short)}</span>`;
  }
  if (margin < 3) return '';
  return `<span class="game-pick-inline" title="${esc(g.awayRec || '?')} vs ${esc(g.homeRec || '?')}">→ ${esc(short)} ${pct}%</span>`;
}

function buildOtherRow(g) {
  const { live, fin, periodLabel } = gameRowState(g);
  autoRecordAndResolvePick(g); // record pick for all games and resolve if finished
  const pick     = inlineGamePick(g);
  const potdHTML = g.league === 'MLB' ? getGameBestPickHTML(String(g.id), g) : '';
  return `
    <div class="other-match-row ${live?'live':''}" id="og-${esc(g.id)}" onclick="toggleGamePreview('${esc(g.id)}')">
      <div class="other-status" id="og-st-${esc(g.id)}">
        ${live ? '<span class="live-badge">LIVE</span>' : fin ? '<span class="fin-badge">FIN</span>' : `<span style="font-size:.78rem;color:var(--text-muted)">${esc(g.status)}</span>`}
      </div>
      <div class="other-teams">
        <div class="other-team away">${esc(g.awayTeam)}${g.awayRec ? ` <span class="rec-tag">${esc(g.awayRec)}</span>` : ''}</div>
        <div class="other-team home">${esc(g.homeTeam)}${g.homeRec ? ` <span class="rec-tag">${esc(g.homeRec)}</span>` : ''}${g.series?.summary ? ` <span class="series-tag">${esc(g.series.summary)}</span>` : ''}</div>
        <div class="potd-line" id="og-potd-${esc(g.id)}">${potdHTML}</div>
      </div>
      <div class="other-scores" id="og-sc-${esc(g.id)}">
        <div class="other-score">${g.awayScore !== '' ? esc(g.awayScore) : '-'}</div>
        <div class="other-score">${g.homeScore !== '' ? esc(g.homeScore) : '-'}</div>
      </div>
      <div class="other-period" id="og-pd-${esc(g.id)}">
        ${live && (periodLabel || g.time) ? `${esc(periodLabel)} ${esc(g.time)}` : ''}
        ${pick}
      </div>
    </div>`;
}

function renderOtherScores(games, sport, src) {
  const area = document.getElementById('other-scores-area');
  const nav  = otherDateNavHTML();
  if (!games.length) {
    const off     = S.otherDateOffset;
    const dateDesc = off === 0 ? 'today' : 'on this date';
    const hint     = sport === 'nfl'
      ? '<p class="muted">NFL season runs Sep–Jan · use the arrows above to browse the schedule</p>'
      : '';
    area.innerHTML = `${nav}<div class="empty-state"><p>No ${sport.toUpperCase()} games ${dateDesc}.</p>${hint}</div>`;
    return;
  }

  // Cache game objects for click preview
  _otherGamesMap.clear();
  for (const g of games) _otherGamesMap.set(String(g.id), g);

  // If all rows already exist, update only scores/status in-place so open previews stay open
  const allExist = games.every(g => !!document.getElementById(`og-${g.id}`));
  if (allExist) {
    for (const g of games) {
      autoRecordAndResolvePick(g);
      const { live, fin, periodLabel } = gameRowState(g);
      const rowEl  = document.getElementById(`og-${g.id}`);
      const stEl   = document.getElementById(`og-st-${g.id}`);
      const scEl   = document.getElementById(`og-sc-${g.id}`);
      const pdEl   = document.getElementById(`og-pd-${g.id}`);
      const potdEl = document.getElementById(`og-potd-${g.id}`);
      if (!rowEl || !stEl || !scEl || !pdEl) continue;
      rowEl.classList.toggle('live', live);
      stEl.innerHTML = live ? '<span class="live-badge">LIVE</span>'
                     : fin  ? '<span class="fin-badge">FIN</span>'
                     : `<span style="font-size:.78rem;color:var(--text-muted)">${esc(g.status)}</span>`;
      scEl.innerHTML = `<div class="other-score">${g.awayScore !== '' ? esc(g.awayScore) : '-'}</div><div class="other-score">${g.homeScore !== '' ? esc(g.homeScore) : '-'}</div>`;
      pdEl.innerHTML = (live && (periodLabel || g.time) ? `<span>${esc(periodLabel)} ${esc(g.time)}</span>` : '') + inlineGamePick(g);
      if (potdEl && g.league === 'MLB') potdEl.innerHTML = getGameBestPickHTML(String(g.id), g);
    }
    return;
  }

  // Full re-render (first load or game count changed)
  const groups = new Map();
  for (const g of games) {
    const key = g.league || sport.toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }

  let html = nav + `<div class="source-badge">Source: ${esc(src)}</div>`;
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

function parseWinPct(recStr) {
  if (!recStr) return 0.5;
  const m3 = recStr.match(/(\d+)-(\d+)-(\d+)/);
  if (m3) { // W-D-L (soccer)
    const w = +m3[1], d = +m3[2], l = +m3[3], t = w + d + l;
    return t > 0 ? (w + d * 0.4) / t : 0.5;
  }
  const m = recStr.match(/(\d+)-(\d+)/);
  if (!m) return 0.5;
  const w = +m[1], l = +m[2];
  return (w + l) > 0 ? w / (w + l) : 0.5;
}

function parseWeatherFactor(w, fmt) {
  if (!w) return null;
  let temp, windSpeed, hasPrecip, condition, windText;
  if (fmt === 'mlb') {
    temp      = parseInt(w.temp || '70');
    condition = w.condition || '';
    const wm  = (w.wind || '').match(/(\d+)\s*mph/i);
    windSpeed = wm ? parseInt(wm[1]) : 0;
    windText  = w.wind || '';
    hasPrecip = /rain|drizzle|shower|snow|sleet|thunder/i.test(condition);
  } else {
    temp      = parseInt(w.temperature || '70');
    condition = w.type || '';
    windSpeed = parseInt(w.gust || '0');
    windText  = windSpeed > 0 ? `${windSpeed} mph` : '';
    const pct = parseInt(w.precipitation || '0');
    hasPrecip = pct > 10 || /rain|snow|shower|drizzle|thunder|storm/i.test(condition);
  }
  const isExtreme = windSpeed > 18 || hasPrecip || temp < 40;
  const parts = [];
  if (temp) parts.push(`${temp}°F`);
  if (condition) parts.push(condition);
  if (windText) parts.push(`Wind ${windText}`);
  let impact = '';
  if (windSpeed > 25 || (windSpeed > 15 && hasPrecip)) impact = '⚠ Rough conditions may suppress scoring';
  else if (windSpeed > 18) impact = '🌬 Windy - may affect passing/HR';
  else if (hasPrecip) impact = '🌧 Wet conditions';
  else if (temp < 40) impact = '🥶 Cold - may reduce offense';
  return { display: parts.join(' · ') + (impact ? ` · ${impact}` : ''), isExtreme, windSpeed, hasPrecip, temp, condition };
}

function buildPickSection(awayName, homeName, opts) {
  const {
    awayRec = '', homeRec = '', awayERA = null, homeERA = null,
    seriesSummary = '', seriesTitle = '', awayAbbr = '', homeAbbr = '',
    awayForm = null, homeForm = null, awayH2H = 0, homeH2H = 0, h2hTotal = 0,
    sport = '', weather = null, weatherFmt = 'espn'
  } = opts || {};

  const aShort = awayAbbr || awayName.split(' ').pop();
  const hShort = homeAbbr || homeName.split(' ').pop();

  const seriesHTML = seriesSummary
    ? `<div class="gp-series-badge">🏆 ${seriesTitle ? `<span class="gp-series-title">${esc(seriesTitle)}</span> · ` : ''}${esc(seriesSummary)}</div>`
    : '';

  const hasData = awayRec || homeRec || awayERA !== null || seriesSummary || awayForm;
  if (!hasData) return seriesHTML;

  const factors = []; // { label, detail, winner: 'away'|'home'|'tie' }
  let aScore = 0, hScore = 0;

  // 1. Season record (30%)
  const aWP = parseWinPct(awayRec), hWP = parseWinPct(homeRec);
  if (awayRec || homeRec) {
    aScore += aWP * 0.30; hScore += hWP * 0.30;
    const w = aWP > hWP + 0.02 ? 'away' : hWP > aWP + 0.02 ? 'home' : 'tie';
    factors.push({ label: 'Record', detail: `${esc(aShort)} ${awayRec||'-'} · ${esc(hShort)} ${homeRec||'-'}`, winner: w });
  } else { aScore += 0.15; hScore += 0.15; }

  // 2. Home advantage (fixed 4% bump)
  hScore += 0.04;
  factors.push({ label: 'Home court', detail: `${esc(hShort)} at home`, winner: 'home' });

  // 3. Recent form - last 5 games (25%)
  if (awayForm?.recentPlayed >= 3 || homeForm?.recentPlayed >= 3) {
    const aFP = awayForm?.recentPlayed || 0, hFP = homeForm?.recentPlayed || 0;
    const aPct = aFP > 0 ? awayForm.recentWins / aFP : 0.5;
    const hPct = hFP > 0 ? homeForm.recentWins / hFP : 0.5;
    aScore += aPct * 0.25; hScore += hPct * 0.25;
    const w = aPct > hPct + 0.15 ? 'away' : hPct > aPct + 0.15 ? 'home' : 'tie';
    const aStr = aFP > 0 ? `${esc(aShort)} ${awayForm.recentWins}-${aFP - awayForm.recentWins}` : '';
    const hStr = hFP > 0 ? `${esc(hShort)} ${homeForm.recentWins}-${hFP - homeForm.recentWins}` : '';
    factors.push({ label: `Last ${Math.max(aFP, hFP)}`, detail: [aStr, hStr].filter(Boolean).join(' · '), winner: w });
  } else { aScore += 0.125; hScore += 0.125; }

  // 4. H2H this season (15%)
  if (h2hTotal >= 2) {
    const aH = awayH2H / h2hTotal, hH = homeH2H / h2hTotal;
    aScore += aH * 0.15; hScore += hH * 0.15;
    const w = awayH2H > homeH2H ? 'away' : homeH2H > awayH2H ? 'home' : 'tie';
    factors.push({ label: `H2H '${String(new Date().getFullYear()).slice(-2)}`, detail: `${esc(aShort)} ${awayH2H}W · ${esc(hShort)} ${homeH2H}W (${h2hTotal} games)`, winner: w });
  } else { aScore += 0.075; hScore += 0.075; }

  // 5. Playoff series
  if (seriesSummary) {
    const sm = seriesSummary.match(/^(\S+)\s+leads/i);
    if (sm) {
      const leader = sm[1].toUpperCase();
      const matchAway = leader === awayAbbr.toUpperCase() ||
                        awayName.toUpperCase().split(' ').some(w => w.startsWith(leader));
      if (matchAway) aScore += 0.18; else hScore += 0.18;
      factors.push({ label: 'Series', detail: esc(seriesSummary), winner: matchAway ? 'away' : 'home' });
    } else {
      factors.push({ label: 'Series', detail: esc(seriesSummary), winner: 'tie' });
    }
  }

  // 6. MLB pitcher ERA
  if (awayERA !== null && homeERA !== null) {
    const ae = parseFloat(awayERA), he = parseFloat(homeERA);
    if (ae > 0 && he > 0) {
      aScore += Math.max(0, 5.5 - ae) * 0.025;
      hScore += Math.max(0, 5.5 - he) * 0.025;
      if (Math.abs(ae - he) > 0.4) {
        factors.push({ label: 'Starter ERA', detail: `${esc(aShort)} ${ae.toFixed(2)} · ${esc(hShort)} ${he.toFixed(2)}`, winner: ae < he ? 'away' : 'home' });
      }
    }
  }

  // 7. Weather - outdoor sports only (NFL, MLB); shown when API returns it
  if (weather && (sport === 'nfl' || sport === 'mlb' || sport === 'soccer')) {
    const wf = parseWeatherFactor(weather, weatherFmt);
    if (wf) {
      factors.push({ label: 'Weather', detail: wf.display, winner: 'tie', extreme: wf.isExtreme });
    }
  }

  // ── Verdict ──
  const gap = Math.abs(aScore - hScore);
  const pickIsHome = hScore > aScore;
  const pickTeam = pickIsHome ? hShort : aShort;
  const fWins = factors.filter(f => pickIsHome ? f.winner === 'home' : f.winner === 'away').length;
  const fTotal = factors.filter(f => f.winner !== 'tie').length;

  const verdictHTML = gap < 0.025
    ? `<div class="gp-pick-verdict gp-verdict-toss">🎲 Toss-up - factors split evenly</div>`
    : `<div class="gp-pick-verdict">📌 ${gap > 0.14 ? 'Strong lean' : gap > 0.08 ? 'Lean' : 'Slight lean'}: <span class="gp-pick-team">${esc(pickTeam)}</span>${fTotal > 0 ? ` <span class="gp-pick-count">${fWins}/${fTotal} factors</span>` : ''}</div>`;

  const factorsHTML = factors.map(f => {
    const myWin = pickIsHome ? f.winner === 'home' : f.winner === 'away';
    const isTie = f.winner === 'tie';
    let cls  = isTie ? 'gp-pf-tie' : myWin ? 'gp-pf-win' : 'gp-pf-loss';
    if (f.label === 'Weather') cls += f.extreme ? ' gp-pf-weather-warn' : ' gp-pf-weather';
    const icon = isTie ? '~' : myWin ? '✓' : '✗';
    return `<div class="gp-pfactor ${cls}"><span class="gp-pf-icon">${icon}</span><span class="gp-pf-label">${esc(f.label)}</span><span class="gp-pf-detail">${f.detail}</span></div>`;
  }).join('');

  return `${seriesHTML}<div class="gp-pick-box">${verdictHTML}<div class="gp-pick-factors">${factorsHTML}</div></div>`;
}

function buildMLBPreStats(leaders) {
  if (!leaders?.length) return '<div class="gp-no-lineup">Lineups not posted yet - check back closer to game time</div>';

  // Pull out the top-1 leader per category per team, show as clear "most likely" cards
  const WATCH_CATS = {
    'Home Runs':       { icon: '💣', label: 'HR Leader' },
    'Batting Average': { icon: '🎯', label: 'AVG Leader' },
    'RBI':             { icon: '⚡', label: 'RBI Leader' },
    'Hits':            { icon: '🏏', label: 'Hits Leader' },
    'OPS':             { icon: '📈', label: 'OPS Leader' },
  };
  const PIT_CATS = {
    'ERA':        { icon: '🔥', label: 'ERA' },
    'Strikeouts': { icon: '🌀', label: 'K Leader' },
  };

  // Build per-team, per-category top player
  const teamCards = leaders.map(tl => {
    const tAbbr = tl.team?.abbreviation || tl.team?.name || '';
    const hits = [], pits = [];
    for (const cat of (tl.leaders || [])) {
      const cn  = cat.displayName || '';
      const wc  = WATCH_CATS[cn];
      const pc  = PIT_CATS[cn];
      if (!wc && !pc) continue;
      const top = (cat.leaders || [])[0];
      if (!top) continue;
      const name = top.athlete?.shortName || top.athlete?.displayName || '-';
      const val  = top.displayValue || String(top.value ?? '-');
      if (wc) hits.push(`<div class="pre-stat-chip"><span class="pre-stat-icon">${wc.icon}</span><span class="pre-stat-lbl">${wc.label}</span><span class="pre-stat-name">${esc(name)}</span><span class="pre-stat-val">${esc(val)}</span></div>`);
      if (pc) pits.push(`<div class="pre-stat-chip pre-stat-pit"><span class="pre-stat-icon">${pc.icon}</span><span class="pre-stat-lbl">${pc.label}</span><span class="pre-stat-name">${esc(name)}</span><span class="pre-stat-val">${esc(val)}</span></div>`);
    }
    if (!hits.length && !pits.length) return '';
    return `<div class="pre-team-block">
      <div class="pre-team-hdr">${esc(tAbbr)} - Season Leaders</div>
      ${hits.length ? `<div class="pre-stat-chips">${hits.join('')}</div>` : ''}
      ${pits.length ? `<div class="pre-stat-chips">${pits.join('')}</div>` : ''}
    </div>`;
  }).filter(Boolean).join('');

  return teamCards
    ? `<div class="gp-section"><div class="gp-section-hdr">📊 Most Likely to Produce - Lineups Not Posted Yet</div>${teamCards}</div>`
    : '<div class="gp-no-lineup">Lineups not posted yet - check back closer to game time</div>';
}

// ── MLB PICKS PAGE — REAL MATCHUP ENGINE ─────────────────────

function _windHRBonus(weather) {
  if (!weather?.wind) return { bonus: 0, label: '' };
  const w = weather.wind.toLowerCase();
  const mph = parseInt(w.match(/(\d+)/)?.[1] || 0);
  const out = /out/i.test(w);
  const inn = /in/i.test(w);
  if (out && mph >= 15) return { bonus: 2, label: `${mph}mph out (HR+)` };
  if (out && mph >= 8)  return { bonus: 1, label: `${mph}mph out` };
  if (inn && mph >= 15) return { bonus: -2, label: `${mph}mph in (HR-)` };
  if (inn && mph >= 8)  return { bonus: -1, label: `${mph}mph in` };
  return { bonus: 0, label: mph >= 5 ? `${mph}mph` : '' };
}

function _handAdv(batSide, pitcherHand) {
  if (!batSide || !pitcherHand) return { adv: 0, label: '' };
  if (batSide === 'S') return { adv: 1, label: 'switch hitter' };
  if (batSide !== pitcherHand) return { adv: 2, label: `${batSide}HB vs ${pitcherHand}HP (favorable)` };
  return { adv: -1, label: `${batSide}HB vs ${pitcherHand}HP (same hand)` };
}

function _fmtAvg(v) {
  const n = parseFloat(v);
  if (!n) return null;
  return '.' + String(n.toFixed(3)).replace('0.', '').replace('.', '');
}

// Park factors indexed by home team abbreviation (>1 = hitter-friendly)
const PARK_HR  = { COL:1.25, CIN:1.15, BOS:1.12, PHI:1.10, TEX:1.08, CHC:1.06, MIL:1.05, NYY:1.04, DET:1.03, HOU:1.02, ATL:1.01, TOR:0.99, LAD:0.98, LAA:0.97, MIN:0.96, PIT:0.95, CLE:0.94, BAL:0.93, SEA:0.92, WSH:0.92, CWS:0.91, KC:0.90, OAK:0.89, MIA:0.88, NYM:0.90, SF:0.88, SD:0.85, TB:0.94 };
const PARK_HIT = { COL:1.15, BOS:1.05, TEX:1.04, CIN:1.03, CHC:1.02, MIL:1.01, NYY:1.01, PHI:1.01, SD:0.88, SF:0.90, MIA:0.92, LAA:0.94, SEA:0.95, OAK:0.96 };

async function buildMLBPicksGameCard(espnGame, mlbGame) {
  const { fin, live } = gameRowState(espnGame);

  // ── Win prediction (folded into header) ──
  const awayWP = parseWinPct(espnGame.awayRec), homeWP = parseWinPct(espnGame.homeRec);
  let favLine = '';
  const gameMatchup = `${espnGame.awayTeam} @ ${espnGame.homeTeam}`;
  if (espnGame.awayRec || espnGame.homeRec) {
    const rawHome = homeWP * 1.03, total = awayWP + rawHome;
    const homePct = Math.round((rawHome / total) * 100);
    const favTeam = homePct >= 50 ? espnGame.homeTeam : espnGame.awayTeam;
    const pct     = Math.max(homePct, 100 - homePct);
    const margin  = Math.abs(homePct - 50);
    if (!fin && margin >= 3) recordPick(String(espnGame.id), favTeam.split(' ').pop(), gameMatchup, 'mlb');
    favLine = margin >= 3
      ? `<span class="pc-fav">${esc(favTeam.split(' ').pop())} favored ${pct}%</span>`
      : `<span class="pc-fav pc-fav-even">Even matchup</span>`;
  }

  const statusLabel = fin  ? '<span class="fin-badge">FIN</span>'
                    : live ? '<span class="live-badge">LIVE</span>'
                    : `<span class="pc-time">${esc(espnGame.status)}</span>`;

  // If no MLB schedule data, show minimal card
  if (!mlbGame) {
    return `<div class="picks-card">
      <div class="pc-hdr"><span class="pc-teams">${esc(espnGame.awayTeam)} @ ${esc(espnGame.homeTeam)}</span>${statusLabel}</div>
      ${favLine ? `<div class="pc-meta">${favLine}</div>` : ''}
      <div class="pc-no-data">Lineup not posted yet</div>
    </div>`;
  }

  const away = mlbGame.teams.away, home = mlbGame.teams.home;
  const awayAbbr = away.team?.abbreviation || espnGame.awayAbbr;
  const homeAbbr = home.team?.abbreviation || espnGame.homeAbbr;
  const awayPitcherId = away.probablePitcher?.id;
  const homePitcherId = home.probablePitcher?.id;
  const awayPName = away.probablePitcher?.fullName || 'TBD';
  const homePName = home.probablePitcher?.fullName || 'TBD';
  const weather   = mlbGame.weather || null;
  const wind      = _windHRBonus(weather);

  // Pitcher stats (already pre-fetched)
  const awayPD = awayPitcherId ? _pitcherCache.get(awayPitcherId) : null;
  const homePD = homePitcherId ? _pitcherCache.get(homePitcherId) : null;
  const awayHand = awayPD?.pitchHand || null;
  const homeHand = homePD?.pitchHand || null;

  // Pitcher rate stats derived from season totals — no extra API calls
  const _pRates = pd => {
    const s  = pd?.season;
    const ip = parseFloat(s?.inningsPitched || 0);
    return {
      hr9: ip > 5 ? (parseInt(s?.homeRuns||0)    / ip) * 9 : 1.2,
      bb9: ip > 5 ? (parseInt(s?.baseOnBalls||0) / ip) * 9 : 3.0,
      k9:  ip > 5 ? (parseInt(s?.strikeOuts||0)  / ip) * 9 : 8.5,
    };
  };
  const awayRates = _pRates(awayPD);   // home batters face away pitcher
  const homeRates = _pRates(homePD);   // away batters face home pitcher
  const parkHR    = PARK_HR[homeAbbr]  || 1.0;
  const parkHit   = PARK_HIT[homeAbbr] || 1.0;
  const windMult  = wind.bonus >= 2 ? 1.16 : wind.bonus === 1 ? 1.08 : wind.bonus <= -2 ? 0.85 : wind.bonus === -1 ? 0.93 : 1.0;

  // ── Compact pitcher line ──
  const pitStr = (name, pd, hand) => {
    const era = pd?.season?.era ? ` · ${pd.season.era} ERA` : '';
    return `${esc(lastName(name))} (${hand||'?'}HP${esc(era)})`;
  };
  const pitcherLine = `<div class="pc-pit-line">${pitStr(awayPName, awayPD, awayHand)} <span class="pc-pit-sep">vs</span> ${pitStr(homePName, homePD, homeHand)}</div>`;

  // ── Compact weather ──
  const wxParts = weather ? [
    weather.condition,
    weather.temp ? `${weather.temp}°F` : '',
    weather.wind ? `${weather.wind}${wind.bonus > 0 ? ' ↑HR' : wind.bonus < 0 ? ' ↓HR' : ''}` : ''
  ].filter(Boolean) : [];
  const wxLine = wxParts.length ? `<div class="pc-wx">${wxParts.map(s => esc(s)).join(' · ')}</div>` : '';

  // ── Elite pitcher warning ──
  const _pitWarn = (pd, rates, facingAbbr, pitName) => {
    if (!pitName || pitName === 'TBD') return '';
    const era = parseFloat(pd?.season?.era || 99);
    if (era < 3.10 && rates.k9 > 9.0) return `⚠️ ${esc(lastName(pitName))} ${era.toFixed(2)} ERA · ${rates.k9.toFixed(1)} K/9 — tough day for ${esc(facingAbbr)} bats`;
    return '';
  };
  const warnAway = _pitWarn(awayPD, awayRates, homeAbbr, awayPName); // home batters face away pitcher
  const warnHome = _pitWarn(homePD, homeRates, awayAbbr, homePName); // away batters face home pitcher
  const pitWarnLine = (warnAway || warnHome)
    ? `<div class="pc-pit-warn">${[warnAway, warnHome].filter(Boolean).join('<br>')}</div>` : '';

  // ── Build batter objects ──
  const awayLineup = mlbGame.lineups?.awayPlayers || [];
  const homeLineup = mlbGame.lineups?.homePlayers || [];

  const mkBatter = (p, pos, oppHand, teamAbbr, oppPitcherId, pitRates) => {
    const st       = _batterCache.get(p.id) || {};
    const batSide  = st.batSide || null;
    const hand     = _handAdv(batSide, oppHand);
    const avg      = parseFloat(st.avg     || 0);
    const hr       = parseInt(st.homeRuns  || 0);
    const rbi      = parseInt(st.rbi       || 0);
    const h        = parseInt(st.hits      || 0);
    const bb       = parseInt(st.baseOnBalls || 0);
    const sb       = parseInt(st.stolenBases  || 0);
    const cs       = parseInt(st.caughtStealing || 0);
    const ab       = parseInt(st.atBats    || 0);
    const ops      = parseFloat(st.ops     || 0);
    const obp      = parseFloat(st.obp     || 0);
    const sbSucc   = (sb + cs) > 0 ? sb / (sb + cs) : 0;
    const posW     = [0,1.1,1.0,1.4,1.5,1.2,1.1,1.0,0.9,0.8][pos] || 0.9;
    const l30avg   = parseFloat(st.l30avg || 0);
    const streak   = l30avg && avg ? (l30avg - avg >= 0.040 ? '🔥' : avg - l30avg >= 0.040 ? '❄️' : '') : '';
    // Platoon-specific AVG from actual split data (fallback to season AVG)
    const vsL      = st.vsL || null;
    const vsR      = st.vsR || null;
    const platAvg  = oppHand === 'L' ? parseFloat(vsL?.avg || avg) : parseFloat(vsR?.avg || avg);
    // Rate stats (more predictive than raw counting totals)
    const hrRate   = ab > 20 ? hr / ab : 0;
    const bbPct    = (ab + bb) > 0 ? bb / (ab + bb) : 0;
    const rbiRate  = ab > 0 ? rbi / ab : 0;
    // Rate × matchup factor scoring
    const hitScore = platAvg * 1000 * parkHit * Math.max(0.72, 1 - pitRates.k9 / 80);
    const hrScore  = hrRate  * 1000 * pitRates.hr9 * parkHR * windMult;
    const rbiScore = rbiRate * 1000 * posW;
    const bbScore  = bbPct   * pitRates.bb9 * 100;
    const sbScore  = sb * 10 + sbSucc * 50;
    const hScore   = platAvg * 600 + (ab > 0 ? h / ab : 0) * 400;
    // Confidence: 0–3 based on platoon avg quality, streak, sample size
    const conf = Math.min(3,
      (platAvg >= 0.310 ? 2 : platAvg >= 0.270 ? 1 : 0) +
      (streak === '🔥' ? 1 : 0) +
      (ab >= 150 ? 1 : 0)
    );
    return {
      id: p.id, name: p.fullName, abbr: teamAbbr, pos,
      batSide, oppPitcherId, oppHand, hand, avg, platAvg, vsL, vsR,
      hr, rbi, h, bb, sb, cs, sbSucc, ab, ops, obp, pitRates, l30avg, streak, conf,
      hitScore, hrScore, rbiScore, bbScore, sbScore, hScore,
    };
  };

  const awayBatters = awayLineup.slice(0, 9).map((p, i) => mkBatter(p, i+1, homeHand, awayAbbr, homePitcherId, homeRates));
  const homeBatters = homeLineup.slice(0, 9).map((p, i) => mkBatter(p, i+1, awayHand, homeAbbr, awayPitcherId, awayRates));
  const allBatters  = [...awayBatters, ...homeBatters].filter(b => b.ab >= 5);
  const awayValid   = awayBatters.filter(b => b.ab >= 5);
  const homeValid   = homeBatters.filter(b => b.ab >= 5);

  const hasLineup = allBatters.length > 0;

  // ── Fetch career vs-pitcher stats for top hit + HR candidates ──
  let vsMap = new Map(); // batterId -> vs stat
  if (hasLineup) {
    const topHit = [...allBatters].sort((a,b) => b.hitScore - a.hitScore)[0];
    const topHR  = [...allBatters].sort((a,b) => b.hrScore  - a.hrScore)[0];
    const toFetch = [...new Set([topHit, topHR].filter(b => b?.id && b?.oppPitcherId).map(b => b.id))];
    const vsRes = await Promise.allSettled(
      toFetch.map(bid => {
        const batter = allBatters.find(b => b.id === bid);
        return fetchVsStats(bid, batter.oppPitcherId).then(s => ({ bid, s }));
      })
    );
    for (const r of vsRes) {
      if (r.status === 'fulfilled' && r.value?.s) vsMap.set(r.value.bid, r.value.s);
    }
  }

  // ── Simplified pick row (one line each) ──
  const pickRow = (icon, label, batter, keyStat) => {
    if (!batter) return '';
    const vs     = vsMap.get(batter.id);
    const vsNote = vs && parseInt(vs.atBats || 0) >= 3
      ? `<span class="pc-vs-note"> · ${vs.hits||0}/${vs.atBats||0} career</span>`
      : '';
    const streakBadge = batter.streak ? `<span class="pc-streak">${batter.streak}</span>` : '';
    const conf = batter.conf || 0;
    const confDots = conf > 0 ? `<span class="pc-conf pc-conf-${conf}" title="Confidence: ${['','Low','Medium','High'][conf]}">${'●'.repeat(conf)}${'○'.repeat(3-conf)}</span>` : '';
    return `<div class="pc-row">
      <span class="pc-ri">${icon}</span>
      <span class="pc-rl">${esc(label)}</span>
      <strong class="pc-rn">${esc(lastName(batter.name))}${streakBadge}</strong>
      <span class="pc-rt">${esc(batter.abbr)}</span>
      <span class="pc-rs">${confDots}${esc(keyStat)}${vsNote}</span>
    </div>`;
  };

  let picksHTML = '';
  if (hasLineup) {
    const top = (arr, key) => [...arr].sort((a, b) => b[key] - a[key])[0];
    // One best per team per category
    const aHit = top(awayValid, 'hitScore');
    const hHit = top(homeValid, 'hitScore');
    // HR: deduplicate within each team side if same player tops multiple categories
    const aHR  = top(awayValid, 'hrScore');
    const hHR  = top(homeValid, 'hrScore');
    const aRBI = top(awayValid, 'rbiScore');
    const hRBI = top(homeValid, 'rbiScore');
    const aBB  = top(awayValid, 'bbScore');
    const hBB  = top(homeValid, 'bbScore');
    const aSB  = awayValid.filter(b => b.sb >= 3).sort((a, b) => b.sbScore - a.sbScore)[0];
    const hSB  = homeValid.filter(b => b.sb >= 3).sort((a, b) => b.sbScore - a.sbScore)[0];

    const avg_    = b => _fmtAvg(b?.platAvg || b?.avg) || '-';
    const statStr = {
      hit:  b => b ? `${avg_(b)} vs ${b.oppHand||'?'}HP` : '',
      hr:   b => b ? `${b.hr||0}HR · ${avg_(b)} vs ${b.oppHand||'?'}HP` : '',
      rbi:  b => b ? `${b.rbi||0}RBI · #${b.pos}` : '',
      walk: b => b ? `${b.bb||0}BB · ${b.obp||'-'}OBP` : '',
      sb:   b => b ? `${b.sb}SB` : '',
    };

    // Record both teams' picks per category
    const gKey   = String(espnGame.id);
    const gamePk = mlbGame?.gamePk || null;
    if (!fin) {
      for (const [b, prop] of [[aHit,'hit'],[hHit,'hit'],[aHR,'hr'],[hHR,'hr'],[aRBI,'rbi'],[hRBI,'rbi'],[aBB,'walk'],[hBB,'walk'],[aSB,'sb'],[hSB,'sb']]) {
        if (b) recordPlayerPick('plr_'+gKey+'_'+b.id+'_'+prop, 'mlb', b.name, prop==='hit'?'Hit':prop==='hr'?'HR':prop==='rbi'?'RBI':prop==='walk'?'Walk':'SB', statStr[prop](b), gameMatchup, gamePk);
      }
    } else {
      resolvePlayerPicksForGame(gKey, gamePk);
    }

    // Two rows per category (away top + home top), skip if both absent
    const catRows = (icon, label, away, home, prop) => {
      const rows = [];
      if (away) rows.push(pickRow(icon, label, away, statStr[prop](away)));
      if (home) rows.push(pickRow('', '',    home, statStr[prop](home)));
      return rows.join('');
    };

    const hasSB = aSB || hSB;
    picksHTML = `<div class="pc-picks">
      ${catRows('🎯','Hit',  aHit, hHit, 'hit')}
      ${catRows('💣','HR',   aHR,  hHR,  'hr')}
      ${catRows('⚡','RBI',  aRBI, hRBI, 'rbi')}
      ${catRows('🚶','Walk', aBB,  hBB,  'walk')}
      ${hasSB ? catRows('🏃','SB', aSB, hSB, 'sb') : ''}
    </div>`;
  } else {
    picksHTML = '<div class="pc-no-data">Lineup not posted yet</div>';
  }

  return `<div class="picks-card">
    <div class="pc-hdr">
      <span class="pc-teams">${esc(espnGame.awayTeam)} @ ${esc(espnGame.homeTeam)}</span>
      ${statusLabel}
    </div>
    ${favLine ? `<div class="pc-meta">${favLine}</div>` : ''}
    ${pitcherLine}
    ${wxLine}
    ${pitWarnLine}
    ${picksHTML}
  </div>`;
}

// ── TENNIS PICKS PAGE ────────────────────────────────────────
async function loadTennisPicksPage() {
  const area = document.getElementById('mlb-picks-area');

  let tennisPicks = Object.values(getPicks()).filter(p => (p.sport || 'tennis') === 'tennis');

  if (!tennisPicks.length) {
    // Fetch today's fixtures in background — inlineTennisPick records picks as a side effect
    area.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><p>Loading picks…</p></div>`;
    try {
      const d = dateStr(S.dateOffset);
      const results = await tennisFetch('get_fixtures', { date_start: d, date_stop: d });
      for (const m of results) {
        S.matches.set(String(m.event_key), m);
        if (!isLive(m.event_status) && !isFinished(m.event_status)) inlineTennisPick(m);
        else if (isFinished(m.event_status) && m.event_winner) {
          let wln = '';
          if (m.event_winner === 'First Player')       wln = lastName(m.event_first_player || '');
          else if (m.event_winner === 'Second Player') wln = lastName(m.event_second_player || '');
          else                                          wln = lastName(m.event_winner);
          if (wln) resolvePick('tn_' + m.event_key, wln);
        }
      }
    } catch {}
    tennisPicks = Object.values(getPicks()).filter(p => (p.sport || 'tennis') === 'tennis');
  }

  if (!tennisPicks.length) {
    area.innerHTML = '<div class="empty-state">No picks available today.<div class="muted">Picks are generated for upcoming matches with seeded or ranked players.</div></div>';
    updatePicksDisplay();
    return;
  }

  const pending  = tennisPicks.filter(p => p.result === null);
  const resolved = tennisPicks.filter(p => p.result !== null);

  const makeRow = p => {
    const win  = p.result === 'win';
    const icon = p.result === null ? '⏳' : (win ? '✓' : '✗');
    const cls  = p.result === null ? 'ph-pending-row' : (win ? 'ph-win' : 'ph-loss');
    return `<div class="ph-row ${cls}">
      <span class="ph-icon">${icon}</span>
      <span class="ph-date">${esc(p.date)}</span>
      <span class="ph-matchup">${esc(p.matchup || p.team)}</span>
      <span class="ph-pick">→ ${esc(p.team)}</span>
    </div>`;
  };

  let html = '';
  if (pending.length) {
    html += `<div class="ph-sport-hdr ph-pending-hdr">Pending (${pending.length})</div>`;
    html += pending.map(makeRow).join('');
  }
  if (resolved.length) {
    const w = resolved.filter(p => p.result === 'win').length;
    html += `<div class="ph-sport-hdr">Results — ${w}W ${resolved.length - w}L</div>`;
    html += resolved.map(makeRow).join('');
  }

  area.innerHTML = `<div class="pc-data-note">Picks based on seedings &amp; live rankings · last 14 days</div><div class="ph-list">${html}</div>`;
  updatePicksDisplay();
}

// ── PICKS DATE NAV ───────────────────────────────────────────
function picksDateNavHTML() {
  const off = S.picksDateOffset;
  const d   = new Date(); d.setDate(d.getDate() + off);
  const lbl = off === 0 ? 'Today'
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: Math.abs(off) > 180 ? 'numeric' : undefined });
  const dv  = dateStr(off);
  const isNFL = S.sport === 'nfl';
  return `<div class="other-date-nav" style="margin-bottom:10px">
    ${isNFL ? `<button class="odn-btn odn-wk" onclick="picksDateNav(-7)">&#171; Week</button>` : ''}
    <button class="odn-btn" onclick="picksDateNav(-1)">&#8249;</button>
    <label class="odn-date-label">
      <input type="date" class="odn-date-input" value="${dv}" onchange="picksDatePickerChange(this.value)">
      <span class="odn-date-text">${esc(lbl)}</span>
    </label>
    <button class="odn-btn" onclick="picksDateNav(1)">&#8250;</button>
    ${isNFL ? `<button class="odn-btn odn-wk" onclick="picksDateNav(7)">Week &#187;</button>` : ''}
    ${off !== 0 ? `<button class="odn-today" onclick="picksDateNav(0, true)">Today</button>` : ''}
  </div>`;
}
function picksDateNav(delta, reset = false) {
  S.picksDateOffset = reset ? 0 : S.picksDateOffset + delta;
  if (S.sport === 'mlb') loadMLBPicksPage();
  else loadOtherPicksPage(S.sport);
}
function picksDatePickerChange(val) {
  const today = new Date(); today.setHours(0,0,0,0);
  S.picksDateOffset = Math.round((new Date(val + 'T12:00:00') - today) / 86400000);
  if (S.sport === 'mlb') loadMLBPicksPage();
  else loadOtherPicksPage(S.sport);
}

// ── ALL-SPORTS WIN PREDICTION CARD ───────────────────────────
function buildWinPredCard(g) {
  const { fin, live } = gameRowState(g);
  const awayWP = parseWinPct(g.awayRec), homeWP = parseWinPct(g.homeRec);
  let favLine = '';
  if (g.awayRec || g.homeRec) {
    const rawHome = homeWP * 1.03, total = awayWP + rawHome;
    const homePct = Math.round((rawHome / total) * 100);
    const favTeam = homePct >= 50 ? g.homeTeam : g.awayTeam;
    const pct     = Math.max(homePct, 100 - homePct);
    const margin  = Math.abs(homePct - 50);
    if (!fin && margin >= 3) recordPick(String(g.id), favTeam.split(' ').pop(), `${g.awayTeam} @ ${g.homeTeam}`, g.sport || '');
    favLine = margin >= 3
      ? `<span class="pc-fav">${esc(favTeam.split(' ').pop())} favored ${pct}%</span>`
      : `<span class="pc-fav pc-fav-even">Even matchup</span>`;
  }
  const statusLabel = fin  ? '<span class="fin-badge">FIN</span>'
                    : live ? '<span class="live-badge">LIVE</span>'
                    : `<span class="pc-time">${esc(g.status)}</span>`;
  const oddsLine = g.odds?.spread
    ? `<span class="pc-odds">${esc(g.odds.spread)}${g.odds.overUnder ? ` · O/U ${g.odds.overUnder}` : ''}</span>` : '';
  const recLine = (g.awayRec || g.homeRec)
    ? `<div class="pc-meta pc-recs">${esc(g.awayTeam)} ${esc(g.awayRec||'?')}  ·  ${esc(g.homeTeam)} ${esc(g.homeRec||'?')}</div>` : '';
  return `<div class="picks-card">
    <div class="pc-hdr">
      <span class="pc-teams">${esc(g.awayTeam)} @ ${esc(g.homeTeam)}</span>
      ${statusLabel}
    </div>
    ${recLine}
    ${favLine || oddsLine ? `<div class="pc-meta">${favLine}${oddsLine ? `<span class="pc-meta-sep">·</span>${oddsLine}` : ''}</div>` : ''}
  </div>`;
}

async function loadOtherPicksPage(sport) {
  const area = document.getElementById('mlb-picks-area');
  const nav  = picksDateNavHTML();
  area.innerHTML = `${nav}<div class="loading-spinner"><div class="spinner"></div><p>Loading ${sport.toUpperCase()} picks…</p></div>`;
  try {
    const off   = S.picksDateOffset;
    const games = await espnGames(sport, off);
    if (!games.length) {
      const isNFL = sport === 'nfl' && off === 0;
      area.innerHTML = nav + `<div class="empty-state"><p>No ${sport.toUpperCase()} games on this date.</p>${isNFL ? '<p class="muted">Use the date navigation above to browse the schedule.</p>' : ''}</div>`;
      return;
    }
    const cards = games.map(g => buildWinPredCard(g)).join('');
    const note  = off !== 0 ? '' : `<div class="pc-data-note">Win predictions based on season records · ESPN odds where available</div>`;
    area.innerHTML = nav + note + `<div class="picks-cards">${cards}</div>`;
    updatePicksDisplay();
  } catch (err) {
    area.innerHTML = nav + `<div class="error-state"><div class="error-icon">⚠</div><p>Could not load ${sport.toUpperCase()} picks: ${esc(err.message)}</p></div>`;
  }
}

async function loadMLBPicksPage() {
  const area = document.getElementById('mlb-picks-area');
  const off  = S.picksDateOffset;
  const nav  = picksDateNavHTML();
  area.innerHTML = `${nav}<div class="loading-spinner"><div class="spinner"></div><p>Loading matchup data…</p></div>`;
  try {
    // Phase 1: fast parallel fetches
    const [espnResult, schedResult] = await Promise.allSettled([
      espnGames('mlb', off),
      getMLBSchedule(off)
    ]);
    const games    = espnResult.status  === 'fulfilled' ? espnResult.value  : [];
    const schedule = schedResult.status === 'fulfilled' ? schedResult.value : [];

    if (!games.length) {
      area.innerHTML = nav + '<div class="empty-state"><p>No MLB games on this date.</p></div>';
      return;
    }

    // Phase 2: pre-fetch all probable pitcher stats
    const pitcherIds = new Set();
    for (const g of schedule) {
      if (g.teams.away.probablePitcher?.id) pitcherIds.add(g.teams.away.probablePitcher.id);
      if (g.teams.home.probablePitcher?.id) pitcherIds.add(g.teams.home.probablePitcher.id);
    }
    await Promise.allSettled([...pitcherIds].map(id => fetchPitcherPreview(id)));

    // Phase 3: pre-fetch batter stats for all lineups (full 9 per team)
    const batterIds = new Set();
    for (const g of schedule) {
      const all = [...(g.lineups?.awayPlayers || []).slice(0,9), ...(g.lineups?.homePlayers || []).slice(0,9)];
      for (const p of all) if (p.id) batterIds.add(p.id);
    }
    await Promise.allSettled([...batterIds].map(id => fetchBatterPreview(id)));

    // Phase 4: match ESPN games to schedule games
    const nameMatch = (full, short) => {
      const f = (full||'').toLowerCase(), s = (short||'').toLowerCase();
      return f === s || f.endsWith(' '+s) || f.includes(s);
    };
    const findSched = g => schedule.find(sg =>
      nameMatch(sg.teams.away.team?.name||'', g.awayTeam) &&
      nameMatch(sg.teams.home.team?.name||'', g.homeTeam)
    ) || null;

    // Phase 5: build cards
    const cardHTMLs = await Promise.all(games.map(g => buildMLBPicksGameCard(g, findSched(g))));
    const note = `<div class="pc-data-note">Platoon splits · park factors · pitcher HR/9 &amp; BB/9 · career vs-pitcher where available</div>`;
    area.innerHTML = nav + note + `<div class="picks-cards">${cardHTMLs.join('')}</div>`;
    updatePicksDisplay();
  } catch (err) {
    area.innerHTML = nav + `<div class="error-state"><div class="error-icon">⚠</div><p>Could not load picks: ${esc(err.message)}</p></div>`;
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
      panel.innerHTML = '<div class="pp-empty" style="padding:12px">Game preview not available yet - check back closer to game time</div>';
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

    // Fetch pitcher stats, batter stats, and ESPN summary in parallel
    const _allFetches = await Promise.allSettled([
      awayPId && fetchPitcherPreview(awayPId),
      homePId && fetchPitcherPreview(homePId),
      ...[...awayLineup, ...homeLineup].map(p => fetchBatterPreview(p.id)),
      fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${espnGame.id}`).then(r => r.json())
    ]);
    const _espnRes  = _allFetches[_allFetches.length - 1];
    const espnSummary = _espnRes?.status === 'fulfilled' ? _espnRes.value : null;
    const espnState   = espnSummary?.header?.competitions?.[0]?.status?.type?.state || 'pre';

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

    const pickHTML = buildPickSection(awayAbbr, homeAbbr, {
      awayRec: espnGame.awayRec || '', homeRec: espnGame.homeRec || '',
      awayERA: awayPD?.season?.era ?? null, homeERA: homePD?.season?.era ?? null,
      awayAbbr, homeAbbr,
      sport: 'mlb', weather: mlbGame.weather || null, weatherFmt: 'mlb'
    });

    const hrThreats   = [...allBatters].filter(b => b.hr > 0).sort((a, b) => b.hr - a.hr).slice(0, 5);
    const topProd     = [...allBatters].sort((a, b) => b.prodScore - a.prodScore).slice(0, 5);
    const dueForHits  = [...allBatters].filter(b => b.babip !== null && b.babip < 0.270 && parseFloat(b.stat.avg || 0) >= 0.235)
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
        <span class="gp-pname">${esc(lastName(b.name))}</span>
        <span class="gp-team">${esc(b.team)}</span>
        <span class="gp-stats">
          <span class="gp-hr-val">${b.hr}HR</span>
          <span class="gp-muted">${b.stat.ops || '-'} OPS</span>
          <span class="gp-muted">${b.stat.avg || '.---'}</span>
        </span>
      </div>`;

    const prodRow = b => `
      <div class="gp-player-row">
        ${posTag(b.pos)}
        ${handTag(b.batSide, b.favorable, b.team === awayAbbr ? homeHand : awayHand)}
        <span class="gp-pname">${esc(lastName(b.name))}</span>
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
        <span class="gp-pname">${esc(lastName(b.name))}</span>
        <span class="gp-team">${esc(b.team)}</span>
        <span class="gp-stats">
          <span class="gp-avg-val">${b.stat.avg}</span>
          ${babipTag(b.babip)}
          ${xbaTag(b.id, b.stat.avg)}
          <span class="gp-muted">${b.stat.ops || '-'} OPS</span>
        </span>
      </div>`;

    const dueRow = b => `
      <div class="gp-player-row">
        ${posTag(b.pos)}
        ${handTag(b.batSide, b.favorable, b.team === awayAbbr ? homeHand : awayHand)}
        <span class="gp-pname">${esc(lastName(b.name))}</span>
        <span class="gp-team">${esc(b.team)}</span>
        <span class="gp-stats">
          <span class="gp-avg-val">${b.stat.avg}</span>
          ${babipTag(b.babip)}
          ${xbaTag(b.id, b.stat.avg)}
          <span class="gp-muted">${b.stat.ops || '-'} OPS</span>
        </span>
      </div>`;

    const pdSlot = (pid, pname, pd) => {
      const s  = pd?.season;
      const lh = pd?.pitchHand ? pd.pitchHand + 'HP' : '';
      const lastName = pname !== 'TBD' ? pname.split(' ').slice(1).join(' ') || pname : 'TBD';
      return `<div class="gp-pd-slot">
        <div class="gp-pd-hand">${lh}</div>
        <div class="gp-pd-name">${esc(lastName)}</div>
        <div class="gp-pd-era ${!s?'pd-tbd':''}">${s?.era || '-'}</div>
        <div class="gp-pd-era-lbl">ERA</div>
        ${s ? `<div class="gp-pd-sub">${s.wins??0}-${s.losses??0} &nbsp;·&nbsp; ${s.whip||'-'} WHIP &nbsp;·&nbsp; ${s.strikeOuts??0}K</div>` : ''}
      </div>`;
    };

    const noLineup    = allBatters.length === 0;
    const isLiveOrFin = espnState === 'in' || espnState === 'post';
    const mlbBoxHTML  = isLiveOrFin ? renderMLBBoxScore(espnSummary) : '';
    const sitHTML     = espnState === 'in' ? renderMLBSituation(espnSummary) : '';

    panel.innerHTML = `
      <div class="gp-inner">
        ${sitHTML}
        ${pickHTML}
        <div class="gp-duel">
          ${pdSlot(awayPId, awayPName, awayPD)}
          <div class="gp-duel-vs">VS</div>
          ${pdSlot(homePId, homePName, homePD)}
        </div>
        ${mlbBoxHTML}
        ${noLineup
          ? (!isLiveOrFin ? buildMLBPreStats(espnSummary?.leaders) : '')
          : `
          <div class="gp-hand-legend"><span class="gp-hand gp-fav">L/R/S</span> = favorable matchup &nbsp;·&nbsp; <span class="gp-babip gp-babip-due">BABIP .240 ↑</span> = unlucky, hits coming &nbsp;·&nbsp; <span class="gp-babip gp-babip-hot">BABIP .360 ↓</span> = running hot</div>
          ${dueForHits.length ? `<div class="gp-section"><div class="gp-section-hdr">🍀 Due for Hits <span style="font-size:.65rem;font-weight:400;color:var(--text-muted)">- low BABIP = getting unlucky</span></div>${dueForHits.map(dueRow).join('')}</div>` : ''}
          ${hrThreats.length ? `<div class="gp-section"><div class="gp-section-hdr">💣 HR Threats</div>${hrThreats.map(hrRow).join('')}</div>` : ''}
          ${topProd.length  ? `<div class="gp-section"><div class="gp-section-hdr">⚡ H + R + RBI Leaders</div>${topProd.map(prodRow).join('')}</div>` : ''}
          ${topHitters.length ? `<div class="gp-section"><div class="gp-section-hdr">🎯 Best Hitters by AVG</div>${topHitters.map(hitRow).join('')}</div>` : ''}
          `
        }
      </div>`;
  } catch (err) {
    panel.innerHTML = `<div class="pp-error" style="padding:12px">Could not load: ${esc(err.message)}</div>`;
  }
}

function renderMLBSituation(j) {
  const sit = j?.situation;
  if (!sit) return '';
  const batter  = sit.batter?.athlete?.shortName  || sit.batter?.athlete?.displayName  || '';
  const pitcher = sit.pitcher?.athlete?.shortName || sit.pitcher?.athlete?.displayName || '';
  if (!batter && !pitcher) return '';
  const balls   = sit.balls   ?? '-';
  const strikes = sit.strikes ?? '-';
  const outs    = sit.outs    ?? '-';
  const onBase  = ['onFirst','onSecond','onThird']
    .filter(b => sit[b])
    .map(b => b.replace('onFirst','1st').replace('onSecond','2nd').replace('onThird','3rd'));
  const baseStr = onBase.length ? onBase.join(', ') + ' on base' : 'Bases empty';
  return `<div class="gp-live-sit">
    <span class="gp-live-badge">LIVE</span>
    ${batter  ? `<span class="gp-sit-batter">⚡ ${esc(batter.split(' ').pop())} at bat</span>` : ''}
    ${pitcher ? `<span class="gp-sit-pitcher">🌀 ${esc(pitcher.split(' ').pop())} pitching</span>` : ''}
    <span class="gp-sit-count">${balls}-${strikes} · ${outs} out${outs !== 1 ? 's' : ''}</span>
    <span class="gp-sit-bases">${esc(baseStr)}</span>
  </div>`;
}

function renderMLBBoxScore(j) {
  const BATTING_COLS = [
    { key:'AB',  alts:['AB'] },
    { key:'R',   alts:['R'] },
    { key:'H',   alts:['H'] },
    { key:'HR',  alts:['HR'] },
    { key:'RBI', alts:['RBI'] },
    { key:'BB',  alts:['BB'] },
    { key:'K',   alts:['K','SO'] },
    { key:'AVG', alts:['AVG'] }
  ];
  const PITCHING_COLS = [
    { key:'IP',  alts:['IP'] },
    { key:'H',   alts:['H'] },
    { key:'ER',  alts:['ER'] },
    { key:'BB',  alts:['BB'] },
    { key:'K',   alts:['K','SO'] },
    { key:'ERA', alts:['ERA'] }
  ];
  let html = '';
  for (const teamBox of (j.boxscore?.players || [])) {
    const tAbbr = teamBox.team?.abbreviation || '';
    for (const grp of (teamBox.statistics || [])) {
      const grpName = (grp.name || grp.label || '').toLowerCase();
      const isBatting  = grpName.includes('batting')  || grpName.includes('hitter');
      const isPitching = grpName.includes('pitching') || grpName.includes('pitcher');
      if (!isBatting && !isPitching) continue;
      const COLS   = isBatting ? BATTING_COLS : PITCHING_COLS;
      const labels = grp.labels || [];
      const cols   = COLS.map(c => { for (const alt of c.alts) { const i = labels.indexOf(alt); if (i >= 0) return { key: c.key, i }; } return null; }).filter(Boolean);
      if (!cols.length) continue;
      const athletes = grp.athletes || [];
      const leaders  = {};
      if (isBatting) {
        for (const { key, i } of cols.filter(c => ['H','HR','RBI'].includes(c.key))) {
          const max = Math.max(0, ...athletes.map(a => parseFloat(a.stats?.[i] || '0')));
          if (max > 0) leaders[key] = max;
        }
      }
      const colHdr = cols.map(c => `<span class="nba-sc">${esc(c.key)}</span>`).join('');
      const mkRow  = a => {
        const nm    = a.athlete?.shortName || a.athlete?.displayName || '-';
        const cells = cols.map(({ key, i }) => {
          const v    = a.stats?.[i] || '-';
          const lead = leaders[key] !== undefined && parseFloat(v) === leaders[key];
          return `<span class="nba-sc${lead ? ' nba-lead' : ''}">${esc(v)}</span>`;
        }).join('');
        return `<div class="nba-row"><span class="nba-pname">${esc(nm)}</span>${cells}</div>`;
      };
      html += `<div class="nba-block">
        <div class="nba-block-hdr"><span class="nba-hdr-team">${esc(tAbbr)}</span><span class="nba-hdr-label">${isBatting ? 'Batting' : 'Pitching'}</span></div>
        <div class="nba-row nba-row-hdr"><span class="nba-pname">Player</span>${colHdr}</div>
        ${athletes.map(mkRow).join('')}
      </div>`;
    }
  }
  return html ? `<div class="gp-section"><div class="gp-section-hdr">⚾ Box Score</div>${html}</div>` : '';
}

function renderNBABoxScore(j) {
  const COLS = [
    { key:'PTS', alts:['PTS'] },
    { key:'REB', alts:['REB'] },
    { key:'AST', alts:['AST'] },
    { key:'3PM', alts:['3PM','3PT','3PTM'] },
    { key:'STL', alts:['STL'] },
    { key:'BLK', alts:['BLK'] },
    { key:'TO',  alts:['TO','TOS'] }
  ];
  let html = '';
  for (const teamBox of (j.boxscore?.players || [])) {
    const tAbbr = teamBox.team?.abbreviation || '';
    for (const grp of (teamBox.statistics || [])) {
      const labels = grp.labels || [];
      const cols = COLS.map(c => {
        for (const alt of c.alts) { const idx = labels.indexOf(alt); if (idx >= 0) return { key: c.key, i: idx }; }
        return null;
      }).filter(Boolean);
      if (!cols.length) continue;
      const minI = labels.indexOf('MIN');
      const played = a => minI < 0 || parseInt(a.stats?.[minI] || '0') > 0;
      const starters = (grp.athletes || []).filter(a => a.starter === true  && played(a));
      const bench    = (grp.athletes || []).filter(a => a.starter === false && played(a));
      const allPlayed = [...starters, ...bench];
      const leaders = {};
      for (const { key, i } of cols) {
        const max = Math.max(0, ...allPlayed.map(a => parseFloat(a.stats?.[i] || '0')));
        if (max > 0) leaders[key] = max;
      }
      const colHdr = cols.map(c => `<span class="nba-sc">${esc(c.key)}</span>`).join('');
      const mkRow = a => {
        const nm = a.athlete?.shortName || a.athlete?.displayName || '-';
        const cells = cols.map(({ key, i }) => {
          const v = a.stats?.[i] || '0';
          const lead = leaders[key] !== undefined && parseFloat(v) === leaders[key];
          return `<span class="nba-sc${lead ? ' nba-lead' : ''}">${esc(v)}</span>`;
        }).join('');
        return `<div class="nba-row"><span class="nba-pname">${esc(nm)}</span>${cells}</div>`;
      };
      if (starters.length) {
        html += `<div class="nba-block">
          <div class="nba-block-hdr"><span class="nba-hdr-team">${esc(tAbbr)}</span><span class="nba-hdr-label">Starters</span></div>
          <div class="nba-row nba-row-hdr"><span class="nba-pname">Player</span>${colHdr}</div>
          ${starters.map(mkRow).join('')}
        </div>`;
      }
      if (bench.length) {
        html += `<div class="nba-block">
          <div class="nba-block-hdr"><span class="nba-hdr-team">${esc(tAbbr)}</span><span class="nba-hdr-label nba-bench-lbl">Bench</span></div>
          <div class="nba-row nba-row-hdr"><span class="nba-pname">Player</span>${colHdr}</div>
          ${bench.map(mkRow).join('')}
        </div>`;
      }
    }
  }
  return html ? `<div class="gp-section"><div class="gp-section-hdr">🏀 Full Box Score</div>${html}</div>` : '';
}

async function renderESPNGamePreview(game, panel) {
  const paths = { nba:'basketball/nba', wnba:'basketball/wnba', nfl:'football/nfl', nhl:'hockey/nhl' };
  const path  = paths[game.sport];
  if (!path) { panel.innerHTML = '<div class="pp-empty" style="padding:12px">No preview available</div>'; return; }

  // Sport config: which categories to highlight (pre-game) + which labels to show (live)
  const SPORT_CFG = {
    nba:    { cats: ['Points','Rebounds','Assists'],
              live: { sort:'PTS', show:['PTS','REB','AST','BLK','STL'] }, icon:'🏀' },
    wnba:   { cats: ['Points','Rebounds','Assists'],
              live: { sort:'PTS', show:['PTS','REB','AST'] }, icon:'🏀' },
    nfl:    { cats: ['Passing Yards','Rushing Yards','Receiving Yards','Sacks'],
              live: { sort:'YDS', show:['YDS','TD','INT'] }, icon:'🏈' },
    nhl:    { cats: ['Points','Goals','Assists','Save Percentage'],
              live: { sort:'PTS', show:['G','A','PTS','+/-'] }, icon:'🏒' },
    soccer: { cats: ['Goals','Assists','Shots on Target'],
              live: { sort:'G',   show:['G','A','SH'] }, icon:'⚽' }
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
    const seriesSummary = comp?.series?.summary || '';
    const seriesTitle   = comp?.series?.title   || '';
    const awayAbbr2 = awayC?.team?.abbreviation || game.awayAbbr || '';
    const homeAbbr2 = homeC?.team?.abbreviation || game.homeAbbr || '';
    const awayTeamId = awayC?.team?.id;
    const homeTeamId = homeC?.team?.id;

    // Fetch team schedules for recent form + H2H
    let awayForm = null, homeForm = null, awayH2H = 0, homeH2H = 0, h2hTotal = 0;
    if (awayTeamId && homeTeamId) {
      const [aRes, hRes] = await Promise.allSettled([
        fetchTeamSched(game.sport, awayTeamId),
        fetchTeamSched(game.sport, homeTeamId)
      ]);
      if (aRes.status === 'fulfilled' && aRes.value) {
        const ai = parseScheduleInsights(aRes.value, awayTeamId, homeTeamId);
        awayForm = { recentWins: ai.recentWins, recentPlayed: ai.recentPlayed };
        awayH2H = ai.h2hWins; h2hTotal = ai.h2hTotal;
      }
      if (hRes.status === 'fulfilled' && hRes.value) {
        const hi = parseScheduleInsights(hRes.value, homeTeamId, awayTeamId);
        homeForm = { recentWins: hi.recentWins, recentPlayed: hi.recentPlayed };
        homeH2H = hi.h2hWins;
        if (hi.h2hTotal > h2hTotal) h2hTotal = hi.h2hTotal;
      }
    }

    const pickHTML = buildPickSection(game.awayTeam, game.homeTeam, {
      awayRec, homeRec, seriesSummary, seriesTitle,
      awayAbbr: awayAbbr2, homeAbbr: homeAbbr2,
      awayForm, homeForm, awayH2H, homeH2H, h2hTotal,
      sport: game.sport, weather: j.gameInfo?.weather || null, weatherFmt: 'espn'
    });

    let html = pickHTML;

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
      const isBball = game.sport === 'nba' || game.sport === 'wnba';

      if (isBball) {
        // Combined per-team player table: PPG / RPG / APG / SPG etc.
        const COL_SHORT = { 'Points':'PPG','Rebounds':'RPG','Assists':'APG','Steals':'SPG','Blocks':'BPG','Three Pointers Made':'3PM','Three-Point Field Goals Made':'3PM','Turnovers':'TO' };
        let tableHTML = '';
        for (const tl of teamLeaders) {
          const tAbbr = tl.team?.abbreviation || tl.team?.shortDisplayName || '';
          const playerMap = new Map();
          const catNames  = [];
          for (const cat of (tl.leaders || [])) {
            const cName = cat.displayName || cat.shortDisplayName || '';
            if (cfg.cats.length && !cfg.cats.some(c => cName.toLowerCase().includes(c.toLowerCase()))) continue;
            if (!catNames.includes(cName)) catNames.push(cName);
            for (const l of (cat.leaders || []).slice(0, 5)) {
              const id = l.athlete?.id; if (!id) continue;
              if (!playerMap.has(id)) playerMap.set(id, { name: l.athlete?.shortName || l.athlete?.displayName || '-', stats: {} });
              playerMap.get(id).stats[cName] = l.displayValue || String(l.value ?? '-');
            }
          }
          if (!playerMap.size || !catNames.length) continue;
          const gs = `grid-template-columns:1fr repeat(${catNames.length},42px)`;
          const colHdr = catNames.map(c => `<span class="nba-sc">${esc(COL_SHORT[c] || c.slice(0,3).toUpperCase())}</span>`).join('');
          const rows   = [...playerMap.values()].map(p => {
            const cells = catNames.map(c => `<span class="nba-sc">${esc(p.stats[c] || '-')}</span>`).join('');
            return `<div class="nba-row" style="${gs}"><span class="nba-pname">${esc(p.name)}</span>${cells}</div>`;
          }).join('');
          tableHTML += `<div class="nba-block">
            <div class="nba-block-hdr"><span class="nba-hdr-team">${esc(tAbbr)}</span><span class="nba-hdr-label">Season Avg</span></div>
            <div class="nba-row nba-row-hdr" style="${gs}"><span class="nba-pname">Player</span>${colHdr}</div>
            ${rows}
          </div>`;
        }
        if (tableHTML) {
          html += `<div class="gp-section"><div class="gp-section-hdr">${cfg.icon} Players to Watch</div>${tableHTML}</div>`;
        } else {
          html += `<div class="gp-no-lineup">Pre-game stats not available yet - check back closer to tip-off</div>`;
        }
      } else {
        // Other sports: category-by-category display
        const catMap = {};
        for (const tl of teamLeaders) {
          const tAbbr = tl.team?.abbreviation || tl.team?.shortDisplayName || '';
          for (const cat of (tl.leaders || [])) {
            const cName = cat.displayName || cat.shortDisplayName || '';
            const matches = cfg.cats.some(c => cName.toLowerCase().includes(c.toLowerCase()));
            if (cfg.cats.length && !matches) continue;
            if (!catMap[cName]) catMap[cName] = [];
            for (const l of (cat.leaders || []).slice(0, 1)) {
              catMap[cName].push({ team: tAbbr, name: l.athlete?.shortName || l.athlete?.displayName || '-', val: l.displayValue || String(l.value ?? '-') });
            }
          }
        }
        const catKeys = Object.keys(catMap);
        if (catKeys.length) {
          let catHTML = '';
          for (const [cat, players] of Object.entries(catMap)) {
            catHTML += `<div class="gp-stat-cat"><div class="gp-cat-lbl">${esc(cat)}</div>
              ${players.map(p => `<div class="gp-player-row"><span class="gp-team">${esc(p.team)}</span><span class="gp-pname">${esc(p.name)}</span><span class="gp-avg-val">${esc(p.val)}</span></div>`).join('')}
            </div>`;
          }
          html += `<div class="gp-section"><div class="gp-section-hdr">${cfg.icon} Key Players to Watch</div>${catHTML}</div>`;
        } else {
          html += `<div class="gp-no-lineup">Pre-game stats not available yet - check back closer to tip-off / puck drop / kickoff</div>`;
        }
      }
    }

    // ── LIVE / FINAL: box score ──
    if (state === 'in' || state === 'post') {
      const isBball = game.sport === 'nba' || game.sport === 'wnba';
      if (isBball) {
        html += renderNBABoxScore(j);
      } else {
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
                .map(i => `<span class="gp-muted">${esc(labels[i])} <b>${esc(a.stats[i] || '-')}</b></span>`)
                .join('');
              performers += `<div class="gp-player-row">
                <span class="gp-team">${esc(tName)}</span>
                <span class="gp-pname">${esc(a.athlete?.shortName || a.athlete?.displayName || '-')}</span>
                <span class="gp-stats" style="gap:6px;flex-wrap:wrap">${statStr}</span>
              </div>`;
            }
          }
        }
        if (performers) {
          html += `<div class="gp-section"><div class="gp-section-hdr">${cfg.icon} Top Performers</div>${performers}</div>`;
        }
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
const _vsCache        = new Map(); // `${batterId}_${pitcherId}` -> career vs-pitcher stat
const _otherGamesMap  = new Map(); // espn event id → game object
const _schedCache     = new Map(); // `${sport}_${teamId}` → events[]
let   _mlbSchedCache  = null;
let   _mlbSchedDate   = null;

async function fetchTeamSched(sport, teamId) {
  const key = `${sport}_${teamId}`;
  if (_schedCache.has(key)) return _schedCache.get(key);
  const paths = { nba:'basketball/nba', wnba:'basketball/wnba', nfl:'football/nfl', nhl:'hockey/nhl' };
  const path = paths[sport];
  if (!path) { _schedCache.set(key, null); return null; }
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${teamId}/schedule`);
    const j = await res.json();
    const data = j.events || [];
    _schedCache.set(key, data);
    return data;
  } catch { _schedCache.set(key, null); return null; }
}

function parseScheduleInsights(events, myTeamId, oppTeamId) {
  if (!events?.length) return { recentWins: 0, recentPlayed: 0, h2hWins: 0, h2hTotal: 0 };
  const myId = String(myTeamId), oppId = String(oppTeamId);
  let recentWins = 0, recentPlayed = 0, h2hWins = 0, h2hTotal = 0;
  const completed = [...events]
    .filter(e => e.competitions?.[0]?.status?.type?.completed)
    .reverse();
  for (const ev of completed) {
    const comp = ev.competitions[0];
    const mySlot = comp.competitors?.find(c => c.team?.id === myId);
    if (!mySlot) continue;
    const won = mySlot.winner === true;
    const isH2H = comp.competitors.some(c => c.team?.id === oppId);
    if (recentPlayed < 5) { if (won) recentWins++; recentPlayed++; }
    if (isH2H) { if (won) h2hWins++; h2hTotal++; }
  }
  return { recentWins, recentPlayed, h2hWins, h2hTotal };
}

async function fetchPitcherPreview(pitcherId) {
  if (!pitcherId) return null;
  if (_pitcherCache.has(pitcherId)) return _pitcherCache.get(pitcherId);
  try {
    const [r1, r2] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season,gameLog&season=${CURRENT_SEASON}&group=pitching&limit=1`).then(r => r.json()),
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
      fetch(`https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=season,statSplits&season=${CURRENT_SEASON}&group=hitting&sitCodes=vl,vr,lastMonth`).then(r => r.json()),
      fetch(`https://statsapi.mlb.com/api/v1/people/${batterId}?fields=people,id,batSide`).then(r => r.json())
    ]);
    const stat      = r1.stats?.find(s => s.type?.displayName === 'season')?.splits?.[0]?.stat || null;
    const splitArr  = r1.stats?.find(s => s.type?.displayName === 'statSplits')?.splits || [];
    const vsL       = splitArr.find(s => s.split?.code === 'vl')?.stat || null;
    const vsR       = splitArr.find(s => s.split?.code === 'vr')?.stat || null;
    const lm        = splitArr.find(s => s.split?.code === 'lastMonth' || s.split?.description?.toLowerCase().includes('last month'))?.stat || null;
    const l30avg    = lm ? parseFloat(lm.avg || 0) : null;
    const batSide   = r2.people?.[0]?.batSide?.code || null;
    const result    = stat ? { ...stat, batSide, vsL, vsR, l30avg } : { batSide, vsL, vsR, l30avg };
    _batterCache.set(batterId, result);
    return result;
  } catch { _batterCache.set(batterId, null); return null; }
}

async function fetchVsStats(batterId, pitcherId) {
  if (!batterId || !pitcherId) return null;
  const key = `${batterId}_vs_${pitcherId}`;
  if (_vsCache.has(key)) return _vsCache.get(key);
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&sportId=1&group=hitting`);
    const j = await r.json();
    const stat = j.stats?.[0]?.splits?.[0]?.stat || null;
    _vsCache.set(key, stat);
    return stat;
  } catch { _vsCache.set(key, null); return null; }
}

async function getMLBSchedule(dateOffset = 0) {
  const target = dateStr(dateOffset);
  if (dateOffset === 0 && _mlbSchedCache && _mlbSchedDate === target) return _mlbSchedCache;
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${target}&hydrate=lineups,probablePitcher,team,linescore,weather`);
    const j   = await res.json();
    const games = j.dates?.[0]?.games || [];
    if (dateOffset === 0) { _mlbSchedCache = games; _mlbSchedDate = target; }
    return games;
  } catch { if (dateOffset === 0) _mlbSchedCache = []; return []; }
}

async function loadBatterStatsForCard(game) {
  const gamePk  = game.gamePk;
  const sides   = [game.lineups?.awayPlayers || [], game.lineups?.homePlayers || []];
  const dueList = [];

  for (const players of sides) {
    if (!players.length) continue;
    const results = await Promise.allSettled(players.map(p => fetchBatterPreview(p.id)));
    players.forEach((p, i) => {
      const st = results[i].status === 'fulfilled' ? results[i].value : null;
      const el = document.getElementById(`bstat-${p.id}-${gamePk}`);
      if (!el) return;
      if (st) {
        const babip = calcBABIP(st);
        el.innerHTML = `<span class="bi-avg">${st.avg || '.---'}</span><span class="bi-hr">${st.homeRuns ?? 0}HR</span><span class="bi-rbi">${st.rbi ?? 0}RBI</span>${babipTag(babip)}`;
        if (babip !== null && babip < 0.270 && parseFloat(stat?.avg || 0) >= 0.235) {
          dueList.push({ name: p.fullName, pos: i + 1, babip, avg: st.avg || '.---' });
        }
      } else {
        el.innerHTML = '';
      }
    });
  }

  const dueEl = document.getElementById(`due-hits-${gamePk}`);
  if (!dueEl) return;
  if (dueList.length) {
    dueList.sort((a, b) => a.babip - b.babip);
    dueEl.innerHTML = `<div class="lineup-due-hdr">🍀 Due for Hits</div>` +
      dueList.map(p =>
        `<span class="lineup-due-tag">#${p.pos} ${esc(p.name.split(' ').pop())} ${babipTag(p.babip)}</span>`
      ).join('');
    dueEl.style.display = '';
  } else {
    dueEl.style.display = 'none';
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
    showError('mlb-lineups-area', `Could not load lineups - ${err.message}`, 'loadMLBLineups()');
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
        <span class="lineup-pos-tag">${esc(p.position?.abbreviation || '-')}</span>
        <span class="lineup-name">${esc(p.fullName || '-')}${hint}</span>
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
        <div class="pd-era ${!s ? 'pd-tbd' : ''}">${s ? (s.era || '-') : '-'}</div>
        <div class="pd-era-lbl">ERA</div>
        ${s ? `
          <div class="pd-secondary">
            <span>${s.wins ?? 0}-${s.losses ?? 0}</span>
            <span>${s.whip || '-'} WHIP</span>
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
    const awayName      = away.team?.name || '-';
    const homeName      = home.team?.name || '-';
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
    const gameTime      = g.gameDate ? new Date(g.gameDate).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZoneName:'short' }) : '-';
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
        <div class="lineup-due-section" id="due-hits-${gamePk}" style="display:none"></div>
      </div>`;
  }).join('');

  // Auto-load batter stats for any confirmed lineups
  for (const g of games) {
    if ((g.lineups?.awayPlayers?.length || 0) + (g.lineups?.homePlayers?.length || 0) > 0) {
      loadBatterStatsForCard(g);
    }
  }
}

// ── SOCCER ───────────────────────────────────────────────────
const SOCCER_LEAGUES = [
  { id:'eng.1',           name:'Premier League',     icon:'🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  { id:'esp.1',           name:'La Liga',             icon:'🇪🇸' },
  { id:'ger.1',           name:'Bundesliga',          icon:'🇩🇪' },
  { id:'ita.1',           name:'Serie A',             icon:'🇮🇹' },
  { id:'fra.1',           name:'Ligue 1',             icon:'🇫🇷' },
  { id:'usa.1',           name:'MLS',                 icon:'🇺🇸' },
  { id:'uefa.champions',  name:'Champions League',    icon:'⭐' },
  { id:'uefa.europa',     name:'Europa League',       icon:'🟠' },
  { id:'uefa.europa_conf',name:'Conference League',   icon:'🔵' },
  { id:'ned.1',           name:'Eredivisie',          icon:'🇳🇱' },
  { id:'mex.1',           name:'Liga MX',             icon:'🇲🇽' },
  { id:'por.1',           name:'Primeira Liga',       icon:'🇵🇹' }
];

async function loadSoccerScores() {
  showLoading('other-scores-area', 'Loading soccer matches…');
  try {
    const results = await Promise.allSettled(
      SOCCER_LEAGUES.map(l =>
        fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${l.id}/scoreboard`)
          .then(r => r.json())
      )
    );
    const allGames = [];
    for (let i = 0; i < SOCCER_LEAGUES.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      const d   = results[i].value;
      const lg  = SOCCER_LEAGUES[i];
      for (const ev of (d.events || [])) {
        const comp = ev.competitions?.[0]; if (!comp) continue;
        const home = comp.competitors?.find(c => c.homeAway === 'home') || comp.competitors?.[0];
        const away = comp.competitors?.find(c => c.homeAway === 'away') || comp.competitors?.[1];
        const st   = comp.status || ev.status || {};
        const state = st.type?.state || '';
        allGames.push({
          id:        ev.id,
          league:    `${lg.icon} ${lg.name}`,
          leagueId:  lg.id,
          sport:     'soccer',
          homeTeam:  home?.team?.shortDisplayName || home?.team?.name || '-',
          awayTeam:  away?.team?.shortDisplayName || away?.team?.name || '-',
          homeAbbr:  home?.team?.abbreviation || '',
          awayAbbr:  away?.team?.abbreviation || '',
          homeRec:   home?.record?.[0]?.summary || '',
          awayRec:   away?.record?.[0]?.summary || '',
          series:    comp.series ? { summary: comp.series.summary||'', title: comp.series.title||'' } : null,
          homeScore: state !== 'pre' ? (home?.score ?? '') : '',
          awayScore: state !== 'pre' ? (away?.score ?? '') : '',
          status:    st.type?.shortDetail || st.type?.description || '-',
          period:    st.period || '',
          time:      st.displayClock || ''
        });
      }
    }
    if (!allGames.length) {
      document.getElementById('other-scores-area').innerHTML = '<div class="empty-state"><p>No soccer matches today.</p><p class="muted">Check back later - fixtures are loaded day-of.</p></div>';
      setConn('connected', 'Soccer - no matches today');
      return;
    }
    renderOtherScores(allGames, 'soccer', 'ESPN');
    const t = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    setConn('connected', `Soccer - updated ${t} · refreshes every 30s`);
  } catch (err) {
    setConn('disconnected', 'Soccer - update failed');
    showError('other-scores-area', `Could not load soccer - ${err.message}`, 'loadSoccerScores()');
  }
}

async function loadSoccerTables() {
  showLoading('other-standings-area', 'Loading league tables…');
  try {
    const leagues = SOCCER_LEAGUES.filter(l => ['eng.1','esp.1','ger.1','ita.1','fra.1','usa.1'].includes(l.id));
    const results = await Promise.allSettled(
      leagues.map(l =>
        fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${l.id}/standings`).then(r => r.json())
      )
    );
    const area = document.getElementById('other-standings-area');
    let html = '<div class="source-badge">Source: ESPN</div>';
    for (let i = 0; i < leagues.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      const data = results[i].value;
      const lg   = leagues[i];
      const entries = data.standings?.entries || data.children?.[0]?.standings?.entries || [];
      if (!entries.length) continue;
      html += `<div class="league-group"><div class="league-header">${lg.icon} ${esc(lg.name)}</div><div class="standings-list">`;
      entries.forEach((e, idx) => {
        const team = e.team?.shortDisplayName || e.team?.name || '-';
        const stats = {};
        (e.stats || []).forEach(s => { stats[s.name] = s.displayValue; });
        const pts = stats.points || stats.pts || '-';
        const w   = stats.wins   || stats.W   || '-';
        const d   = stats.ties   || stats.D   || stats.draws || '-';
        const l2  = stats.losses || stats.L   || '-';
        html += `<div class="standing-row">
          <span class="standing-rank">${idx+1}</span>
          <span class="standing-team">${esc(team)}</span>
          <span class="standing-record">${w}-${d}-${l2}</span>
          <span class="standing-pts">${pts} pts</span>
        </div>`;
      });
      html += '</div></div>';
    }
    area.innerHTML = html || '<div class="empty-state">No table data available.</div>';
  } catch (err) {
    showError('other-standings-area', `Could not load tables - ${err.message}`, 'loadSoccerTables()');
  }
}

// ── GOLF ─────────────────────────────────────────────────────
const GOLF_TOURS = [
  { key:'pga',  label:'PGA Tour',      icon:'🏌️' },
  { key:'lpga', label:'LPGA Tour',     icon:'🏌️‍♀️' },
  { key:'dpwt', label:'DP World Tour', icon:'🏌️' },
  { key:'liv',  label:'LIV Golf',      icon:'🏌️' }
];

function formatTeeTime(raw) {
  try { const d = new Date(raw); if (!isNaN(d)) return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }); } catch {}
  return raw;
}

function groupByTeeTime(players) {
  const map = new Map();
  for (const p of players) {
    const t = p.teeTime || '';
    if (!map.has(t)) map.set(t, []);
    map.get(t).push(p);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (!a && !b) return 0; if (!a) return 1; if (!b) return -1;
      return a.localeCompare(b);
    })
    .map(([time, ps]) => ({ time, players: ps }))
    .filter(g => g.players.length >= 2 && g.time); // only real groups with a tee time
}

function renderGolfGroup(group, round, isLive) {
  const players = group.players.slice(0, 3);
  const getWRNum = p => { const s = p.statistics?.find(x => x.name === 'worldRanking' || x.abbreviation === 'WR'); return s ? parseInt(s.displayValue) || 9999 : 9999; };
  const getWRStr = p => { const s = p.statistics?.find(x => x.name === 'worldRanking' || x.abbreviation === 'WR'); return s?.displayValue || null; };
  let pick;
  if (isLive) {
    pick = [...players].sort((a, b) => (+a.sortOrder || 9999) - (+b.sortOrder || 9999))[0];
  } else {
    pick = [...players].sort((a, b) => getWRNum(a) - getWRNum(b))[0];
    if (getWRNum(pick) === 9999) pick = [...players].sort((a, b) => (+a.sortOrder || 9999) - (+b.sortOrder || 9999))[0];
  }
  const pickWR = getWRStr(pick);
  const pickName = pick?.athlete?.shortName || pick?.athlete?.displayName || '?';
  const pickScore = pick?.score || 'E';
  let pickReason = '';
  if (isLive) {
    pickReason = (pick?.sortOrder || 9999) <= 5 ? `Leading at #${pick.sortOrder} - momentum is strong` : pickWR && parseInt(pickWR) <= 20 ? `World #${pickWR} - elite talent in this group` : `Best current position in the group`;
  } else {
    pickReason = pickWR && parseInt(pickWR) <= 30 ? `World #${pickWR} - highest-ranked player in this group` : `Best placed heading into the round`;
  }

  const rows = players.map(p => {
    const name = p.athlete?.shortName || p.athlete?.displayName || '-';
    const total = p.score || 'E';
    const totalNum = total === 'E' ? 0 : parseInt(total);
    const scoreCls = isNaN(totalNum) ? '' : totalNum < 0 ? 'golf-under' : totalNum > 0 ? 'golf-over' : 'golf-even';
    const thru  = p.status?.displayValue || '-';
    const today = p.linescores?.[round - 1]?.displayValue || '-';
    const pos   = p.sortOrder ? `#${p.sortOrder}` : '-';
    const wr    = getWRStr(p);
    const isPick = p === pick;
    return `<div class="golf-group-row${isPick ? ' golf-group-pick-row' : ''}">
      <span class="golf-group-pos">${esc(pos)}</span>
      <span class="golf-group-name">${esc(name)}${wr ? ` <span class="golf-wr">WR${esc(wr)}</span>` : ''}</span>
      <span class="golf-group-score ${scoreCls}">${esc(total)}</span>
      <span class="golf-group-today">${esc(today)}</span>
      <span class="golf-group-thru">${esc(thru)}</span>
    </div>`;
  }).join('');

  return `<div class="golf-group-card">
    <div class="golf-group-time">⏰ ${esc(formatTeeTime(group.time))}</div>
    <div class="golf-group-hdr">
      <span>POS</span><span>PLAYER</span><span>TOTAL</span><span>TODAY</span><span>THRU</span>
    </div>
    ${rows}
    <div class="golf-group-edge">📌 Edge: <b>${esc(pickName)}</b> (${esc(pickScore)}) - ${esc(pickReason)}</div>
  </div>`;
}

async function loadGolfLeaderboard() {
  const area = document.getElementById('golf-leaderboard-area');
  if (!area) return;
  area.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Loading golf…</p></div>';
  try {
    const results = await Promise.allSettled(
      GOLF_TOURS.map(t =>
        fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/${t.key}/scoreboard`).then(r => r.json())
      )
    );
    let html = '';
    for (let i = 0; i < GOLF_TOURS.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      const data = results[i].value;
      const tour = GOLF_TOURS[i];
      for (const ev of (data.events || [])) {
        const comp    = ev.competitions?.[0]; if (!comp) continue;
        const state   = comp.status?.type?.state || '';
        const round   = comp.status?.period || 1;
        const isLive  = state === 'in';
        const isFinal = state === 'post' || comp.status?.type?.completed;
        const venue   = comp.venue?.fullName ? `${comp.venue.fullName}` : '';
        const city    = comp.venue?.address?.city || '';
        const statusTxt = isLive  ? `<span class="live-badge pulse">LIVE</span> Round ${round}`
                        : isFinal ? `<span class="fin-badge">FINAL</span>`
                        :           `Round ${round} · Upcoming`;
        const allCompetitors = comp.competitors || [];
        const players = [...allCompetitors]
          .sort((a, b) => (+a.sortOrder||99) - (+b.sortOrder||99))
          .slice(0, 25);
        if (!players.length) continue;
        const groups = groupByTeeTime(allCompetitors);
        const groupsHTML = groups.length >= 2
          ? `<div class="golf-groups-section">
              <div class="golf-groups-hdr">🎯 Today's Groups &amp; Picks</div>
              ${groups.slice(0, 24).map(g => renderGolfGroup(g, round, isLive)).join('')}
            </div>`
          : '';
        html += `<div class="golf-tournament">
          <div class="golf-tourn-header">
            <div class="golf-tourn-name">${tour.icon} ${esc(ev.name || ev.shortName || tour.label)}</div>
            <div class="golf-tourn-meta">${statusTxt}${venue ? ` · ${esc(venue)}` : ''}${city ? `, ${esc(city)}` : ''}</div>
          </div>
          ${groupsHTML}
          <div class="golf-leaderboard">
            <div class="golf-lb-hdr">
              <span class="gc-pos">POS</span>
              <span class="gc-name">PLAYER</span>
              <span class="gc-score">SCORE</span>
              <span class="gc-today">TODAY</span>
              <span class="gc-thru">THRU</span>
            </div>
            ${players.map(p => renderGolfRow(p, round)).join('')}
          </div>
        </div>`;
      }
    }
    area.innerHTML = html || '<div class="empty-state"><p>No active golf tournaments right now.</p><p class="muted">Check back when a PGA/LPGA/DP World Tour event is in progress.</p></div>';
    const t = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    setConn('connected', `Golf - updated ${t} · refreshes every 30s`);
  } catch (err) {
    setConn('disconnected', 'Golf - update failed');
    area.innerHTML = `<div class="pp-error" style="padding:16px">Could not load golf - ${esc(err.message)}</div>`;
  }
}

function renderGolfRow(p, round) {
  const name     = p.athlete?.shortName || p.athlete?.displayName || '-';
  const total    = p.score || 'E';
  const totalNum = total === 'E' ? 0 : parseInt(total);
  const scoreCls = isNaN(totalNum) ? '' : totalNum < 0 ? 'golf-under' : totalNum > 0 ? 'golf-over' : 'golf-even';
  const thru     = p.status?.displayValue || '-';
  const status   = (p.status?.type?.name || '').toLowerCase();
  const isCut    = status === 'cut' || thru === 'CUT' || status === 'wd' || status === 'dq';
  const today    = p.linescores?.[round - 1]?.displayValue || (p.statistics?.find?.(s => s.name === 'scoringPlayByPlay')?.displayValue) || '-';
  const pos      = p.sortOrder ? String(p.sortOrder) : '-';

  if (isCut) {
    return `<div class="golf-player-row golf-row-cut">
      <span class="gc-pos golf-cut-lbl">${esc(status.toUpperCase() || 'CUT')}</span>
      <span class="gc-name">${esc(name)}</span>
      <span class="gc-score golf-over">${esc(total)}</span>
      <span class="gc-today">-</span>
      <span class="gc-thru">-</span>
    </div>`;
  }
  return `<div class="golf-player-row">
    <span class="gc-pos">${esc(pos)}</span>
    <span class="gc-name">${esc(name)}</span>
    <span class="gc-score ${scoreCls}">${esc(total)}</span>
    <span class="gc-today">${esc(today)}</span>
    <span class="gc-thru ${thru === 'F' ? 'golf-thru-done' : ''}">${esc(thru)}</span>
  </div>`;
}

// ── MLB FULL STANDINGS + STAT LEADERS ───────────────────────
let _mlbStandData = null;
let _mlbLeadData  = null;

async function loadMLBFullStandings() {
  showLoading('other-standings-area', 'Loading MLB standings…');
  try {
    const [standRes, leadRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${CURRENT_SEASON}&standingsTypes=regularSeason&hydrate=division,team,record`),
      fetch(`https://statsapi.mlb.com/api/v1/stats/leaders?leaderCategories=homeRuns,battingAverage,rbi,stolenBases,hits,earnedRunAverage,strikeouts,wins,saves&season=${CURRENT_SEASON}&sportId=1&limit=10&hydrate=person,team`)
    ]);
    if (!standRes.ok) throw new Error(`HTTP ${standRes.status}`);
    if (!leadRes.ok)  throw new Error(`HTTP ${leadRes.status}`);
    _mlbStandData = await standRes.json();
    _mlbLeadData  = await leadRes.json();
    renderMLBStandingsView('standings');
  } catch (err) {
    showError('other-standings-area', `Could not load MLB stats - ${err.message}`, 'loadMLBFullStandings()');
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
                <span class="standing-team">${esc(t.team?.name || '-')}</span>
                <span class="standing-record">${t.wins}–${t.losses}</span>
                <span class="standing-gb">${esc(t.gamesBack || '-')}</span>
                <span class="standing-streak">${esc(t.streak?.streakCode || '-')}</span>
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
              <span class="leader-name">${esc(l.person?.fullName || '-')}</span>
              <span class="leader-team">${esc(l.team?.abbreviation || '-')}</span>
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
      <span class="pp-season">${CURRENT_SEASON}</span>
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
      const r = await fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}?hydrate=stats(group=[hitting,pitching],type=season,season=${CURRENT_SEASON}),currentTeam,position`);
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
        fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${CURRENT_SEASON}&group=hitting&limit=20`).then(r=>r.json()),
        fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${CURRENT_SEASON}&group=pitching&limit=20`).then(r=>r.json()),
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
        fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=byDateRange&startDate=${start}&endDate=${end}&group=hitting&season=${CURRENT_SEASON}`).then(r=>r.json()),
        fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=byDateRange&startDate=${start}&endDate=${end}&group=pitching&season=${CURRENT_SEASON}`).then(r=>r.json()),
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
    if (!data) { el.innerHTML = '<div class="pp-empty">No Statcast data available - player may not qualify or Baseball Savant is unavailable</div>'; return; }
    const f = (v, d=1) => (v && !isNaN(parseFloat(v))) ? parseFloat(v).toFixed(d) : '-';
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
            <div class="pp-stat-val">${val != null ? esc(String(val)) : '-'}</div>
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
  if (babip < 0.265) return `<span class="gp-babip gp-babip-due" title="BABIP ${val} - below avg, hits should come">BABIP ${val} ↑</span>`;
  if (babip > 0.340) return `<span class="gp-babip gp-babip-hot" title="BABIP ${val} - above avg, may cool off">BABIP ${val} ↓</span>`;
  return                    `<span class="gp-babip gp-babip-avg" title="BABIP ${val} - about average">${val}</span>`;
}

function xbaTag(playerId, actualAvg) {
  const cached = _ppCache.get(`${playerId}_statcast`);
  if (!cached) return '';
  const xba = parseFloat(cached.estimated_ba_using_speedangle || 0);
  const ba  = parseFloat(actualAvg || 0);
  if (!xba || !ba) return '';
  const gap = xba - ba;
  if (gap >=  0.020) return `<span class="gp-xba-up"   title="xBA ${xba.toFixed(3)} vs AVG ${ba.toFixed(3)} - contact quality says more hits coming">xBA↑</span>`;
  if (gap <= -0.020) return `<span class="gp-xba-down" title="xBA ${xba.toFixed(3)} vs AVG ${ba.toFixed(3)} - outperforming contact quality, may cool off">xBA↓</span>`;
  return '';
}

function renderGameLog(hLog, pLog) {
  const log = hLog.length ? hLog : pLog;
  const isBatter = hLog.length > 0;
  if (!log.length) return '<div class="pp-empty">No game log available</div>';

  const fmt = (d) => {
    if (!d) return '-';
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { month:'short', day:'numeric' });
  };

  const head = isBatter
    ? ['Date','Opp','AB','H','HR','RBI','BB','K','AVG']
    : ['Date','Opp','Dec','IP','H','R','ER','BB','K','ERA'];

  const rows = log.slice(0, 15).map(s => {
    const opp   = (s.isHome ? '' : '@') + (s.opponent?.abbreviation || '-');
    const d     = fmt(s.date);
    const st    = s.stat;
    if (isBatter) {
      const hasHit = (st.hits || 0) > 0;
      const hasHR  = (st.homeRuns || 0) > 0;
      return `<div class="gl-row ${hasHR?'gl-hr':hasHit?'gl-hit':''}">
        <span>${d}</span><span>${opp}</span><span>${st.atBats??'-'}</span>
        <span>${st.hits??'-'}</span><span>${st.homeRuns??'-'}</span><span>${st.rbi??'-'}</span>
        <span>${st.baseOnBalls??'-'}</span><span>${st.strikeOuts??'-'}</span>
        <span class="gl-avg">${st.avg??'-'}</span>
      </div>`;
    } else {
      const dec = s.stat.wins ? 'W' : s.stat.losses ? 'L' : s.stat.saves ? 'SV' : '-';
      return `<div class="gl-row ${dec==='W'?'gl-hit':dec==='L'?'gl-loss':''}">
        <span>${d}</span><span>${opp}</span><span class="gl-dec">${dec}</span>
        <span>${st.inningsPitched??'-'}</span><span>${st.hits??'-'}</span>
        <span>${st.runs??'-'}</span><span>${st.earnedRuns??'-'}</span>
        <span>${st.baseOnBalls??'-'}</span><span>${st.strikeOuts??'-'}</span>
        <span class="gl-avg">${st.era??'-'}</span>
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
  const PARAMS = `hfGT=R%7C&hfSea=${CURRENT_SEASON}%7C&group_by=name&sort_col=pitches&sort_order=desc&min_results=0&type=details`;
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
        .map(([l,v]) => `<div class="matchup-stat"><div class="matchup-val">${v??'-'}</div><div class="matchup-lbl">${l}</div></div>`).join('')}
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
    showError('other-standings-area', `Could not load standings - ${err.message}`, `loadOtherStandings('${sport}')`);
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
      const team = entry.team?.shortDisplayName || entry.team?.name || '-';
      const stats = {};
      (entry.stats || []).forEach(s => { stats[s.name] = s.displayValue; });
      const w = stats.wins || stats.W || '-';
      const l = stats.losses || stats.L || '-';
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
    const name = item.team?.name || item.name || item.team || '-';
    const wins   = item.wins   ?? item.won  ?? item.w   ?? '-';
    const losses = item.losses ?? item.lost ?? item.l   ?? '-';
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
  // retryCall is a plain JS string like "loadFixtures(0)" - avoids closure issues
  const btn = retryCall ? `<button class="retry-btn" onclick="${retryCall}">Retry</button>` : '';
  document.getElementById(id).innerHTML =
    `<div class="error-state"><div class="error-icon">⚠</div><p>${esc(msg)}</p>${btn}</div>`;
}

function toggleGroup(header) {
  const group = header.parentElement;
  const expanded = group.dataset.expanded === 'true';
  group.dataset.expanded = expanded ? 'false' : 'true';
}

function toggleDetail(panelId, dataKey) {
  const el = document.getElementById(`md-${panelId}`);
  if (!el) return;
  const showing = el.style.display !== 'none';
  el.style.display = showing ? 'none' : 'block';
  if (!showing && !_detailLoaded.has(panelId)) {
    _detailLoaded.add(panelId);
    const container = document.getElementById(`di-${panelId}`);
    const m = S.matches.get(String(dataKey || panelId));
    if (container && m) loadTennisMatchDetail(dataKey || panelId, container, m);
  }
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
  clearOldPicks();
  updatePicksDisplay();
  renderDateBar();
  switchSport('tennis');
}

init();
