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

// Incremented on every switchSport call. Async loaders capture the value at start
// and bail before writing to the DOM if the sport has since changed.
let _loadSeq = 0;
let _tpTab          = 'upcoming'; // tennis picks active tab: 'upcoming' | 'results'
let _golfPicksTab   = 'today';    // golf picks active tab: 'yesterday' | 'today' | 'tomorrow'
let _svPreloadDone  = false;      // true after preloadPicksForSimpleView completes
let _ticketDateOffset = 0;        // tickets tab date: -1=yesterday, 0=today, 1=tomorrow
let _golfTournamentActive = false; // true only when ESPN confirms a live/pre-round golf event today

// ── REST DAYS CACHE ──────────────────────────────────────────
// Populated by populateRestDaysCache() during preload.
// Key: "sport:ABBR" (e.g. "nba:BOS"), value: daysRest (1=B2B, 2=short, 3+=normal)
const _restDaysCache = new Map();

// ── INJURY PENALTY CACHE ─────────────────────────────────────
// Populated by fetchInjuryPenalties() during preload for NBA/WNBA.
// Key: "sport:ABBR" (e.g. "nba:GSW"), value: win-probability penalty (0–0.12)
const _injuryPenalty = new Map();

// ── NHL TEAM STATS CACHE ─────────────────────────────────────
// Keyed by ESPN team ID, value: { ppPct, pkPct, svPct }
const _nhlTeamStats = new Map();

// ── TENNIS INJURY MAP ────────────────────────────────────────
// Keyed by lowercase last name → { note, returning, published }
// Populated from ESPN tennis news headlines on tab open.
const _tennisInjuryMap = new Map();

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

// Returns -1 (deflate conf), 0 (no change), or +1 (inflate conf) based on historical accuracy
function getConfCalibration(sport) {
  const all = Object.values(getPicks()).filter(p => p.result && p.conf > 0 && (!sport || p.sport === sport) && p.type !== 'player');
  if (all.length < 12) return 0;
  const tiers = { 1:{w:0,t:0}, 2:{w:0,t:0}, 3:{w:0,t:0} };
  for (const p of all) { const c = Math.min(3, Math.max(1, parseInt(p.conf))); tiers[c].t++; if (p.result === 'win') tiers[c].w++; }
  const r3 = tiers[3].t >= 5 ? tiers[3].w / tiers[3].t : null;
  const r1 = tiers[1].t >= 5 ? tiers[1].w / tiers[1].t : null;
  if (r3 !== null && r3 < 0.45) return -1;  // high-conf picks losing too often → be more conservative
  if (r1 !== null && r1 > 0.68) return  1;  // low-conf picks hitting well → we can trust more
  return 0;
}

function recordPick(gameId, pickedTeam, matchup = '', sport = '', conf = 0, force = false, dateOverride = null, tier = '', meta = {}) {
  const picks = getPicks();
  const existing = picks[gameId];
  // Silently fix the date if an unresolved pick was stamped with the wrong date
  if (existing && dateOverride && existing.result === null && existing.date !== dateOverride) {
    existing.date = dateOverride;
    savePicks(picks);
    return;
  }
  // force = true lets a nuanced pick overwrite a simple W-L seed, but never overwrite a resolved result
  if (existing && (!force || existing.result !== null)) return;
  const entry = { team: pickedTeam, date: dateOverride || dateStrLocal(), result: existing?.result ?? null, matchup, sport, conf };
  if (tier) entry.tier = tier;
  if (meta && Object.keys(meta).length) Object.assign(entry, meta);
  picks[gameId] = entry;
  savePicks(picks);
}

function recordPlayerPick(pickKey, sport, playerName, prop, stat, gameMatchup, gamePk, gameTime = null) {
  const picks = getPicks();
  if (picks[pickKey]) return;
  const entry = { type: 'player', sport, player: playerName, prop, stat, gameMatchup, gamePk: gamePk || null, date: dateStrLocal(), result: null };
  if (gameTime) entry.gameTime = gameTime;
  picks[pickKey] = entry;
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
  const sport    = S.sport;
  const allVals  = Object.values(getPicks());

  // Filter everything to the current sport only
  const sportPicks   = allVals.filter(p => (p.sport || 'tennis') === sport);
  const gamePicks    = sportPicks.filter(p => p.type !== 'player');
  const playerPicks  = sportPicks.filter(p => p.type === 'player');
  const pending      = sportPicks.filter(p => p.result === null).sort((a,b) => (b.date||'').localeCompare(a.date||''));
  const resolved     = sportPicks.filter(p => p.result !== null).sort((a,b) => (b.date||'').localeCompare(a.date||''));

  const SPORT_LABEL = { tennis:'🎾 Tennis', mlb:'⚾ MLB', nba:'🏀 NBA', wnba:'🏀 WNBA', nfl:'🏈 NFL', nhl:'🏒 NHL', soccer:'⚽ Soccer', golf:'⛳ Golf' };
  const sportLabel  = SPORT_LABEL[sport] || sport.toUpperCase();

  const PROP_ICON = { Hit:'🎯', HR:'💣', RBI:'⚡', Walk:'🚶', SB:'🏃', Double:'2️⃣', XBH:'💥', Points:'🏀', Rebounds:'📊', Assists:'🎽' };

  const makeRow = p => {
    const win = p.result === 'win';
    return `<div class="ph-row ${win ? 'ph-win' : 'ph-loss'}">
      <div class="ph-result-pill ${win ? 'ph-win-pill' : 'ph-loss-pill'}">${win ? 'W' : 'L'}</div>
      <div class="ph-row-info">
        <div class="ph-matchup">${esc(p.matchup || p.team)}</div>
        <div class="ph-pick-line">Picked: <strong>${esc(p.team)}</strong></div>
      </div>
    </div>`;
  };

  const makePendingRow = p => `<div class="ph-row ph-pending-row">
    <div class="ph-result-pill ph-pend-pill">·</div>
    <div class="ph-row-info">
      <div class="ph-matchup">${esc(p.matchup || p.team)}</div>
      <div class="ph-pick-line">Picked: <strong>${esc(p.team)}</strong></div>
    </div>
  </div>`;

  const makePlayerRow = p => {
    const win  = p.result === 'win';
    const isPending = p.result === null;
    const pillCls = isPending ? 'ph-pend-pill' : (win ? 'ph-win-pill' : 'ph-loss-pill');
    const pillTxt = isPending ? '·' : (win ? 'W' : 'L');
    const cls = isPending ? 'ph-pending-row' : (win ? 'ph-win' : 'ph-loss');
    return `<div class="ph-row ph-player-row ${cls}">
      <div class="ph-result-pill ${pillCls}">${pillTxt}</div>
      <div class="ph-row-info">
        <div class="ph-matchup"><span class="ph-prop-badge">${PROP_ICON[p.prop]||''} ${esc(p.prop)}</span>${esc(lastName(p.player || ''))}</div>
        <div class="ph-pick-line">${esc(p.gameMatchup || '')}</div>
      </div>
    </div>`;
  };

  const renderRow  = p => p.type === 'player' ? makePlayerRow(p) : makeRow(p);
  const renderPend = p => p.type === 'player' ? makePlayerRow(p) : makePendingRow(p);

  // Group all picks by date (most recent first)
  const allSorted = [...sportPicks].sort((a,b) => (b.date||'').localeCompare(a.date||''));
  const byDay = new Map();
  for (const p of allSorted) {
    const d = p.date || 'unknown';
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p);
  }

  const todayUTC    = dateStrLocal(0);
  const ystUTC      = dateStrLocal(-1);
  const tomorrowUTC = dateStrLocal(1);
  const fmtDayLabel = d => {
    if (d === todayUTC)    return 'Today';
    if (d === ystUTC)      return 'Yesterday';
    if (d === tomorrowUTC) return 'Tomorrow';
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  };

  // Build content
  let content = '';

  // Player picks prop-type summary chips
  if (playerPicks.length) {
    const pRes = playerPicks.filter(p => p.result !== null);
    const cats = {};
    for (const p of pRes) {
      if (!cats[p.prop]) cats[p.prop] = { w:0, l:0 };
      if (p.result === 'win') cats[p.prop].w++; else cats[p.prop].l++;
    }
    if (Object.keys(cats).length) {
      content += `<div class="ph-cat-summary">${Object.entries(cats).map(([prop, r]) => {
        const tot = r.w + r.l, pct = Math.round(r.w / tot * 100);
        return `<span class="ph-cat-chip ph-cat-${pct >= 55 ? 'good' : pct <= 40 ? 'bad' : 'avg'}">${PROP_ICON[prop]||''} ${prop} ${r.w}–${r.l}</span>`;
      }).join('')}</div>`;
    }
  }

  if (byDay.size === 0) {
    content = '<div class="ph-empty">No picks yet for this sport.<br><span class="muted">Picks are generated automatically as you browse games.</span></div>';
  } else {
    for (const [date, dayPicks] of byDay) {
      const dayResolved = dayPicks.filter(p => p.result !== null);
      const dayPending  = dayPicks.filter(p => p.result === null);
      const w = dayResolved.filter(p => p.result === 'win').length;
      const l = dayResolved.length - w;
      const recordBadge = dayResolved.length
        ? `<span class="ph-day-record ${w > l ? 'ph-day-up' : w < l ? 'ph-day-down' : 'ph-day-even'}">${w}W–${l}L</span>` : '';
      const gId = 'phg_' + date.replace(/\D/g,'');
      const pendBadge = dayPending.length
        ? `<button class="ph-day-pend-btn" onclick="(function(b){var g=document.getElementById('${gId}');var open=g.style.display!=='none';g.style.display=open?'none':'block';b.textContent=open?'${dayPending.length} pending ▾':'${dayPending.length} pending ▴';})(this)">${dayPending.length} pending ▾</button>`
        : '';
      content += `<div class="ph-day-hdr">${fmtDayLabel(date)}${recordBadge}${pendBadge}</div>`;
      if (dayPending.length)  content += `<div class="ph-pend-group" id="${gId}" style="display:none">${dayPending.map(renderPend).join('')}</div>`;
      if (dayResolved.length) content += dayResolved.map(renderRow).join('');
    }
  }

  // Confidence calibration (how accurate are high-conf vs low-conf picks?)
  const calPicks = resolved.filter(p => p.conf > 0 && p.type !== 'player');
  if (calPicks.length >= 3) {
    const tiers = { 1:{w:0,t:0}, 2:{w:0,t:0}, 3:{w:0,t:0} };
    for (const p of calPicks) { const c = parseInt(p.conf); if (tiers[c]) { tiers[c].t++; if (p.result==='win') tiers[c].w++; } }
    const calRows = [3,2,1].filter(c => tiers[c].t > 0).map(c => {
      const pct = Math.round(tiers[c].w / tiers[c].t * 100);
      const dots = '●'.repeat(c) + '○'.repeat(3-c);
      const cls  = pct >= 60 ? 'good' : pct <= 40 ? 'bad' : 'avg';
      return `<div class="ph-cal-row">
        <span class="ph-cal-dots">${dots}</span>
        <span class="ph-cal-label">${c === 3 ? 'High' : c === 2 ? 'Medium' : 'Low'} confidence</span>
        <span class="ph-cal-stat ph-cat-${cls}">${tiers[c].w}–${tiers[c].t-tiers[c].w} <em>${pct}%</em></span>
      </div>`;
    }).join('');
    content += `<div class="ph-cal-section"><div class="ph-cal-title">Accuracy by Confidence</div>${calRows}</div>`;
  }

  // Overall W-L for header badge
  const totalW = resolved.filter(p => p.result === 'win').length;
  const totalL = resolved.length - totalW;
  const overallPct = resolved.length ? Math.round(totalW / resolved.length * 100) : null;
  const overallCls = overallPct === null ? '' : overallPct >= 55 ? 'ph-cat-good' : overallPct <= 40 ? 'ph-cat-bad' : 'ph-cat-avg';
  const overallBadge = resolved.length
    ? `<span class="ph-hdr-record ${overallCls}">${totalW}W – ${totalL}L${overallPct !== null ? ` · ${overallPct}%` : ''}</span>`
    : '';

  const modal = document.createElement('div');
  modal.id    = 'picks-history-modal';
  modal.className = 'ph-modal';
  modal.innerHTML = `<div class="ph-panel">
    <div class="ph-hdr">
      <div class="ph-hdr-left">
        <span class="ph-title">${esc(sportLabel)} Picks</span>
        <span class="ph-sub">last 14 days</span>
      </div>
      ${overallBadge}
      <button class="ph-close" onclick="document.getElementById('picks-history-modal').remove()">✕</button>
    </div>
    <div class="ph-list">${content}</div>
  </div>`;

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
  const allVals    = Object.values(getPicks());
  const sport      = S.sport;
  const today      = dateStrLocal(0);

  const sportPicks = allVals.filter(p => (p.sport || 'tennis') === sport && p.date === today);
  const sportRes   = sportPicks.filter(p => p.result !== null);
  const sportPend  = sportPicks.filter(p => p.result === null);
  const sWins      = sportRes.filter(p => p.result === 'win').length;
  const sLosses    = sportRes.length - sWins;
  const sPct       = sportRes.length ? Math.round((sWins / sportRes.length) * 100) : 0;

  // Small topbar badge
  const badge = document.getElementById('picks-accuracy');
  if (badge) {
    if (!sportRes.length) { badge.textContent = ''; badge.classList.remove('has-picks'); }
    else {
      badge.textContent = `${sWins}W-${sLosses}L (${sPct}%)`;
      badge.title = `${sWins} correct, ${sLosses} wrong`;
      badge.classList.add('has-picks');
    }
  }

  // Banner - always visible, shows this sport's record only
  const banner  = document.getElementById('picks-banner');
  const pbWins  = document.getElementById('pb-wins');
  const pbLoss  = document.getElementById('pb-losses');
  const pbPct   = document.getElementById('pb-pct');
  const pbBreak = document.getElementById('pb-breakdown');
  if (!banner || !pbWins || !pbLoss || !pbPct) return;

  banner.style.display = '';

  if (sportRes.length) {
    pbWins.textContent = sWins;
    pbLoss.textContent = sLosses;
    pbPct.textContent  = `(${sPct}%)`;
    if (pbBreak) pbBreak.textContent = sportPend.length ? `+${sportPend.length} active` : '';
    banner.className = sPct >= 55 ? 'pb-hot' : sPct <= 40 ? 'pb-cold' : '';
  } else if (sportPend.length) {
    pbWins.textContent = '-';
    pbLoss.textContent = '-';
    pbPct.textContent  = `${sportPend.length} active`;
    if (pbBreak) pbBreak.textContent = '';
    banner.className = '';
  } else {
    pbWins.textContent = '0';
    pbLoss.textContent = '0';
    pbPct.textContent  = 'making picks…';
    if (pbBreak) pbBreak.textContent = '';
    banner.className = '';
  }
}

function clearOldPicks() {
  const picks  = getPicks();
  const cutStr = dateStrLocal(-30);
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

// ── TIMEZONE SYSTEM ─────────────────────────────────────────
const _TZ_KEY = '_baseline_tz';
const TZ_OPTIONS = [
  { label:'ET', tz:'America/New_York' },
  { label:'CT', tz:'America/Chicago' },
  { label:'MT', tz:'America/Denver' },
  { label:'PT', tz:'America/Los_Angeles' },
];
function getUserTZ() { return localStorage.getItem(_TZ_KEY) || 'America/New_York'; }
function setUserTZ(tz) {
  localStorage.setItem(_TZ_KEY, tz);
  document.querySelectorAll('.tz-btn').forEach(b => b.classList.toggle('tz-active', b.dataset.tz === tz));
  renderSimpleView();
  switchSport(S.sport); // re-render game times in the active view
}
// Returns YYYY-MM-DD in the user's chosen timezone (default ET)
function dateStrLocal(offset = 0) {
  const d = new Date();
  if (offset) d.setDate(d.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { timeZone: getUserTZ() }).format(d);
}
// Format an ISO datetime string into a time string in the user's timezone (with TZ label)
function fmtTimeTZ(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (!isNaN(d)) return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone: getUserTZ(), timeZoneName:'short' });
  } catch {}
  return iso;
}

// ── UTILITIES ───────────────────────────────────────────────
function dateStr(offset = 0) {
  return dateStrLocal(offset); // use user-chosen TZ for all date math
}
// Tennis API uses UTC dates - use this for all tennis fetches and event_date comparisons
function dateStrUTC(offset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
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
// Tennis event_time is "HH:MM" UTC - convert to user's selected timezone
function fmtTennisTime(date, time) {
  if (!time) return '';
  try {
    const d = new Date((date || dateStrLocal()) + 'T' + time + ':00Z');
    if (!isNaN(d)) return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone: getUserTZ() });
  } catch {}
  return fmtTime12(time);
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
    const d = dateStrLocal(offset); // use user TZ - tennis date bar matches the user's "today"
    const results = await tennisFetch('get_fixtures', { date_start: d, date_stop: d });
    const picks = getPicks();
    let picksDirty = false;
    for (const m of results) {
      S.matches.set(String(m.event_key), m);
      // Re-date any pick that was stamped with the wrong date (pre-fix migration)
      // Only move dates forward - never pull a tomorrow pick back to today.
      if (m.event_date) {
        const pid = 'tn_' + m.event_key;
        const ex  = picks[pid];
        if (ex && ex.result === null && ex.date !== m.event_date && m.event_date >= ex.date) {
          ex.date = m.event_date;
          picksDirty = true;
        }
      }
    }
    if (picksDirty) savePicks(picks);
    renderMatches(results);
    renderOverview(results);
    renderSidebar(results);
    // Picks just got recorded - refresh simple view if it's open
    if (document.getElementById('simple-view')?.classList.contains('sv-active')) renderSimpleView();
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
        league:  p.league || (atp.includes(p) ? 'ATP' : 'WTA'),
        country: (p.country || p.player_country || p.nationality || '').toUpperCase().slice(0,3)
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

// Background-only rank load - no UI, just fills S.rankIndex then re-runs picks for cached matches.
// Called on tennis tab open so ranking-based picks generate without waiting for the user to visit Rankings.
async function preloadRankIndex() {
  if (S.rankIndex.size > 0) return;
  try {
    const [atpR, wtaR] = await Promise.allSettled([
      tennisFetch('get_standings', { event_type: 'ATP' }),
      tennisFetch('get_standings', { event_type: 'WTA' })
    ]);
    const atp = atpR.status === 'fulfilled' ? atpR.value : [];
    const wta = wtaR.status === 'fulfilled' ? wtaR.value : [];
    S.rankIndex.clear();
    // Store player name in each entry so ESPN supplement can match by name
    for (const p of [...atp, ...wta]) {
      if (p.player_key) S.rankIndex.set(String(p.player_key), {
        rank:   p.place ?? p.standing_place ?? p.ranking ?? 999,
        points: p.points ?? p.standing_points ?? 0,
        league: atp.includes(p) ? 'ATP' : 'WTA',
        name:   (p.player_name || p.name || '').toLowerCase()
      });
    }

    // Supplement with ESPN tennis rankings - updated much more frequently than api-tennis.com.
    // api-tennis.com standings can lag weeks behind real rankings for fast-rising players.
    // We use last-name + first-initial matching to cross-reference, then update any entry
    // where ESPN shows a significantly better (lower number) rank.
    const lnorm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
    const espnSupplement = async (url, league) => {
      try {
        const j = await fetch(url).then(r => r.json());
        const rows = j?.rankings?.[0]?.ranks || [];
        for (const row of rows) {
          const espnRank = row.current;
          const fullName = row.athlete?.displayName || row.athlete?.fullName || '';
          if (!fullName || !espnRank) continue;
          const parts    = fullName.trim().split(/\s+/);
          const espnLast = lnorm(parts[parts.length - 1]);
          const espnInit = parts[0] ? lnorm(parts[0])[0] : '';
          // Find matching entry in rank index: same league, last name matches, first initial matches
          for (const [, entry] of S.rankIndex) {
            if (entry.league !== league) continue;
            const entryParts = (entry.name || '').trim().split(/\s+/);
            const entryLast  = lnorm(entryParts[entryParts.length - 1]);
            const entryInit  = entryParts[0] ? lnorm(entryParts[0])[0] : '';
            if (espnLast && entryLast && espnLast === entryLast &&
                (!espnInit || !entryInit || espnInit === entryInit)) {
              if (espnRank < entry.rank) {
                // ESPN has this player ranked higher - use it (with synthetic points so ratio logic works)
                entry.rank   = espnRank;
                entry.points = Math.max(entry.points, Math.round(15000 - espnRank * 130));
              }
              break;
            }
          }
        }
      } catch {}
    };
    await Promise.allSettled([
      espnSupplement('https://site.api.espn.com/apis/site/v2/sports/tennis/wta/rankings?limit=200', 'WTA'),
      espnSupplement('https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings?limit=200', 'ATP'),
    ]);

    // Re-run pick generation for all already-cached matches now that rankings are available
    for (const m of S.matches.values()) inlineTennisPick(m);
    updatePicksDisplay();
  } catch { /* silent - rankings are best-effort for pick generation */ }
}

// Fetch ESPN ATP + WTA news and build _tennisInjuryMap from injury/withdrawal headlines.
// Only runs once per session. Helps inlineTennisPick avoid backing injured players.
async function loadTennisInjuryNews() {
  if (_tennisInjuryMap.size > 0) return; // already loaded
  const INJURY_RX = /injur|withdraw|pulls?\s+out|out\s+of|ruled?\s+out|absent|surgery|unable|won't\s+(return|play)|falls?\s+ill|thigh|wrist|achilles|knee|elbow|ankle|hamstring|hip|rib|arm\s+pain|leg\s+pain|muscle|fitness\s+doubt/i;
  const RETURN_RX  = /returns?\s+(to|from)|back\s+from\s+injur|recovered?|cleared\s+to\s+play/i;
  const urls = [
    'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/news?limit=50',
    'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/news?limit=50'
  ];
  try {
    const results = await Promise.allSettled(urls.map(u => fetch(u).then(r => r.json())));
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      const articles = res.value.articles || [];
      for (const art of articles) {
        const hl = art.headline || '';
        if (!INJURY_RX.test(hl)) continue;
        // Skip articles about coaching staff, not the player themselves
        if (/\bcoach(es|ing)?\b/i.test(hl)) continue;
        const isReturn = RETURN_RX.test(hl);
        for (const cat of (art.categories || [])) {
          if (cat.type !== 'athlete') continue;
          const fullName = cat.description || cat.athlete?.description || '';
          if (!fullName) continue;
          const ln = lastName(fullName).toLowerCase();
          if (!ln || ln === '-') continue;
          if (!_tennisInjuryMap.has(ln)) {
            _tennisInjuryMap.set(ln, {
              note:      hl,
              returning: isReturn,  // true = returning/recovered (lighter flag)
              published: art.published || ''
            });
          }
        }
      }
    }
    // Re-run picks now that injury data is available
    if (_tennisInjuryMap.size > 0) {
      for (const m of S.matches.values()) inlineTennisPick(m);
      updatePicksDisplay();
    }
  } catch { /* silent - injury data is best-effort */ }
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
  const liveMatches = filtered.filter(m => isLive(m.event_status));
  let html = '';
  if (liveMatches.length) {
    // Group live matches by tournament
    const liveTournMap = new Map();
    for (const m of liveMatches) {
      const tKey = m.tournament_name || m.league_name || m.event_type_type || 'Other';
      if (!liveTournMap.has(tKey)) {
        liveTournMap.set(tKey, { name: tKey, surface: m.tournament_surface || inferSurface(tKey), matches: [] });
      }
      liveTournMap.get(tKey).matches.push(m);
    }
    const tournBlocks = [...liveTournMap.values()].map(t => {
      const sc = surfaceClass(t.surface);
      return `<div class="live-tourn-block">
        <div class="live-tourn-hdr">
          <span class="surface-dot ${sc}" title="${esc(t.surface || 'hard')}"></span>
          <span class="live-tourn-name">${esc(t.name)}</span>
        </div>
        ${t.matches.map(m => buildMatchRow(m, 'live')).join('')}
      </div>`;
    }).join('');
    html += `
      <div class="live-now-section">
        <div class="live-now-header">
          <span class="live-now-dot">●</span>
          LIVE NOW
          <span class="live-now-count">${liveMatches.length} match${liveMatches.length !== 1 ? 'es' : ''}</span>
        </div>
        ${tournBlocks}
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
        ${sortedGroups.map(g => buildGroup(g, key)).join('')}
      </div>`;
  }

  area.innerHTML = html;
  updatePicksDisplay();
}

function buildGroup(g, catKey = '') {
  const hasLive = g.matches.some(m => isLive(m.event_status));
  const sc = surfaceClass(g.surface);
  const sortedM = [...g.matches].sort((a, b) => {
    const al = isLive(a.event_status) ? 0 : 1;
    const bl = isLive(b.event_status) ? 0 : 1;
    if (al !== bl) return al - bl;
    return (a.event_time || '').localeCompare(b.event_time || '');
  });

  // Collapse lower-tier categories by default to reduce visual noise
  const collapseByDefault = !hasLive && ['itf-m','itf-w','challenger-m','challenger-w','doubles','other'].includes(catKey);

  const tier     = g.matches[0] ? tournamentTier(g.matches[0]) : '250';
  const tierLbl  = TIER_LABEL[tier] || '';
  const roundLbl = groupRoundLabel(g.matches);
  const surfLbl  = (g.surface || 'Hard').charAt(0).toUpperCase() + (g.surface || 'Hard').slice(1);

  return `
    <div class="tournament-group tg-surf-${sc}" id="tg-${slugify(g.name)}" data-expanded="${collapseByDefault ? 'false' : 'true'}">
      <div class="tournament-header" onclick="toggleGroup(this)">
        <span class="surface-pill surf-${sc}">${esc(surfLbl)}</span>
        <span class="tournament-name">${esc(g.name)}</span>
        ${tierLbl ? `<span class="tier-badge tier-${tier}">${tierLbl}</span>` : ''}
        ${roundLbl ? `<span class="round-badge">${roundLbl}</span>` : ''}
        ${hasLive ? '<span class="live-badge">LIVE</span>' : ''}
        <span class="collapse-icon">▾</span>
      </div>
      <div class="tournament-matches">
        ${sortedM.map(m => buildMatchRow(m)).join('')}
      </div>
    </div>`;
}

// Returns 'r1'|'r2'|'r3'|'mid'|'quarter'|'semi'|'final'|'unknown'
function tennisRound(m) {
  const r = (m.event_round || '').toLowerCase();
  if (!r) return 'unknown';
  if (/final/.test(r) && !/semi|quarter/.test(r)) return 'final';
  if (/semi|1\/2/.test(r))                         return 'semi';
  if (/quarter|1\/4/.test(r))                      return 'quarter';
  if (/3rd|r3|round.?3/.test(r))                   return 'r3';
  if (/2nd|r2|round.?2/.test(r))                   return 'r2';
  if (/1st|r1|round.?1/.test(r))                   return 'r1';
  return 'mid';
}

// Countries known to produce clay / fast-court specialists
const CLAY_COUNTRIES  = new Set(['ESP','ARG','ITA','FRA','CHL','COL','PER','URU','BRA','AUT','SUI','MON','SVK']);
const GRASS_COUNTRIES = new Set(['AUS','GBR','USA','GER','CAN','RSA','NZL','SWE']);

// Tournament-specific affinity - last name (lowercase) → partial tournament name → strength (1-4)
// Updated 2025: reflect current form, post-surgery players, new top-10 entrants
const TOURNAMENT_AFFINITY = {
  // ATP
  djokovic:  { 'australian open':2, 'wimbledon':2, 'us open':2, 'paris masters':2, 'roland garros':3, 'french open':3 }, // 3x RG champion
  alcaraz:   { 'roland garros':4, 'french open':4, 'wimbledon':3, 'us open':2, 'madrid':3, 'barcelona':2 },
  sinner:    { 'australian open':4, 'miami':2, 'us open':3, 'paris masters':2, 'rome':2 }, // won Rome 2024 on clay
  zverev:    { 'roland garros':3, 'paris masters':3, 'hamburg':2, 'french open':3 },
  tsitsipas: { 'monte carlo':2, 'barcelona':2, 'lyon':2 }, // reduced - less consistent 2024-25
  medvedev:  { 'us open':3, 'paris masters':2, 'shanghai':2 },
  ruud:      { 'roland garros':3, 'french open':3, 'rome':2, 'monte carlo':2, 'barcelona':2 },
  rublev:    { 'monte carlo':3, 'hamburg':2, 'madrid':2 },
  fritz:     { 'indian wells':3, 'us open':2 },
  musetti:   { 'roland garros':2, 'french open':2, 'rome':2, 'monte carlo':2 }, // clay specialist
  // WTA
  swiatek:   { 'roland garros':4, 'french open':4, 'madrid':3, 'rome':3, 'miami':2 },
  sabalenka: { 'australian open':4, 'us open':3, 'madrid':2 },
  keys:      { 'australian open':3, 'us open':2 }, // AO 2025 winner
  gauff:     { 'us open':3, 'roland garros':2, 'miami':2 },
  rybakina:  { 'wimbledon':3, 'australian open':2, 'dubai':2 },
  paolini:   { 'roland garros':3, 'wimbledon':2, 'dubai':2 },
  pegula:    { 'us open':2, 'miami':2 },
  andreeva:  { 'roland garros':2, 'french open':2 }, // rising 2024-25, solid clay results
  navarro:   { 'wimbledon':2, 'us open':2 }, // rising 2024-25
  mboko:     { 'canadian open':2 }, // ranked #9 WTA 2025, hard-court specialist
  jabeur:    { 'wimbledon':2, 'roland garros':2 }, // reduced - injury history 2024
  krejcikova:{ 'roland garros':3, 'french open':3 }, // 2021 RG champion
  halep:     { 'roland garros':3, 'french open':3 }, // 2018 RG champion (if active)
  kvitova:   { 'wimbledon':3 }, // 2x Wimbledon champion
};

// Players who significantly underperform their ranking as favorites.
// Negative score applied regardless of surface or opponent.
const PLAYER_VOLATILITY = {
  // ATP
  bublik:        -3,  // highest retirement rate on tour, mentally unpredictable
  kyrgios:       -3,  // extreme variance, frequent retirements
  korda:         -2,  // multiple in-match retirements, inconsistent
  kokkinakis:    -2,  // injury/inconsistency pattern
  davidovich:    -2,  // volatile despite clay ability
  rune:          -2,  // mercurial, inconsistent vs lower-ranked opponents
  borges:        -1,
  nakashima:     -1,  // underperforms seeding in slams
  etcheverry:    -1,
  cerundolo:     -1,
  // WTA
  ostapenko:     -3,  // most volatile player in women's game
  kvitova:       -2,  // injury history, major variance
  alexandrova:   -2,
  muchova:       -2,  // injury history, unreliable form
  bouzkova:      -1,
};

// Returns true if the player retired (lost via retirement/walkover) in any recent match.
function hadRecentRetirement(recent, playerKey) {
  return recent.some(g => {
    const st = (g.event_status || '').toLowerCase();
    if (!st.includes('retir') && !st.includes('walkover') && st !== 'w/o') return false;
    const gp1 = String(g.first_player_key || '');
    const won = (g.event_winner === 'First Player' && gp1 === playerKey) ||
                (g.event_winner === 'Second Player' && gp1 !== playerKey);
    return !won;
  });
}

// Returns current streak: +N = N-match win streak, -N = losing streak.
function calcWinStreak(recent, playerKey) {
  if (!recent.length) return 0;
  let streak = 0;
  for (const g of recent) {
    const gp1 = String(g.first_player_key || '');
    const won = (g.event_winner === 'First Player' && gp1 === playerKey) ||
                (g.event_winner === 'Second Player' && gp1 !== playerKey);
    if (streak === 0)         streak = won ? 1 : -1;
    else if (won  && streak > 0) streak++;
    else if (!won && streak < 0) streak--;
    else break;
  }
  return streak;
}

function isGrandSlam(m) {
  const n = (m.tournament_name || m.event_type_type || '').toLowerCase();
  return /wimbledon|us open|french open|roland.?garros|australian open/.test(n);
}

function isBestOf5(m) {
  return isGrandSlam(m) && matchCategory(m.event_type_type || '') === 'atp';
}

function tournamentTier(m) {
  const n = (m.tournament_name || '').toLowerCase();
  const cat = matchCategory(m.event_type_type || '');
  if (isGrandSlam(m)) return 'slam';
  if (cat === 'challenger-m' || cat === 'challenger-w') return 'chal';
  if (cat === 'itf-m' || cat === 'itf-w') return 'itf';
  if (/masters 1000|rolex|indian wells|miami open|madrid|rome|montreal|toronto|cincinnati|shanghai|paris masters|monte.?carlo/.test(n)) return 'masters';
  if (/500|dubai|acapulco|barcelona|halle|queen.?s|eastbourne|washington|osaka|beijing|vienna|basel|rotterdam/.test(n)) return '500';
  return '250';
}

const TIER_LABEL = { slam:'SLAM', masters:'MASTERS', '500':'500', '250':'250', chal:'CHAL', itf:'ITF' };

// Returns the label for the highest-priority round found across matches in a group
function groupRoundLabel(matches) {
  const ORDER = ['final','semi','quarter','mid','r3','r2','r1'];
  const SHORT  = { final:'Final', semi:'Semis', quarter:'QF', mid:'R16', r3:'R3', r2:'R2', r1:'R1' };
  const rounds = new Set(matches.map(m => tennisRound(m)));
  for (const r of ORDER) { if (rounds.has(r)) return SHORT[r]; }
  return '';
}

function inlineTennisPick(m, dateOverride = null, allowLive = false) {
  if (isLive(m.event_status) && !allowLive) return '';

  const today     = dateStrLocal(0);
  const matchDate = m.event_date || '';
  const pickDate  = dateOverride || (matchDate && matchDate >= today ? matchDate : today);
  if (!dateOverride && matchDate && matchDate < today) return ''; // skip past matches
  if (!dateOverride && pickDate > today) return '';

  const cat = matchCategory(m.event_type || '');
  if (cat === 'doubles') return '';
  const tier    = tournamentTier(m);
  const pickId  = 'tn_' + m.event_key;
  const surface = m.tournament_surface || inferSurface(m.tournament_name || '');
  const surfLow = surface.toLowerCase();
  const matchup = `${lastName(m.event_first_player||'')} vs ${lastName(m.event_second_player||'')}`;

  const p1Name = m.event_first_player  || '-';
  const p2Name = m.event_second_player || '-';
  const p1key  = String(m.first_player_key  || '');
  const p2key  = String(m.second_player_key || '');
  const s1     = parseInt(m.event_first_player_seed)  || 0;
  const s2     = parseInt(m.event_second_player_seed) || 0;
  const l1     = lastName(p1Name);
  const l2     = lastName(p2Name);

  // Injury check
  const p1Inj  = _tennisInjuryMap.get(l1.toLowerCase());
  const p2Inj  = _tennisInjuryMap.get(l2.toLowerCase());
  const p1Hurt = p1Inj && !p1Inj.returning;
  const p2Hurt = p2Inj && !p2Inj.returning;

  // ── Multi-factor scoring - same model as buildTennisPrediction ──
  let p1Score = 0, p2Score = 0;

  // 1. Injury (decisive - injured player heavily penalised)
  if (p1Hurt) p1Score -= 8;
  if (p2Hurt) p2Score -= 8;

  // 2. Seeds
  if (s1 && s2) {
    if (s1 < s2)      p1Score += 2;
    else if (s2 < s1) p2Score += 2;
  } else if (s1) { p1Score += 1; }
    else if (s2) { p2Score += 1; }

  // 3. Rankings / points
  const rd1 = S.rankIndex.get(p1key), rd2 = S.rankIndex.get(p2key);
  if (rd1 && rd2) {
    const pts1 = parseInt(rd1.points) || 0;
    const pts2 = parseInt(rd2.points) || 0;
    if (pts1 > 0 && pts2 > 0) {
      const ratio = Math.max(pts1, pts2) / Math.min(pts1, pts2);
      if (pts1 > pts2) { p1Score += ratio >= 3 ? 3 : ratio >= 1.5 ? 2 : ratio >= 1.2 ? 1 : 0; }
      else             { p2Score += ratio >= 3 ? 3 : ratio >= 1.5 ? 2 : ratio >= 1.2 ? 1 : 0; }
    } else if (rd1.rank !== rd2.rank) {
      if (rd1.rank < rd2.rank) p1Score += 2; else p2Score += 2;
    }
  }

  // 4. Nationality × surface affinity
  const c1 = rd1?.country || '', c2 = rd2?.country || '';
  if (surfLow.includes('clay')) {
    // Clay slam (Roland Garros) = +2; other clay events = +1
    const clayBonus = tier === 'slam' ? 2 : 1;
    if (CLAY_COUNTRIES.has(c1) && !CLAY_COUNTRIES.has(c2)) p1Score += clayBonus;
    else if (CLAY_COUNTRIES.has(c2) && !CLAY_COUNTRIES.has(c1)) p2Score += clayBonus;
  } else if (surfLow.includes('grass') || surfLow.includes('indoor')) {
    if (GRASS_COUNTRIES.has(c1) && !GRASS_COUNTRIES.has(c2)) p1Score += 1;
    else if (GRASS_COUNTRIES.has(c2) && !GRASS_COUNTRIES.has(c1)) p2Score += 1;
  }

  // 5. Tournament affinity (known specialists)
  const tourLow = (m.tournament_name || '').toLowerCase();
  const getAff  = name => { const ln = lastName(name).toLowerCase(); const a = TOURNAMENT_AFFINITY[ln]; if (!a) return 0; for (const [ev,pts] of Object.entries(a)) { if (tourLow.includes(ev)) return pts; } return 0; };
  const ta1 = getAff(p1Name), ta2 = getAff(p2Name);
  if (ta1 > ta2) p1Score += Math.min(3, Math.ceil((ta1-ta2)/2));
  else if (ta2 > ta1) p2Score += Math.min(3, Math.ceil((ta2-ta1)/2));

  // 6. H2H + recent form from cache (populated when user expands a match)
  const ckey   = `${p1key}_${p2key}`;
  const ckeyR  = `${p2key}_${p1key}`;
  const h2hDat = _h2hCache.get(ckey) || _h2hCache.get(ckeyR);
  if (h2hDat) {
    const { h2h = [], p1Recent = [], p2Recent = [] } = h2hDat;
    // Recency-weighted H2H
    if (h2h.length >= 2) {
      const now = Date.now(); let hw1 = 0, hw2 = 0;
      for (const g of h2h) {
        const age = g.event_date ? (now - new Date(g.event_date+'T12:00:00').getTime()) / 2592000000 : 24;
        const wt  = age <= 12 ? 2 : age <= 24 ? 1.5 : 0.5; // >2yr old results barely count
        const gp1 = String(g.first_player_key || '');
        const p1w = (g.event_winner === 'First Player' && gp1 === p1key) || (g.event_winner === 'Second Player' && gp1 !== p1key);
        if (p1w) hw1 += wt; else hw2 += wt;
      }
      if (hw1 > hw2) p1Score += 2; else if (hw2 > hw1) p2Score += 2;
    }
    // Surface H2H
    const h2hS = h2h.filter(g => { const gs = inferSurface(g.tournament_name||'').toLowerCase(); return surfLow.includes('clay') ? gs.includes('clay') : surfLow.includes('grass') ? gs.includes('grass') : gs === 'hard'; });
    if (h2hS.length >= 2) {
      let sw1 = 0, sw2 = 0;
      for (const g of h2hS) { const gp1 = String(g.first_player_key||''); const p1w = (g.event_winner==='First Player'&&gp1===p1key)||(g.event_winner==='Second Player'&&gp1!==p1key); if (p1w) sw1++; else sw2++; }
      if (sw1 > sw2) p1Score += 3; else if (sw2 > sw1) p2Score += 3;
    }
    // Recent form (last 10)
    const fWins = (games, pk) => games.reduce((w,g) => { const gp1=String(g.first_player_key||''); return w+(((g.event_winner==='First Player'&&gp1===pk)||(g.event_winner==='Second Player'&&gp1!==pk))?1:0); }, 0);
    const fw1 = p1Recent.length ? fWins(p1Recent, p1key) : -1;
    const fw2 = p2Recent.length ? fWins(p2Recent, p2key) : -1;
    if (fw1 >= 0 && fw2 >= 0 && fw1 !== fw2) {
      if (fw1 > fw2) p1Score += 2; else p2Score += 2;
    }
    // Surface form
    const onSurf = g => { const gs = inferSurface(g.tournament_name||'').toLowerCase(); return surfLow.includes('clay') ? gs.includes('clay') : surfLow.includes('grass') ? gs.includes('grass') : gs === 'hard'; };
    const p1SF = p1Recent.filter(onSurf), p2SF = p2Recent.filter(onSurf);
    if (p1SF.length >= 2 && p2SF.length >= 2) {
      const r1 = fWins(p1SF, p1key) / p1SF.length, r2 = fWins(p2SF, p2key) / p2SF.length;
      if (r1 > r2 + 0.20) p1Score += 2; else if (r2 > r1 + 0.20) p2Score += 2;
    }
    // Fatigue
    const todayStr = dateStrLocal(0);
    if (p1Recent[0]?.event_date === todayStr && p2Recent[0]?.event_date !== todayStr) p2Score += 1;
    else if (p2Recent[0]?.event_date === todayStr && p1Recent[0]?.event_date !== todayStr) p1Score += 1;

    // Recent retirement - players who retired in last 10 matches get a penalty
    if (hadRecentRetirement(p1Recent, p1key)) p1Score -= 2;
    if (hadRecentRetirement(p2Recent, p2key)) p2Score -= 2;

    // Win/loss streak
    const str1 = calcWinStreak(p1Recent, p1key);
    const str2 = calcWinStreak(p2Recent, p2key);
    if (str1 >= 4) p1Score += 2; else if (str1 >= 2) p1Score += 1; else if (str1 <= -3) p1Score -= 1;
    if (str2 >= 4) p2Score += 2; else if (str2 >= 2) p2Score += 1; else if (str2 <= -3) p2Score -= 1;
  }

  // 7. Player volatility - known high-variance players score lower as favorites
  p1Score += PLAYER_VOLATILITY[l1.toLowerCase()] || 0;
  p2Score += PLAYER_VOLATILITY[l2.toLowerCase()] || 0;

  // 8. BO5 amplifies leader's edge
  if (isBestOf5(m) && p1Score !== p2Score) {
    if (p1Score > p2Score) p1Score += 1; else p2Score += 1;
  }

  // ── Decide pick ──
  const gap = Math.abs(p1Score - p2Score);
  const minGap = 2;
  if (gap < minGap) return '';

  const winner = p1Score > p2Score ? 1 : 2;
  const pick   = winner === 1 ? l1 : l2;
  if (!pick || pick === '-') return '';

  const round      = tennisRound(m);
  const earlyRound = ['r1','r2'].includes(round);
  const lateRound  = ['quarter','semi','final'].includes(round);
  let conf = gap >= 8 ? 3 : gap >= 5 ? 2 : 1;
  if (earlyRound && tier !== 'slam') conf = Math.min(conf, 2);
  if (lateRound && tier === 'slam' && gap >= 5) conf = Math.min(3, conf + 1);
  conf = Math.max(1, Math.min(3, conf + getConfCalibration('tennis')));

  const injTag = (winner === 1 && p2Hurt) || (winner === 2 && p1Hurt) ? ' ⚕' : '';
  // force=true: re-evaluate pre-game picks on every preload as more data arrives.
  // recordPick guards against overwriting resolved (finished) matches.
  // Store matchDate so Secret Ticket can filter without needing S.matches populated.
  recordPick(pickId, pick, matchup, 'tennis', conf, true, pickDate, tier, { matchDate, bo5: isBestOf5(m) || undefined });
  return `<span class="match-pick-inline" title="Multi-factor pick (click for full analysis)">→ ${esc(pick)}${injTag}</span>`;
}

function injBadge(playerName = '') {
  const data = _tennisInjuryMap.get(lastName(playerName).toLowerCase());
  if (!data) return '';
  const icon  = data.returning ? '↩' : '⚠';
  const label = data.returning ? 'Returning from injury' : 'Recent injury/withdrawal news';
  const tip   = esc(data.note.length > 80 ? data.note.slice(0, 80) + '…' : data.note);
  return `<span class="inj-flag${data.returning ? ' inj-return' : ''}" title="${label}: ${tip}">${icon}</span>`;
}

// idSuffix: when provided (e.g. 'live'), creates a unique panel ID so the same
// match can have an independent expandable panel in the LIVE NOW section and the
// category section simultaneously without duplicate IDs.
function buildMatchRow(m, idSuffix = '') {
  const live     = isLive(m.event_status);
  const finished = isFinished(m.event_status);
  const sets     = parseSets(m);
  const serve    = String(m.event_serve ?? '');

  const statusHTML = live
    ? `<span class="status live-status">● LIVE</span>`
    : finished
    ? `<span class="status fin-status">FIN</span>`
    : `<span class="status time-status">${esc(fmtTennisTime(m.event_date, m.event_time))}</span>`;

  // Winner detection
  const p1Won = finished && m.event_winner === 'First Player';
  const p2Won = finished && m.event_winner === 'Second Player';

  const setsHTML = sets.map((s, i) => {
    const cur = live && i === sets.length - 1;
    if (finished && (p1Won || p2Won)) {
      const p1SetWon = parseInt(s.p1) > parseInt(s.p2);
      const p2SetWon = parseInt(s.p2) > parseInt(s.p1);
      return `<span class="set-score">` +
        `<span class="${p1Won && p1SetWon ? 'set-win' : 'set-lose'}">${esc(s.p1)}</span><br>` +
        `<span class="${p2Won && p2SetWon ? 'set-win' : 'set-lose'}">${esc(s.p2)}</span>` +
        `</span>`;
    }
    return `<span class="set-score ${cur ? 'current-set' : ''}">${esc(s.p1)}<br>${esc(s.p2)}</span>`;
  }).join('');

  const gameHTML = live && m.event_game_result
    ? `<span class="game-score">${esc(m.event_game_result).replace('-','<br>')}</span>`
    : '';

  const p1serve = serve === '1' ? '<span class="serve-dot">●</span>' : '';
  const p2serve = serve === '2' ? '<span class="serve-dot">●</span>' : '';

  // Seed tags - show [N] for seeded players; rank # for unseeded (when rankIndex loaded)
  const s1 = parseInt(m.event_first_player_seed)  || 0;
  const s2 = parseInt(m.event_second_player_seed) || 0;
  const s1tag = s1 ? `<span class="player-seed">[${s1}]</span>` : (() => {
    const ri = S.rankIndex.get(String(m.first_player_key || ''));
    return ri ? `<span class="player-rank">#${ri.rank}</span>` : '';
  })();
  const s2tag = s2 ? `<span class="player-seed">[${s2}]</span>` : (() => {
    const ri = S.rankIndex.get(String(m.second_player_key || ''));
    return ri ? `<span class="player-rank">#${ri.rank}</span>` : '';
  })();

  // Last name only in row - cleaner scanning; full name shown in detail panel
  const p1Display = lastName(m.event_first_player  || '-');
  const p2Display = lastName(m.event_second_player || '-');

  // Player row classes - winner bold-green, loser dimmed
  const p1Cls = p1Won ? 'player p1 match-winner' : p2Won ? 'player p1 match-loser' : `player p1 ${serve==='1'?'serving':''}`;
  const p2Cls = p2Won ? 'player p2 match-winner' : p1Won ? 'player p2 match-loser' : `player p2 ${serve==='2'?'serving':''}`;


  const key = esc(m.event_key);
  const pid = idSuffix ? `${key}-${idSuffix}` : key;

  const _pickResult = inlineTennisPick(m); // always call - records pick as side effect (idempotent)
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
        <div class="${p1Cls}">
          ${p1serve}${s1tag}<span class="player-name">${esc(p1Display)}</span>${injBadge(m.event_first_player)}
        </div>
        <div class="${p2Cls}">
          ${p2serve}${s2tag}<span class="player-name">${esc(p2Display)}</span>${injBadge(m.event_second_player)}
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

// ── H2H CACHE ────────────────────────────────────────────────
const _h2hCache = new Map(); // `${p1key}_${p2key}` → { h2h, p1Recent, p2Recent }

async function fetchH2HCached(p1key, p2key) {
  const ckey = `${p1key}_${p2key}`;
  if (_h2hCache.has(ckey)) return _h2hCache.get(ckey);
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url = new URL(CFG.tennis.base);
    url.searchParams.set('method', 'get_H2H');
    url.searchParams.set('APIkey', CFG.tennis.key);
    url.searchParams.set('first_player_key', p1key);
    url.searchParams.set('second_player_key', p2key);
    const res  = await fetch(url.toString(), { signal: ctrl.signal });
    clearTimeout(tid);
    const json = res.ok ? await res.json() : {};
    const raw  = json.success === 1 ? (json.result || {}) : {};
    const data = {
      h2h:      Array.isArray(raw.H2H)                ? raw.H2H                        : [],
      p1Recent: Array.isArray(raw.firstPlayerResults)  ? raw.firstPlayerResults.slice(0,10)  : [],
      p2Recent: Array.isArray(raw.secondPlayerResults) ? raw.secondPlayerResults.slice(0,10) : []
    };
    _h2hCache.set(ckey, data);
    return data;
  } catch {
    clearTimeout(tid);
    return { h2h: [], p1Recent: [], p2Recent: [] };
  }
}

async function loadTennisMatchDetail(key, container, m) {
  try {
    const surface = m.tournament_surface || inferSurface(m.tournament_name);
    let h2h = [], p1Recent = [], p2Recent = [];
    if (m.first_player_key && m.second_player_key) {
      try {
        const data = await fetchH2HCached(m.first_player_key, m.second_player_key);
        h2h      = data.h2h;
        p1Recent = data.p1Recent;
        p2Recent = data.p2Recent;
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
  const rd1 = S.rankIndex.get(p1key), rd2 = S.rankIndex.get(p2key);
  if (!s1 && !s2) {
    if (rd1 && rd2 && rd1.rank !== rd2.rank) {
      if (rd1.rank < rd2.rank) { p1Score += 2; factors.push({ win: true, label: 'Ranking', detail: `${l1} #${rd1.rank} vs ${l2} #${rd2.rank}`, side: 1 }); }
      else                     { p2Score += 2; factors.push({ win: true, label: 'Ranking', detail: `${l2} #${rd2.rank} vs ${l1} #${rd1.rank}`, side: 2 }); }
    }
  }

  // Nationality-surface affinity (only when rankings/seeds don't clearly separate)
  const c1 = rd1?.country || '', c2 = rd2?.country || '';
  const surfLow2 = surfLabel.toLowerCase();
  if (!s1 && !s2 && (c1 || c2)) {
    if (surfLow2.includes('clay')) {
      const c1c = CLAY_COUNTRIES.has(c1), c2c = CLAY_COUNTRIES.has(c2);
      if (c1c && !c2c) { p1Score += 1; factors.push({ win: true, label: 'Surface fit', detail: `${l1} clay nation`, side: 1 }); }
      else if (c2c && !c1c) { p2Score += 1; factors.push({ win: true, label: 'Surface fit', detail: `${l2} clay nation`, side: 2 }); }
    } else if (surfLow2.includes('grass') || surfLow2.includes('indoor')) {
      const c1g = GRASS_COUNTRIES.has(c1), c2g = GRASS_COUNTRIES.has(c2);
      if (c1g && !c2g) { p1Score += 1; factors.push({ win: true, label: 'Surface fit', detail: `${l1} fast-court nation`, side: 1 }); }
      else if (c2g && !c1g) { p2Score += 1; factors.push({ win: true, label: 'Surface fit', detail: `${l2} fast-court nation`, side: 2 }); }
    }
  }

  // H2H overall (recency-weighted: matches ≤12 months count 2×, ≤24 months 1.5×)
  if (h2hAll.length >= 2) {
    const now = Date.now();
    let hw1 = 0, hw2 = 0;
    for (const g of h2hAll) {
      const age = g.event_date ? (now - new Date(g.event_date + 'T12:00:00').getTime()) / 2592000000 : 24;
      const wt  = age <= 12 ? 2 : age <= 24 ? 1.5 : 1;
      const gp1 = String(g.first_player_key || '');
      const p1won = (g.event_winner === 'First Player' && gp1 === p1key) || (g.event_winner === 'Second Player' && gp1 !== p1key);
      if (p1won) hw1 += wt; else hw2 += wt;
    }
    if (hw1 > hw2)      { p1Score += 2; factors.push({ win: true, label: 'H2H (weighted)', detail: `${l1} leads ${aw1}–${aw2}`, side: 1 }); }
    else if (hw2 > hw1) { p2Score += 2; factors.push({ win: true, label: 'H2H (weighted)', detail: `${l2} leads ${aw2}–${aw1}`, side: 2 }); }
    else                {               factors.push({ win: null,  label: 'H2H', detail: `Even ${aw1}–${aw2}`, side: 0 }); }
  }

  // H2H on this surface
  if (h2hSurf.length >= 2) {
    if (sw1 > sw2)      { p1Score += 3; factors.push({ win: true, label: `On ${esc(surfLabel)}`, detail: `${l1} leads ${sw1}–${sw2}`, side: 1 }); }
    else if (sw2 > sw1) { p2Score += 3; factors.push({ win: true, label: `On ${esc(surfLabel)}`, detail: `${l2} leads ${sw2}–${sw1}`, side: 2 }); }
    else                 {               factors.push({ win: null, label: `On ${esc(surfLabel)}`, detail: `Even ${sw1}–${sw2}`, side: 0 }); }
  }

  // Recent form (last 10 matches)
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
  const formN = Math.max(p1Recent.length, p2Recent.length);
  if (fw1 >= 0 && fw2 >= 0 && fw1 !== fw2) {
    if (fw1 > fw2) { p1Score += 2; factors.push({ win: true, label: 'Recent form', detail: `${l1} ${fw1}/${p1Recent.length} vs ${l2} ${fw2}/${p2Recent.length}`, side: 1 }); }
    else           { p2Score += 2; factors.push({ win: true, label: 'Recent form', detail: `${l2} ${fw2}/${p2Recent.length} vs ${l1} ${fw1}/${p1Recent.length}`, side: 2 }); }
  }

  // Recent form on this surface
  const matchesSurf1 = g => {
    const gs = inferSurface(g.tournament_name || '').toLowerCase();
    if (surfLow2.includes('clay'))   return gs.includes('clay');
    if (surfLow2.includes('grass'))  return gs.includes('grass');
    if (surfLow2.includes('indoor')) return gs.includes('indoor');
    return gs === 'hard';
  };
  const p1SF = p1Recent.filter(matchesSurf1), p2SF = p2Recent.filter(matchesSurf1);
  const sf1 = p1SF.length >= 2 ? formWins(p1SF, p1key) : -1;
  const sf2 = p2SF.length >= 2 ? formWins(p2SF, p2key) : -1;
  if (sf1 >= 0 && sf2 >= 0) {
    const r1sf = sf1 / p1SF.length, r2sf = sf2 / p2SF.length;
    if (r1sf > r2sf + 0.20) { p1Score += 2; factors.push({ win: true, label: `${surfLabel} form`, detail: `${l1} ${sf1}/${p1SF.length} vs ${l2} ${sf2}/${p2SF.length}`, side: 1 }); }
    else if (r2sf > r1sf + 0.20) { p2Score += 2; factors.push({ win: true, label: `${surfLabel} form`, detail: `${l2} ${sf2}/${p2SF.length} vs ${l1} ${sf1}/${p1SF.length}`, side: 2 }); }
  } else if (sf1 >= 0 && p1SF.length >= 2) { p1Score += 1; factors.push({ win: true, label: `${surfLabel} form`, detail: `${l1} ${sf1}/${p1SF.length} (no data ${l2})`, side: 1 }); }
    else if (sf2 >= 0 && p2SF.length >= 2) { p2Score += 1; factors.push({ win: true, label: `${surfLabel} form`, detail: `${l2} ${sf2}/${p2SF.length} (no data ${l1})`, side: 2 }); }

  // Tournament affinity (known specialists)
  const tourLow1 = (m.tournament_name || '').toLowerCase();
  const getAff = name => { const lname = lastName(name).toLowerCase(); const aff = TOURNAMENT_AFFINITY[lname]; if (!aff) return 0; for (const [ev, pts] of Object.entries(aff)) { if (tourLow1.includes(ev)) return pts; } return 0; };
  const taff1 = getAff(p1Name), taff2 = getAff(p2Name);
  if (taff1 > taff2) { p1Score += Math.min(3, Math.ceil((taff1-taff2)/2)); factors.push({ win: true, label: 'Tournament history', detail: `${l1} specialist here`, side: 1 }); }
  else if (taff2 > taff1) { p2Score += Math.min(3, Math.ceil((taff2-taff1)/2)); factors.push({ win: true, label: 'Tournament history', detail: `${l2} specialist here`, side: 2 }); }

  // Fatigue: last match was yesterday - possible carry-over fatigue
  const ystStr = dateStrLocal(-1);
  const p1Tired = p1Recent.length > 0 && p1Recent[0].event_date === ystStr;
  const p2Tired = p2Recent.length > 0 && p2Recent[0].event_date === ystStr;
  if (p1Tired && !p2Tired) {
    p2Score += 1;
    factors.push({ win: true, label: 'Fatigue', detail: `${l1} played yesterday`, side: 2 });
  } else if (p2Tired && !p1Tired) {
    p1Score += 1;
    factors.push({ win: true, label: 'Fatigue', detail: `${l2} played yesterday`, side: 1 });
  }

  // Recent retirement flag
  const p1Ret = hadRecentRetirement(p1Recent, p1key);
  const p2Ret = hadRecentRetirement(p2Recent, p2key);
  if (p1Ret) { p1Score -= 2; factors.push({ win: true, label: 'Retirement risk', detail: `${l1} retired in recent match`, side: 2 }); }
  if (p2Ret) { p2Score -= 2; factors.push({ win: true, label: 'Retirement risk', detail: `${l2} retired in recent match`, side: 1 }); }

  // Win/loss streak
  const str1 = calcWinStreak(p1Recent, p1key);
  const str2 = calcWinStreak(p2Recent, p2key);
  if (str1 >= 4)       { p1Score += 2; factors.push({ win: true, label: 'Hot streak', detail: `${l1} on ${str1}-match win streak`, side: 1 }); }
  else if (str1 >= 2)  { p1Score += 1; factors.push({ win: true, label: 'Winning form', detail: `${l1} won last ${str1}`, side: 1 }); }
  else if (str1 <= -3) { p1Score -= 1; factors.push({ win: true, label: 'Cold streak', detail: `${l1} lost last ${Math.abs(str1)}`, side: 2 }); }
  if (str2 >= 4)       { p2Score += 2; factors.push({ win: true, label: 'Hot streak', detail: `${l2} on ${str2}-match win streak`, side: 2 }); }
  else if (str2 >= 2)  { p2Score += 1; factors.push({ win: true, label: 'Winning form', detail: `${l2} won last ${str2}`, side: 2 }); }
  else if (str2 <= -3) { p2Score -= 1; factors.push({ win: true, label: 'Cold streak', detail: `${l2} lost last ${Math.abs(str2)}`, side: 1 }); }

  // Player volatility - known high-variance players score lower
  const vt1 = PLAYER_VOLATILITY[lastName(p1Name).toLowerCase()] || 0;
  const vt2 = PLAYER_VOLATILITY[lastName(p2Name).toLowerCase()] || 0;
  if (vt1 < 0) { p1Score += vt1; factors.push({ win: true, label: 'Volatility', detail: `${l1} known for inconsistency`, side: 2 }); }
  if (vt2 < 0) { p2Score += vt2; factors.push({ win: true, label: 'Volatility', detail: `${l2} known for inconsistency`, side: 1 }); }

  if (!factors.length) return '';

  // Round + tier + BO5 weighting
  const round = tennisRound(m);
  const tier  = tournamentTier(m);
  const bo5   = isBestOf5(m);
  const earlyRound = ['r1','r2'].includes(round);
  const lateRound  = ['quarter','semi','final'].includes(round);

  // BO5 Grand Slam bonus for the leading player
  if (bo5 && p1Score !== p2Score) {
    const winner = p1Score > p2Score ? 1 : 2;
    if (winner === 1) { p1Score += 1; factors.push({ win: true, label: 'Best of 5', detail: `BO5 amplifies ${l1}'s edge`, side: 1 }); }
    else              { p2Score += 1; factors.push({ win: true, label: 'Best of 5', detail: `BO5 amplifies ${l2}'s edge`, side: 2 }); }
  }

  let verdictHTML = '';
  if (p1Score > p2Score) {
    let pct = Math.round((p1Score / (p1Score + p2Score)) * 100);
    if (earlyRound || tier === '250') pct = Math.min(pct, 70);
    if (lateRound)  pct = Math.min(100, pct + (tier === 'slam' ? 6 : 3));
    const badge = bo5 ? ' <span class="gp-bo5-badge">BO5</span>' : '';
    const roundNote = earlyRound ? ' <span class="gp-round-note">(early rd)</span>' : lateRound ? ' <span class="gp-round-note">(late rd)</span>' : '';
    verdictHTML = `<div class="gp-pick-verdict"><span class="gp-pick-team">${esc(p1Name)}</span> likely to win <span class="gp-pick-count">(${pct}%${round !== 'unknown' ? ` · ${round.toUpperCase()}` : ''})</span>${badge}${roundNote}</div>`;
  } else if (p2Score > p1Score) {
    let pct = Math.round((p2Score / (p1Score + p2Score)) * 100);
    if (earlyRound || tier === '250') pct = Math.min(pct, 70);
    if (lateRound)  pct = Math.min(100, pct + (tier === 'slam' ? 6 : 3));
    const badge = bo5 ? ' <span class="gp-bo5-badge">BO5</span>' : '';
    const roundNote = earlyRound ? ' <span class="gp-round-note">(early rd)</span>' : lateRound ? ' <span class="gp-round-note">(late rd)</span>' : '';
    verdictHTML = `<div class="gp-pick-verdict"><span class="gp-pick-team">${esc(p2Name)}</span> likely to win <span class="gp-pick-count">(${pct}%${round !== 'unknown' ? ` · ${round.toUpperCase()}` : ''})</span>${badge}${roundNote}</div>`;
  } else {
    let leanName = null;
    if      (rd1 && rd2 && rd1.rank !== rd2.rank) leanName = rd1.rank < rd2.rank ? p1Name : p2Name;
    else if (aw1 !== aw2)                          leanName = aw1 > aw2 ? p1Name : p2Name;
    else if (fw1 >= 0 && fw2 >= 0 && fw1 !== fw2)  leanName = fw1 > fw2 ? p1Name : p2Name;
    const leanHTML = leanName ? ` <em class="gp-verdict-lean">(leaning towards ${esc(lastName(leanName))})</em>` : '';
    verdictHTML = `<div class="gp-pick-verdict gp-verdict-toss">Even matchup - too close to call${leanHTML}</div>`;
  }

  const pickSide = p1Score > p2Score ? 1 : p2Score > p1Score ? 2 : 0;
  const factorsHTML = factors.map(f => {
    const myFactor = f.side === pickSide;
    const isTie    = f.side === 0;
    const cls  = isTie ? 'gp-pf-tie' : myFactor ? 'gp-pf-win' : 'gp-pf-loss';
    const icon = isTie ? '~' : myFactor ? '✓' : '✗';
    return `<div class="gp-pfactor ${cls}">
      <span class="gp-pf-icon">${icon}</span>
      <span class="gp-pf-label">${f.label}</span>
      <span class="gp-pf-detail">${f.detail}</span>
    </div>`;
  }).join('');

  return `<div class="td-section td-section-pred">
    <div class="td-section-hdr">📌 Match Prediction</div>
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
  const serve    = String(m.event_serve ?? '');

  row.className = `match-row ${live?'live':''} ${finished?'finished':''}`;

  // Status
  const statusEl = row.querySelector('.match-status');
  if (statusEl) {
    statusEl.innerHTML = live
      ? `<span class="status live-status">● LIVE</span>`
      : finished
      ? `<span class="status fin-status">FIN</span>`
      : `<span class="status time-status">${esc(fmtTennisTime(m.event_date, m.event_time))}</span>`;
  }

  // Sets
  const p1Won = finished && m.event_winner === 'First Player';
  const p2Won = finished && m.event_winner === 'Second Player';
  const setsArea = row.querySelector('.sets-area');
  if (setsArea) {
    setsArea.innerHTML = sets.map((s, i) => {
      const cur = live && i === sets.length - 1;
      if (finished && (p1Won || p2Won)) {
        const p1SetWon = parseInt(s.p1) > parseInt(s.p2);
        const p2SetWon = parseInt(s.p2) > parseInt(s.p1);
        return `<span class="set-score">` +
          `<span class="${p1Won && p1SetWon ? 'set-win' : 'set-lose'}">${esc(s.p1)}</span><br>` +
          `<span class="${p2Won && p2SetWon ? 'set-win' : 'set-lose'}">${esc(s.p2)}</span>` +
          `</span>`;
      }
      return `<span class="set-score ${cur?'current-set':''}">${esc(s.p1)}<br>${esc(s.p2)}</span>`;
    }).join('');
  }

  // Winner/loser player classes
  const p1El = row.querySelector('.player.p1');
  const p2El = row.querySelector('.player.p2');
  if (p1El) { p1El.classList.toggle('match-winner', p1Won); p1El.classList.toggle('match-loser', p2Won); }
  if (p2El) { p2El.classList.toggle('match-winner', p2Won); p2El.classList.toggle('match-loser', p1Won); }

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
    dot.textContent = '●';
    el.prepend(dot);  // show before the player name
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
       <span class="date-value">${fmtDateShort(dateStrLocal(off))}</span>
     </button>`).join('');
}

function pickDate(offset) {
  S.dateOffset = offset;
  S.matches.clear();
  renderDateBar();
  if (S.sport === 'tennis' && S.view === 'picks') {
    loadTennisPicksPage();
  } else {
    loadFixtures(offset);
  }
}

// ── SPORT / VIEW SWITCHING ───────────────────────────────────
function stopScoresTimer() {
  if (S.scoresTimer) { clearInterval(S.scoresTimer); S.scoresTimer = null; }
}

function loadSportScores(sport) {
  if (sport === 'soccer')       loadSoccerScores();
  else if (sport === 'golf')    loadGolfLeaderboard();
  else if (sport === 'tickets') renderTicketsPage();
  else loadOtherScores(sport);
}

function startScoresTimer(sport) {
  stopScoresTimer();
  S.scoresTimer = setInterval(() => {
    if (S.sport === sport && S.view === 'scores') loadSportScores(sport);
  }, 30000);
}

function switchSport(sport) {
  _loadSeq++;           // invalidate any in-flight loads from the previous sport
  S.sport = sport;
  S.otherDateOffset = 0;
  try { localStorage.setItem('_baseline_sport', sport); } catch {}
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
    picksTab.style.display    = '';
    picksTab.textContent = '⛳ Picks';
  } else if (sport === 'tickets') {
    secTab.style.display    = 'none';
    playersTab.style.display = 'none';
    lineupsTab.style.display = 'none';
    picksTab.style.display   = 'none';
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
    preloadRankIndex();    // fire-and-forget: fills S.rankIndex and re-runs picks once ready
    loadTennisInjuryNews(); // fire-and-forget: ESPN news injury flags - re-runs picks once loaded
  } else {
    wsDisconnect();
    if (sport === 'tickets') {
      setConn('connected', 'Tickets ready');
    } else {
      setConn('disconnected', `${sport.toUpperCase()} - updating every 30s`);
    }
    loadSportScores(sport);
  }
}

function switchView(view) {
  // Gate picks tab — free/unauthenticated users see upgrade modal, stay on current view
  if (view === 'picks' && !_hasFullAccess()) {
    openUpgradeModal();
    return;
  }
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
      const panelId = S.sport === 'golf'    ? 'view-golf-leaderboard'
                    : S.sport === 'tickets' ? 'view-tickets'
                    : 'view-other-scores';
      document.getElementById(panelId).classList.add('active');
      loadSportScores(S.sport);
      if (S.sport !== 'tickets') startScoresTimer(S.sport);
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
      else if (S.sport === 'golf') loadGolfPicksPage();
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
  const seq = _loadSeq;
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
    if (_loadSeq !== seq) return;
    renderOtherScores(games, sport, src);
    const t = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone: getUserTZ() });
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
  const isBasketball = ['nba','wnba'].includes(sport);
  return (json.events || []).map(ev => {
    const comp = ev.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === 'home') || comp.competitors[0];
    const away = comp.competitors.find(c => c.homeAway === 'away') || comp.competitors[1];
    const st   = comp.status || ev.status || {};
    const state = st.type?.state || '';
    const teamLeaders = (teamId) => {
      if (!isBasketball) return [];
      return (comp.leaders || []).map(cat => {
        const best = (cat.leaders || []).find(l => l.team?.id === String(teamId));
        if (!best || !best.athlete?.displayName) return null;
        return {
          stat:      cat.name,
          label:     cat.shortDisplayName || cat.displayName || cat.name,
          value:     best.displayValue || '',
          name:      best.athlete.displayName,
          shortName: best.athlete.shortName || best.athlete.displayName,
          id:        best.athlete.id || '',
          pos:       best.athlete.position?.abbreviation || ''
        };
      }).filter(Boolean);
    };
    return {
      id: ev.id,
      league: sport.toUpperCase(),
      homeTeam: home?.team?.shortDisplayName || home?.team?.name || '-',
      awayTeam: away?.team?.shortDisplayName || away?.team?.name || '-',
      homeAbbr: home?.team?.abbreviation || '',
      awayAbbr: away?.team?.abbreviation || '',
      homeRec:  ((home?.records || home?.record || []).find(r => r.type === 'total') || (home?.records || home?.record || [])[0])?.summary || '',
      awayRec:  ((away?.records || away?.record || []).find(r => r.type === 'total') || (away?.records || away?.record || [])[0])?.summary || '',
      homeRecs: (() => { const rr = home?.records || home?.record || []; return { total: (rr.find(r=>r.type==='total')||rr[0])?.summary||'', home: rr.find(r=>r.type==='home')?.summary||'', road: rr.find(r=>r.type==='road')?.summary||'', l10: rr.find(r=>r.name==='L10'||r.name==='Last 10')?.summary||'' }; })(),
      awayRecs: (() => { const rr = away?.records || away?.record || []; return { total: (rr.find(r=>r.type==='total')||rr[0])?.summary||'', home: rr.find(r=>r.type==='home')?.summary||'', road: rr.find(r=>r.type==='road')?.summary||'', l10: rr.find(r=>r.name==='L10'||r.name==='Last 10')?.summary||'' }; })(),
      gameDate: ev.date || '',
      series: comp.series ? { summary: comp.series.summary || '', title: comp.series.title || '' } : null,
      homeScore: state !== 'pre' ? (home?.score ?? '') : '',
      awayScore: state !== 'pre' ? (away?.score ?? '') : '',
      status: st.type?.shortDetail || st.type?.description || '-',
      period: st.period || '',
      time: st.displayClock || '',
      sport,
      homeId: home?.team?.id || '',
      awayId: away?.team?.id || '',
      odds: (() => { const o = comp.odds?.[0]; return o ? { spread: o.details || '', overUnder: o.overUnder || null } : null; })(),
      homeLeaders: teamLeaders(home?.team?.id),
      awayLeaders: teamLeaders(away?.team?.id)
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

// Returns HTML for the best pick for an MLB game row - player prop if available, else game winner if confident.
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

// Records pick + immediately resolves if game is finished. Pre-game only - never mid-game.
// dateOverride: pass dateStrLocal(1) when pre-loading tomorrow's games so picks get the right date.
function autoRecordAndResolvePick(g, dateOverride = null) {
  if (!g.awayRec && !g.homeRec) return;
  const { fin, live } = gameRowState(g);
  if (!live && !fin) {
    const sc   = parseSeriesContext(g.series);
    // Playoffs: home court worth more (crowd, refs, routines) - bump by extra 2%
    const playoffMult = sc.isPlayoff ? 1.02 : 1.0;
    const boost    = (HOME_BOOST[g.sport] || 1.025) * playoffMult;
    const momentum = seriesMomentumAdj(sc, g.homeTeam, g.homeAbbr, g.awayTeam, g.awayAbbr);
    const homeRM   = restMult(getDaysRest(g.homeAbbr, g.sport));
    const awayRM   = restMult(getDaysRest(g.awayAbbr, g.sport));
    const homeWPr  = smartWP(g.homeRecs || { total: g.homeRec }, true,  g.sport) * momentum.home * homeRM;
    const awayWPr  = smartWP(g.awayRecs || { total: g.awayRec }, false, g.sport) * momentum.away * awayRM;
    const rawHome  = homeWPr * boost;
    const total    = awayWPr + rawHome;
    let homeFrac   = rawHome / total;

    // Blend with Vegas spread (50/50) - most predictive single signal available
    const spreadData = parseOddsSpread(g);
    if (spreadData) {
      const spreadHomeFrac = spreadData.isHomeFavored ? spreadData.spreadWP : 1 - spreadData.spreadWP;
      homeFrac = 0.5 * homeFrac + 0.5 * spreadHomeFrac;
    }

    // Apply injury penalty - teams with confirmed Out players lose win probability
    const sp = g.sport || '';
    const homePenalty = _injuryPenalty.get(`${sp}:${(g.homeAbbr||'').toUpperCase()}`) || 0;
    const awayPenalty = _injuryPenalty.get(`${sp}:${(g.awayAbbr||'').toUpperCase()}`) || 0;
    if (homePenalty || awayPenalty) {
      homeFrac = Math.max(0.10, Math.min(0.90, homeFrac - homePenalty + awayPenalty));
    }

    // NHL special teams + goalie adjustment
    if (sp === 'nhl') {
      const hSt = _nhlTeamStats.get(String(g.homeId || ''));
      const aSt = _nhlTeamStats.get(String(g.awayId || ''));
      if (hSt && aSt) {
        const svAdj = (hSt.svPct - aSt.svPct) * 2.5;           // .01 SV% gap -> 2.5% WP
        const ppAdj = (hSt.ppPct - aSt.ppPct) * 0.0012;        // 10 pp% gap -> 1.2% WP
        const pkAdj = (hSt.pkPct - aSt.pkPct) * 0.0012;
        homeFrac = Math.max(0.10, Math.min(0.90, homeFrac + svAdj + ppAdj + pkAdj));
      }
    }

    const homePct  = Math.round(homeFrac * 100);
    const short    = (homePct >= 50 ? g.homeTeam : g.awayTeam).split(' ').pop();
    const conf     = wpToConf(homePct >= 50 ? homeFrac : 1 - homeFrac);
    recordPick(String(g.id), short, `${g.awayTeam} @ ${g.homeTeam}`, g.sport || '', conf, false, dateOverride);
  }
  if (fin && g.awayScore !== '' && g.homeScore !== '') {
    const aS = parseFloat(g.awayScore) || 0, hS = parseFloat(g.homeScore) || 0;
    if (aS !== hS) resolvePick(String(g.id), aS > hS ? g.awayTeam.split(' ').pop() : g.homeTeam.split(' ').pop());
  }
}

function inlineGamePick(g) {
  if (!g.awayRec && !g.homeRec) return '';
  const { fin, live } = gameRowState(g);
  const stored = getPicks()[String(g.id)];

  // Finished game - show W/L result against the stored pre-game pick
  if (fin) {
    if (!stored || stored.result === null) return '';
    return stored.result === 'win'
      ? `<span class="game-pick-inline pick-win" title="Pick correct">✓ ${esc(stored.team)}</span>`
      : `<span class="game-pick-inline pick-loss" title="Pick wrong">✗ ${esc(stored.team)}</span>`;
  }

  // Live game - freeze the pre-game pick, never recalculate mid-game
  if (live) {
    if (!stored) return '';
    return `<span class="game-pick-inline pick-locked" title="Pre-game pick (locked)">→ ${esc(stored.team)}</span>`;
  }

  // Pre-game - show smart win probability (with playoff context + rest/B2B)
  const sc       = parseSeriesContext(g.series);
  const playoffMult = sc.isPlayoff ? 1.02 : 1.0;
  const boost    = (HOME_BOOST[g.sport] || 1.025) * playoffMult;
  const momentum = seriesMomentumAdj(sc, g.homeTeam, g.homeAbbr, g.awayTeam, g.awayAbbr);
  const awayDR   = getDaysRest(g.awayAbbr, g.sport);
  const homeDR   = getDaysRest(g.homeAbbr, g.sport);
  const homeWPr  = smartWP(g.homeRecs || { total: g.homeRec }, true,  g.sport) * momentum.home * restMult(homeDR);
  const awayWPr  = smartWP(g.awayRecs || { total: g.awayRec }, false, g.sport) * momentum.away * restMult(awayDR);
  const rawHome  = homeWPr * boost;
  const total    = awayWPr + rawHome;
  const homeFrac = rawHome / total;
  const homePct  = Math.round(homeFrac * 100);
  const margin   = Math.abs(homePct - 50);
  const favTeam  = homePct >= 50 ? g.homeTeam : g.awayTeam;
  const pct      = Math.max(homePct, 100 - homePct);
  const short    = favTeam.split(' ').pop();
  const hasL10   = g.homeRecs?.l10 || g.awayRecs?.l10;
  const seriesTip = sc.isPlayoff && sc.gameNum ? ` · Game ${sc.gameNum}${sc.leader ? ` (${sc.leader} leads)` : ' (tied)'}` : '';
  const b2bNote  = awayDR === 1 ? ` · B2B: ${g.awayAbbr || g.awayTeam.split(' ').pop()}` :
                   homeDR === 1 ? ` · B2B: ${g.homeAbbr || g.homeTeam.split(' ').pop()}` : '';
  const tip      = (hasL10 ? `L10: ${g.homeRecs?.l10||'?'} / ${g.awayRecs?.l10||'?'}` : `${g.awayRec||'?'} vs ${g.homeRec||'?'}`) + seriesTip + b2bNote;
  if (margin < 3) return '';
  return `<span class="game-pick-inline" title="${esc(tip)}">→ ${esc(short)} ${pct}%</span>`;
}

function buildOtherRow(g) {
  const { live, fin, periodLabel } = gameRowState(g);
  autoRecordAndResolvePick(g); // record pick for all games and resolve if finished
  const pick     = inlineGamePick(g);
  const potdHTML = g.league === 'MLB' ? getGameBestPickHTML(String(g.id), g) : '';
  return `
    <div class="other-match-row ${live?'live':''}" id="og-${esc(g.id)}" onclick="toggleGamePreview('${esc(g.id)}')">
      <div class="other-status" id="og-st-${esc(g.id)}">
        ${live ? '<span class="live-badge">LIVE</span>' : fin ? '<span class="fin-badge">FIN</span>' : `<span style="font-size:.78rem;color:var(--text-muted)">${esc(g.gameDate ? fmtTimeTZ(g.gameDate) : g.status)}</span>`}
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
                     : `<span style="font-size:.78rem;color:var(--text-muted)">${esc(g.gameDate ? fmtTimeTZ(g.gameDate) : g.status)}</span>`;
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

// Per-sport home field advantage multipliers (playoffs boost applied separately)
const HOME_BOOST = { nba:1.035, wnba:1.025, mlb:1.015, nfl:1.025, nhl:1.020, soccer:1.030 };

// Parse ESPN series summary into structured playoff context
function parseSeriesContext(series) {
  if (!series?.summary) return { isPlayoff: false };
  const s = series.summary;
  const tiedM = s.match(/Series tied (\d+)-(\d+)/i);
  const leadM  = s.match(/(.+?)\s+leads\s+series\s+(\d+)-(\d+)/i);
  if (tiedM) {
    const each = parseInt(tiedM[1]);
    return { isPlayoff: true, gameNum: each * 2 + 1, tied: true, leader: null };
  }
  if (leadM) {
    const w = parseInt(leadM[2]), l = parseInt(leadM[3]);
    return { isPlayoff: true, gameNum: w + l + 1, leader: leadM[1].trim(), wins: w, losses: l, tied: false };
  }
  return { isPlayoff: true, gameNum: null, leader: null };
}

// Determine which team leads the series and return their edge multiplier.
// Tiered by series lead — a 3-1 lead is much more decisive than 1-0.
// Trailing team gets a small desperation boost in elimination games.
function seriesMomentumAdj(sc, homeTeam, homeAbbr, awayTeam, awayAbbr) {
  if (!sc.isPlayoff) return { home: 1.0, away: 1.0 };
  if (!sc.leader || sc.tied) return { home: 1.0, away: 1.0 };

  const ll = sc.leader.toLowerCase();
  const homeMatch = homeTeam.toLowerCase().split(' ').some(w => ll.includes(w)) ||
                    homeAbbr.toLowerCase() === ll;

  const w = sc.wins || 1, l = sc.losses || 0;

  // Leader's edge grows with series lead; capped because individual games are noisy
  let leaderEdge =
    (w === 3 && l === 0) ? 1.028 :  // 3-0: near-certain series win; leader plays loose
    (w === 3 && l === 1) ? 1.025 :  // 3-1: closing out; strong but not automatic
    (w === 3 && l === 2) ? 1.018 :  // 3-2: slight edge, both teams have proven themselves
    (w === 2 && l === 0) ? 1.020 :  // 2-0: solid momentum
    (w === 2 && l === 1) ? 1.012 :  // 2-1: modest edge
                           1.010;   // 1-0 or any other lead

  // Elimination game: trailing team plays more desperate; reduce leader's edge ~1%
  // (they've had all week to prepare and have nothing to lose)
  if (w === 3) leaderEdge = Math.max(1.010, leaderEdge - 0.010);

  return homeMatch
    ? { home: leaderEdge, away: 1.0 }
    : { home: 1.0, away: leaderEdge };
}

// Smarter win probability: blends season record, home/road split, and L10 recent form
function smartWP(recs, isHome, sport) {
  const seasonWP = parseWinPct(recs?.total);
  if (!seasonWP && seasonWP !== 0) return 0.5;
  const splitRec = isHome ? recs?.home : recs?.road;
  const splitWP  = parseWinPct(splitRec) || seasonWP;
  const l10WP    = recs?.l10 ? parseWinPct(recs.l10) : null;
  // Weights: L10 most predictive, then split, then season
  if (l10WP !== null && recs?.l10) return 0.35 * seasonWP + 0.35 * splitWP + 0.30 * l10WP;
  return 0.50 * seasonWP + 0.50 * splitWP;
}

// Confidence level based on blended win probability margin
function wpToConf(winPct) {
  const margin = Math.abs(winPct - 0.5);
  if (margin >= 0.18) return 2;  // 68%+ win probability
  if (margin >= 0.10) return 1;  // 60%+ win probability
  return 0;                       // < 60% - too close to call, excluded from ticket
}

// Rest-days win-probability multiplier. daysRest=1 means B2B (played yesterday).
function restMult(daysRest) {
  if (daysRest === null || daysRest >= 3) return 1.0;
  if (daysRest === 1) return 0.94;  // B2B: 6% penalty
  return 0.97;                       // 1-day rest: 3% penalty
}

function getDaysRest(abbr, sport) {
  if (!abbr || !sport) return null;
  const v = _restDaysCache.get(`${sport}:${abbr.toUpperCase()}`);
  return v !== undefined ? v : null;
}

// Fetch yesterday/2-days-ago scoreboards for NBA/WNBA/NHL and populate _restDaysCache.
async function populateRestDaysCache() {
  const sports = [
    { key: 'nba',  path: 'basketball/nba'  },
    { key: 'wnba', path: 'basketball/wnba' },
    { key: 'nhl',  path: 'hockey/nhl'      },
  ];
  const today = dateStrLocal(0);
  const fmt8 = (offset) => {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  };
  for (const sp of sports) {
    for (let off = -1; off >= -3; off--) {
      try {
        const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sp.path}/scoreboard?dates=${fmt8(off)}`);
        const j   = await res.json();
        const daysRest = -off; // off=-1 → daysRest=1 (B2B today), off=-2 → daysRest=2, etc.
        for (const ev of (j.events || [])) {
          const comp = ev.competitions?.[0];
          if (!comp?.status?.type?.completed) continue;
          for (const c of (comp.competitors || [])) {
            const abbr = c.team?.abbreviation?.toUpperCase();
            if (!abbr) continue;
            const key = `${sp.key}:${abbr}`;
            if (!_restDaysCache.has(key)) _restDaysCache.set(key, daysRest);
          }
        }
      } catch (e) {}
    }
  }
}

// Parse ESPN odds spread string (e.g. "OKC -6.5") into { isHomeFavored, spreadWP }.
// Returns null if spread is missing, too small, or team can't be identified.
function parseOddsSpread(g) {
  const s = String(g.odds?.spread || '').trim();
  if (!s) return null;
  const m = s.match(/^([A-Z]{2,5})\s+([-+]?\d+\.?\d*)$/i);
  if (!m) return null;
  const tag = m[1].toUpperCase();
  const pts = parseFloat(m[2]);
  if (isNaN(pts) || Math.abs(pts) < 1) return null;
  const homeAbbr  = (g.homeAbbr || '').toUpperCase();
  const awayAbbr  = (g.awayAbbr || '').toUpperCase();
  const homeWords = (g.homeTeam || '').toUpperCase().split(/\s+/);
  const awayWords = (g.awayTeam || '').toUpperCase().split(/\s+/);
  const isHome = tag === homeAbbr || homeWords.includes(tag);
  const isAway = !isHome && (tag === awayAbbr || awayWords.includes(tag));
  if (!isHome && !isAway) return null;
  // Negative spread → that team is the favorite
  const isHomeFavored = isHome ? pts < 0 : pts > 0;
  // 3 pts ≈ 60%, 6 pts ≈ 65%, 10 pts ≈ 72%, 14 pts ≈ 78%
  const spreadWP = Math.min(0.80, 0.5 + Math.abs(pts) * 0.022);
  return { isHomeFavored, spreadWP };
}

// Fetch ESPN injury report for NBA or WNBA and populate _injuryPenalty cache.
// Only "Out" and "Doubtful" statuses earn a penalty (Questionable/DTD are uncertain).
async function fetchInjuryPenalties(sport) {
  const paths = { nba: 'basketball/nba', wnba: 'basketball/wnba' };
  const path = paths[sport];
  if (!path) return;
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/injuries`);
    const j   = await res.json();
    for (const team of (j.injuries || [])) {
      const abbr = (team.abbreviation || '').toUpperCase();
      if (!abbr) continue;
      let penalty = 0;
      for (const inj of (team.injuries || [])) {
        const st = (inj.status || '').toLowerCase();
        if (st === 'out')           penalty += 0.05;
        else if (st === 'doubtful') penalty += 0.025;
      }
      if (penalty > 0) _injuryPenalty.set(`${sport}:${abbr}`, Math.min(0.18, penalty));
    }
  } catch {}
}

// Fetch NHL team PP%/PK%/SV% from ESPN core API. Uses playoff type if after April, else regular season.
async function fetchNHLTeamStats(teamId) {
  if (!teamId) return;
  const key = String(teamId);
  if (_nhlTeamStats.has(key)) return;
  try {
    const now  = new Date();
    const year = now.getMonth() >= 8 ? now.getFullYear() + 1 : now.getFullYear();
    const type = now.getMonth() >= 3 && now.getMonth() <= 6 ? 3 : 2; // Apr-Jul = playoffs
    const url  = `https://sports.core.api.espn.com/v2/sports/hockey/leagues/nhl/seasons/${year}/types/${type}/teams/${key}/statistics`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j    = await res.json();
    const cats = j.splits?.categories || [];
    const findStat = name => {
      for (const cat of cats) {
        const s = (cat.stats || []).find(st =>
          (st.name || '').toLowerCase().includes(name) ||
          (st.displayName || '').toLowerCase().includes(name)
        );
        if (s != null) return parseFloat(s.displayValue ?? s.value ?? '') || null;
      }
      return null;
    };
    const ppPct = findStat('powerplaypct') ?? findStat('powerplay');
    const pkPct = findStat('penaltykillpct') ?? findStat('penaltykill');
    const svPct = findStat('savepct') ?? findStat('save');
    if (ppPct !== null || pkPct !== null || svPct !== null) {
      _nhlTeamStats.set(key, {
        ppPct: ppPct ?? 20,
        pkPct: pkPct ?? 80,
        svPct: svPct != null && svPct > 1 ? svPct / 100 : (svPct ?? 0.905),
      });
    }
  } catch {}
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
    sport = '', weather = null, weatherFmt = 'espn',
    awayLastStartERA = null, homeLastStartERA = null,
    awayRestDays = null, homeRestDays = null
  } = opts || {};

  const aShort = awayAbbr || awayName.split(' ').pop();
  const hShort = homeAbbr || homeName.split(' ').pop();

  const seriesHTML = seriesSummary
    ? `<div class="gp-series-badge">🏆 ${seriesTitle ? `<span class="gp-series-title">${esc(seriesTitle)}</span> · ` : ''}${esc(seriesSummary)}</div>`
    : '';

  const hasData = awayRec || homeRec || awayERA !== null || seriesSummary || awayForm;
  if (!hasData) return { html: seriesHTML, team: '', conf: 1 };

  const factors = []; // { label, detail, winner: 'away'|'home'|'tie' }
  let aScore = 0, hScore = 0;

  // 1. Season record (30%)
  const aWP = parseWinPct(awayRec), hWP = parseWinPct(homeRec);
  if (awayRec || homeRec) {
    aScore += aWP * 0.30; hScore += hWP * 0.30;
    const w = aWP > hWP + 0.02 ? 'away' : hWP > aWP + 0.02 ? 'home' : 'tie';
    factors.push({ label: 'Record', detail: `${esc(aShort)} ${awayRec||'-'} · ${esc(hShort)} ${homeRec||'-'}`, winner: w });
  } else { aScore += 0.15; hScore += 0.15; }

  // 2. Home advantage (4% regular season, 6% playoffs - crowd + routine + refs)
  const _sc = parseSeriesContext({ summary: seriesSummary });
  const homeCourtBoost = _sc.isPlayoff ? 0.06 : 0.04;
  hScore += homeCourtBoost;
  factors.push({ label: _sc.isPlayoff ? 'Home court (playoffs)' : 'Home court', detail: `${esc(hShort)} at home`, winner: 'home' });

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

  // 5. Playoff series momentum + game number context
  if (seriesSummary) {
    const gameNumLabel = _sc.gameNum ? ` · Game ${_sc.gameNum}` : '';
    const sm = seriesSummary.match(/^(\S+)\s+leads/i);
    if (sm) {
      const leader = sm[1].toUpperCase();
      const matchAway = leader === awayAbbr.toUpperCase() ||
                        awayName.toUpperCase().split(' ').some(w => w.startsWith(leader));
      if (matchAway) aScore += 0.18; else hScore += 0.18;
      factors.push({ label: `Series${gameNumLabel}`, detail: esc(seriesSummary), winner: matchAway ? 'away' : 'home' });
    } else {
      factors.push({ label: `Series${gameNumLabel}`, detail: esc(seriesSummary), winner: 'tie' });
    }
  }

  // 6. MLB pitcher ERA - starting pitcher is the single biggest game-by-game factor
  if (awayERA !== null && homeERA !== null) {
    const ae = parseFloat(awayERA), he = parseFloat(homeERA);
    if (ae > 0 && he > 0) {
      aScore += Math.max(0, 5.5 - ae) * 0.05;
      hScore += Math.max(0, 5.5 - he) * 0.05;
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

  // 8. Pitcher last start quality (MLB)
  if (sport === 'mlb' && (awayLastStartERA !== null || homeLastStartERA !== null)) {
    const ase = parseFloat(awayERA || 4.20), hse = parseFloat(homeERA || 4.20);
    if (awayLastStartERA !== null) { const d = awayLastStartERA - ase; if (d < -1.5) aScore += 0.05; else if (d > 2.5) aScore -= 0.05; }
    if (homeLastStartERA !== null) { const d = homeLastStartERA - hse; if (d < -1.5) hScore += 0.05; else if (d > 2.5) hScore -= 0.05; }
    if (awayLastStartERA !== null && homeLastStartERA !== null && Math.abs(awayLastStartERA - homeLastStartERA) >= 2.0) {
      factors.push({ label: 'Last start', detail: `${esc(aShort)} ${awayLastStartERA.toFixed(2)} · ${esc(hShort)} ${homeLastStartERA.toFixed(2)}`, winner: awayLastStartERA < homeLastStartERA ? 'away' : 'home' });
    }
  }

  // 9. Pitcher rest days (MLB)
  if (sport === 'mlb' && (awayRestDays !== null || homeRestDays !== null)) {
    const ar = awayRestDays, hr = homeRestDays;
    if (ar !== null && ar >= 6) aScore += 0.02;
    if (hr !== null && hr >= 6) hScore += 0.02;
    const awayBonus = ar !== null && ar >= 6, homeBonus = hr !== null && hr >= 6;
    if (awayBonus !== homeBonus) {
      const who = awayBonus ? aShort : hShort;
      const days = awayBonus ? ar : hr;
      factors.push({ label: 'Extra rest', detail: `${esc(who)} ${days}d rest`, winner: awayBonus ? 'away' : 'home' });
    }
  }

  // 10. Team rest / back-to-back penalty (NBA, WNBA, NHL)
  if (sport !== 'mlb' && sport !== 'nfl' && (awayRestDays !== null || homeRestDays !== null)) {
    const ar = awayRestDays, hr = homeRestDays;
    const aB2B = ar !== null && ar <= 1;
    const hB2B = hr !== null && hr <= 1;
    if (aB2B || hB2B) {
      if (aB2B) aScore -= 0.06;
      if (hB2B) hScore -= 0.06;
      let detail = '';
      if (aB2B && hB2B) {
        detail = `Both on B2B`;
      } else if (aB2B) {
        detail = `${esc(aShort)} B2B${hr !== null && hr >= 2 ? ` · ${esc(hShort)} ${hr}d rest` : ''}`;
      } else {
        detail = `${esc(hShort)} B2B${ar !== null && ar >= 2 ? ` · ${esc(aShort)} ${ar}d rest` : ''}`;
      }
      const winner = aB2B && !hB2B ? 'home' : !aB2B && hB2B ? 'away' : 'tie';
      factors.push({ label: 'Rest/B2B', detail, winner });
    }
  }

  // ── Verdict ──
  const gap = Math.abs(aScore - hScore);
  const pickIsHome = hScore > aScore;
  const pickTeam = pickIsHome ? hShort : aShort;
  const fWins = factors.filter(f => pickIsHome ? f.winner === 'home' : f.winner === 'away').length;
  const fTotal = factors.filter(f => f.winner !== 'tie').length;

  const verdictHTML = gap < 0.025
    ? `<div class="gp-pick-verdict gp-verdict-toss">🎲 Toss-up - too close to call <em class="gp-verdict-lean">(leaning towards ${esc(pickTeam)})</em></div>`
    : `<div class="gp-pick-verdict">📌 ${gap > 0.14 ? 'Strong lean' : gap > 0.08 ? 'Lean' : 'Slight lean'}: <span class="gp-pick-team">${esc(pickTeam)}</span>${fTotal > 0 ? ` <span class="gp-pick-count">${fWins}/${fTotal} factors</span>` : ''}</div>`;

  const factorsHTML = factors.map(f => {
    const myWin = pickIsHome ? f.winner === 'home' : f.winner === 'away';
    const isTie = f.winner === 'tie';
    let cls  = isTie ? 'gp-pf-tie' : myWin ? 'gp-pf-win' : 'gp-pf-loss';
    if (f.label === 'Weather') cls += f.extreme ? ' gp-pf-weather-warn' : ' gp-pf-weather';
    const icon = isTie ? '~' : myWin ? '✓' : '✗';
    return `<div class="gp-pfactor ${cls}"><span class="gp-pf-icon">${icon}</span><span class="gp-pf-label">${esc(f.label)}</span><span class="gp-pf-detail">${f.detail}</span></div>`;
  }).join('');

  const pickedConf = gap < 0.025 ? 0 : gap > 0.14 ? 3 : gap > 0.08 ? 2 : 1;
  return {
    html: `${seriesHTML}<div class="gp-pick-box">${verdictHTML}<div class="gp-pick-factors">${factorsHTML}</div></div>`,
    team: pickTeam,
    conf: pickedConf,
  };
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

// ── MLB PICKS PAGE - REAL MATCHUP ENGINE ─────────────────────

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
// Run-scoring environment factor (affects both teams; >1 = more runs expected)
const PARK_RUN = { COL:1.20, CIN:1.12, BOS:1.08, PHI:1.07, CHC:1.06, TEX:1.05, MIL:1.04, NYY:1.03, ATL:1.01, HOU:1.01, DET:1.00, TOR:0.99, LAD:0.97, LAA:0.96, PIT:0.96, MIN:0.95, CLE:0.95, BAL:0.93, SEA:0.93, WSH:0.93, CWS:0.91, KC:0.90, OAK:0.92, MIA:0.91, NYM:0.93, TB:0.94, SF:0.89, SD:0.88 };
const PARK_NAMES = { COL:'Coors Field', BOS:'Fenway', CIN:'GABP', CHC:'Wrigley', SF:'Oracle', SD:'Petco', MIA:'LoanDepot', SEA:'T-Mobile' };

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
    favLine = margin >= 3
      ? `<span class="pc-fav">${esc(favTeam.split(' ').pop())} favored ${pct}%</span>`
      : `<span class="pc-fav pc-fav-even">Even matchup</span>`;
  }

  const statusLabel = fin  ? '<span class="fin-badge">FIN</span>'
                    : live ? '<span class="live-badge">LIVE</span>'
                    : `<span class="pc-time">${esc(espnGame.gameDate ? fmtTimeTZ(espnGame.gameDate) : espnGame.status)}</span>`;

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
  const awayMLBId = String(away.team?.id || '');
  const homeMLBId = String(home.team?.id || '');
  const awayPitcherId = away.probablePitcher?.id;
  const homePitcherId = home.probablePitcher?.id;
  const awayPName = away.probablePitcher?.fullName || 'TBD';
  const homePName = home.probablePitcher?.fullName || 'TBD';
  const weather   = mlbGame.weather || null;
  const wind      = _windHRBonus(weather);

  // L10 momentum + streak
  const standings = _mlbStandingsCache || new Map();
  const awayStand = standings.get(awayMLBId);
  const homeStand = standings.get(homeMLBId);
  const awayMom = awayStand ? awayStand.l10w / 10 : 0.5;
  const homeMom = homeStand ? homeStand.l10w / 10 : 0.5;

  // Team pitching ERA (proxy for bullpen quality)
  const awayTeamPitch = _teamPitchingCache.get(awayMLBId);
  const homeTeamPitch = _teamPitchingCache.get(homeMLBId);
  const awayTeamERA = parseFloat(awayTeamPitch?.era || 0);
  const homeTeamERA = parseFloat(homeTeamPitch?.era || 0);

  // Pitcher stats (already pre-fetched)
  const awayPD = awayPitcherId ? _pitcherCache.get(awayPitcherId) : null;
  const homePD = homePitcherId ? _pitcherCache.get(homePitcherId) : null;
  const awayHand = awayPD?.pitchHand || null;
  const homeHand = homePD?.pitchHand || null;

  // Pitcher rate stats - adjusted for recent form + bullpen drag + last start + rest
  const LEAGUE_ERA = 4.20;
  const mlbCalOffset = getConfCalibration('mlb');
  const _pRates = (pd, teamERA) => {
    const s  = pd?.season;
    const ip = parseFloat(s?.inningsPitched || 0);
    let hr9 = ip > 5 ? (parseInt(s?.homeRuns||0)    / ip) * 9 : 1.2;
    let bb9 = ip > 5 ? (parseInt(s?.baseOnBalls||0) / ip) * 9 : 3.0;
    let k9  = ip > 5 ? (parseInt(s?.strikeOuts||0)  / ip) * 9 : 8.5;
    // Recent form adjustment
    if (pd?.eraTrend === 'cold') { hr9 *= 1.20; bb9 *= 1.12; k9  *= 0.88; }
    if (pd?.eraTrend === 'hot')  { hr9 *= 0.85; bb9 *= 0.92; k9  *= 1.10; }
    // Bullpen drag: if team ERA >> starter ERA, back-end of the staff inflates run risk
    if (teamERA > 0) {
      const pitERA = parseFloat(s?.era || LEAGUE_ERA);
      const drag = teamERA - pitERA;
      if (drag > 1.5) { hr9 *= 1.10; bb9 *= 1.07; k9 *= 0.95; }
      else if (drag > 0.5) { hr9 *= 1.05; bb9 *= 1.03; k9 *= 0.98; }
    }
    // Last start quality
    if (pd?.lastStartERA != null) {
      const seasonERA = parseFloat(s?.era || LEAGUE_ERA);
      const lsDiff = pd.lastStartERA - seasonERA;
      if (lsDiff > 3.0)  { hr9 *= 1.08; bb9 *= 1.06; }
      else if (lsDiff < -2.0) { hr9 *= 0.94; k9  *= 1.05; }
    }
    // Extra rest bonus (6+ days)
    if (pd?.restDays != null && pd.restDays >= 6) { hr9 *= 0.97; k9 *= 1.03; }
    return { hr9, bb9, k9 };
  };
  const awayRates = _pRates(awayPD, awayTeamERA);   // home batters face away pitcher
  const homeRates = _pRates(homePD, homeTeamERA);   // away batters face home pitcher
  const parkHR    = PARK_HR[homeAbbr]  || 1.0;
  const parkHit   = PARK_HIT[homeAbbr] || 1.0;
  const windMult  = wind.bonus >= 2 ? 1.16 : wind.bonus === 1 ? 1.08 : wind.bonus <= -2 ? 0.85 : wind.bonus === -1 ? 0.93 : 1.0;

  // ── ERA-informed team win pick (recorded for ticket) ──
  if (!fin && !live) {
    const awayWP = parseWinPct(espnGame.awayRec);
    const homeWP = parseWinPct(espnGame.homeRec);
    const rawHome = homeWP * 1.03 * (0.5 + (homeMom - 0.5) * 0.4);
    const rawAway = awayWP        * (0.5 + (awayMom - 0.5) * 0.4);
    let homeFrac = (rawHome + rawAway) > 0 ? rawHome / (rawHome + rawAway) : 0.5;
    // ERA gap: each 1.0 ERA difference shifts win probability ~4%
    const ae = parseFloat(awayPD?.season?.era || 4.20);
    const he = parseFloat(homePD?.season?.era || 4.20);
    homeFrac = Math.max(0.10, Math.min(0.90, homeFrac + (ae - he) * 0.04));
    // Last-start quality nudge (smaller weight than season ERA)
    if (awayPD?.lastStartERA != null) homeFrac = Math.max(0.10, Math.min(0.90, homeFrac + (awayPD.lastStartERA - ae) * 0.015));
    if (homePD?.lastStartERA != null) homeFrac = Math.max(0.10, Math.min(0.90, homeFrac - (homePD.lastStartERA - he) * 0.015));
    // Blend 50/50 with Vegas spread when available
    const spreadData = parseOddsSpread(espnGame);
    if (spreadData) {
      const spreadHomeFrac = spreadData.isHomeFavored ? spreadData.spreadWP : 1 - spreadData.spreadWP;
      homeFrac = 0.5 * homeFrac + 0.5 * spreadHomeFrac;
    }
    const eraConf = wpToConf(homeFrac >= 0.5 ? homeFrac : 1 - homeFrac);
    if (eraConf >= 1) {
      const short = (homeFrac >= 0.5 ? espnGame.homeTeam : espnGame.awayTeam).split(' ').pop();
      recordPick(String(espnGame.id), short, gameMatchup, 'mlb', eraConf, true, null, '', { gameTime: espnGame.gameDate });
    }
  }

  // ── Compact pitcher line with recent-form trend ──
  const pitStr = (name, pd, hand) => {
    const era    = pd?.season?.era ? `${pd.season.era} ERA` : '';
    const ip     = parseFloat(pd?.season?.inningsPitched || 0);
    const ks     = parseInt(pd?.season?.strikeOuts || 0);
    const k9str  = ip > 20 ? ` · ${((ks / ip) * 9).toFixed(1)}K/9` : ks > 0 ? ` · ${ks}K` : '';
    const rEra   = pd?.recentEra != null ? pd.recentEra.toFixed(2) : null;
    const trend  = pd?.eraTrend;
    const tArrow = trend === 'hot' ? '<span class="pit-trend-hot">↑</span>' : trend === 'cold' ? '<span class="pit-trend-cold">↓</span>' : '';
    const recentStr = rEra && pd?.last3starts >= 2 ? ` · L3: ${rEra}${tArrow}` : '';
    const sERA = parseFloat(pd?.season?.era || 0);
    const lsStr = (pd?.lastStartERA != null && sERA > 0 && Math.abs(pd.lastStartERA - sERA) >= 1.0)
      ? ` · LS: ${pd.lastStartERA.toFixed(2)}` : '';
    const restStr = pd?.restDays != null && pd.restDays >= 6
      ? ` <span class="pit-rest-bonus" title="${pd.restDays} days rest">+rest</span>` : '';
    return `${esc(lastName(name))} (${hand||'?'}HP · ${era}${k9str}${recentStr}${lsStr}${restStr})`;
  };
  const pitcherLine = `<div class="pc-pit-line">${pitStr(awayPName, awayPD, awayHand)} <span class="pc-pit-sep">vs</span> ${pitStr(homePName, homePD, homeHand)}</div>`;

  // ── L10 momentum + streak line ──
  const l10Chip = (stand, abbr) => {
    if (!stand) return '';
    const { l10w, l10l, streak } = stand;
    const cls = l10w >= 7 ? 'l10-hot' : l10w <= 3 ? 'l10-cold' : 'l10-avg';
    const strk = streak ? ` <span class="l10-streak">${esc(streak)}</span>` : '';
    return `<span class="pc-l10 ${cls}">${esc(abbr)} L10: ${l10w}-${l10l}${strk}</span>`;
  };
  const momentumLine = (awayStand || homeStand)
    ? `<div class="pc-momentum">${l10Chip(awayStand, espnGame.awayAbbr)} ${l10Chip(homeStand, espnGame.homeAbbr)}</div>` : '';

  // ── ESPN odds line ──
  const oddsInfo = espnGame.odds;
  const oddsLine = (oddsInfo?.spread || oddsInfo?.overUnder)
    ? `<div class="pc-odds-line">${[oddsInfo.spread ? `Line: ${esc(oddsInfo.spread)}` : '', oddsInfo.overUnder ? `O/U: ${oddsInfo.overUnder}` : ''].filter(Boolean).join(' · ')}</div>`
    : '';

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
    if (era < 3.10 && rates.k9 > 9.0) return `⚠️ ${esc(lastName(pitName))} ${era.toFixed(2)} ERA · ${rates.k9.toFixed(1)} K/9 - tough day for ${esc(facingAbbr)} bats`;
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
    const doubles  = parseInt(st.doubles || 0);
    const triples  = parseInt(st.triples || 0);
    const xbh      = doubles + triples + hr;
    const hrRate   = ab > 20 ? hr / ab : 0;
    const dblRate  = ab > 20 ? doubles / ab : 0;
    const xbhRate  = ab > 20 ? xbh / ab : 0;
    const bbPct    = (ab + bb) > 0 ? bb / (ab + bb) : 0;
    const rbiRate  = ab > 0 ? rbi / ab : 0;
    // Rate × matchup factor scoring
    const hitScore = platAvg * 1000 * parkHit * Math.max(0.72, 1 - pitRates.k9 / 80);
    const hrScore  = hrRate  * 1000 * pitRates.hr9 * parkHR * windMult;
    const rbiScore = rbiRate * 1000 * posW;
    const bbScore  = bbPct   * pitRates.bb9 * 100;
    const sbScore  = sb * 10 + sbSucc * 50;
    const hScore   = platAvg * 600 + (ab > 0 ? h / ab : 0) * 400;
    const dblScore = dblRate * 1000 * parkHit;
    const xbhScore = xbhRate * 1000 * Math.sqrt(parkHR * parkHit);
    // Confidence: 0–3 based on platoon avg quality, streak, sample size + historical calibration
    const conf = Math.max(0, Math.min(3,
      (platAvg >= 0.310 ? 2 : platAvg >= 0.270 ? 1 : 0) +
      (streak === '🔥' ? 1 : 0) +
      (ab >= 150 ? 1 : 0) +
      mlbCalOffset
    ));
    return {
      id: p.id, name: p.fullName, abbr: teamAbbr, pos,
      batSide, oppPitcherId, oppHand, hand, avg, platAvg, vsL, vsR,
      hr, rbi, h, bb, sb, cs, sbSucc, ab, ops, obp, pitRates, l30avg, streak, conf,
      doubles, triples, xbh,
      hitScore, hrScore, rbiScore, bbScore, sbScore, hScore, dblScore, xbhScore,
    };
  };

  const awayBatters = awayLineup.slice(0, 9).map((p, i) => mkBatter(p, i+1, homeHand, awayAbbr, homePitcherId, homeRates));
  const homeBatters = homeLineup.slice(0, 9).map((p, i) => mkBatter(p, i+1, awayHand, homeAbbr, awayPitcherId, awayRates));
  const allBatters  = [...awayBatters, ...homeBatters].filter(b => b.ab >= 5);
  const awayValid   = awayBatters.filter(b => b.ab >= 5);
  const homeValid   = homeBatters.filter(b => b.ab >= 5);

  const hasLineup = allBatters.length > 0;

  // ── Fetch career vs-pitcher stats for top batters (top 2 hitters + top HR per team) ──
  let vsMap = new Map(); // batterId -> vs stat
  if (hasLineup) {
    const topBatters = [...new Set([
      ...[...awayValid].sort((a,b) => b.hitScore - a.hitScore).slice(0,2),
      ...[...homeValid].sort((a,b) => b.hitScore - a.hitScore).slice(0,2),
      ...[...awayValid].sort((a,b) => b.hrScore  - a.hrScore ).slice(0,1),
      ...[...homeValid].sort((a,b) => b.hrScore  - a.hrScore ).slice(0,1),
    ].filter(b => b?.id && b?.oppPitcherId).map(b => b.id))];
    const vsRes = await Promise.allSettled(
      topBatters.map(bid => {
        const batter = allBatters.find(b => b.id === bid);
        return fetchVsStats(bid, batter.oppPitcherId).then(s => ({ bid, s }));
      })
    );
    for (const r of vsRes) {
      if (r.status === 'fulfilled' && r.value?.s) vsMap.set(r.value.bid, r.value.s);
    }
  }

  // ── Projected run totals (park-adjusted) ──
  let projLine = '';
  if (hasLineup && awayValid.length && homeValid.length) {
    const LEAGUE_OPS = 0.728, LEAGUE_RPG = 4.50;
    const parkRun = PARK_RUN[homeAbbr] || 1.0;
    const avgOPS = arr => arr.reduce((s,b) => s + parseFloat(b.ops||0), 0) / arr.length;
    const projR  = (batters, pitERA) => {
      const opsR = avgOPS(batters) / LEAGUE_OPS;
      const eraR = LEAGUE_ERA / Math.max(parseFloat(pitERA) || LEAGUE_ERA, 1.5);
      return Math.max(0.5, Math.min(13, LEAGUE_RPG * opsR * eraR * parkRun)).toFixed(1);
    };
    const awayProj = projR(awayValid, homePD?.season?.era);
    const homeProj = projR(homeValid, awayPD?.season?.era);
    const projTotal = (parseFloat(awayProj) + parseFloat(homeProj)).toFixed(1);
    const ouNote = oddsInfo?.overUnder
      ? ` · O/U ${oddsInfo.overUnder} <span class="pc-ou-${parseFloat(projTotal) >= oddsInfo.overUnder ? 'over' : 'under'}">(model ${parseFloat(projTotal) >= oddsInfo.overUnder ? 'leans OVER' : 'leans UNDER'})</span>`
      : ` · total ${projTotal}`;
    const parkName = PARK_NAMES[homeAbbr];
    const parkNote = parkRun >= 1.10 ? ` · <span class="pc-park-note pc-park-up">${parkName || 'Park'}: runs ↑</span>`
                   : parkRun <= 0.91 ? ` · <span class="pc-park-note pc-park-down">${parkName || 'Park'}: runs ↓</span>` : '';
    projLine = `<div class="pc-proj-line">${esc(espnGame.awayAbbr)}: <b>${awayProj}</b> · ${esc(espnGame.homeAbbr)}: <b>${homeProj}</b>${ouNote}${parkNote}</div>`;
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
    const aDbl = awayValid.filter(b => b.doubles >= 4).sort((a, b) => b.dblScore - a.dblScore)[0];
    const hDbl = homeValid.filter(b => b.doubles >= 4).sort((a, b) => b.dblScore - a.dblScore)[0];
    const aXBH = awayValid.filter(b => b.xbh >= 8).sort((a, b) => b.xbhScore - a.xbhScore)[0];
    const hXBH = homeValid.filter(b => b.xbh >= 8).sort((a, b) => b.xbhScore - a.xbhScore)[0];

    const avg_    = b => _fmtAvg(b?.platAvg || b?.avg) || '-';
    const statStr = {
      hit: b => {
        if (!b) return '';
        const oppPD = b.team === awayAbbr ? homePD : awayPD;
        const pitERA = parseFloat(oppPD?.season?.era || 4.5);
        const ph = (PARK_HIT[homeAbbr] || 1.0) >= 1.02;
        let s = `${avg_(b)} vs ${b.oppHand||'?'}HP`;
        if (b.babip !== null && b.babip < 0.270) s += '·due';
        if (pitERA > 4.8) s += '·pitH↑';
        if (ph) s += '·park↑';
        return s;
      },
      hr: b => {
        if (!b) return '';
        const vs    = vsMap.get(b.id);
        const vsHR  = (vs && parseInt(vs.atBats||0) >= 5) ? parseInt(vs.homeRuns||0) : 0;
        const oppR  = b.team === awayAbbr ? homeRates : awayRates;
        const phHR  = parkHR >= 1.05;
        let s = `${b.hr||0}HR · ${avg_(b)} vs ${b.oppHand||'?'}HP`;
        if (vsHR > 0)              s += `·${vsHR}vsHR`;
        if ((oppR?.hr9||0) > 1.25) s += '·pitHR↑';
        if (phHR)                  s += '·parkHR↑';
        if (b.favorable)           s += '·plat';
        return s;
      },
      rbi: b => {
        if (!b) return '';
        const oppPD = b.team === awayAbbr ? homePD : awayPD;
        const pitERA = parseFloat(oppPD?.season?.era || 4.5);
        let s = `${b.rbi||0}RBI · #${b.pos}`;
        if (pitERA > 4.8) s += '·pitR↑';
        return s;
      },
      walk: b => b ? `${b.bb||0}BB · ${b.obp||'-'}OBP` : '',
      sb:   b => b ? `${b.sb}SB` : '',
      dbl:  b => b ? `${b.doubles||0}2B · ${avg_(b)} vs ${b.oppHand||'?'}HP` : '',
      xbh:  b => b ? `${b.xbh||0}XBH · ${b.hr||0}HR · ${b.doubles||0}2B` : '',
    };

    // Record both teams' picks per category
    const gKey   = String(espnGame.id);
    const gamePk = mlbGame?.gamePk || null;
    if (!fin && !live) {
      const propLabel = p => ({ hit:'Hit', hr:'HR', rbi:'RBI', walk:'Walk', sb:'SB', dbl:'Double', xbh:'XBH' }[p] || p);
      for (const [b, prop] of [[aHit,'hit'],[hHit,'hit'],[aHR,'hr'],[hHR,'hr'],[aRBI,'rbi'],[hRBI,'rbi'],[aBB,'walk'],[hBB,'walk'],[aSB,'sb'],[hSB,'sb'],[aDbl,'dbl'],[hDbl,'dbl'],[aXBH,'xbh'],[hXBH,'xbh']]) {
        if (b) recordPlayerPick('plr_'+gKey+'_'+b.id+'_'+prop, 'mlb', b.name, propLabel(prop), statStr[prop](b), gameMatchup, gamePk);
      }
      // Pitcher strikeout picks - record for high-K/9 arms (adjusted for form, rest, bullpen)
      const recKPick = (pd, pname, rates, side) => {
        if (!pd?.season) return;
        const ip = parseFloat(pd.season.inningsPitched || 0);
        if (ip < 20) return;
        if (rates.k9 >= 9.0) {
          const gs = parseInt(pd.season.gamesStarted || 0);
          const avgIP = gs > 0 ? ip / gs : 5.5;
          const projK = rates.k9 * avgIP / 9;
          const ouLine = Math.max(3.5, Math.floor(projK) - 0.5).toFixed(1);
          recordPlayerPick(`plr_${gKey}_k_${side}`, 'mlb', pname, 'K',
            `${rates.k9.toFixed(1)}K/9 · OVER ${ouLine} K`, gameMatchup, gamePk);
        }
      };
      recKPick(awayPD, awayPName, awayRates, 'away');
      recKPick(homePD, homePName, homeRates, 'home');
      // Run total O/U - model projection vs official betting line
      if (oddsInfo?.overUnder && hasLineup && awayValid.length && homeValid.length) {
        const LEAGUE_OPS = 0.728, LEAGUE_RPG = 4.50;
        const parkRun    = PARK_RUN[homeAbbr] || 1.0;
        const avgOPS     = arr => arr.reduce((s, b) => s + parseFloat(b.ops||0), 0) / arr.length;
        const projR      = (batters, era) => Math.max(0.5, Math.min(13,
          LEAGUE_RPG * (avgOPS(batters)/LEAGUE_OPS) * (LEAGUE_ERA/Math.max(parseFloat(era)||LEAGUE_ERA,1.5)) * parkRun));
        const projTotalRuns = (projR(awayValid, homePD?.season?.era) + projR(homeValid, awayPD?.season?.era)).toFixed(1);
        const ouLine        = parseFloat(oddsInfo.overUnder);
        const dir           = parseFloat(projTotalRuns) >= ouLine ? 'OVER' : 'UNDER';
        recordPlayerPick(`runs_${gKey}`, 'mlb', `${dir} ${ouLine}`, 'RunTotal',
          `proj ${projTotalRuns} runs`, gameMatchup, gamePk);
      }
    } else if (fin) {
      // Only grade picks once the game is truly final - never during live play
      resolvePlayerPicksForGame(gKey, gamePk);
      // Resolve run total pick once game is final
      const _rtKey = `runs_${gKey}`;
      const _pks = getPicks(); const _rtp = _pks[_rtKey];
      if (_rtp && _rtp.result === null) {
        const _total = parseFloat(espnGame.awayScore||0) + parseFloat(espnGame.homeScore||0);
        const _m = (_rtp.player||'').match(/^(OVER|UNDER)\s+(\d+\.?\d*)/);
        if (_m && _total > 0) {
          _pks[_rtKey].result = (_m[1]==='OVER' ? _total > parseFloat(_m[2]) : _total < parseFloat(_m[2])) ? 'win' : 'loss';
          savePicks(_pks);
        }
      }
    }

    // Two rows per category (away top + home top), skip if both absent
    const catRows = (icon, label, away, home, prop) => {
      const rows = [];
      if (away) rows.push(pickRow(icon, label, away, statStr[prop](away)));
      if (home) rows.push(pickRow('', '',    home, statStr[prop](home)));
      return rows.join('');
    };

    const hasSB  = aSB  || hSB;
    const hasDbl = aDbl || hDbl;
    const hasXBH = aXBH || hXBH;
    picksHTML = `<div class="pc-picks">
      ${catRows('🎯','Hit',    aHit, hHit, 'hit')}
      ${catRows('💣','HR',     aHR,  hHR,  'hr')}
      ${catRows('⚡','RBI',    aRBI, hRBI, 'rbi')}
      ${hasDbl ? catRows('2️⃣','2B',  aDbl, hDbl, 'dbl') : ''}
      ${hasXBH ? catRows('💥','XBH', aXBH, hXBH, 'xbh') : ''}
      ${catRows('🚶','Walk',   aBB,  hBB,  'walk')}
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
    ${momentumLine}
    ${oddsLine}
    ${pitcherLine}
    ${wxLine}
    ${projLine}
    ${pitWarnLine}
    ${picksHTML}
  </div>`;
}

function tpSwitchTab(tab) {
  _tpTab = tab;
  document.querySelectorAll('.tp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tp-panel-upcoming').style.display = tab === 'upcoming' ? '' : 'none';
  document.getElementById('tp-panel-results').style.display  = tab === 'results'  ? '' : 'none';
}

// ── TENNIS PICKS PAGE ────────────────────────────────────────
async function loadTennisPicksPage() {
  const seq  = _loadSeq;
  const area = document.getElementById('mlb-picks-area');
  area.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><p>Loading picks…</p></div>`;

  let results = [];
  try {
    const d = dateStrLocal(S.dateOffset);
    results = await tennisFetch('get_fixtures', { date_start: d, date_stop: d });
    const picks = getPicks();
    let picksDirty = false;
    for (const m of results) {
      S.matches.set(String(m.event_key), m);
      inlineTennisPick(m);
      // Re-date any existing pick that was stamped with the wrong date.
      // Only move dates forward - never pull a tomorrow pick back to today.
      if (m.event_date) {
        const pid = 'tn_' + m.event_key;
        const ex  = picks[pid];
        if (ex && ex.result === null && ex.date !== m.event_date && m.event_date >= ex.date) {
          ex.date  = m.event_date;
          picksDirty = true;
        }
      }
      if (isFinished(m.event_status) && m.event_winner) {
        let wln = '';
        if (m.event_winner === 'First Player')       wln = lastName(m.event_first_player || '');
        else if (m.event_winner === 'Second Player') wln = lastName(m.event_second_player || '');
        else                                          wln = lastName(m.event_winner);
        if (wln) resolvePick('tn_' + m.event_key, wln);
      }
    }
    if (picksDirty) savePicks(picks);
  } catch {}

  const todayStr     = dateStrLocal(0);
  const selectedDate = dateStrLocal(S.dateOffset);

  // Build match lookup from this date's fixtures (for time/tournament enrichment)
  const matchByKey = new Map(results.map(m => ['tn_' + m.event_key, m]));

  const labelForDate = d => {
    if (!d || d === todayStr)   return 'Today';
    if (d === dateStrLocal(1))  return 'Tomorrow';
    if (d === dateStrLocal(-1)) return 'Yesterday';
    try {
      const [y, mo, dy] = d.split('-').map(Number);
      return new Date(y, mo - 1, dy).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch { return d; }
  };
  const selLabel = labelForDate(selectedDate);

  const confDots = c => {
    if (!c) return '';
    const cls = c >= 3 ? 'tp-conf-3' : c === 2 ? 'tp-conf-2' : 'tp-conf-1';
    return `<span class="tp-conf ${cls}">${'•'.repeat(Math.min(c, 3))}</span>`;
  };

  // Enrich a pick with live match metadata (time, tournament, category)
  const enrich = (p, id) => {
    const match = matchByKey.get(id);
    return { ...p, _id: id,
      _time:    match?.event_time || '',
      _date:    match?.event_date || '',
      _tourn:   match?.tournament_name || '',
      _cat:     match ? matchCategory(match.event_type_type || '') : '',
      _tier:    p.tier || (match ? tournamentTier(match) : ''),
    };
  };

  const makeRow = p => {
    const win = p.result === 'win';
    const rowCls = p.result === null ? 'tp-row' : win ? 'tp-row tp-row-win' : 'tp-row tp-row-loss';
    const resultIcon = p.result === null ? ''
      : `<span class="tp-row-icon ${win ? 'tp-ico-win' : 'tp-ico-loss'}">${win ? '✓' : '✗'}</span>`;
    const matchupClean = (p.matchup || p.team).replace(/\s*\(\w+\)$/i, '');
    const timeStr = p._time ? `<span class="tp-row-time">${esc(fmtTennisTime(p._date, p._time))}</span>` : '';
    return `<div class="${rowCls}">
      ${timeStr}
      <span class="tp-row-arrow">→</span>
      <span class="tp-row-pick">${esc(p.team)}</span>
      <span class="tp-row-vs">${esc(matchupClean)}</span>
      <span class="tp-row-meta">${confDots(p.conf)}${resultIcon}</span>
    </div>`;
  };

  const CAT_LABEL = { atp:'ATP', wta:'WTA', 'challenger-m':'Challenger M', 'challenger-w':'Challenger W', 'itf-m':'ITF Men', 'itf-w':'ITF Women' };

  // Group picks by tournament, sort each group by scheduled time
  // rowFn: optional custom row renderer (defaults to makeRow)
  const renderTournamentGroups = (picks, rowFn = makeRow) => {
    const byTourn = new Map();
    for (const p of picks) {
      const key = p._tourn || 'Other';
      if (!byTourn.has(key)) byTourn.set(key, { tier: p._tier, cat: p._cat, rows: [] });
      byTourn.get(key).rows.push(p);
    }
    // Sort by tier priority (slam first), then tournament name
    const TIER_PRI = { slam:0, masters:1, '500':2, '250':3, chal:4, itf:5 };
    const sorted = [...byTourn.entries()].sort(([, a], [, b]) =>
      (TIER_PRI[a.tier] ?? 9) - (TIER_PRI[b.tier] ?? 9) || 0
    );
    return sorted.map(([name, { tier, cat, rows }]) => {
      // Sort each tournament's picks by scheduled time
      rows.sort((a, b) => (a._time || '99:99').localeCompare(b._time || '99:99'));
      const tierBadge = tier && tier !== '250'
        ? `<span class="tier-badge tier-${tier}">${TIER_LABEL[tier] || tier.toUpperCase()}</span>` : '';
      const catLabel = CAT_LABEL[cat] || '';
      return `<div class="tp-tourn-block">
        <div class="tp-tourn-hdr">
          <span class="tp-tourn-name">${esc(name || 'Other')}</span>
          ${tierBadge}
          ${catLabel ? `<span class="tp-tourn-cat">${esc(catLabel)}</span>` : ''}
        </div>
        ${rows.map(rowFn).join('')}
      </div>`;
    }).join('');
  };

  // Enrich all picks with match metadata
  const allPicksEntries = Object.entries(getPicks()).filter(([, p]) => (p.sport || 'tennis') === 'tennis');
  const allTennisPicks  = allPicksEntries.map(([k, p]) => enrich(p, k));
  // Split ALL tennis picks into upcoming (pending) and results (resolved)
  const upcomingPicks = allTennisPicks
    .filter(p => p.result === null)
    .sort((a, b) => (a.date || todayStr).localeCompare(b.date || todayStr) || (a._time || '99:99').localeCompare(b._time || '99:99'));

  const resolvedPicks = allTennisPicks
    .filter(p => p.result !== null)
    .sort((a, b) => (b.date || todayStr).localeCompare(a.date || todayStr) || (a._time || '99:99').localeCompare(b._time || '99:99'));

  // Row builder that adds a date badge when the pick is not for today
  const makeRowWithBadge = p => {
    const win = p.result === 'win';
    const rowCls = p.result === null ? 'tp-row' : win ? 'tp-row tp-row-win' : 'tp-row tp-row-loss';
    const resultIcon = p.result === null ? ''
      : `<span class="tp-row-icon ${win ? 'tp-ico-win' : 'tp-ico-loss'}">${win ? '✓' : '✗'}</span>`;
    const matchupClean = (p.matchup || p.team).replace(/\s*\(\w+\)$/i, '');
    const timeStr = p._time ? `<span class="tp-row-time">${esc(fmtTennisTime(p._date, p._time))}</span>` : '';
    const dateBadge = p.date && p.date !== todayStr
      ? `<span class="tp-date-badge">${esc(labelForDate(p.date))}</span>` : '';
    return `<div class="${rowCls}">
      ${dateBadge}${timeStr}
      <span class="tp-row-arrow">→</span>
      <span class="tp-row-pick">${esc(p.team)}</span>
      <span class="tp-row-vs">${esc(matchupClean)}</span>
      <span class="tp-row-meta">${confDots(p.conf)}${resultIcon}</span>
    </div>`;
  };
  const renderGroupsWithBadge = picks => renderTournamentGroups(picks, makeRowWithBadge);

  // Upcoming tab: all pending grouped by tournament
  const upcomingHTML = upcomingPicks.length
    ? `<div class="tp-tourn-list">${renderGroupsWithBadge(upcomingPicks)}</div>`
    : '<div class="empty-state muted">No upcoming picks yet - visit Scores tab to generate.</div>';

  // Results tab: grouped by date (most recent first), within each date by tournament
  const resolvedByDate = new Map();
  for (const p of resolvedPicks) {
    const d = p.date || todayStr;
    if (!resolvedByDate.has(d)) resolvedByDate.set(d, []);
    resolvedByDate.get(d).push(p);
  }
  const resultsHTML = resolvedPicks.length
    ? [...resolvedByDate.entries()]
        .sort(([a],[b]) => b.localeCompare(a))
        .map(([d, picks]) => {
          const w = picks.filter(p => p.result === 'win').length;
          return `<div class="tp-section-hdr">${esc(labelForDate(d))} <span class="tp-res-record">${w}W ${picks.length - w}L</span></div>
            <div class="tp-tourn-list">${renderTournamentGroups(picks)}</div>`;
        }).join('')
    : '<div class="empty-state muted">No results yet.</div>';

  if (_loadSeq !== seq) return;
  const tab = _tpTab;
  area.innerHTML = `
    <div class="pc-data-note">Picks use seedings · rankings · H2H · surface form · fatigue · round weighting</div>
    <div class="picks-tab-bar">
      <button class="tp-tab${tab==='upcoming'?' active':''}" data-tab="upcoming" onclick="tpSwitchTab('upcoming')">📅 Upcoming (${upcomingPicks.length})</button>
      <button class="tp-tab${tab==='results'?' active':''}" data-tab="results" onclick="tpSwitchTab('results')">✓ Results (${resolvedPicks.length})</button>
    </div>
    <div id="tp-panel-upcoming" style="${tab!=='upcoming'?'display:none':''}"><div class="ph-list">${upcomingHTML}</div></div>
    <div id="tp-panel-results"  style="${tab!=='results' ?'display:none':''}"><div class="ph-list">${resultsHTML}</div></div>
    <div class="tp-tomorrow-section">
      <div class="tp-tmrw-hdr">
        <span class="tp-tmrw-title">Tomorrow's Preview</span>
        <span class="tp-tmrw-sub">H2H analysis · top ATP &amp; WTA matches</span>
      </div>
      <div id="tomorrow-preview-area"><div class="loading-spinner" style="padding:16px"><div class="spinner"></div></div></div>
    </div>`;
  updatePicksDisplay();

  loadTomorrowPreview();
}

// ── TOMORROW'S TENNIS PREVIEW ─────────────────────────────────
async function loadTomorrowPreview() {
  const seq  = _loadSeq;
  const area = document.getElementById('tomorrow-preview-area');
  if (!area) return;
  try {
    const d = dateStrLocal(1);
    const results = await tennisFetch('get_fixtures', { date_start: d, date_stop: d });

    // Only ATP/WTA singles with player keys - cap at 10 to limit API calls
    const eligible = results.filter(m => {
      const cat = matchCategory(m.event_type_type || '');
      return ['atp','wta'].includes(cat) && m.first_player_key && m.second_player_key;
    }).slice(0, 10);

    if (!eligible.length) {
      area.innerHTML = '<div class="tp-empty">No tomorrow matches found yet - check back later today.</div>';
      return;
    }

    // Pre-fetch H2H for all eligible matches in parallel
    await Promise.allSettled(eligible.map(m => fetchH2HCached(m.first_player_key, m.second_player_key)));

    const cards = eligible.map(m => buildTomorrowPickCard(m)).join('');
    if (_loadSeq !== seq) return;
    area.innerHTML = cards || '<div class="tp-empty">No analysis available.</div>';
  } catch (err) {
    const area2 = document.getElementById('tomorrow-preview-area');
    if (area2) area2.innerHTML = `<div class="tp-empty">Could not load tomorrow's matches - ${esc(err.message)}</div>`;
  }
}

function buildTomorrowPickCard(m) {
  const p1Name = m.event_first_player  || '-';
  const p2Name = m.event_second_player || '-';
  const p1key  = String(m.first_player_key  || '');
  const p2key  = String(m.second_player_key || '');
  const s1     = parseInt(m.event_first_player_seed)  || 0;
  const s2     = parseInt(m.event_second_player_seed) || 0;
  const surface = m.tournament_surface || inferSurface(m.tournament_name || '');
  const scLow   = surfaceClass(surface);

  const data     = _h2hCache.get(`${p1key}_${p2key}`) || { h2h: [], p1Recent: [], p2Recent: [] };
  const { h2h, p1Recent, p2Recent } = data;

  // Surface-specific H2H
  const surfLow  = surface.toLowerCase();
  const h2hSurf  = h2h.filter(g => {
    const gs = inferSurface(g.tournament_name || '').toLowerCase();
    if (surfLow.includes('clay'))   return gs.includes('clay');
    if (surfLow.includes('grass'))  return gs.includes('grass');
    if (surfLow.includes('indoor')) return gs.includes('indoor');
    return gs === 'hard';
  });

  function countWins(games) {
    let w1 = 0, w2 = 0;
    for (const g of games) {
      const winner = g.event_winner; if (!winner) continue;
      const gp1key = String(g.first_player_key || '');
      if (winner === 'First Player')  { if (gp1key === p1key) w1++; else w2++; }
      else if (winner === 'Second Player') { if (gp1key === p1key) w2++; else w1++; }
    }
    return { w1, w2 };
  }
  const { w1: aw1, w2: aw2 } = countWins(h2h);
  const { w1: sw1, w2: sw2 } = countWins(h2hSurf);

  // Full scoring (same weights as buildTennisPrediction)
  let p1Score = 0, p2Score = 0;
  const factors = [];
  const l1 = lastName(p1Name), l2 = lastName(p2Name);

  // Seeds
  if (s1 && s2) {
    if (s1 < s2)      { p1Score += 2; factors.push({ label:'Seeding', detail:`${l1} [${s1}] vs [${s2}]`, side:1 }); }
    else if (s2 < s1) { p2Score += 2; factors.push({ label:'Seeding', detail:`${l2} [${s2}] vs [${s1}]`, side:2 }); }
  } else if (s1) { p1Score += 1; factors.push({ label:'Seeding', detail:`${l1} seeded, ${l2} unseeded`, side:1 }); }
    else if (s2) { p2Score += 1; factors.push({ label:'Seeding', detail:`${l2} seeded, ${l1} unseeded`, side:2 }); }

  // Rankings
  const tr1 = S.rankIndex.get(p1key), tr2 = S.rankIndex.get(p2key);
  if (!s1 && !s2) {
    if (tr1 && tr2 && tr1.rank !== tr2.rank) {
      if (tr1.rank < tr2.rank) { p1Score += 2; factors.push({ label:'Ranking', detail:`${l1} #${tr1.rank} vs ${l2} #${tr2.rank}`, side:1 }); }
      else                     { p2Score += 2; factors.push({ label:'Ranking', detail:`${l2} #${tr2.rank} vs ${l1} #${tr1.rank}`, side:2 }); }
    }
  }

  // Nationality-surface affinity (when no clear seeding/ranking separation)
  if (!s1 && !s2) {
    const c1 = tr1?.country || '', c2 = tr2?.country || '';
    if (surfLow.includes('clay')) {
      const c1c = CLAY_COUNTRIES.has(c1), c2c = CLAY_COUNTRIES.has(c2);
      if (c1c && !c2c) { p1Score += 1; factors.push({ label:'Surface fit', detail:`${l1} clay nation`, side:1 }); }
      else if (c2c && !c1c) { p2Score += 1; factors.push({ label:'Surface fit', detail:`${l2} clay nation`, side:2 }); }
    } else if (surfLow.includes('grass') || surfLow.includes('indoor')) {
      const c1g = GRASS_COUNTRIES.has(c1), c2g = GRASS_COUNTRIES.has(c2);
      if (c1g && !c2g) { p1Score += 1; factors.push({ label:'Surface fit', detail:`${l1} fast-court nation`, side:1 }); }
      else if (c2g && !c1g) { p2Score += 1; factors.push({ label:'Surface fit', detail:`${l2} fast-court nation`, side:2 }); }
    }
  }

  // H2H overall (recency-weighted)
  if (h2h.length >= 2) {
    const nowT = Date.now();
    let hw1 = 0, hw2 = 0;
    for (const g of h2h) {
      const age = g.event_date ? (nowT - new Date(g.event_date + 'T12:00:00').getTime()) / 2592000000 : 24;
      const wt  = age <= 12 ? 2 : age <= 24 ? 1.5 : 1;
      const gp1 = String(g.first_player_key || '');
      const p1won = (g.event_winner === 'First Player' && gp1 === p1key) || (g.event_winner === 'Second Player' && gp1 !== p1key);
      if (p1won) hw1 += wt; else hw2 += wt;
    }
    if (hw1 > hw2)      { p1Score += 2; factors.push({ label:'H2H (weighted)', detail:`${l1} leads ${aw1}–${aw2}`, side:1 }); }
    else if (hw2 > hw1) { p2Score += 2; factors.push({ label:'H2H (weighted)', detail:`${l2} leads ${aw2}–${aw1}`, side:2 }); }
    else                {               factors.push({ label:'H2H',             detail:`Even ${aw1}–${aw2}`,      side:0 }); }
  }

  // H2H on surface (weight 3 - most predictive)
  if (h2hSurf.length >= 2) {
    if (sw1 > sw2)      { p1Score += 3; factors.push({ label:`${surface} H2H`, detail:`${l1} leads ${sw1}–${sw2}`, side:1 }); }
    else if (sw2 > sw1) { p2Score += 3; factors.push({ label:`${surface} H2H`, detail:`${l2} leads ${sw2}–${sw1}`, side:2 }); }
    else                 {               factors.push({ label:`${surface} H2H`, detail:`Even ${sw1}–${sw2}`,       side:0 }); }
  }

  // Recent form (up to 10 matches)
  const formWins = (games, pkey) => games.reduce((w, g) => {
    const winner = g.event_winner, gp1 = String(g.first_player_key || '');
    return w + (((winner === 'First Player' && gp1 === pkey) || (winner === 'Second Player' && gp1 !== pkey)) ? 1 : 0);
  }, 0);
  const fw1 = p1Recent.length ? formWins(p1Recent, p1key) : -1;
  const fw2 = p2Recent.length ? formWins(p2Recent, p2key) : -1;
  if (fw1 >= 0 && fw2 >= 0 && fw1 !== fw2) {
    if (fw1 > fw2) { p1Score += 2; factors.push({ label:'Form', detail:`${l1} ${fw1}/${p1Recent.length} vs ${l2} ${fw2}/${p2Recent.length}`, side:1 }); }
    else           { p2Score += 2; factors.push({ label:'Form', detail:`${l2} ${fw2}/${p2Recent.length} vs ${l1} ${fw1}/${p1Recent.length}`, side:2 }); }
  }

  // Recent form on this surface
  const matchesSurfT = g => {
    const gs = inferSurface(g.tournament_name || '').toLowerCase();
    if (surfLow.includes('clay'))   return gs.includes('clay');
    if (surfLow.includes('grass'))  return gs.includes('grass');
    if (surfLow.includes('indoor')) return gs.includes('indoor');
    return gs === 'hard';
  };
  const p1SFT = p1Recent.filter(matchesSurfT), p2SFT = p2Recent.filter(matchesSurfT);
  const sf1t = p1SFT.length >= 2 ? formWins(p1SFT, p1key) : -1;
  const sf2t = p2SFT.length >= 2 ? formWins(p2SFT, p2key) : -1;
  if (sf1t >= 0 && sf2t >= 0) {
    const r1sf = sf1t / p1SFT.length, r2sf = sf2t / p2SFT.length;
    if (r1sf > r2sf + 0.20) { p1Score += 2; factors.push({ label:`${surface} form`, detail:`${l1} ${sf1t}/${p1SFT.length} vs ${l2} ${sf2t}/${p2SFT.length}`, side:1 }); }
    else if (r2sf > r1sf + 0.20) { p2Score += 2; factors.push({ label:`${surface} form`, detail:`${l2} ${sf2t}/${p2SFT.length} vs ${l1} ${sf1t}/${p1SFT.length}`, side:2 }); }
  } else if (sf1t >= 0) { p1Score += 1; factors.push({ label:`${surface} form`, detail:`${l1} ${sf1t}/${p1SFT.length} (no data ${l2})`, side:1 }); }
    else if (sf2t >= 0) { p2Score += 1; factors.push({ label:`${surface} form`, detail:`${l2} ${sf2t}/${p2SFT.length} (no data ${l1})`, side:2 }); }

  // Tournament affinity
  const tourLowT = (m.tournament_name || '').toLowerCase();
  const getAffT = name => { const lname = lastName(name).toLowerCase(); const aff = TOURNAMENT_AFFINITY[lname]; if (!aff) return 0; for (const [ev, pts] of Object.entries(aff)) { if (tourLowT.includes(ev)) return pts; } return 0; };
  const taff1t = getAffT(p1Name), taff2t = getAffT(p2Name);
  if (taff1t > taff2t) { p1Score += Math.min(3, Math.ceil((taff1t-taff2t)/2)); factors.push({ label:'Tournament history', detail:`${l1} specialist here`, side:1 }); }
  else if (taff2t > taff1t) { p2Score += Math.min(3, Math.ceil((taff2t-taff1t)/2)); factors.push({ label:'Tournament history', detail:`${l2} specialist here`, side:2 }); }

  // Fatigue: player's last match was TODAY (playing tomorrow after today's match)
  const todayStr = dateStrLocal(0);
  const p1Tired = p1Recent.length > 0 && p1Recent[0].event_date === todayStr;
  const p2Tired = p2Recent.length > 0 && p2Recent[0].event_date === todayStr;
  if (p1Tired && !p2Tired) {
    p2Score += 1; factors.push({ label:'Fatigue', detail:`${l1} plays today`, side:2 });
  } else if (p2Tired && !p1Tired) {
    p1Score += 1; factors.push({ label:'Fatigue', detail:`${l2} plays today`, side:1 });
  }

  // Round + tier + BO5 weighting
  const round     = tennisRound(m);
  const tier      = tournamentTier(m);
  const bo5       = isBestOf5(m);
  const earlyRound = ['r1','r2'].includes(round);
  const lateRound  = ['quarter','semi','final'].includes(round);

  // BO5 Grand Slam bonus for the leader
  if (bo5 && p1Score !== p2Score) {
    if (p1Score > p2Score) { p1Score += 1; factors.push({ label:'Best of 5', detail:`BO5 amplifies ${l1}'s edge`, side:1 }); }
    else                   { p2Score += 1; factors.push({ label:'Best of 5', detail:`BO5 amplifies ${l2}'s edge`, side:2 }); }
  }

  // Decide pick (with historical calibration offset)
  const tennisCalOffset = getConfCalibration('tennis');
  let pickName = '', pickSide = 0, conf = 0;
  const total = p1Score + p2Score;
  if (p1Score > p2Score) {
    pickName = p1Name; pickSide = 1;
    conf = total >= 10 ? 3 : total >= 6 ? 2 : 1;
    if (earlyRound || tier === '250') conf = Math.min(conf, 2);
    if (lateRound && tier === 'slam' && total >= 6) conf = Math.min(3, conf + 1);
    conf = Math.max(1, Math.min(3, conf + tennisCalOffset));
  } else if (p2Score > p1Score) {
    pickName = p2Name; pickSide = 2;
    conf = total >= 10 ? 3 : total >= 6 ? 2 : 1;
    if (earlyRound || tier === '250') conf = Math.min(conf, 2);
    if (lateRound && tier === 'slam' && total >= 6) conf = Math.min(3, conf + 1);
    conf = Math.max(1, Math.min(3, conf + tennisCalOffset));
  }

  // Record the pick with full analysis — pass tier, bo5, and match date so ticket scoring works correctly
  if (pickName && m.event_date && m.event_date >= dateStrLocal(0)) {
    const pickId  = 'tn_' + m.event_key;
    const surfTag = surface ? ` (${surface})` : '';
    const matchup = `${l1} vs ${l2}${surfTag}`;
    recordPick(pickId, lastName(pickName), matchup, 'tennis', conf, true, m.event_date, tier, { matchDate: m.event_date, bo5: bo5 || undefined });
  }

  // Confidence dots
  const confDots = conf > 0
    ? `<span class="tp-conf tp-conf-${conf}">${'●'.repeat(conf)}${'○'.repeat(3-conf)}</span>`
    : '';

  // Form dots
  const fmtForm = (games, pkey) => games.length
    ? games.map(g => {
        const winner = g.event_winner, gp1 = String(g.first_player_key || '');
        const won = (winner === 'First Player' && gp1 === pkey) || (winner === 'Second Player' && gp1 !== pkey);
        return `<span class="td-form-dot ${won?'td-form-w':'td-form-l'}">${won?'W':'L'}</span>`;
      }).join('')
    : '<span class="tp-no-form">no data</span>';

  const seedTag = n => n ? ` <span class="td-seed">[${n}]</span>` : '';
  const r1 = S.rankIndex.get(p1key), r2 = S.rankIndex.get(p2key);
  const rankTag = (r, s) => (!s && r) ? ` <span class="tp-rank">#${r.rank}</span>` : '';

  const factorsHTML = factors.map(f =>
    `<span class="tp-factor tp-factor-${f.side === 1 ? 'p1' : f.side === 2 ? 'p2' : 'tie'}">${esc(f.label)}: ${esc(f.detail)}</span>`
  ).join('');

  const tierBadge = tier === 'slam' ? '<span class="tp-tier-slam">GS</span>' : tier === 'masters' ? '<span class="tp-tier-masters">M1000</span>' : '';
  const bo5Badge  = bo5 ? '<span class="tp-bo5-badge">BO5</span>' : '';
  let tpLeanName = null;
  if (!pickName) {
    if      (tr1 && tr2 && tr1.rank !== tr2.rank) tpLeanName = tr1.rank < tr2.rank ? p1Name : p2Name;
    else if (aw1 !== aw2)                          tpLeanName = aw1 > aw2 ? p1Name : p2Name;
    else if (fw1 >= 0 && fw2 >= 0 && fw1 !== fw2)  tpLeanName = fw1 > fw2 ? p1Name : p2Name;
  }
  const tpLeanHTML = tpLeanName ? ` <em class="tp-lean-note">(leaning towards ${esc(lastName(tpLeanName))})</em>` : '';
  const verdictHTML = pickName
    ? `<div class="tp-pick-line">→ <strong>${esc(lastName(pickName))}</strong> ${confDots}${bo5Badge}${tierBadge}</div>`
    : `<div class="tp-pick-line tp-pick-even">Too close to call${tpLeanHTML}${tierBadge}</div>`;

  const roundLabel = round !== 'unknown' && round !== 'mid' ? `<span class="tp-round-tag">${round.toUpperCase()}</span>` : '';
  const fatigueTag = (p1Tired || p2Tired)
    ? `<span class="tp-fatigue-tag">⚡ ${p1Tired ? esc(l1) : esc(l2)} plays today</span>` : '';

  return `<div class="tp-card ${pickSide === 1 ? 'tp-leans-p1' : pickSide === 2 ? 'tp-leans-p2' : ''}">
    <div class="tp-card-hdr">
      <span class="surface-dot ${scLow}" title="${esc(surface)}"></span>
      <span class="tp-tourney">${esc(m.tournament_name || m.event_type_type || '')}</span>
      ${roundLabel}
      <span class="tp-match-time">${esc(fmtTennisTime(m.event_date, m.event_time || ''))}</span>
    </div>
    <div class="tp-players">
      <span class="tp-p1 ${pickSide===1?'tp-favored':''}">${esc(p1Name)}${seedTag(s1)}${rankTag(r1, s1)}${p1Tired?'<span class="tp-tired-dot" title="Played today">⚡</span>':''}</span>
      <span class="tp-vs">vs</span>
      <span class="tp-p2 ${pickSide===2?'tp-favored':''}">${esc(p2Name)}${seedTag(s2)}${rankTag(r2, s2)}${p2Tired?'<span class="tp-tired-dot" title="Played today">⚡</span>':''}</span>
    </div>
    ${h2h.length ? `<div class="tp-h2h">H2H: <strong>${aw1}–${aw2}</strong>${h2hSurf.length ? ` · ${surface}: <strong>${sw1}–${sw2}</strong>` : ''}</div>` : ''}
    ${(p1Recent.length || p2Recent.length) ? `<div class="tp-form">
      <span class="tp-form-player">${esc(l1)}</span>${fmtForm(p1Recent, p1key)}
      <span class="tp-form-sep">·</span>
      <span class="tp-form-player">${esc(l2)}</span>${fmtForm(p2Recent, p2key)}
    </div>` : ''}
    ${verdictHTML}
    ${factors.length ? `<div class="tp-factors">${factorsHTML}</div>` : ''}
  </div>`;
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

// ── NBA / WNBA PICKS CARD (win prediction + season stat leaders) ─
function buildNBAPicksCard(g, summary) {
  const { fin, live } = gameRowState(g);
  const matchup = `${g.awayTeam} @ ${g.homeTeam}`;

  // Win prediction
  const awayWP = parseWinPct(g.awayRec), homeWP = parseWinPct(g.homeRec);
  let favLine = '';
  if (g.awayRec || g.homeRec) {
    const rawHome = homeWP * 1.03, total = awayWP + rawHome;
    const homePct = Math.round((rawHome / total) * 100);
    const favTeam = homePct >= 50 ? g.homeTeam : g.awayTeam;
    const pct     = Math.max(homePct, 100 - homePct);
    const margin  = Math.abs(homePct - 50);
    if (!fin && margin >= 3) recordPick(String(g.id), favTeam.split(' ').pop(), matchup, g.sport || '');
    favLine = margin >= 3
      ? `<span class="pc-fav">${esc(favTeam.split(' ').pop())} favored ${pct}%</span>`
      : `<span class="pc-fav pc-fav-even">Even matchup</span>`;
  }

  // Season leaders from game summary
  // Match on displayName (ESPN uses 'Points', 'Rebounds', 'Assists' - not the name field)
  const catKey  = cat => (cat.displayName || cat.shortDisplayName || cat.name || '').toLowerCase();
  const isPoint = cat => catKey(cat).includes('point');
  const isReb   = cat => catKey(cat).includes('rebound');
  const isAst   = cat => catKey(cat).includes('assist');
  const isWanted = cat => isPoint(cat) || isReb(cat) || isAst(cat);
  const statLabel = cat => isPoint(cat) ? 'PPG' : isReb(cat) ? 'RPG' : isAst(cat) ? 'APG' : catKey(cat).slice(0,3).toUpperCase();

  let playerSection = '';
  const teamLeadersList = summary?.leaders || [];
  if (teamLeadersList.length) {
    let blocksHTML = '';
    for (const tl of teamLeadersList) {
      const tAbbr = tl.team?.abbreviation || tl.team?.shortDisplayName || '';
      const playerMap = new Map();
      for (const cat of (tl.leaders || [])) {
        if (!isWanted(cat)) continue;
        const top = (cat.leaders || [])[0];
        if (!top?.athlete?.displayName) continue;
        const pid  = top.athlete.id || top.athlete.displayName;
        const skey = catKey(cat);
        if (!playerMap.has(pid)) playerMap.set(pid, { name: top.athlete.shortName || top.athlete.displayName, id: pid, pos: top.athlete.position?.abbreviation || '', stats: {} });
        playerMap.get(pid).stats[skey] = { val: top.displayValue || '', label: statLabel(cat) };
        // Record player pick for top scorer
        if (isPoint(cat) && !fin) {
          const pid2    = top.athlete.id || top.athlete.displayName.replace(/\W+/g,'');
          const pickKey = `plr_${g.id}_${pid2}_pts`;
          const ppg     = parseFloat(top.displayValue);
          const ptLine  = !isNaN(ppg) ? (Math.max(0.5, Math.round(ppg - 0.5) + 0.5)).toFixed(1) : null;
          const dir     = propDirection(g.sport || 'nba', ppg, 'points', tAbbr.toUpperCase(), g);
          recordPlayerPick(pickKey, g.sport || 'nba', top.athlete.displayName, 'Points',
            ptLine ? `${dir} ${ptLine} PTS` : (top.displayValue ? `${top.displayValue} PPG` : '-'), matchup, null, g.gameDate || null);
        }
      }
      if (!playerMap.size) continue;
      const playerRows = [...playerMap.values()].slice(0, 3).map(p => {
        const stored  = getPicks()[`plr_${g.id}_${p.id}_pts`];
        const icon    = stored?.result === 'win' ? '✓' : stored?.result === 'loss' ? '✗' : '';
        const cls     = stored?.result === 'win' ? 'nba-pick-win' : stored?.result === 'loss' ? 'nba-pick-loss' : '';
        const statStr = Object.values(p.stats).map(s => `${s.val} ${s.label}`).join(' · ');
        return `<div class="nba-player-row ${cls}">
          <span class="nba-pick-icon">${icon}</span>
          <span class="nba-player-pos">${esc(p.pos)}</span>
          <span class="nba-player-name">${esc(p.name)}</span>
          <span class="nba-player-team">${esc(tAbbr)}</span>
          <span class="nba-player-stat">${esc(statStr)}</span>
        </div>`;
      }).join('');
      blocksHTML += `<div class="nba-team-block">
        <div class="nba-team-block-hdr">${esc(tAbbr)} Season Avg</div>
        ${playerRows}
      </div>`;
    }
    if (blocksHTML) playerSection = `<div class="nba-players-section">${blocksHTML}</div>`;
  }

  const statusLabel = fin  ? '<span class="fin-badge">FIN</span>'
                    : live ? '<span class="live-badge">LIVE</span>'
                    : `<span class="pc-time">${esc(g.gameDate ? fmtTimeTZ(g.gameDate) : g.status)}</span>`;
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
    ${playerSection}
  </div>`;
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
                    : `<span class="pc-time">${esc(g.gameDate ? fmtTimeTZ(g.gameDate) : g.status)}</span>`;
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
  const seq  = _loadSeq;
  const area = document.getElementById('mlb-picks-area');
  const nav  = picksDateNavHTML();
  area.innerHTML = `${nav}<div class="loading-spinner"><div class="spinner"></div><p>Loading ${sport.toUpperCase()} picks…</p></div>`;
  try {
    const off        = S.picksDateOffset;
    const isNBALeague = ['nba','wnba'].includes(sport);
    const games = await espnGames(sport, off);
    if (!games.length) {
      if (_loadSeq !== seq) return;
      const isNFL = sport === 'nfl' && off === 0;
      area.innerHTML = nav + `<div class="empty-state"><p>No ${sport.toUpperCase()} games on this date.</p>${isNFL ? '<p class="muted">Use the date navigation above to browse the schedule.</p>' : ''}</div>`;
      return;
    }

    let summaryMap = new Map();
    if (isNBALeague) {
      // Pre-fetch game summaries in parallel - contains season leaders per team
      const bPath = sport === 'wnba' ? 'basketball/wnba' : 'basketball/nba';
      const results = await Promise.allSettled(
        games.map(g => fetch(`https://site.api.espn.com/apis/site/v2/sports/${bPath}/summary?event=${g.id}`)
          .then(r => r.ok ? r.json() : null).catch(() => null))
      );
      games.forEach((g, i) => {
        const val = results[i].status === 'fulfilled' ? results[i].value : null;
        if (val) summaryMap.set(String(g.id), val);
      });
    }

    if (_loadSeq !== seq) return;
    const cards = games.map(g => isNBALeague ? buildNBAPicksCard(g, summaryMap.get(String(g.id))) : buildWinPredCard(g)).join('');
    const note  = off !== 0 ? '' : `<div class="pc-data-note">${isNBALeague ? 'Win prediction · season stat leaders from ESPN' : 'Win predictions based on season records · ESPN odds where available'}</div>`;
    area.innerHTML = nav + note + `<div class="picks-cards">${cards}</div>`;
    updatePicksDisplay();
  } catch (err) {
    area.innerHTML = nav + `<div class="error-state"><div class="error-icon">⚠</div><p>Could not load ${sport.toUpperCase()} picks: ${esc(err.message)}</p></div>`;
  }
}

async function loadMLBPicksPage() {
  const seq  = _loadSeq;
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
      if (_loadSeq !== seq) return;
      area.innerHTML = nav + '<div class="empty-state"><p>No MLB games on this date.</p></div>';
      return;
    }

    // Phase 2: pre-fetch pitcher stats, team pitching ERA, and L10 standings in parallel
    const pitcherIds = new Set();
    const mlbTeamIds = new Set();
    for (const g of schedule) {
      if (g.teams.away.probablePitcher?.id) pitcherIds.add(g.teams.away.probablePitcher.id);
      if (g.teams.home.probablePitcher?.id) pitcherIds.add(g.teams.home.probablePitcher.id);
      if (g.teams.away.team?.id) mlbTeamIds.add(String(g.teams.away.team.id));
      if (g.teams.home.team?.id) mlbTeamIds.add(String(g.teams.home.team.id));
    }
    await Promise.allSettled([
      fetchMLBStandings(),
      ...[...pitcherIds].map(id => fetchPitcherPreview(id)),
      ...[...mlbTeamIds].map(id => fetchTeamPitchingStats(id))
    ]);

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
    if (_loadSeq !== seq) return;
    const note = `<div class="pc-data-note">Platoon splits · park factors · pitcher ERA + L3 trend · bullpen ERA · L10 momentum · career vs-pitcher</div>`;
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

    const gameMatchup = `${espnGame.awayTeam} @ ${espnGame.homeTeam}`;
    const pickResult = buildPickSection(awayAbbr, homeAbbr, {
      awayRec: espnGame.awayRec || '', homeRec: espnGame.homeRec || '',
      awayERA: awayPD?.season?.era ?? null, homeERA: homePD?.season?.era ?? null,
      awayLastStartERA: awayPD?.lastStartERA ?? null, homeLastStartERA: homePD?.lastStartERA ?? null,
      awayRestDays: awayPD?.restDays ?? null, homeRestDays: homePD?.restDays ?? null,
      awayAbbr, homeAbbr,
      sport: 'mlb', weather: mlbGame.weather || null, weatherFmt: 'mlb'
    });
    const pickHTML = pickResult.html;
    const _gs = gameRowState(espnGame);
    if (pickResult.team && !_gs.fin && !_gs.live) {
      recordPick(String(espnGame.id), pickResult.team, gameMatchup, 'mlb', pickResult.conf, true, null, '', { gameTime: espnGame.gameDate });
    }

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

    // Fetch team schedules for recent form + H2H + rest days
    let awayForm = null, homeForm = null, awayH2H = 0, homeH2H = 0, h2hTotal = 0;
    let awayDaysRest = null, homeDaysRest = null;
    if (awayTeamId && homeTeamId) {
      const [aRes, hRes] = await Promise.allSettled([
        fetchTeamSched(game.sport, awayTeamId),
        fetchTeamSched(game.sport, homeTeamId)
      ]);
      if (aRes.status === 'fulfilled' && aRes.value) {
        const ai = parseScheduleInsights(aRes.value, awayTeamId, homeTeamId);
        awayForm = { recentWins: ai.recentWins, recentPlayed: ai.recentPlayed };
        awayH2H = ai.h2hWins; h2hTotal = ai.h2hTotal;
        awayDaysRest = ai.daysRest;
      }
      if (hRes.status === 'fulfilled' && hRes.value) {
        const hi = parseScheduleInsights(hRes.value, homeTeamId, awayTeamId);
        homeForm = { recentWins: hi.recentWins, recentPlayed: hi.recentPlayed };
        homeH2H = hi.h2hWins;
        if (hi.h2hTotal > h2hTotal) h2hTotal = hi.h2hTotal;
        homeDaysRest = hi.daysRest;
      }
    }

    const pickResult = buildPickSection(game.awayTeam, game.homeTeam, {
      awayRec, homeRec, seriesSummary, seriesTitle,
      awayAbbr: awayAbbr2, homeAbbr: homeAbbr2,
      awayForm, homeForm, awayH2H, homeH2H, h2hTotal,
      sport: game.sport, weather: j.gameInfo?.weather || null, weatherFmt: 'espn',
      awayRestDays: awayDaysRest, homeRestDays: homeDaysRest
    });
    // MLB: force=true so pitcher ERA data overrides the simple seed pick.
    // NBA/NHL/Soccer: force=false so we never overwrite the Vegas-blended pick from autoRecordAndResolvePick.
    if (pickResult.team && !gameRowState(game).fin) {
      recordPick(String(game.id), pickResult.team, `${game.awayTeam} @ ${game.homeTeam}`, game.sport || '', pickResult.conf, game.sport === 'mlb', null, '', game.sport === 'mlb' ? { gameTime: game.gameDate } : {});
    }

    let html = pickResult.html;

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
const _pitcherCache      = new Map();
const _batterCache       = new Map();
const _vsCache           = new Map(); // `${batterId}_${pitcherId}` -> career vs-pitcher stat
const _otherGamesMap     = new Map(); // espn event id → game object
const _schedCache        = new Map(); // `${sport}_${teamId}` → events[]
const _teamPitchingCache = new Map(); // mlb teamId → team pitching stat
let   _mlbSchedCache     = null;
let   _mlbSchedDate      = null;
let   _mlbStandingsCache = null; // Map: mlbTeamId → { w, l, l10w, l10l, streak }
let   _mlbStandingsSeason = null;

async function fetchMLBStandings() {
  const yr = CURRENT_SEASON;
  if (_mlbStandingsCache && _mlbStandingsSeason === yr) return _mlbStandingsCache;
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${yr}&standingsTypes=regularSeason&hydrate=team,record`);
    const j = await r.json();
    const map = new Map();
    for (const rec of (j.records || [])) {
      for (const tr of (rec.teamRecords || [])) {
        const id = String(tr.team?.id || '');
        if (!id) continue;
        const last10 = (tr.records?.splitRecords || []).find(s => s.type === 'lastTen');
        map.set(id, {
          w: tr.wins || 0, l: tr.losses || 0,
          l10w: parseInt(last10?.wins  || 0),
          l10l: parseInt(last10?.losses || 0),
          streak: tr.streak?.streakCode || '',
          divRank: tr.divisionRank || 0
        });
      }
    }
    _mlbStandingsCache  = map;
    _mlbStandingsSeason = yr;
    return map;
  } catch { return new Map(); }
}

async function fetchTeamPitchingStats(teamId) {
  if (!teamId) return null;
  const key = String(teamId);
  if (_teamPitchingCache.has(key)) return _teamPitchingCache.get(key);
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=pitching&gameType=R&season=${CURRENT_SEASON}`);
    const j = await r.json();
    const stat = j.stats?.[0]?.splits?.[0]?.stat || null;
    _teamPitchingCache.set(key, stat);
    return stat;
  } catch { _teamPitchingCache.set(String(teamId), null); return null; }
}

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
  if (!events?.length) return { recentWins: 0, recentPlayed: 0, h2hWins: 0, h2hTotal: 0, daysRest: null };
  const myId = String(myTeamId), oppId = String(oppTeamId);
  let recentWins = 0, recentPlayed = 0, h2hWins = 0, h2hTotal = 0;
  const today = dateStrLocal(0);
  const completed = [...events]
    .filter(e => e.competitions?.[0]?.status?.type?.completed)
    .reverse(); // most recent first
  // Find the most recent completed game to calculate rest days
  let daysRest = null;
  for (const ev of completed) {
    const d = (ev.date || '').slice(0, 10);
    if (d && d < today) {
      daysRest = Math.round((new Date(today + 'T12:00:00') - new Date(d + 'T12:00:00')) / 86400000);
      break;
    }
  }
  for (const ev of completed) {
    const comp = ev.competitions[0];
    const mySlot = comp.competitors?.find(c => c.team?.id === myId);
    if (!mySlot) continue;
    const won = mySlot.winner === true;
    const isH2H = comp.competitors.some(c => c.team?.id === oppId);
    if (recentPlayed < 5) { if (won) recentWins++; recentPlayed++; }
    if (isH2H) { if (won) h2hWins++; h2hTotal++; }
  }
  return { recentWins, recentPlayed, h2hWins, h2hTotal, daysRest };
}

async function fetchPitcherPreview(pitcherId) {
  if (!pitcherId) return null;
  if (_pitcherCache.has(pitcherId)) return _pitcherCache.get(pitcherId);
  try {
    const [r1, r2] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season,gameLog&season=${CURRENT_SEASON}&group=pitching`).then(r => r.json()),
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}?fields=people,id,pitchHand`).then(r => r.json())
    ]);
    const season    = r1.stats?.find(s => s.type?.displayName === 'season')?.splits?.[0]?.stat || null;
    const gameLogs  = r1.stats?.find(s => s.type?.displayName === 'gameLog')?.splits || [];
    const lastStart = gameLogs[0] || null;

    // Compute recent-form ERA from last 3 starts (most recent first)
    const last3     = gameLogs.slice(0, 3);
    let recentEra   = null, eraTrend = 'neutral';
    if (last3.length >= 2) {
      const totalER = last3.reduce((s, g) => s + parseInt(g.stat?.earnedRuns || 0), 0);
      const totalIP = last3.reduce((s, g) => {
        const ip = String(g.stat?.inningsPitched || '0');
        const [full, frac] = ip.split('.');
        return s + parseInt(full || 0) + (parseInt(frac || 0) / 3);
      }, 0);
      recentEra = totalIP > 0 ? (totalER / totalIP) * 9 : null;
      const seasonEra = parseFloat(season?.era || 0);
      if (recentEra !== null && seasonEra > 0) {
        eraTrend = recentEra <= seasonEra - 0.75 ? 'hot'
                 : recentEra >= seasonEra + 1.25 ? 'cold'
                 : 'neutral';
      }
    }

    // Last start ERA and days of rest
    let lastStartERA = null, restDays = null;
    if (lastStart) {
      const er  = parseInt(lastStart.stat?.earnedRuns || 0);
      const ips = String(lastStart.stat?.inningsPitched || '0');
      const [ipF, ipFr] = ips.split('.');
      const ip  = parseInt(ipF || 0) + (parseInt(ipFr || 0) / 3);
      if (ip >= 1) lastStartERA = (er / ip) * 9;
      const d = lastStart.date || lastStart.gameDate || '';
      if (d) {
        const lastDate = new Date(d.length === 10 ? d + 'T12:00:00' : d);
        restDays = Math.round((Date.now() - lastDate.getTime()) / 86400000);
      }
    }
    const result = { season, lastStart, pitchHand: r2.people?.[0]?.pitchHand?.code || null, recentEra, eraTrend, last3starts: last3.length, lastStartERA, restDays };
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
    const gameTime      = g.gameDate ? new Date(g.gameDate).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone: getUserTZ(), timeZoneName:'short' }) : '-';
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
  const seq = _loadSeq;
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
    // Always record picks regardless of seq (preload calls us from simple view context)
    allGames.forEach(g => autoRecordAndResolvePick(g));
    if (_loadSeq !== seq) return;
    if (!allGames.length) {
      document.getElementById('other-scores-area').innerHTML = '<div class="empty-state"><p>No soccer matches today.</p><p class="muted">Check back later - fixtures are loaded day-of.</p></div>';
      setConn('connected', 'Soccer - no matches today');
      return;
    }
    renderOtherScores(allGames, 'soccer', 'ESPN');
    const t = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone: getUserTZ() });
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

// ── MANUAL PAIRING OVERRIDES ──────────────────────────────────────────────────
// When ESPN's tee-time grouping produces wrong 3-balls, set correct pairings here.
// Key = ESPN event ID. Update date/round/groups each round from a screenshot.
// Entries use last names; for duplicate last names use ESPN short-name format "F. Last".
// Scores/stats still come from ESPN - only group membership changes.
const GOLF_PAIRINGS_OVERRIDE = {
  '401811948': {
    date: '2026-05-24',
    round: 4,
    groups: [
      ['A. Svensson','Griffin'],
      ['D. Brown','Blair'],
      ['Higgo','Willett'],
      ['Ramey','Hughes'],
      ['Byrd','Shipley'],
      ['Cole','Olesen'],
      ['Bae','VanDerLaan'],
      ['Gomez','Pendrith'],
      ['T. Kim','Hojgaard'],
      ['Lebioda','Smith'],
      ['Saddier','Parry'],
      ['Spieth','Lower'],
      ['Kang','Pavon'],
      ['Clanton','Meissner'],
      ['Ghim','Hoffman'],
      ['Grillo','Ewart'],
      ['Power','Duncan'],
      ['Keefer','C. Kim'],
      ['Coody','List'],
      ['Fishburn','Hubbard'],
      ['Rodgers','Merritt'],
      ['Villegas','Eckroat'],
      ['Ryder','Silverman'],
      ['Malnati','Kirk'],
      ['Moore','Hoey'],
      ['Hisatsune','J. Svensson'],
      ['Noh','Neergaard-Petersen'],
      ['Hirata','Fisk'],
      ['B. Brown','Finau'],
      ['Suber','Rooyen'],
      ['Koepka','Mitchell'],
      ['Bauchou','Greyserman'],
      ['Hoge','Im'],
      ['Clark','Jaeger'],
      ['S. Kim','Scheffler'],
    ]
  }
};

function formatTeeTime(raw) {
  try {
    const d = new Date(raw);
    if (!isNaN(d)) return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone: getUserTZ(), timeZoneName:'short' });
  } catch {}
  return String(raw);
}

// ESPN embeds the actual round tee time inside linescores statistics.
// p.teeTime at root gets overwritten with the NEXT round's pairings once ESPN
// publishes them, so we check the current round's linescore stats first.
// round param: if provided, search that round's stats before falling back.
function extractTeeTime(p, round) {
  const todayUTC = new Date().toISOString().slice(0, 10);

  // 1. Current round's linescore statistics - most accurate, not overwritten
  if (round) {
    try {
      const roundLS = p.linescores?.[round - 1];
      if (roundLS) {
        for (const cat of (roundLS.statistics?.categories || [])) {
          for (const stat of (cat.stats || [])) {
            const dv = String(stat.displayValue || '');
            if (dv.length > 15 && /\d{1,2}:\d{2}:\d{2}/.test(dv)) return dv;
          }
        }
      }
    } catch {}
  }

  // 2. Root p.teeTime - only trust it if it's today or earlier (not next-round pairing)
  if (p.teeTime) {
    try {
      if (new Date(p.teeTime).toISOString().slice(0, 10) <= todayUTC) return p.teeTime;
    } catch {}
  }

  // 3. All other linescores as last resort
  try {
    for (const ls of (p.linescores || [])) {
      for (const cat of (ls.statistics?.categories || [])) {
        for (const stat of (cat.stats || [])) {
          const dv = String(stat.displayValue || '');
          if (dv.length > 15 && /\d{1,2}:\d{2}:\d{2}/.test(dv)) return dv;
        }
      }
    }
  } catch {}
  return '';
}

// Returns 'live' | 'finished' | 'upcoming'
function playerRoundStatus(p, round) {
  const holes = p.linescores?.[round - 1]?.linescores?.length || 0;
  if (holes >= 18) return 'finished';
  if (holes > 0)   return 'live';
  return 'upcoming';
}

// Stable pickId for a golf group: uses UTC HHMM + nine so it doesn't change
// when ESPN overwrites p.teeTime with next-round pairings.
// For override groups, overrideIdx is used instead to guarantee uniqueness
// even when two groups share the same tee time + nine.
function normGolfPickId(eventId, teeTime, nine, overrideIdx, overrideDate) {
  if (overrideIdx !== undefined) {
    const d = overrideDate || dateStrLocal(0);
    return `golf_${eventId}_${d}_ov${overrideIdx}`;
  }
  try {
    const d = new Date(teeTime);
    if (!isNaN(d)) {
      const hhmm = d.getUTCHours().toString().padStart(2,'0') + d.getUTCMinutes().toString().padStart(2,'0');
      return `golf_${eventId}_${hhmm}_${nine || 'front'}`;
    }
  } catch {}
  return `golf_${eventId}_${teeTime.replace(/\D/g,'')}_${nine || 'front'}`;
}

// Returns { groups: [...], upcomingGroups: [...] }
// groups: players with hole data, keyed by (teeTime + startingNine) for split-tee correctness.
// upcomingGroups: players yet to tee off, grouped by tee time (starting nine unknown until play).
// eventId: if GOLF_PAIRINGS_OVERRIDE has an entry for this event+round, use it instead of
// ESPN tee-time guessing so correct 3-ball pairings are always displayed.
function groupByTeeTime(players, round = 1, eventId = '') {
  // ── Manual override path ──────────────────────────────────────────────────
  const ov = eventId && GOLF_PAIRINGS_OVERRIDE[eventId];
  if (ov && ov.round === round && ov.date === dateStrLocal(0)) {
    // Normalize: strip diacritics, replace Scandinavian chars, lowercase
    const norm = s => s.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a');

    // Build lookup keyed by: normalized last name, normalized full name, normalized short name
    // Short name (e.g. "T. Kim") is the tiebreaker for duplicate last names.
    const lookup = new Map();
    for (const p of players) {
      const full  = norm(p.athlete?.displayName || '');
      const short = norm(p.athlete?.shortName   || '');
      const last  = full.split(' ').pop();
      if (last)  lookup.set(last, p);   // may be overwritten by duplicate - short name wins
      if (full)  lookup.set(full, p);
      if (short) lookup.set(short, p);  // "t. kim" beats plain "kim"
    }

    const groups = [];
    const upcomingGroups = [];
    for (const [ovIdx, nameList] of ov.groups.entries()) {
      const matched = nameList.map(n => lookup.get(norm(n))).filter(Boolean);
      if (matched.length < 2) continue;
      // Determine tee time + nine from first matched player that has hole data
      const withHoles = matched.find(p => (p.linescores?.[round-1]?.linescores?.length || 0) > 0);
      if (withHoles) {
        const t = extractTeeTime(withHoles, round) || '';
        const startHole = withHoles.linescores[round-1].linescores[0]?.period || 1;
        const nine = startHole >= 10 ? 'back' : 'front';
        // overrideIdx makes the pickId unique even when two groups share a tee time + nine
        groups.push({ time: t, nine, players: matched, overrideIdx: ovIdx, overrideDate: ov.date });
      } else {
        const anyT = matched.map(p => extractTeeTime(p, round)).find(t => t) || '';
        upcomingGroups.push({ time: anyT, nine: 'unknown', players: matched, upcoming: true, overrideIdx: ovIdx, overrideDate: ov.date });
      }
    }
    groups.sort((a, b) => new Date(a.time) - new Date(b.time));
    upcomingGroups.sort((a, b) => new Date(a.time) - new Date(b.time));
    return { groups, upcomingGroups };
  }

  // ── ESPN tee-time grouping (fallback when no override) ────────────────────
  const definite = new Map();
  const upcoming = new Map();

  for (const p of players) {
    const holeScores = p.linescores?.[round - 1]?.linescores || [];
    const t = extractTeeTime(p, round);

    if (holeScores.length === 0) {
      if (t) {
        if (!upcoming.has(t)) upcoming.set(t, { time: t, nine: 'unknown', players: [], upcoming: true });
        upcoming.get(t).players.push(p);
      }
      continue;
    }

    const startHole = holeScores[0]?.period || 1;
    const nine = startHole >= 10 ? 'back' : 'front';

    if (!t) continue;

    const key = `${t}||${startHole}`;
    if (!definite.has(key)) definite.set(key, { time: t, nine, players: [] });
    definite.get(key).players.push(p);
  }

  const groups = [...definite.values()]
    .filter(g => g.players.length >= 1 && g.players.length <= 3)
    .sort((a, b) => new Date(a.time) - new Date(b.time) || a.nine.localeCompare(b.nine));

  const upcomingGroups = [...upcoming.values()]
    .filter(g => g.players.length >= 1 && g.players.length <= 3)
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  return { groups, upcomingGroups };
}

function renderGolfGroup(group, round, tournIsLive) {
  const players = group.players.slice(0, 3);
  if (players.length < 2) return '';

  // Determine group status from individual player hole counts
  const statuses  = players.map(p => playerRoundStatus(p, round));
  const groupLive = statuses.some(s => s === 'live');
  const groupDone = statuses.every(s => s === 'finished');

  // Pick: best position for live/done groups, else lowest order (leaderboard rank)
  const byPos  = [...players].sort((a, b) => (+a.order || 9999) - (+b.order || 9999));
  const pick   = byPos[0];
  const pickName  = pick?.athlete?.shortName || pick?.athlete?.displayName || '?';
  const isAllUpcoming = players.every(p => playerRoundStatus(p, round) === 'upcoming');
  const pickScore = isAllUpcoming ? '-' : (pick?.score || 'E');

  const nineLabel = group.nine === 'back' ? ' · Hole 10' : group.nine === 'front' ? ' · Hole 1' : '';
  const statusTag = groupLive ? `<span class="golf-live-tag pulse">● LIVE${esc(nineLabel)}</span>`
                  : groupDone ? `<span class="golf-done-tag">✓ F${esc(nineLabel)}</span>`
                  :             `<span class="golf-time-tag">⏰ ${esc(formatTeeTime(group.time))}${esc(nineLabel)}</span>`;

  const rows = players.map(p => {
    const name     = p.athlete?.shortName || p.athlete?.displayName || '-';
    const total    = p.score || (playerRoundStatus(p, round) === 'upcoming' ? '-' : 'E');
    const totalNum = total === 'E' ? 0 : parseInt(total);
    const scoreCls = isNaN(totalNum) ? '' : totalNum < 0 ? 'golf-under' : totalNum > 0 ? 'golf-over' : 'golf-even';
    const holes    = p.linescores?.[round - 1]?.linescores?.length || 0;
    const thruStr  = holes === 18 ? 'F' : holes > 0 ? `${holes}` : '-';
    const todayVal = p.linescores?.[round - 1]?.displayValue || (holes > 0 ? 'E' : '-');
    const todayNum = todayVal === 'E' ? 0 : parseInt(todayVal);
    const todayCls = isNaN(todayNum) ? '' : todayNum < 0 ? 'golf-under' : todayNum > 0 ? 'golf-over' : 'golf-even';
    const pos      = p.order ? String(p.order) : '-';
    const isPick   = p === pick;
    return `<div class="golf-group-row${isPick ? ' golf-group-pick-row' : ''}">
      <span class="golf-group-pos">${esc(pos)}</span>
      <span class="golf-group-name">${esc(name)}</span>
      <span class="golf-group-score ${scoreCls}">${esc(total)}</span>
      <span class="golf-group-today ${todayCls}">${esc(todayVal)}</span>
      <span class="golf-group-thru">${thruStr === 'F' ? `<span class="golf-thru-done">F</span>` : esc(thruStr)}</span>
    </div>`;
  }).join('');

  return `<div class="golf-group-card${groupLive ? ' golf-gc-live' : ''}">
    <div class="golf-group-time">${statusTag}<span class="golf-gc-edge">→ <b>${esc(pickName)}</b> ${esc(pickScore)}</span></div>
    <div class="golf-group-hdr"><span>POS</span><span>PLAYER</span><span>TOT</span><span>RD${round}</span><span>THRU</span></div>
    ${rows}
  </div>`;
}

function toggleGolfGroups(btn) {
  const body = btn.nextElementSibling;
  const collapsed = body.classList.toggle('golf-groups-collapsed');
  const n = body.querySelectorAll('.golf-group-card').length;
  btn.textContent = collapsed ? `🎯 3-Ball Groups (${n}) ▼` : `🎯 3-Ball Groups (${n}) ▲`;
}

// Leaderboard grouped by 3-ball groups, sorted by best player position
function renderGroupedLeaderboard(activeG, upcomingGroups, round) {
  const allPlayers = [...activeG, ...upcomingGroups].flatMap(g => g.players);
  if (!allPlayers.length) return '';

  const posCount = new Map();
  for (const p of allPlayers) {
    const k = p.order ? String(p.order) : '';
    if (k) posCount.set(k, (posCount.get(k) || 0) + 1);
  }

  const makeRow = (p, opts = {}) => {
    const name     = p.athlete?.shortName || p.athlete?.displayName || '-';
    const rawPos   = p.order ? String(p.order) : '-';
    const isTied   = rawPos !== '-' && (posCount.get(rawPos) || 0) > 1;
    const posDisp  = rawPos === '-' ? '-' : (isTied ? 'T' + rawPos : rawPos);
    const total    = p.score || 'E';
    const totalNum = total === 'E' ? 0 : parseInt(total) || 0;
    const scoreCls = totalNum < 0 ? 'golf-under' : totalNum > 0 ? 'golf-over' : 'golf-even';
    const today    = p.linescores?.[round - 1]?.displayValue || '-';
    const todayNum = today === 'E' ? 0 : parseInt(today) || 0;
    const todayCls = isNaN(todayNum) ? '' : todayNum < 0 ? 'golf-under' : todayNum > 0 ? 'golf-over' : 'golf-even';
    const holes    = p.linescores?.[round - 1]?.linescores?.length || 0;
    const status   = playerRoundStatus(p, round);
    const thruHTML = status === 'finished'
      ? `<span class="golf-thru-done">F</span>`
      : status === 'live'
      ? `<span class="golf-thru-live">● ${holes}</span>`
      : `<span class="golf-thru-pre">-</span>`;
    const pos3 = parseInt(rawPos); const isTop3 = pos3 >= 1 && pos3 <= 3;
    const extraCls = (opts.cut ? ' golf-row-cut-player' : '') + (isTop3 ? ' golf-row-top3' : '');
    return `<div class="golf-player-row${extraCls}">
      <span class="gc-pos ${isTop3 ? 'gc-pos-top' : ''}">${esc(posDisp)}</span>
      <span class="gc-name">${esc(name)}</span>
      <span class="gc-score ${scoreCls}">${esc(total)}</span>
      <span class="gc-today ${todayCls}">${esc(today)}</span>
      <span class="gc-thru">${thruHTML}</span>
    </div>`;
  };

  // Detect cut: look for players with status indicating missed cut
  const isCutPlayer = p => {
    const st = (p.status?.type?.abbreviation || p.status?.type?.name || p.status?.displayValue || '').toUpperCase();
    return st === 'CUT' || st === 'MC' || st === 'WD' || st === 'DQ';
  };
  const cutExists = [...activeG, ...upcomingGroups].some(g => g.players.some(isCutPlayer));
  let cutShown = false;

  let inner = '';
  for (const group of activeG) {
    const players   = [...group.players].sort((a, b) => (+a.order || 9999) - (+b.order || 9999));
    const statuses  = players.map(p => playerRoundStatus(p, round));
    const groupLive = statuses.some(s => s === 'live');
    const groupDone = statuses.every(s => s === 'finished');
    const nineLabel = group.nine === 'back' ? ' · Hole 10' : group.nine === 'front' ? ' · Hole 1' : '';
    const sepLabel  = groupLive ? `● LIVE${nineLabel}` : groupDone ? `✓ F` : `⏰ ${formatTeeTime(group.time)}${nineLabel}`;
    const sepCls    = groupLive ? 'golf-group-lb-sep golf-group-lb-sep-live'
                    : groupDone ? 'golf-group-lb-sep golf-group-lb-sep-done'
                    :             'golf-group-lb-sep golf-group-lb-sep-pre';
    inner += `<div class="${sepCls}">${esc(sepLabel)}</div>`;
    for (const p of players) {
      const cut = isCutPlayer(p);
      if (cut && !cutShown) {
        inner += `<div class="golf-cut-line">✂ Cut Line</div>`;
        cutShown = true;
      }
      inner += makeRow(p, { cut });
    }
  }
  for (const group of upcomingGroups) {
    const players = [...group.players].sort((a, b) => (+a.order || 9999) - (+b.order || 9999));
    inner += `<div class="golf-group-lb-sep golf-group-lb-sep-pre">⏰ ${esc(formatTeeTime(group.time))}</div>`;
    inner += players.map(p => makeRow(p)).join('');
  }

  return `<div class="golf-leaderboard">
    <div class="golf-lb-hdr">
      <span class="gc-pos">POS</span>
      <span class="gc-name">PLAYER</span>
      <span class="gc-score">TOTAL</span>
      <span class="gc-today">RD${round}</span>
      <span class="gc-thru">THRU</span>
    </div>
    ${inner}
  </div>`;
}

async function loadGolfLeaderboard() {
  const seq  = _loadSeq;
  const area = document.getElementById('golf-leaderboard-area');
  if (!area) return;
  if (!area.querySelector('.golf-tournament')) {
    area.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Loading golf…</p></div>';
  }
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
        const espnRound = comp.status?.period || 1;
        const pickOv  = GOLF_PAIRINGS_OVERRIDE[ev.id];
        const round   = (pickOv && pickOv.date === dateStrLocal(0)) ? pickOv.round : espnRound;
        const isLive  = state === 'in';
        const isFinal = state === 'post' || comp.status?.type?.completed;
        const venue   = comp.venue?.fullName || '';
        const city    = comp.venue?.address?.city || '';
        const statusTxt = isLive  ? `<span class="live-badge pulse">LIVE</span> Round ${round}`
                        : isFinal ? `<span class="fin-badge">FINAL</span>`
                        :           `Round ${round} · Upcoming`;
        const allComp = comp.competitors || [];
        const players = [...allComp].sort((a, b) => (+a.order||999) - (+b.order||999));
        if (!players.length) continue;

        // Groups: players with hole data (split-tee correct); upcoming: grouped by tee time (approx.)
        const { groups, upcomingGroups } = groupByTeeTime(allComp, round, ev.id);

        // Live groups first (by best leaderboard position), finished groups at the bottom (by tee time)
        const bestPos = g => Math.min(...g.players.map(p => parseInt(p.order) || 9999));
        const liveG   = groups.filter(g =>  g.players.some(p => playerRoundStatus(p, round) === 'live'))
                              .sort((a, b) => bestPos(a) - bestPos(b));
        const doneG   = groups.filter(g =>  g.players.every(p => playerRoundStatus(p, round) === 'finished'))
                              .sort((a, b) => new Date(a.time) - new Date(b.time));
        const activeG = [...liveG, ...doneG];

        // Leader score for the header
        const sortedAll = [...allComp].sort((a, b) => (+a.order||999) - (+b.order||999));
        const leader = sortedAll[0];
        const leaderName  = leader?.athlete?.shortName || leader?.athlete?.displayName || '';
        const leaderScore = leader?.score || 'E';
        const leaderNum   = leaderScore === 'E' ? 0 : parseInt(leaderScore) || 0;
        const leaderCls   = leaderNum < 0 ? 'golf-under' : leaderNum > 0 ? 'golf-over' : 'golf-even';
        const leaderHTML  = leaderName && (isLive || isFinal)
          ? `<span class="golf-leader-tag"><span class="${leaderCls}">${esc(leaderScore)}</span> ${esc(leaderName.split(' ').pop())}</span>` : '';

        html += `<div class="golf-tournament">
          <div class="golf-tourn-header">
            <div class="golf-tourn-name">${tour.icon} ${esc(ev.name || ev.shortName || tour.label)} ${leaderHTML}</div>
            <div class="golf-tourn-meta">${statusTxt}${venue ? ` · ${esc(venue)}` : ''}${city ? `, ${esc(city)}` : ''}</div>
          </div>
          ${renderGroupedLeaderboard(activeG, upcomingGroups, round)}
        </div>`;
      }
    }
    if (_loadSeq !== seq) return;
    area.innerHTML = html || '<div class="empty-state"><p>No active golf tournaments right now.</p><p class="muted">Check back when a PGA/LPGA/DP World Tour event is in progress.</p></div>';
    const t = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone: getUserTZ() });
    setConn('connected', `Golf updated ${t} · refreshes every 30s`);
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
  const holes    = p.linescores?.[round - 1]?.linescores?.length || 0;
  const thru     = holes === 18 ? 'F' : holes > 0 ? String(holes) : (p.status?.displayValue || '-');
  const today    = p.linescores?.[round - 1]?.displayValue || '-';
  const todayNum = today === 'E' ? 0 : parseInt(today);
  const todayCls = isNaN(todayNum) ? '' : todayNum < 0 ? 'golf-under' : todayNum > 0 ? 'golf-over' : 'golf-even';
  const pos      = p.order ? String(p.order) : '-';
  const rndStatus = playerRoundStatus(p, round);
  if (rndStatus === 'upcoming' && total === 'E') {
    return `<div class="golf-player-row golf-row-upcoming">
      <span class="gc-pos">${esc(pos)}</span>
      <span class="gc-name">${esc(name)}</span>
      <span class="gc-score golf-even">-</span>
      <span class="gc-today">-</span>
      <span class="gc-thru golf-thru-upcoming">⏰</span>
    </div>`;
  }
  return `<div class="golf-player-row">
    <span class="gc-pos">${esc(pos)}</span>
    <span class="gc-name">${esc(name)}</span>
    <span class="gc-score ${scoreCls}">${esc(total)}</span>
    <span class="gc-today ${todayCls}">${esc(today)}</span>
    <span class="gc-thru ${thru === 'F' ? 'golf-thru-done' : ''}">${esc(thru)}</span>
  </div>`;
}

// ── GOLF 2-BALL PICKS ─────────────────────────────────────────
// isFinal: tournament is complete — don't record picks (prevents stale picks appearing in today's ticket)
function buildGolfGroupPickCard(group, round, isLive, tourKey, eventId, isFinal = false) {
  const players = group.players.slice(0, 3);
  if (players.length < 2) return '';

  // ── Stat extractors — broad regex to catch ESPN's varying abbreviation formats ──
  const getSA = p => {
    const s = p.statistics?.find(x => /^(SA|AVG|scoringAverage|scoring.avg|avg)$/i.test(x.abbreviation||x.name||''));
    return s ? parseFloat(s.displayValue) || 0 : 0;
  };
  const getOWGR = p => {
    const s = p.statistics?.find(x => /owgr|world.*rank|worldRank|officialWorld/i.test(x.abbreviation||x.name||''));
    return s ? parseInt(s.displayValue) || 0 : 0;
  };
  const getTodayNum = p => {
    const t = p.linescores?.[round-1]?.displayValue;
    return t ? (t === 'E' ? 0 : parseInt(t) || 0) : null;
  };
  // SG: Total — ESPN uses sgTotal, SGT, sg:total, strokesGainedTotal, SG:T
  const getSGT = p => {
    const s = p.statistics?.find(x => /^(sgt|sg[:\-.]?t(otal)?|strokesGainedTotal|sg.*tee.*green)$/i.test(x.abbreviation||x.name||''));
    return s ? parseFloat(s.displayValue) : null;
  };
  // SG: Approach — sgApp, SGA, sg:app, strokesGainedApproach
  const getSGApp = p => {
    const s = p.statistics?.find(x => /^(sga|sg[:\-.]?app(roach)?|strokesGainedApp)$/i.test(x.abbreviation||x.name||''));
    return s ? parseFloat(s.displayValue) : null;
  };
  // Greens In Regulation % — reliable backup when SG unavailable
  const getGIR = p => {
    const s = p.statistics?.find(x => /^(gir|greens?(InReg)?|girPct)$/i.test(x.abbreviation||x.name||''));
    return s ? parseFloat(s.displayValue) : null;
  };
  // Putts per round — lower = better
  const getPutts = p => {
    const s = p.statistics?.find(x => /^(putts?PerRound|ppr|avgPutts?)$/i.test(x.abbreviation||x.name||''));
    return s ? parseFloat(s.displayValue) : null;
  };

  const avgSA = players.reduce((s,p) => s + (getSA(p)||70), 0) / players.length;
  const avgGIR = (() => {
    const vals = players.map(p => getGIR(p)).filter(v => v !== null);
    return vals.length ? vals.reduce((a,b) => a+b, 0) / vals.length : null;
  })();
  const avgPutts = (() => {
    const vals = players.map(p => getPutts(p)).filter(v => v !== null);
    return vals.length ? vals.reduce((a,b) => a+b, 0) / vals.length : null;
  })();

  // Determine group state BEFORE scoring so we know if pick should be locked
  const statuses     = players.map(p => playerRoundStatus(p, round));
  const groupStarted = statuses.some(s => s === 'live' || s === 'finished');
  const pickId       = normGolfPickId(eventId, group.time, group.nine, group.overrideIdx, group.overrideDate);
  const ttPickId     = normGolfPickId(eventId, group.time, group.nine);
  const oldPickId    = group.time ? `golf_${eventId}_${group.time.replace(/\D/g,'')}` : null;
  const allPicksNow2 = getPicks();
  const groupLastNames = players.map(p =>
    (p.athlete?.shortName || p.athlete?.displayName || '').split(' ').pop().toLowerCase()
  );
  const validatePick = p => {
    if (!p) return null;
    const s = ((p.team || '') + ' ' + (p.matchup || '')).toLowerCase();
    return groupLastNames.some(ln => ln && s.includes(ln)) ? p : null;
  };
  const existingPick = validatePick(allPicksNow2[pickId])
    || validatePick(allPicksNow2[ttPickId])
    || (oldPickId ? validatePick(allPicksNow2[oldPickId]) : null);

  const scored = players.map(p => {
    const sa       = getSA(p);
    const owgr     = getOWGR(p);
    const pos      = parseInt(p.order) || 999;
    const todayNum = getTodayNum(p);
    const gir      = getGIR(p);
    const putts    = getPutts(p);
    let score = 0;
    const factors = [];

    // 1. OWGR world ranking
    const owgrPts = owgr > 0 && owgr <= 5 ? 4 : owgr <= 15 ? 3 : owgr <= 40 ? 2 : owgr <= 100 ? 1 : 0;
    if (owgrPts > 0) { score += owgrPts; factors.push(`W${owgr}`); }

    // 2. Tournament leaderboard position
    const posPts = pos <= 3 ? 5 : pos <= 10 ? 4 : pos <= 25 ? 3 : pos <= 50 ? 2 : pos <= 80 ? 1 : 0;
    if (posPts > 0 && pos < 999) { score += posPts; factors.push(`#${pos}`); }

    // 3. Season scoring average vs group
    if (sa > 0 && avgSA > 0) {
      const diff = sa - avgSA;
      if (diff < -0.5) { score += 3; factors.push(`${sa.toFixed(1)} avg`); }
      else if (diff < -0.2) { score += 2; factors.push(`${sa.toFixed(1)} avg`); }
      else if (diff < 0)    { score += 1; factors.push(`${sa.toFixed(1)} avg`); }
    }

    // 4. Previous rounds — weight most recent round 2x, older rounds 1x
    const roundScores = [];
    for (let r = 1; r < round; r++) {
      const rv = p.linescores?.[r - 1]?.displayValue;
      if (!rv || rv === '-') continue;
      const rn = rv === 'E' ? 0 : parseInt(rv);
      if (!isNaN(rn)) roundScores.push({ score: rn, weight: r === round - 1 ? 2 : 1 });
    }
    const underParWeighted = roundScores.filter(r => r.score < 0).reduce((a,r) => a + r.weight, 0);
    if (underParWeighted >= 3)     { score += 3; factors.push(`${roundScores.filter(r=>r.score<0).length}× under`); }
    else if (underParWeighted >= 2){ score += 2; factors.push(`${roundScores.filter(r=>r.score<0).length}× under`); }
    else if (underParWeighted >= 1){ score += 1; factors.push('prev. under'); }
    // Trajectory: most recent round better than the one before
    if (roundScores.length >= 2) {
      const last = roundScores[roundScores.length - 1].score;
      const prev = roundScores[roundScores.length - 2].score;
      if (last < prev - 1) { score += 2; factors.push('↑ trending'); }
      else if (last > prev + 1) { score -= 1; factors.push('↓ fading'); }
    }

    // 5. Strokes Gained — most predictive stat; broad regex catches ESPN variations
    const sgt  = getSGT(p);
    const sgApp = getSGApp(p);
    if (sgt !== null) {
      if (sgt >= 2.0)      { score += 4; factors.push(`SGT +${sgt.toFixed(1)}`); }
      else if (sgt >= 1.0) { score += 3; factors.push(`SGT +${sgt.toFixed(1)}`); }
      else if (sgt >= 0.3) { score += 2; factors.push(`SGT +${sgt.toFixed(1)}`); }
      else if (sgt >= 0)   { score += 1; }
      else if (sgt < -1.0) { score -= 1; }
    }
    if (sgApp !== null && sgt === null) {
      if (sgApp >= 1.5)      { score += 3; factors.push(`SGA +${sgApp.toFixed(1)}`); }
      else if (sgApp >= 0.5) { score += 2; factors.push(`SGA +${sgApp.toFixed(1)}`); }
      else if (sgApp >= 0)   { score += 1; }
    }

    // 6. GIR % — greens in regulation is reliable when SG isn't available
    if (gir !== null && avgGIR !== null) {
      const girDiff = gir - avgGIR;
      if (girDiff >= 8)      { score += 2; factors.push(`GIR ${gir.toFixed(0)}%`); }
      else if (girDiff >= 4) { score += 1; factors.push(`GIR ${gir.toFixed(0)}%`); }
      else if (girDiff < -6) { score -= 1; }
    }

    // 7. Putts per round — fewer putts = better; lower is better
    if (putts !== null && avgPutts !== null) {
      const puttDiff = putts - avgPutts;
      if (puttDiff < -0.5)    { score += 1; factors.push(`${putts.toFixed(1)} putts`); }
      else if (puttDiff > 0.5){ score -= 1; }
    }

    const total    = p.score || 'E';
    const totalNum = total === 'E' ? 0 : parseInt(total) || 0;
    return { p, score, factors, sa, pos, total, totalNum, todayNum };
  });

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  const pickName = winner.p.athlete?.shortName || winner.p.athlete?.displayName || '?';

  // 2-ball confidence: lower thresholds since it's head-to-head not 3-way
  const gap  = winner.score - (scored[1]?.score || 0);
  const conf = gap >= 3 ? 3 : gap >= 1 ? 2 : 1;

  // Record pick only for active/in-progress tournaments — not for completed events from prior weeks.
  // force=false means existing picks are never overwritten (locked pre-round picks stay intact).
  const matchup = players.map(p => (p.athlete?.shortName||'-').split(' ').pop()).join(' v ');
  if (!isFinal) recordPick(pickId, pickName.split(' ').pop(), matchup, 'golf', conf);

  // Display: if group has started, show the stored pre-round pick at the top
  const storedLastName = (existingPick?.team || '').toLowerCase();
  const displayScored  = groupStarted && storedLastName
    ? [...scored].sort((a, b) => {
        const aL = (a.p.athlete?.shortName || '').split(' ').pop().toLowerCase();
        const bL = (b.p.athlete?.shortName || '').split(' ').pop().toLowerCase();
        return (aL === storedLastName ? -1 : bL === storedLastName ? 1 : 0);
      })
    : scored;

  const displayPick = displayScored[0];
  const displayName = existingPick ? existingPick.team : pickName.split(' ').pop();
  const displayConf  = existingPick ? (existingPick.conf || conf) : conf;
  const confDots = `<span class="tp-conf tp-conf-${displayConf}">${'●'.repeat(displayConf)}${'○'.repeat(3-displayConf)}</span>`;

  // Auto-resolve when all players in the group have finished the round (18 holes)
  const allDone = players.every(p => playerRoundStatus(p, round) === 'finished');
  if (allDone && existingPick) {
    const parseRndScore = p => {
      const v = p.linescores?.[round-1]?.displayValue;
      if (!v || v === '-') return 999;
      if (v === 'E') return 0;
      const n = parseInt(v);
      return isNaN(n) ? 999 : n;
    };
    const bestScore = Math.min(...players.map(parseRndScore));
    const pickWon = bestScore < 999 && players.some(p => {
      if (parseRndScore(p) !== bestScore) return false;
      const ln = (p.athlete?.shortName || p.athlete?.displayName || '').split(' ').pop().toLowerCase();
      return ln === storedLastName;
    });
    const todayDateStr = dateStrLocal();
    const allPicksNow = getPicks();
    const thisPick = allPicksNow[pickId];
    if (thisPick && (thisPick.result === null || existingPick.date === todayDateStr)) {
      thisPick.result = pickWon ? 'win' : 'loss';
      savePicks(allPicksNow);
      updatePicksDisplay();
    }
  }

  const rows = displayScored.map(({ p, score, factors, total, totalNum, todayNum }, idx) => {
    const name  = p.athlete?.shortName || p.athlete?.displayName || '-';
    const lastName = name.split(' ').pop().toLowerCase();
    const holes = p.linescores?.[round-1]?.linescores?.length || 0;
    const thru  = holes === 18 ? 'F' : holes > 0 ? String(holes) : '-';
    const scoreCls = totalNum < 0 ? 'golf-under' : totalNum > 0 ? 'golf-over' : 'golf-even';
    const todayStr = todayNum !== null ? (todayNum > 0 ? `+${todayNum}` : todayNum === 0 ? 'E' : String(todayNum)) : '-';
    const isPick = idx === 0;
    const owgr   = getOWGR(p);
    const owgrTag = owgr > 0 ? `<span class="golf-pick-owgr">W${owgr}</span>` : '';
    const chips  = factors.map(f => `<span class="golf-pick-chip">${esc(f)}</span>`).join('');
    return `<div class="golf-pick-row ${isPick ? 'golf-pick-winner' : ''}">
      ${isPick ? '<span class="golf-pick-arrow">→</span>' : '<span class="golf-pick-arrow"></span>'}
      <span class="golf-pick-name">${esc(name)}${owgrTag}</span>
      <span class="golf-pick-score ${scoreCls}">${esc(total)}</span>
      <span class="golf-pick-today">${esc(todayStr)}</span>
      <span class="golf-pick-thru">${esc(thru)}</span>
      <span class="golf-pick-factors">${chips}</span>
    </div>`;
  });

  const preLabel = groupStarted && existingPick ? ' <span class="golf-pick-pre-label">pre-round</span>' : '';
  return `<div class="golf-pick-card">
    <div class="golf-pick-time">⏰ ${group.time ? esc(formatTeeTime(group.time)) : 'In Progress'}</div>
    <div class="golf-pick-hdr"><span></span><span>PLAYER</span><span>TOT</span><span>TODAY</span><span>THRU</span><span>FACTORS</span></div>
    ${rows.join('')}
    <div class="golf-pick-verdict-bar">
      <span class="golf-pick-verdict-name">→ ${esc(displayName)}</span>
      ${confDots}${preLabel}
    </div>
  </div>`;
}

async function loadGolfPicksPage(tab = _golfPicksTab) {
  _golfPicksTab = tab;
  const seq  = _loadSeq;
  const area = document.getElementById('mlb-picks-area');

  const tabBar = `<div class="picks-tab-bar">
    <button class="golf-tab${tab==='yesterday'?' active':''}" onclick="loadGolfPicksPage('yesterday')">Yesterday</button>
    <button class="golf-tab${tab==='today'   ?' active':''}" onclick="loadGolfPicksPage('today')">Today</button>
    <button class="golf-tab${tab==='tomorrow'?' active':''}" onclick="loadGolfPicksPage('tomorrow')">Tomorrow</button>
  </div>`;
  area.innerHTML = tabBar + '<div class="loading-spinner"><div class="spinner"></div><p>Loading golf groups…</p></div>';

  try {
    // ESPN scoreboard ignores ?dates= and always returns the current tournament state.
    // Single fetch for all tabs; derive yesterday/today/tomorrow from round offsets.
    const results = await Promise.allSettled(GOLF_TOURS.map(t =>
      fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/${t.key}/scoreboard`).then(r => r.json())
    ));

    let html = '';
    const note = '<div class="pc-data-note">2-ball picks · world ranking · scoring avg · GIR · SG when available</div>';

    for (let i = 0; i < GOLF_TOURS.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      const data = results[i].value;
      const tour = GOLF_TOURS[i];

      for (const ev of (data.events || [])) {
        const comp    = ev.competitions?.[0]; if (!comp) continue;
        const round   = comp.status?.period || 1;
        const state   = comp.status?.type?.state || '';
        const isLive  = state === 'in';
        const allComp = comp.competitors || [];

        if (tab === 'yesterday') {
          const prevRound = round - 1;
          if (prevRound < 1) continue;
          // Round-specific tee times aren't stored in ESPN data for past rounds,
          // so we can't reconstruct who played together. Show a score leaderboard instead.
          const finishers = allComp.filter(p => {
            const holes = p.linescores?.[prevRound - 1]?.linescores?.length || 0;
            return holes >= 18;
          }).sort((a, b) => {
            const vA = a.linescores?.[prevRound-1]?.displayValue;
            const vB = b.linescores?.[prevRound-1]?.displayValue;
            const nA = !vA || vA === '-' ? 999 : vA === 'E' ? 0 : parseInt(vA) || 0;
            const nB = !vB || vB === '-' ? 999 : vB === 'E' ? 0 : parseInt(vB) || 0;
            return nA - nB;
          });
          if (!finishers.length) continue;
          const rows = finishers.slice(0, 20).map(p => {
            const name   = p.athlete?.shortName || p.athlete?.displayName || '-';
            const rv     = p.linescores?.[prevRound-1]?.displayValue || '-';
            const rn     = rv === 'E' ? 0 : parseInt(rv) || 0;
            const rCls   = rn < 0 ? 'golf-under' : rn > 0 ? 'golf-over' : 'golf-even';
            const total  = p.score || 'E';
            const tn     = total === 'E' ? 0 : parseInt(total) || 0;
            const tCls   = tn < 0 ? 'golf-under' : tn > 0 ? 'golf-over' : 'golf-even';
            const pos    = p.order ? `#${p.order}` : '-';
            return `<div class="golf-yday-row">
              <span class="golf-yday-pos">${esc(pos)}</span>
              <span class="golf-yday-name">${esc(name)}</span>
              <span class="golf-yday-rnd ${rCls}">${esc(rv)}</span>
              <span class="golf-yday-tot ${tCls}">${esc(total)}</span>
            </div>`;
          }).join('');
          html += `<div class="golf-picks-section">
            <div class="golf-picks-event-hdr">${tour.icon} ${esc(ev.name || tour.label)} · Round ${prevRound} Results · <span class="golf-tmrw-label">Yesterday</span></div>
            <div class="golf-yday-hdr"><span>POS</span><span>PLAYER</span><span>RND</span><span>TOT</span></div>
            ${rows}
          </div>`;

        } else if (tab === 'today') {
          const isFinal = state === 'post' || comp.status?.type?.completed;
          // Mark tournament active only when there's a live or upcoming event today
          if (!isFinal) _golfTournamentActive = true;

          const todayOv = GOLF_PAIRINGS_OVERRIDE[ev.id];
          const roundForGroups = (todayOv && todayOv.date === dateStrLocal(0)) ? todayOv.round : round;
          const { groups, upcomingGroups } = groupByTeeTime(allComp, roundForGroups, ev.id);

          // Collect pickIds that are already displayed via current groups
          const shownPickIds = new Set([...groups, ...upcomingGroups].flatMap(g => {
            const ids = [normGolfPickId(ev.id, g.time, g.nine, g.overrideIdx, g.overrideDate)];
            // Also mark the tee-time-based ID as shown so old stored picks aren't double-rendered
            if (g.overrideIdx !== undefined) ids.push(normGolfPickId(ev.id, g.time, g.nine));
            if (g.time) ids.push(`golf_${ev.id}_${g.time.replace(/\D/g,'')}`);
            return ids;
          }));

          // Earlier groups: stored pre-round picks from today whose groups no longer have
          // valid tee times in the API (ESPN overwrote p.teeTime with next-round pairings).
          const todayStr2 = dateStrLocal(0);
          const earlierPicks = Object.entries(getPicks()).filter(([id, p]) =>
            p.sport === 'golf' && p.date === todayStr2 && p.team &&
            id.startsWith(`golf_${ev.id}_`) && !id.includes('_fb_') && !shownPickIds.has(id)
          );

          if (!groups.length && !upcomingGroups.length && !earlierPicks.length) continue;

          const preHdr = upcomingGroups.length > 0
            ? `<div class="golf-group-status-hdr">⏰ Pre-Round - ${upcomingGroups.length} group${upcomingGroups.length !== 1 ? 's' : ''}</div>` : '';

          const earlierHTML = earlierPicks.length
            ? `<div class="golf-group-status-hdr">⏳ Earlier Groups - picks locked pre-round</div>` +
              earlierPicks.map(([, p]) => {
                const conf = p.conf || 1;
                const dots = `<span class="tp-conf tp-conf-${conf}">${'●'.repeat(conf)}${'○'.repeat(3-conf)}</span>`;
                const result = p.result === 'win' ? ' <span class="pick-win">✓</span>' : p.result === 'loss' ? ' <span class="pick-loss">✗</span>' : '';
                return `<div class="golf-pick-card golf-pick-card-locked">
                  <div class="golf-pick-verdict-bar">
                    <span class="golf-pick-verdict-name">→ ${esc(p.team)}${result}</span>
                    ${dots}
                    <span class="golf-pick-pre-label">pre-round</span>
                  </div>
                  <div class="golf-pick-matchup-small">${esc(p.matchup || '')}</div>
                </div>`;
              }).join('')
            : '';

          html += `<div class="golf-picks-section">
            <div class="golf-picks-event-hdr">${tour.icon} ${esc(ev.name || tour.label)} · Round ${roundForGroups} ${isLive ? '<span class="live-badge">LIVE</span>' : ''}</div>
            ${groups.map(g => buildGolfGroupPickCard(g, roundForGroups, isLive, tour.key, ev.id, isFinal)).join('')}
            ${preHdr}
            ${upcomingGroups.map(g => buildGolfGroupPickCard(g, roundForGroups, isLive, tour.key, ev.id, isFinal)).join('')}
            ${earlierHTML}
          </div>`;

        } else if (tab === 'tomorrow') {
          const nextRound = round + 1;
          const tmrwDateStr = dateStr(1); // "YYYY-MM-DD"
          // Only include teeTime values whose date portion is actually tomorrow.
          // p.teeTime during an active round is today's time - filtering by date
          // prevents showing today's groups in the tomorrow tab.
          const teeMap = new Map();
          for (const p of allComp) {
            const t = p.teeTime || '';
            if (!t) continue;
            if (t.substring(0, 10) !== tmrwDateStr) continue; // skip today's or past tee times
            if (!teeMap.has(t)) teeMap.set(t, { time: t, nine: 'unknown', players: [], upcoming: true });
            teeMap.get(t).players.push(p);
          }
          const validGroups = [...teeMap.values()]
            .filter(g => g.players.length >= 2)
            .sort((a, b) => new Date(a.time) - new Date(b.time));

          if (!validGroups.length) {
            html += `<div class="golf-picks-section">
              <div class="golf-picks-event-hdr golf-tmrw-hdr">${tour.icon} ${esc(ev.name || tour.label)} · Round ${nextRound} · <span class="golf-tmrw-label">Tomorrow</span></div>
              <div class="empty-state muted" style="padding:12px">Pairings not yet released for Round ${nextRound}.</div>
            </div>`;
            continue;
          }
          html += `<div class="golf-picks-section">
            <div class="golf-picks-event-hdr golf-tmrw-hdr">${tour.icon} ${esc(ev.name || tour.label)} · Round ${nextRound} · <span class="golf-tmrw-label">Tomorrow</span></div>
            ${validGroups.map(g => buildGolfGroupPickCard(g, nextRound, false, tour.key, ev.id)).join('')}
          </div>`;
        }
      }
    }

    if (_loadSeq !== seq) return;
    area.innerHTML = tabBar + note + (html || `<div class="empty-state"><p>No golf groups for ${tab}.</p><p class="muted">Picks appear when a tournament is in progress or tee times are posted.</p></div>`);
    updatePicksDisplay();
  } catch (err) {
    area.innerHTML = tabBar + `<div class="error-state"><div class="error-icon">⚠</div><p>Could not load golf: ${esc(err.message)}</p></div>`;
  }
}

// ── MLB FULL STANDINGS + STAT LEADERS ───────────────────────
let _mlbStandData = null;
let _mlbLeadData  = null;

async function loadMLBFullStandings() {
  const seq = _loadSeq;
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
    if (_loadSeq !== seq) return;
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
  const seq = _loadSeq;
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
      if (_loadSeq !== seq) return;
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
// Hard reload: picks up new JS/CSS code AND refreshes all live data
function refresh() {
  window.location.replace(window.location.pathname + '?_r=' + Date.now());
}


// ── SIMPLE VIEW (Picks of the Day) ───────────────────────────
const SPORT_ICONS  = { tennis:'🎾', mlb:'⚾', nba:'🏀', wnba:'🏀', nfl:'🏈', nhl:'🏒', soccer:'⚽', golf:'⛳' };
const SPORT_LABELS = { tennis:'Tennis', mlb:'Baseball', nba:'NBA', wnba:'WNBA', nfl:'Football', nhl:'Hockey', soccer:'Soccer', golf:'Golf' };

let _svPreloadedAt = 0;   // timestamp of last completed preload (0 = never)

// ── SUPABASE SYNC ─────────────────────────────────────────────────────────────
// Anon key is safe in frontend - read + insert only, protected by RLS.
// Service role key is NEVER stored here. First-build-wins: once a ticket is
// written for a date, ignore-duplicates prevents any overwrite.
const _SB_URL = 'https://xxbymjminigvhfetfvwe.supabase.co';
const _SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4Ynltam1pbmlndmhmZXRmdndlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NzA3ODYsImV4cCI6MjA5NTE0Njc4Nn0.oVz5wqtrOKeCEVhCGvuSsOHAEzsGEMjvaTYSnehPT1M';
const _sbClient = supabase.createClient(_SB_URL, _SB_KEY);

async function _sbGetTickets(date) {
  try {
    const url = `${_SB_URL}/rest/v1/baseline_tickets?date=in.(${encodeURIComponent(date+'_day')},${encodeURIComponent(date+'_night')})&select=date,morn_legs,eve_legs`;
    const res = await fetch(url, { headers: { apikey: _SB_KEY, Authorization: `Bearer ${_SB_KEY}` } });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    const day   = rows.find(r => r.date === date + '_day');
    const night = rows.find(r => r.date === date + '_night');
    return { morn: day?.morn_legs || null, eve: night?.eve_legs || null };
  } catch { return null; }
}

async function _sbSaveTicket(date, slot, legs) {
  // slot: 'day' | 'night' - stored as separate rows so no UPDATE needed
  try {
    const { data: { session } } = await _sbClient.auth.getSession();
    if (!session) return; // must be signed in as admin to write tickets
    const row = slot === 'day'
      ? { date: date + '_day',   morn_legs: legs, eve_legs: null }
      : { date: date + '_night', morn_legs: null, eve_legs: legs };
    await fetch(`${_SB_URL}/rest/v1/baseline_tickets`, {
      method: 'POST',
      headers: {
        apikey: _SB_KEY, Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates'  // first build wins - never overwrites
      },
      body: JSON.stringify(row)
    });
  } catch {}
}

// After admin signs in, push any locally-built tickets that aren't yet in Supabase.
// This handles the race where buildSplitTicketsIfNeeded ran before auth completed.
let _ticketSyncedThisSession = false;
async function _trySyncTicketsToSupabase() {
  if (_ticketSyncedThisSession) return;
  _ticketSyncedThisSession = true;
  const today = dateStrLocal();
  try {
    const sbData = await _sbGetTickets(today);
    const morn = _morningTicketCache || JSON.parse(localStorage.getItem(_MORN_TICKET_KEY) || 'null');
    const eve  = _eveningTicketCache || JSON.parse(localStorage.getItem(_EVE_TICKET_KEY)  || 'null');
    if (morn?.date === today && !sbData?.morn) _sbSaveTicket(today, 'day',   morn.legs);
    if (eve?.date  === today && !sbData?.eve)  _sbSaveTicket(today, 'night', eve.legs);
  } catch {}
}

// Fetch yesterday's tickets from Supabase and cache them in localStorage.
// Called during preload (so Yesterday tab works immediately) and on-demand when
// the tab is clicked and localStorage is empty (e.g. first visit on this device).
async function _fetchAndCacheYesterdayTickets(date) {
  try {
    const sbYst = await _sbGetTickets(date);
    let changed = false;
    if (sbYst?.morn) {
      try { localStorage.setItem(_YST_MORN_TICKET_KEY, JSON.stringify({ date, legs: sbYst.morn })); changed = true; } catch {}
    }
    if (sbYst?.eve) {
      try { localStorage.setItem(_YST_EVE_TICKET_KEY, JSON.stringify({ date, legs: sbYst.eve })); changed = true; } catch {}
    }
    if (changed && S.sport === 'tickets' && _ticketDateOffset === -1) renderTicketsPage();
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────

// ── AUTH STATE ───────────────────────────────────────────────────────────────
let _currentUser     = null;
let _currentUserRole = null;  // 'free' | 'paid' | 'admin' | null (not yet loaded)
let _authReady       = false; // true after first onAuthStateChange fires

function _hasFullAccess() {
  return _currentUserRole === 'paid' || _currentUserRole === 'admin';
}
function _isAdmin() {
  return _currentUserRole === 'admin';
}

const _ROLE_CACHE_KEY = '_usr_role_v1';

async function _fetchUserRole(userId) {
  // Apply cached role immediately so UI doesn't block while fetching
  try {
    const cached = JSON.parse(localStorage.getItem(_ROLE_CACHE_KEY) || 'null');
    if (cached?.id === userId) {
      _currentUserRole = cached.role;
      updateAuthUI();
    }
  } catch {}

  try {
    const { data: { session } } = await _sbClient.auth.getSession();
    const token = session?.access_token || _SB_KEY;
    const res = await fetch(
      `${_SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role&limit=1`,
      { headers: { apikey: _SB_KEY, Authorization: `Bearer ${token}` } }
    );
    if (res.ok) {
      const rows = await res.json();
      _currentUserRole = rows?.[0]?.role || 'free';
      localStorage.setItem(_ROLE_CACHE_KEY, JSON.stringify({ id: userId, role: _currentUserRole }));
    } else {
      if (_currentUserRole === null) _currentUserRole = 'free';
    }
  } catch {
    if (_currentUserRole === null) _currentUserRole = 'free';
  }
  updateAuthUI();
}

function updateAuthUI() {
  const signinBtn = document.getElementById('auth-signin-btn');
  const userInfo  = document.getElementById('auth-user-info');
  const emailChip = document.getElementById('auth-user-email');

  if (_currentUser) {
    if (signinBtn) signinBtn.style.display  = 'none';
    if (userInfo)  userInfo.style.display   = 'flex';
    if (emailChip) emailChip.textContent    = _currentUser.email || '';
    const manageBtn = document.getElementById('auth-manage-btn');
    if (manageBtn) manageBtn.style.display = _hasFullAccess() ? '' : 'none';
    const adminLink = document.getElementById('admin-topbar-link');
    if (adminLink) adminLink.style.display = _isAdmin() ? '' : 'none';
    // Re-enable Full App button if it was in "Checking…" state
    const fullBtn = document.querySelector('.sv-full-btn');
    if (fullBtn && fullBtn.disabled) { fullBtn.disabled = false; fullBtn.textContent = 'Full App →'; }
    // Banned users: lock the simple view with a suspension notice
    if (_currentUserRole === 'banned') {
      if (fullBtn) { fullBtn.style.display = 'none'; }
      const svContent = document.getElementById('sv-content');
      if (svContent) svContent.innerHTML = `<div class="sv-empty" style="color:#ff5252;font-size:1rem">Your account has been suspended.<br><span style="font-size:.8rem;color:#888">Contact support if you believe this is an error.</span></div>`;
      return;
    }
    // Paid/admin: always go straight to the full app
    if (_hasFullAccess()) {
      const sv = document.getElementById('simple-view');
      if (sv?.classList.contains('sv-active')) {
        document.body.classList.remove('simple-mode');
        sv.classList.remove('sv-active');
        localStorage.setItem('sv_dismissed', dateStrLocal());
      }
      // Admin: push any locally-built tickets that haven't reached Supabase yet
      if (_isAdmin()) _trySyncTicketsToSupabase();
    }
  } else {
    if (signinBtn) signinBtn.style.display  = 'block';
    if (userInfo)  userInfo.style.display   = 'none';
    const manageBtn = document.getElementById('auth-manage-btn');
    if (manageBtn) manageBtn.style.display = 'none';
    if (_authReady) {
      const sv = document.getElementById('simple-view');
      if (sv && !sv.classList.contains('sv-active')) showSimpleView();
    }
  }

  if (S.sport === 'tickets') renderTicketsPage();
  updateSvAuthBar();
}

function updateSvAuthBar() {
  const bar = document.getElementById('sv-auth-bar');
  if (!bar) return;
  if (!_authReady) return;
  if (!_currentUser) {
    bar.innerHTML = `<button class="sv-auth-btn" onclick="openAuthModal()">Sign In</button>`;
  } else {
    const email = _currentUser.email || '';
    const short = email.length > 18 ? email.slice(0, 16) + '…' : email;
    const subBtn = _hasFullAccess() ? '' : `<button class="sv-subscribe-btn" onclick="openUpgradeModal()">Subscribe</button>`;
    bar.innerHTML = `<span class="sv-signed-chip">● ${short}</span>${subBtn}<button class="sv-signout-small" onclick="signOut()">Sign Out</button>`;
  }
}

function initAuth() {
  _sbClient.auth.onAuthStateChange(async (event, session) => {
    _currentUser     = session?.user || null;
    _currentUserRole = null;
    _authReady       = true;

    if (_currentUser) {
      await _fetchUserRole(_currentUser.id);
    } else {
      updateAuthUI();
    }

    if (event === 'SIGNED_IN') {
      closeAuthModal();
    }
  });
}

// ── AUTH MODAL FUNCTIONS ─────────────────────────────────────────────────────
function openAuthModal() {
  showAuthForm();
  document.getElementById('auth-modal').classList.add('auth-open');
  setTimeout(() => document.getElementById('auth-email-input')?.focus(), 60);
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.remove('auth-open');
}

let _otpEmail = '';

function showAuthForm() {
  _otpEmail = '';
  const btn = document.getElementById('auth-submit-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Send Code'; }
  document.getElementById('auth-step-email').style.display = '';
  document.getElementById('auth-step-code').style.display  = 'none';
  document.getElementById('auth-error').style.display      = 'none';
  const inp = document.getElementById('auth-email-input');
  if (inp) inp.value = '';
}

async function sendOtpCode() {
  const inp   = document.getElementById('auth-email-input');
  const email = (inp?.value || '').trim();
  if (!email) { inp?.focus(); return; }

  const errEl = document.getElementById('auth-error');
  errEl.style.display = 'none';
  const btn = document.getElementById('auth-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const { error } = await _sbClient.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw error;
    _otpEmail = email;
    document.getElementById('auth-step-email').style.display = 'none';
    document.getElementById('auth-code-email').textContent   = email;
    document.getElementById('auth-step-code').style.display  = '';
    document.getElementById('auth-error').style.display      = 'none';
    setTimeout(() => document.getElementById('auth-code-input')?.focus(), 60);
  } catch (err) {
    errEl.textContent   = err.message || 'Something went wrong. Please try again.';
    errEl.style.display = '';
    if (btn) { btn.disabled = false; btn.textContent = 'Send Code'; }
  }
}

async function verifyOtpCode() {
  const inp  = document.getElementById('auth-code-input');
  const code = (inp?.value || '').trim().replace(/\s/g, '');
  if (!code || code.length < 6) { inp?.focus(); return; }

  const errEl = document.getElementById('auth-error');
  errEl.style.display = 'none';
  const btn = document.getElementById('auth-verify-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }

  try {
    const { error } = await _sbClient.auth.verifyOtp({ email: _otpEmail, token: code, type: 'email' });
    if (error) throw error;
    // onAuthStateChange handles the rest
  } catch (err) {
    errEl.textContent   = err.message || 'Invalid code. Please try again.';
    errEl.style.display = '';
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    if (inp) inp.value = '';
    inp?.focus();
  }
}

async function signOut() {
  localStorage.removeItem(_ROLE_CACHE_KEY);
  await _sbClient.auth.signOut();
}

// ── UPGRADE MODAL ────────────────────────────────────────────────────────────
// Opens admin panel in a named window — reuses the same tab on repeat clicks,
// never spawns duplicate tabs.
function openAdminPanel(e) {
  if (e) e.preventDefault();
  window.open('admin.html', 'baseline-admin');
}

function _resetCheckoutButtons() {
  ['weekly', 'monthly', 'yearly'].forEach(plan => {
    const btn = document.getElementById(`checkout-btn-${plan}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Subscribe'; }
  });
  const errEl = document.getElementById('upgrade-modal-error');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
}
function openUpgradeModal() {
  _resetCheckoutButtons();
  document.getElementById('upgrade-modal').classList.add('auth-open');
}
function closeUpgradeModal() {
  document.getElementById('upgrade-modal').classList.remove('auth-open');
  updateSvAuthBar(); // always refresh bar when modal closes
}

async function startCheckout(plan) {
  // Disable button immediately — everything else is inside try so it always re-enables on failure
  const btn = document.getElementById(`checkout-btn-${plan}`);
  const origText = btn ? btn.textContent : 'Subscribe';
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  const showErr = msg => {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
    const errEl = document.getElementById('upgrade-modal-error');
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; setTimeout(() => { errEl.style.display = 'none'; }, 6000); }
    else alert(msg);
  };

  try {
    const { data: { session } } = await _sbClient.auth.getSession();
    if (!session) {
      if (btn) { btn.disabled = false; btn.textContent = origText; }
      openAuthModal(); // sign-in slides in on top; upgrade modal stays behind it
      return;
    }

    const ctrl = new AbortController();
    const tmo  = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`${_SB_URL}/functions/v1/create-checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ plan }),
      signal: ctrl.signal,
    });
    clearTimeout(tmo);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.url)  throw new Error('No checkout URL returned. Please try again.');
    window.location.href = data.url;
  } catch (err) {
    showErr(err.name === 'AbortError' ? 'Request timed out. Please try again.' : 'Could not start checkout: ' + err.message);
  }
}

async function openPortal() {
  const { data: { session } } = await _sbClient.auth.getSession();
  if (!session) return;
  const btn = document.getElementById('auth-manage-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
  try {
    const ctrl = new AbortController();
    const tmo  = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`${_SB_URL}/functions/v1/create-portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      signal: ctrl.signal,
    });
    clearTimeout(tmo);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.url) window.location.href = data.url;
  } catch (err) {
    alert(err.name === 'AbortError' ? 'Request timed out. Please try again.' : 'Could not open subscription manager: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Manage Sub'; }
  }
}

async function _pollForPaidRole(attempts) {
  attempts = attempts || 0;
  if (attempts > 8) return; // give up after ~16s
  await _fetchUserRole(_currentUser?.id);
  if (_hasFullAccess()) return; // done
  setTimeout(() => _pollForPaidRole(attempts + 1), 2000);
}
// ─────────────────────────────────────────────────────────────────────────────

const _TICKET_KEY         = '_baseline_ticket_v10';
const _YST_TICKET_KEY     = '_baseline_yst_ticket_v10';
const _MORN_TICKET_KEY    = '_baseline_morn_v10';
const _EVE_TICKET_KEY     = '_baseline_eve_v10';
const _YST_MORN_TICKET_KEY = '_baseline_yst_morn_v10';
const _YST_EVE_TICKET_KEY  = '_baseline_yst_eve_v10';
let _dailyTicketCache   = null; // in-session lock - once set, never changes within this page load
let _morningTicketCache = null;
let _eveningTicketCache = null;

function getDailyTicket() {
  const today = dateStrLocal();
  // Return the in-memory copy if it's already locked for today
  if (_dailyTicketCache?.date === today) return _dailyTicketCache;
  try {
    const s = localStorage.getItem(_TICKET_KEY);
    if (!s) return null;
    const obj = JSON.parse(s);
    if (obj.date !== today) return null;
    _dailyTicketCache = obj; // freeze in memory - can't be rebuilt for the rest of this session
    return obj;
  } catch { return null; }
}

function getMorningTicket() {
  const today = dateStrLocal();
  if (_morningTicketCache?.date === today) return _morningTicketCache;
  try {
    const obj = JSON.parse(localStorage.getItem(_MORN_TICKET_KEY) || 'null');
    if (obj?.date === today) { _morningTicketCache = obj; return obj; }
  } catch {}
  return null;
}

function getEveningTicket() {
  const today = dateStrLocal();
  if (_eveningTicketCache?.date === today) return _eveningTicketCache;
  try {
    const obj = JSON.parse(localStorage.getItem(_EVE_TICKET_KEY) || 'null');
    if (obj?.date === today) { _eveningTicketCache = obj; return obj; }
  } catch {}
  return null;
}

// Returns true if this pick is for a game that starts at/after 5pm ET
function isEveningGame(p) {
  const sport = p.sport || '';
  if (['tennis', 'golf', 'soccer'].includes(sport)) return false;
  const gt = p.gameTime;
  if (!gt) return ['nba', 'wnba', 'nhl', 'nfl'].includes(sport); // fallback by sport
  try {
    const dt = new Date(gt);
    const utcH = dt.getUTCHours() + dt.getUTCMinutes() / 60;
    const etH  = (utcH - 4 + 24) % 24; // EDT = UTC-4 (close enough Apr–Nov)
    return etH >= 17; // 5pm ET cutoff: day ticket = before 5pm, night ticket = 5pm+
  } catch { return ['nba', 'wnba', 'nhl', 'nfl'].includes(sport); }
}

// Split the already-built combined ticket into morning/evening based on game time.
// Runs after buildDailyTicketIfNeeded - does not modify the combined ticket.
// Shared: score all today's picks into a candidate list (same logic as buildDailyTicketIfNeeded)
// ITF events below ~$60k prize money - not covered by major sports apps.
// Match on "W15", "W25", "W35", "W40", "M15", "M25" anywhere in the tournament name.
const _MINOR_ITF_RE = /\b[WM](?:15|25|35|40)\b/i;
function isMinorITFEvent(matchup) {
  return _MINOR_ITF_RE.test(matchup || '');
}

function _buildPickCandidates(allPicks, today) {
  const TIER_BONUS  = { slam: 10, masters: 5, '500': 2, '250': 0, chal: -1, itf: -3 };
  const SPORT_BONUS = { mlb: 3, nba: 3, nhl: 3, soccer: 3, golf: 3, wnba: 2, nfl: 2 };
  const out = [];
  for (const [id, p] of Object.entries(allPicks)) {
    if (p.date !== today || id.includes('_fb_')) continue;
    // Skip golf picks when no active tournament is confirmed — prevents stale completed-event picks
    if (p.sport === 'golf' && !_golfTournamentActive) continue;
    // Extra guard: tennis - check stored matchDate first; fall back to S.matches lookup
    if ((p.sport === 'tennis' || !p.sport) && id.startsWith('tn_')) {
      if (p.matchDate && p.matchDate > today) continue;
      const m = S.matches.get(id.replace(/^tn_/, ''));
      if (m?.event_date && m.event_date > today) continue;
    }
    // Extra guard: other sports with stored gameDate
    if (p.gameDate && String(p.gameDate).slice(0, 10) > today) continue;
    let score = p.conf || 1;
    if (p.type === 'player') {
      score += SPORT_BONUS[p.sport] || 1;
      const s = (p.stat || '').trim();
      const statLabel = (!s || s === '-') ? p.prop
        : /^(OVER|UNDER)\s/i.test(s) ? s
        : (s.match(/(OVER|UNDER)\s+[\d.]+\s+\w+/i)?.[0] || p.prop);
      out.push({ id, score, sport: p.sport || 'other', type: 'player',
        pick: p.player, description: statLabel, matchup: p.gameMatchup || '', conf: p.conf || 1 });
    } else if (p.team) {
      if ((p.conf || 0) < 1) continue;
      const sport = p.sport || 'tennis';
      // Skip micro-level ITF events (W15, M15, W25, M25, W35, W40) - not in major sports apps
      if (sport === 'tennis' && p.tier === 'itf' && isMinorITFEvent(p.matchup)) continue;
      score += sport === 'tennis' ? (TIER_BONUS[p.tier] ?? 0) : (SPORT_BONUS[sport] || 1);
      out.push({ id, score, sport, type: 'game',
        pick: p.team, description: p.matchup || '', matchup: p.matchup || '',
        conf: p.conf || 1, tier: p.tier, bo5: p.bo5 || false });
    }
  }
  return out;
}

// Pick the top-scoring legs — no per-sport or tier caps.
// Best picks win regardless of sport mix (5 tennis picks is fine if they score highest).
function _selectTicketLegs(candidates) {
  candidates.sort((a, b) => b.score - a.score);
  const legs = candidates.slice(0, 10);
  return legs.length >= 2 ? legs : null;
}

// ── SECRET TICKET ────────────────────────────────────────────
function buildSecretTicket() {
  const today    = dateStrLocal(0);
  const allPicks = getPicks();
  const candidates = _buildPickCandidates(allPicks, today);

  // Score and filter MLB picks - use mlbPickMerit for player props
  const scored = [];
  for (const c of candidates) {
    if (c.sport !== 'mlb') continue;
    const p = allPicks[c.id];
    if (!p) continue;
    if (p.prop === 'RunTotal') continue;
    if (c.type === 'player') {
      const merit = mlbPickMerit(p.prop, p.stat || '', p.player || '');
      if (merit < 0) continue; // below quality threshold
      scored.push({ ...c, _stScore: merit + 10, _pickObj: p }); // +10 base so props rank above game picks
    } else {
      scored.push({ ...c, _stScore: (p.conf || 1) * 5, _pickObj: p });
    }
  }

  // Sort by score desc; deduplicate: only 1 pick per player
  scored.sort((a, b) => b._stScore - a._stScore);
  const seenPlayers = new Set();
  const legs = [];
  for (const c of scored) {
    const playerKey = c.type === 'player' ? (c._pickObj?.player || c.pick) : null;
    if (playerKey && seenPlayers.has(playerKey)) continue;
    if (playerKey) seenPlayers.add(playerKey);
    legs.push(c);
    if (legs.length >= 10) break;
  }
  return legs;
}

function showSecretTicket() {
  document.getElementById('st-modal')?.remove();
  const legs   = buildSecretTicket();
  const today  = dateStrLocal(0);
  const allPicks = getPicks();
  const SPORT_ICON = { tennis:'🎾', mlb:'⚾', nba:'🏀', wnba:'🏀', nhl:'🏒', nfl:'🏈', soccer:'⚽', golf:'⛳', other:'🏅' };
  const MLB_DISP_ST = { Hit:'1+ Hits', RBI:'1+ RBI', HR:'To Hit HR', Double:'1+ Double', XBH:'1+ XBH', K:'Pitcher Ks', Walk:'To Walk', SB:'To Steal' };

  const makeRow = (c, i) => {
    const live   = allPicks[c.id] || {};
    const result = live.result ?? null;
    const badge  = result === 'win'  ? '<span class="st-badge st-w">W</span>'
                 : result === 'loss' ? '<span class="st-badge st-l">L</span>' : '';
    const dots   = '●'.repeat(c.conf) + '○'.repeat(3 - c.conf);
    const icon   = SPORT_ICON[c.sport] || '🏅';
    const pick   = c.type === 'player'
      ? (MLB_DISP_ST[c._pickObj?.prop] || c.description || c._pickObj?.prop || '')
      : '';
    const name   = c.type === 'player' ? lastName(c.pick || '') : (c.pick || '');
    const match  = (c.matchup || '').replace(/ @ /g, ' v ');
    return `<div class="st-row${result==='win'?' st-win':result==='loss'?' st-loss':''}">
      <span class="st-num">${i+1}</span>
      <span class="st-sport">${icon}</span>
      <div class="st-body">
        <div class="st-match">${esc(match)}</div>
        <div class="st-pick">${esc(name)}${pick ? `<span class="st-prop">${esc(pick)}</span>` : ''}</div>
      </div>
      <span class="st-conf">${dots}</span>
      ${badge}
    </div>`;
  };

  const wins   = legs.filter(c => (allPicks[c.id]?.result) === 'win').length;
  const losses = legs.filter(c => (allPicks[c.id]?.result) === 'loss').length;
  const statusLine = (wins || losses) ? `<span class="st-record">${wins}W – ${losses}L</span>` : '';

  const body = legs.length
    ? legs.map((c, i) => makeRow(c, i)).join('')
    : '<div class="st-empty">Not enough high-confidence picks yet today.<br><span class="st-empty-sub">Browse the sport tabs to load picks first.</span></div>';

  const modal = document.createElement('div');
  modal.id = 'st-modal';
  modal.innerHTML = `<div class="st-panel">
    <div class="st-hdr">
      <div class="st-hdr-left">
        <div class="st-title">🔒 Secret Ticket</div>
        <div class="st-sub">⚾ MLB · Top ${legs.length} picks today · Highest confidence only</div>
      </div>
      <button class="st-close" onclick="document.getElementById('st-modal').remove()">✕</button>
    </div>
    <div class="st-list">${body}</div>
    <div class="st-footer">Built fresh from today's data · For your eyes only 👀</div>
  </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  modal.className = 'st-modal';
  document.body.appendChild(modal);
}

// Day ticket: built ONCE after 5am ET — locked immediately, never changes.
// Night ticket: built ONCE at 5pm ET (games starting at/after 5pm) — locked immediately.
// Supabase is canonical: first device to build pushes to DB; every other device reads it.
// Once a ticket exists (locally or in Supabase) it is NEVER rebuilt or modified.
async function buildSplitTicketsIfNeeded() {
  const today = dateStrLocal();

  let etHour = 0;
  try {
    const s = new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' });
    etHour = parseInt(s) || 0;
  } catch {}

  const dayAllowed   = etHour >= 5;  // wait until 5am ET — RG and other early picks are loaded by then
  const nightAllowed = etHour >= 17; // night ticket unlocks at 5pm ET

  let dayBuilt   = localStorage.getItem('_day_built_v1')   === today;
  let nightBuilt = localStorage.getItem('_night_built_v1') === today;

  // Restore in-memory caches from localStorage (avoids a full rebuild on same device)
  if (dayBuilt && !_morningTicketCache) {
    try { _morningTicketCache = JSON.parse(localStorage.getItem(_MORN_TICKET_KEY) || 'null') || null; } catch {}
  }
  if (nightBuilt && !_eveningTicketCache) {
    try { _eveningTicketCache = JSON.parse(localStorage.getItem(_EVE_TICKET_KEY) || 'null') || null; } catch {}
  }

  // ── Supabase is always the source of truth — read every load so all devices converge ──
  const sbData = await _sbGetTickets(today);
  if (sbData?.morn) {
    const mo = { date: today, legs: sbData.morn };
    try { localStorage.setItem(_MORN_TICKET_KEY, JSON.stringify(mo)); } catch {}
    _morningTicketCache = mo;
    localStorage.setItem('_day_built_v1', today);
    dayBuilt = true;
  }
  if (sbData?.eve && nightAllowed) {
    const eo = { date: today, legs: sbData.eve };
    try { localStorage.setItem(_EVE_TICKET_KEY, JSON.stringify(eo)); } catch {}
    _eveningTicketCache = eo;
    localStorage.setItem('_night_built_v1', today);
    nightBuilt = true;
  }

  // ── Yesterday pre-fetch (shared helper) ──
  const prefetchYesterday = async () => {
    try {
      const yesterday = dateStrLocal(-1);
      const ystMornStored = JSON.parse(localStorage.getItem(_YST_MORN_TICKET_KEY) || 'null');
      const ystEveStored  = JSON.parse(localStorage.getItem(_YST_EVE_TICKET_KEY)  || 'null');
      if (ystMornStored?.date !== yesterday || ystEveStored?.date !== yesterday) {
        const sbYst = await _sbGetTickets(yesterday);
        if (sbYst?.morn && ystMornStored?.date !== yesterday)
          try { localStorage.setItem(_YST_MORN_TICKET_KEY, JSON.stringify({ date: yesterday, legs: sbYst.morn })); } catch {}
        if (sbYst?.eve && ystEveStored?.date !== yesterday)
          try { localStorage.setItem(_YST_EVE_TICKET_KEY, JSON.stringify({ date: yesterday, legs: sbYst.eve })); } catch {}
      }
    } catch {}
  };

  if (dayBuilt && (nightBuilt || !nightAllowed)) {
    await prefetchYesterday();
    return; // both tickets present — nothing to build
  }

  // ── This device is first to build — compute from current picks and lock immediately ──
  const allPicks   = getPicks();
  const candidates = _buildPickCandidates(allPicks, today);

  if (!dayBuilt && dayAllowed) {
    const mornLegs = _selectTicketLegs(candidates.filter(c => !isEveningGame(allPicks[c.id] || {})));
    if (mornLegs) {
      const mo = { date: today, legs: mornLegs };
      try { localStorage.setItem(_MORN_TICKET_KEY, JSON.stringify(mo)); } catch {}
      _morningTicketCache = mo;
      _sbSaveTicket(today, 'day', mornLegs); // first write wins in Supabase
    }
    localStorage.setItem('_day_built_v1', today);
  }

  if (!nightBuilt && nightAllowed) {
    const eveLegs = _selectTicketLegs(candidates.filter(c => isEveningGame(allPicks[c.id] || {})));
    if (eveLegs) {
      const eo = { date: today, legs: eveLegs };
      try { localStorage.setItem(_EVE_TICKET_KEY, JSON.stringify(eo)); } catch {}
      _eveningTicketCache = eo;
      _sbSaveTicket(today, 'night', eveLegs); // first write wins in Supabase
    }
    localStorage.setItem('_night_built_v1', today);
  }

  await prefetchYesterday();
}

function archiveYesterdayTicket() {
  const yesterday = dateStrLocal(-1);
  try {
    const s = localStorage.getItem(_TICKET_KEY);
    if (s) { const obj = JSON.parse(s); if (obj.date === yesterday) localStorage.setItem(_YST_TICKET_KEY, s); }
    const sm = localStorage.getItem(_MORN_TICKET_KEY);
    if (sm) { const obj = JSON.parse(sm); if (obj.date === yesterday) localStorage.setItem(_YST_MORN_TICKET_KEY, sm); }
    const se = localStorage.getItem(_EVE_TICKET_KEY);
    if (se) { const obj = JSON.parse(se); if (obj.date === yesterday) localStorage.setItem(_YST_EVE_TICKET_KEY, se); }
  } catch {}
}

function buildDailyTicketIfNeeded() {
  const today = dateStrLocal();
  // Belt-and-suspenders: separate flag so even a failed localStorage write can't cause a rebuild
  if (localStorage.getItem('_ticket_built_v10') === today) return;
  if (getDailyTicket()) { localStorage.setItem('_ticket_built_v10', today); return; }
  const allPicks = getPicks();

  const TIER_BONUS  = { slam: 10, masters: 5, '500': 2, '250': 0, chal: -1, itf: -3 };
  const SPORT_BONUS = { mlb: 3, nba: 3, nhl: 3, soccer: 3, golf: 3, wnba: 2, nfl: 2 };

  // Clean up malformed _fb_ golf picks from earlier bug before building ticket
  for (const id of Object.keys(allPicks)) {
    if (id.includes('_fb_')) delete allPicks[id];
  }

  const candidates = [];
  for (const [id, p] of Object.entries(allPicks)) {
    if (p.date !== today) continue;
    if (id.includes('_fb_')) continue;
    let score = (p.conf || 1);

    if (p.type === 'player') {
      score += SPORT_BONUS[p.sport] || 1;
      const statLabel = (() => {
        const s = (p.stat || '').trim();
        if (!s || s === '-') return p.prop;
        if (/^(OVER|UNDER)\s/i.test(s)) return s;  // just the line, e.g. "OVER 27.5"
        const ouMatch = s.match(/(OVER|UNDER)\s+[\d.]+\s+\w+/i);
        if (ouMatch) return ouMatch[0];              // extract "OVER 5.5 K" from composite
        return p.prop;                               // raw stat - show only the prop name
      })();
      candidates.push({ id, score, sport: p.sport || 'other', type: 'player',
        pick: p.player, description: statLabel, matchup: p.gameMatchup || '', conf: p.conf || 1 });
    } else if (p.team) {
      if ((p.conf || 0) < 1) continue; // skip toss-up game picks (< 60% confidence)
      const sport = p.sport || 'tennis';
      if (sport === 'tennis') {
        if (p.tier === 'itf' && isMinorITFEvent(p.matchup)) continue;
        score += TIER_BONUS[p.tier] ?? 0;
      } else {
        score += SPORT_BONUS[sport] || 1;
      }
      candidates.push({ id, score, sport, type: 'game',
        pick: p.team, description: p.matchup || '', matchup: p.matchup || '',
        conf: p.conf || 1, tier: p.tier });
    }
  }

  if (candidates.length < 5) return;   // not enough picks yet - wait for preload

  candidates.sort((a, b) => b.score - a.score);
  const legs = candidates.slice(0, 10);

  if (legs.length < 5) return;

  try { localStorage.setItem(_TICKET_KEY, JSON.stringify({ date: today, legs })); } catch {}
  localStorage.setItem('_ticket_built_v10', today); // mark built even if full ticket write failed
  _dailyTicketCache = { date: today, legs }; // freeze in memory immediately
}


function resetDailyPicks() {
  _svPreloadedAt = 0;
  preloadPicksForSimpleView();
}

// When GOLF_PAIRINGS_OVERRIDE is set, fix the matchup strings stored in any existing
// golf picks whose event+round match the override. This ensures the Today Ticket shows
// the correct "Player v Player v Player" description, not the ESPN-guessed wrong one.
function fixGolfPickMatchupsFromOverride() {
  const today = dateStrLocal(0);
  for (const [eventId, ov] of Object.entries(GOLF_PAIRINGS_OVERRIDE)) {
    if (ov.date !== today) continue;
    const allPicks = getPicks();
    let changed = false;
    for (const [id, p] of Object.entries(allPicks)) {
      if (p.sport !== 'golf' || p.date !== today) continue;
      if (!id.startsWith(`golf_${eventId}_`)) continue;
      // Find which override group this pick belongs to by matching pick's team (last name)
      const pickedLast = (p.team || '').toLowerCase();
      for (const nameList of ov.groups) {
        const lasts = nameList.map(n => n.split(' ').pop().toLowerCase().replace(/ø/g,'o').replace(/æ/g,'ae').replace(/å/g,'a'));
        if (lasts.includes(pickedLast)) {
          const correctMatchup = nameList.map(n => n.split(' ').pop()).join(' v ');
          if (p.matchup !== correctMatchup) {
            p.matchup = correctMatchup;
            changed = true;
          }
          break;
        }
      }
    }
    if (changed) savePicks(allPicks);
  }
}


// Silently fetch today's tennis matches and record picks - used by the preload
// so tennis shows on the front page even if the user hasn't visited the Tennis tab.
async function preloadTennisPicksQuiet() {
  try {
    await preloadRankIndex();
    const today    = dateStrLocal(0);
    const tomorrow = dateStrLocal(1);

    // Fetch today and tomorrow in parallel
    const [todayMatches, tomorrowMatches] = await Promise.all([
      tennisFetch('get_fixtures', { date_start: today,    date_stop: today    }).catch(() => []),
      tennisFetch('get_fixtures', { date_start: tomorrow, date_stop: tomorrow }).catch(() => []),
    ]);

    // Pre-fetch H2H for upcoming AND live main-draw matches so inlineTennisPick has form data.
    // Limit to ATP/WTA - skip Challenger/ITF (too many, low value).
    const isMainDraw = m => { const c = matchCategory(m.event_type || ''); return c === 'atp' || c === 'wta'; };
    const isUpcoming = m => !isLive(m.event_status) && !isFinished(m.event_status);

    // Include live today's matches in H2H fetch so we can record picks for matches that
    // already started by the time the user opens the app (e.g. Roland Garros morning).
    const needsH2H = [...todayMatches, ...tomorrowMatches]
      .filter(m => (isUpcoming(m) || isLive(m.event_status)) && isMainDraw(m) && m.first_player_key && m.second_player_key)
      .slice(0, 50); // cap at 50 API calls

    await Promise.allSettled(needsH2H.map(m => fetchH2HCached(m.first_player_key, m.second_player_key)));

    const existingPicks = getPicks();

    // Process today's matches
    for (const m of todayMatches) {
      S.matches.set(String(m.event_key), m);
      // For live matches: record a pick only if one wasn't already stored (pre-game analysis).
      const pickId = 'tn_' + m.event_key;
      const alreadyHasPick = !!existingPicks[pickId];
      inlineTennisPick(m, null, isLive(m.event_status) && !alreadyHasPick);
      if (isFinished(m.event_status) && m.event_winner) {
        let wln = '';
        if (m.event_winner === 'First Player')       wln = lastName(m.event_first_player  || '');
        else if (m.event_winner === 'Second Player') wln = lastName(m.event_second_player || '');
        else                                          wln = lastName(m.event_winner);
        if (wln) resolvePick('tn_' + m.event_key, wln);
      }
    }

    // Process tomorrow's matches - generate picks stamped with tomorrow's date
    for (const m of tomorrowMatches) {
      S.matches.set(String(m.event_key), m);
      inlineTennisPick(m, tomorrow);
    }
  } catch {}
}

// Silently fetch today's games for all sports in the background and record picks
// into localStorage so renderSimpleView() can show them without the user
// needing to click through every sport tab manually.
async function preloadPicksForSimpleView() {
  const now = Date.now();
  if (now - _svPreloadedAt < 20 * 60 * 1000) return;  // re-run at most every 20 min
  _svPreloadedAt = now;
  const isActive = () => document.getElementById('simple-view')?.classList.contains('sv-active');

  // Purge any MLB picks that were seeded by simple win% math (conf=0) and have already
  // been resolved. These are wrong retroactive predictions, not real analysis picks.
  // Analysis picks always have conf >= 1 (from buildPickSection's pickedConf logic).
  const today = dateStrLocal();
  const stalePicks = getPicks();
  let purged = false;
  for (const [id, p] of Object.entries(stalePicks)) {
    if (p.sport === 'mlb' && p.date === today && (p.conf || 0) === 0 && p.result !== null) {
      delete stalePicks[id];
      purged = true;
    }
  }
  if (purged) { savePicks(stalePicks); updatePicksDisplay(); }

  // ESPN summary paths + which stat categories to record as player picks (per team)
  const sportCfg = {
    nba:  { path: 'basketball/nba',  cats: ['points', 'rebounds', 'assists'] },
    nfl:  { path: 'football/nfl',    cats: ['passing yards', 'rushing yards', 'receiving yards'] },
    nhl:  { path: 'hockey/nhl',      cats: ['points', 'goals', 'assists'] },
    wnba: { path: 'basketball/wnba', cats: ['points', 'rebounds', 'assists'] },
  };

  // Populate rest-days cache and injury reports before recording picks
  try { await populateRestDaysCache(); } catch (e) {}
  await Promise.allSettled([fetchInjuryPenalties('nba'), fetchInjuryPenalties('wnba')]);

  // Seed MLB game picks now with force=false so they show up before the user visits the MLB tab.
  // buildPickSection (force=true for MLB) will overwrite with pitcher/form analysis when the tab loads.
  const tomorrow = dateStrLocal(1);
  try {
    const [mlbToday, mlbTmrw] = await Promise.all([espnGames('mlb', 0), espnGames('mlb', 1).catch(() => [])]);
    mlbToday.forEach(g => autoRecordAndResolvePick(g));
    mlbTmrw.forEach(g => autoRecordAndResolvePick(g, tomorrow));
  } catch {}
  for (const sport of ['nba', 'nfl', 'nhl', 'wnba']) {
    try {
      const [todayGames, tomorrowGames] = await Promise.all([
        espnGames(sport, 0),
        espnGames(sport, 1).catch(() => []),
      ]);
      // Pre-fetch NHL team stats so goalie/PP/PK can influence picks
      if (sport === 'nhl') {
        const allNHL = [...todayGames, ...tomorrowGames];
        await Promise.allSettled(allNHL.flatMap(g => [
          fetchNHLTeamStats(g.homeId),
          fetchNHLTeamStats(g.awayId),
        ]));
      }
      todayGames.forEach(g => autoRecordAndResolvePick(g));
      tomorrowGames.forEach(g => autoRecordAndResolvePick(g, tomorrow));

      const cfg = sportCfg[sport];
      if (cfg) {
        // Max plausible per-game averages - anything above these is a season total, not per-game
        const PER_GAME_MAX = {
          nhl:  { goals: 1.5, assists: 2.5, points: 3.5 },
        };
        const upcoming = todayGames.filter(g => { const { fin, live } = gameRowState(g); return !fin && !live; }).slice(0, 4);
        for (const g of upcoming) {
          try {
            const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${cfg.path}/summary?event=${g.id}`);
            const j   = await res.json();
            const matchup = `${g.awayTeam} @ ${g.homeTeam}`;
            for (const tl of (j.leaders || [])) {
              const tlAbbr = (tl.team?.abbreviation || '').toUpperCase();
              for (const cat of (tl.leaders || [])) {
                const catName = (cat.displayName || cat.shortDisplayName || '').toLowerCase();
                if (!cfg.cats.some(c => catName.includes(c))) continue;
                const top = (cat.leaders || [])[0];
                if (!top?.athlete?.displayName) continue;
                const pid    = top.athlete.id || top.athlete.displayName.replace(/\W+/g,'');
                const name   = top.athlete.shortName || top.athlete.displayName;
                const label  = cat.displayName || cat.shortDisplayName || catName;
                const rawAvg = parseFloat(top.displayValue);
                // Skip if value looks like a season total rather than a per-game average
                const pgMax = PER_GAME_MAX[sport];
                if (pgMax && !isNaN(rawAvg)) {
                  const maxVal = Object.entries(pgMax).find(([k]) => catName.includes(k))?.[1];
                  if (maxVal !== undefined && rawAvg > maxVal) continue;
                }
                if (!isNaN(rawAvg) && rawAvg > 0) {
                  const oLine = (Math.max(0.5, Math.round(rawAvg - 0.5) + 0.5)).toFixed(1);
                  const dir   = propDirection(sport, rawAvg, catName, tlAbbr, g);
                  recordPlayerPick(`plr_${g.id}_${pid}_${catName.replace(/\s+/g,'_')}`,
                    sport, name, label, `${dir} ${oLine}`, matchup, null, g.gameDate || null);
                } else {
                  recordPlayerPick(`plr_${g.id}_${pid}_${catName.replace(/\s+/g,'_')}`,
                    sport, name, label, top.displayValue || '-', matchup, null, g.gameDate || null);
                }
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  const mlbFallback = (games) => {
    games.forEach(g => {
      const { fin } = gameRowState(g);
      if (!fin) {
        autoRecordAndResolvePick(g);
      } else {
        const existing = getPicks()[String(g.id)];
        if (existing && existing.result === null && g.awayScore !== '' && g.homeScore !== '') {
          const aS = parseFloat(g.awayScore) || 0, hS = parseFloat(g.homeScore) || 0;
          if (aS !== hS) resolvePick(String(g.id), aS > hS ? g.awayTeam.split(' ').pop() : g.homeTeam.split(' ').pop());
        }
      }
    });
  };
  let mlbFallbackGames = [];
  try { mlbFallbackGames = await espnGames('mlb', 0); } catch (e) {}
  try {
    await loadMLBPicksPage();
    mlbFallback(mlbFallbackGames);
  } catch (e) { mlbFallback(mlbFallbackGames); }

  try { await loadSoccerScores(); } catch (e) {}
  try { await loadGolfPicksPage(); } catch (e) {}
  try { await preloadTennisPicksQuiet(); } catch (e) {}

  // Fix any stored golf pick matchup strings using the manual override before
  // the ticket reads them - ensures the ticket shows correct 3-ball groupings.
  fixGolfPickMatchupsFromOverride();
  archiveYesterdayTicket();
  // All sports done - now build the ticket (all picks are in localStorage).
  // Do this AFTER all sports load so we score from the full candidate pool.
  buildDailyTicketIfNeeded();
  await buildSplitTicketsIfNeeded();
  _svPreloadDone = true;
  if (isActive()) renderSimpleView();
  if (S.sport === 'tickets') renderTicketsPage();
}

// ── TYPED TICKET HELPERS ──────────────────────────────────────

// Merit score for an MLB player pick - used by both per-game and combined tickets.
// Parses the encoded stat string (set at pick-record time) for matchup context.
// Returns -1 to exclude a pick below quality threshold; higher = better.
function mlbPickMerit(propType, stat, pick) {
  const s = (stat || '').replace(/^[^:]+:\s*/, ''); // strip "Hit: " prefix if present

  if (propType === 'Hit') {
    const avg = parseFloat(s.match(/^(0?\.\d+)/)?.[1] || '0');
    if (avg < 0.245) return -1;
    let score = avg * 1000;
    if (s.includes(' vs '))  score += 15;  // has platoon context
    if (s.includes('due'))   score += 35;  // BABIP below avg - hits are coming
    if (s.includes('pitH↑')) score += 22;  // pitcher allows hits above average ERA
    if (s.includes('park↑')) score += 10;  // hit-friendly park
    return score;
  }

  if (propType === 'HR') {
    const hr   = parseFloat(s.match(/^(\d+)HR/)?.[1] || '0');
    const vsHR = parseFloat(s.match(/(\d+)vsHR/)?.[1] || '0');
    // vs-pitcher HR history is the most powerful HR signal - lower the season-HR floor when present
    const minHR = vsHR >= 2 ? 3 : vsHR >= 1 ? 5 : 8;
    if (hr < minHR) return -1;
    let score = hr * 6;
    score += vsHR * 28;                     // career HR vs this exact pitcher dominates
    if (s.includes('pitHR↑'))  score += 22; // adjusted pitcher HR/9 > 1.25
    if (s.includes('parkHR↑')) score += 12; // HR-friendly park (1.05+)
    if (s.includes('plat'))    score += 15; // platoon power advantage
    return score;
  }

  if (propType === 'RBI') {
    const rbi = parseFloat(s.match(/^(\d+)RBI/)?.[1] || '0');
    const pos = parseFloat(s.match(/#(\d+)/)?.[1] || '9');
    if (rbi < 18) return -1;
    const posBonus = Math.max(0, (6 - Math.min(pos, 7))) * 10; // #3 = +30, #4 = +20, #5 = +10
    let score = rbi * 1.8 + posBonus;
    if (s.includes('pitR↑')) score += 20;  // high ERA pitcher means more runs/RBIs
    return score;
  }

  if (propType === 'K') {
    const k9 = parseFloat(s.match(/(\d+\.?\d*)K\/9/)?.[1] || '0');
    if (k9 < 8.5) return -1;
    return (k9 - 8.0) * 35; // 9.0 → 35, 9.5 → 52, 10.0 → 70
  }

  if (propType === 'Double') {
    const dbl = parseFloat(s.match(/^(\d+)2B/)?.[1] || '0');
    if (dbl < 4) return -1;
    let score = dbl * 5;
    if (s.includes('vs ')) score += 10;
    return score;
  }

  if (propType === 'XBH') {
    const xbh = parseFloat(s.match(/^(\d+)XBH/)?.[1] || '0');
    if (xbh < 8) return -1;
    return xbh * 2.5;
  }

  if (propType === 'RunTotal') {
    const proj = parseFloat(s.match(/proj\s+([\d.]+)/)?.[1] || '0');
    const line = parseFloat((pick || '').match(/([\d.]+)/)?.[1] || '0');
    const dev  = (proj > 0 && line > 0) ? Math.abs(proj - line) : 0;
    if (dev < 0.2) return 8;
    return Math.min(dev * 55, 90);
  }

  return 0;
}

// Multi-factor OVER/UNDER direction for player props.
// Returns 'UNDER' when evidence stacks up; 'OVER' otherwise.
function propDirection(sport, rawAvg, catName, teamAbbr, g) {
  const LEAGUE_OU   = { nba: 225, wnba: 160, nhl: 5.5, nfl: 45 };
  const OU_MARGIN   = { nba: 8,   wnba: 6,   nhl: 0.5, nfl: 4  };
  const MIN_UNDER   = { points: 15, rebound: 7, assist: 5, goal: 0.4, passing: 200, rushing: 60, receiving: 50 };
  let score = 0;

  // Rest / fatigue - strongest signal (B2B = played yesterday)
  const rest = teamAbbr ? (_restDaysCache.get(`${sport}:${teamAbbr}`) ?? 3) : 3;
  if (rest <= 1) score -= 2;
  else if (rest >= 3) score += 1;

  // Game total vs league average
  const ou  = parseFloat(g?.odds?.overUnder || 0);
  const avg = LEAGUE_OU[sport] || 0;
  const mar = OU_MARGIN[sport] || 8;
  if (ou > 0 && avg > 0) {
    if (ou < avg - mar) score -= 1;        // low-scoring game → fewer stat chances
    else if (ou > avg + mar) score += 1;  // high-scoring game → more opportunities
  }

  // Spread magnitude → blowout risk → garbage time → stars sit 4th quarter
  const spreadStr = String(g?.odds?.spread || '');
  const spreadPts = Math.abs(parseFloat(spreadStr.match(/[-−]?[\d.]+/)?.[0] || '0'));
  if (spreadPts > 12) score -= 1;
  else if (spreadPts > 0 && spreadPts < 4) score += 1; // close game → full-game effort

  // Minimum average needed for UNDER to make sense
  const cat = catName.toLowerCase();
  const minKey = Object.keys(MIN_UNDER).find(k => cat.includes(k));
  const minAvg = minKey ? MIN_UNDER[minKey] : 10;

  return score < -1 && rawAvg >= minAvg ? 'UNDER' : 'OVER';
}

function toOULine(sport, prop, raw) {
  if (!raw || raw <= 0) return null;
  if (sport === 'nhl') {
    const p = (prop || '').toLowerCase();
    // ESPN returns per-game rates for NHL (e.g. 0.41 GPG, 1.2 PPG)
    if (p.includes('point') && raw >= 1.0) return '1.5';
    return '0.5'; // Goals/Assists → anytime scorer line
  }
  return (Math.floor(raw * 2) / 2 - 0.5).toFixed(1);
}

function getPicksForTicket(type, date, allPicks) {
  const entries = Object.entries(allPicks).filter(([, p]) => p.date === date);
  const sortConf = (a, b) => (b[1].conf||1) - (a[1].conf||1);
  const numFromStat = (stat, rx) => { const m = (stat||'').match(rx); return m ? parseFloat(m[1]) : 0; };
  const toGame = ([id, p]) => ({ id, pick: p.team, matchup: p.matchup, conf: p.conf||1, sport: p.sport, propType:'game', result: p.result });
  const MLB_DISP = { Hit:'1+ Hits', RBI:'1+ RBI', HR:'To Hit HR', Double:'1+ Double', XBH:'1+ XBH', K:'Pitcher Ks', Walk:'To Walk', SB:'To Steal' };
  const toPlr  = (propType) => ([id, p]) => {
    const betLine = (p.stat||'').match(/(OVER|UNDER)\s+[\d.]+\s+\w+/i)?.[0];
    const desc = betLine || (p.sport === 'mlb' ? (MLB_DISP[p.prop] || p.prop) : p.prop) || '';
    return { id, pick: lastName(p.player||p.team||''), description: desc,
      matchup: p.gameMatchup||p.matchup||'', conf: 2, sport: p.sport, propType, result: p.result };
  };

  switch (type) {
    case 'mlb_game':
      return entries.filter(([, p]) => p.sport === 'mlb' && !p.type && (p.conf||0) >= 1)
        .sort(sortConf).slice(0, 10).map(toGame);
    case 'mlb_hits':
    case 'mlb_rbi':
    case 'mlb_hr':
    case 'mlb_ks':
    case 'mlb_doubles':
    case 'mlb_xbh': {
      const propMap = { mlb_hits:'Hit', mlb_rbi:'RBI', mlb_hr:'HR', mlb_ks:'K', mlb_doubles:'Double', mlb_xbh:'XBH' };
      const plrMap  = { mlb_hits:'hits', mlb_rbi:'rbi', mlb_hr:'hr', mlb_ks:'ks', mlb_doubles:'doubles', mlb_xbh:'xbh' };
      const prop = propMap[type], plrKey = plrMap[type];
      return entries
        .filter(([, p]) => p.sport === 'mlb' && p.type === 'player' && p.prop === prop)
        .map(([id, p]) => ({ id, p, merit: mlbPickMerit(prop, p.stat, p.player) }))
        .filter(x => x.merit > 0)
        .sort((a, b) => b.merit - a.merit)
        .slice(0, 10)
        .map(({ id, p }) => toPlr(plrKey)([id, p]));
    }
    case 'tennis_main': {
      const main = new Set(['slam','masters','500','250']);
      return entries.filter(([, p]) => p.sport === 'tennis' && main.has(p.tier) && (p.conf||0) >= 1)
        .sort(sortConf).slice(0, 10).map(toGame);
    }
    case 'tennis_all':
      return entries.filter(([, p]) => p.sport === 'tennis' && (p.conf||0) >= 1)
        .sort(sortConf).slice(0, 10).map(toGame);
    case 'golf':
      return entries.filter(([id, p]) => p.sport === 'golf' && !id.startsWith('_fb_') && (p.conf||0) >= 1)
        .sort(sortConf).slice(0, 10).map(toGame);
    case 'nba':
    case 'wnba':
    case 'nhl':
    case 'nfl': {
      const sp = type;
      const PA = {
        nba:  { Points:'PTS', Rebounds:'REB', Assists:'AST', 'Goals+Assists':'GA' },
        wnba: { Points:'PTS', Rebounds:'REB', Assists:'AST' },
        nhl:  { Goals:'G', Assists:'A', Points:'PTS', 'Goals+Assists':'GA' },
        nfl:  { 'Passing Yards':'PASS', 'Rushing Yards':'RUSH', 'Receiving Yards':'REC', Points:'PTS' },
      };
      const PROP_ABBR = PA[sp] || {};
      return entries.filter(([, p]) => p.sport === sp && (p.type === 'player' || (p.conf||0) >= 1))
        .sort((a, b) => {
          const ga = a[1].type === 'player' ? 0 : 1, gb = b[1].type === 'player' ? 0 : 1;
          if (ga !== gb) return gb - ga;
          return (b[1].conf||1) - (a[1].conf||1);
        })
        .slice(0, 10)
        .map(([id, p]) => {
          if (p.type === 'player') {
            const raw  = parseFloat(p.stat || 0) || parseFloat((p.stat||'').replace(/^(OVER|UNDER)\s+/i,'')) || 0;
            const line = toOULine(sp, p.prop, raw);
            const dir  = /^UNDER\s/i.test(p.stat||'') ? 'UNDER' : 'OVER';
            const abbr = PROP_ABBR[p.prop] || (p.prop||'PROP').replace(/\s+per\s+game/i,'').trim();
            const desc = line !== null ? `${dir} ${line} ${abbr}` : (p.stat||'').match(/^(OVER|UNDER)/i) ? p.stat : abbr;
            return { id, pick: lastName(p.player||p.team||''), description: desc, matchup: p.gameMatchup||p.matchup||'', conf: p.conf||1, sport: sp, propType:'player', result: p.result };
          }
          return toGame([id, p]);
        });
    }
    default: return [];
  }
}

function getGolfSplitTickets(date, allPicks) {
  const entries = Object.entries(allPicks)
    .filter(([id, p]) => p.sport === 'golf' && !id.startsWith('_fb_') && p.date === date)
    .sort((a, b) => (b[1].conf||1) - (a[1].conf||1));

  const toGolfLeg = ([id, p]) => ({
    id, pick: p.team, matchup: p.matchup, conf: p.conf||1,
    sport: 'golf', propType: 'game', result: p.result
  });

  if (!entries.length) return { early: [], late: [], singleTicket: true };

  // Find active override for today
  const ovEntry = Object.entries(GOLF_PAIRINGS_OVERRIDE).find(([, ov]) => ov.date === date);
  const [ovEventId, activeOv] = ovEntry || [null, null];

  // Round 4 = everyone plays together - single ticket
  if (activeOv?.round === 4) {
    return { early: entries.slice(0, 10).map(toGolfLeg), late: [], singleTicket: true };
  }

  const totalOvGroups = activeOv?.groups?.length || 0;
  // earlyCount can be set explicitly in the override; otherwise split half/half
  const earlyCount = activeOv?.earlyCount ?? (totalOvGroups > 0 ? Math.ceil(totalOvGroups / 2) : null);

  const early = [], late = [];
  for (const entry of entries) {
    const [id] = entry;
    let isEarly = true;

    if (activeOv && ovEventId && id.startsWith(`golf_${ovEventId}_${activeOv.date}_ov`)) {
      const idx = parseInt(id.slice(`golf_${ovEventId}_${activeOv.date}_ov`.length), 10);
      isEarly = !isNaN(idx) && earlyCount !== null ? idx < earlyCount : true;
    } else {
      // Non-override: parse HHMM from pick ID (UTC)
      const m = id.match(/_(\d{4})_/);
      if (m) isEarly = parseInt(m[1], 10) < 1500; // before 15:00 UTC ≈ before 11am ET
    }

    if (isEarly) { if (early.length < 10) early.push(toGolfLeg(entry)); }
    else         { if (late.length  < 10) late.push(toGolfLeg(entry)); }
  }

  // If everything ended up in one bucket, single ticket
  if (!late.length)  return { early, late: [], singleTicket: true };
  if (!early.length) return { early: late, late: [], singleTicket: true };
  return { early, late, singleTicket: false };
}

function isEarlyMLBGame(gameTime) {
  if (!gameTime) return null;
  try {
    const hour = parseInt(new Date(gameTime).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: getUserTZ() }));
    return hour < 18;
  } catch { return null; }
}

function getMLBSplitPerGameTickets(date, allPicks) {
  const perGame = getMLBPerGameTickets(date, allPicks);
  const early = [], late = [];
  for (const g of perGame) {
    const gamePick = allPicks[g.gameId];
    const isEarly = isEarlyMLBGame(gamePick?.gameTime);
    if (isEarly === false) late.push(g);
    else early.push(g); // null (unknown) goes into early bucket
  }
  if (!late.length)  return { early, late: [], singleTicket: true };
  if (!early.length) return { early: late, late: [], singleTicket: true };
  return { early, late, singleTicket: false };
}

function getMLBPerGameTickets(date, allPicks) {
  const PROP_ICONS  = { game:'🏆', Hit:'🎯', RBI:'⚡', RunTotal:'📊', K:'🔥', HR:'💣', Double:'2️⃣', XBH:'💥', Walk:'🚶', SB:'🏃' };
  const PROP_LABELS = { Hit:'1+ Hits', RBI:'1+ RBI', HR:'To Hit HR', K:'Pitcher Ks', Double:'1+ Double', XBH:'1+ XBH', Walk:'To Walk', SB:'To Steal' };
  const RELEVANT    = new Set(['Hit','RBI','K','RunTotal','HR','Double','XBH']);
  const entries    = Object.entries(allPicks).filter(([, p]) => p.sport === 'mlb' && p.date === date);
  const games      = new Map();

  for (const [id, p] of entries) {
    if (!p.type) {
      if ((p.conf||0) < 1) continue; // skip toss-up moneylines
      if (!games.has(id)) games.set(id, { gameId: id, matchup: p.matchup||id, legs: [] });
      games.get(id).legs.push({ id, pick: p.team||'', matchup:'', conf: p.conf||1, sport:'mlb', propType:'game', result: p.result, icon:'🏆' });
    } else if (p.type === 'player' && RELEVANT.has(p.prop)) {
      const parts = id.split('_');
      if (parts.length < 2) continue;
      const gid = parts[1];
      if (!games.has(gid)) games.set(gid, { gameId: gid, matchup: p.gameMatchup||gid, legs: [] });
      const plrName = p.prop === 'RunTotal' ? (p.player||'') : lastName(p.player||'');
      const kLine   = p.prop === 'K' ? (p.stat||'').match(/OVER\s+[\d.]+\s+K/)?.[0] : null;
      const desc    = kLine || PROP_LABELS[p.prop] || p.prop;
      // _rawStat stores the original stat string so mlbPickMerit can parse real numbers,
      // while description stays clean for display ("1+ Hits" vs ".385 vs 7HP,park1")
      games.get(gid).legs.push({ id, pick: plrName, description: desc, _rawStat: p.stat||'', matchup:'', conf: 2, sport:'mlb', propType: p.prop, result: p.result, icon: PROP_ICONS[p.prop]||'🏅' });
    }
  }

  const selectBest = (legs) => {
    const gamePick = legs.find(l => l.propType === 'game');
    const props = legs
      .filter(l => l.propType !== 'game')
      .map(l => ({ ...l, _merit: l.propType === 'game' ? 1000 : mlbPickMerit(l.propType, l._rawStat || l.description, l.pick) }))
      .filter(l => l._merit >= 0)
      .sort((a, b) => b._merit - a._merit);

    // Deduplicate: block exact same player+prop appearing twice (different props for same player are fine)
    const seenPlayerProps = new Set();
    const selected = props.filter(l => l._merit > 0).filter(l => {
      const key = `${l.pick}|${l.propType}`;
      if (seenPlayerProps.has(key)) return false;
      seenPlayerProps.add(key);
      return true;
    });
    return [
      ...(gamePick ? [gamePick] : []),
      ...selected.slice(0, 7),
    ].slice(0, 8);
  };

  return [...games.values()]
    .filter(g => g.legs.length > 0)
    .map(g => ({ ...g, legs: selectBest(g.legs) }))
    .filter(g => g.legs.length > 0)
    .sort((a, b) => a.matchup.localeCompare(b.matchup));
}

function getSportPerGameTickets(date, allPicks, sport) {
  const ICONS = {
    nba:  { game:'🏆', Points:'🏀', Rebounds:'💪', Assists:'🎯' },
    wnba: { game:'🏆', Points:'🏀', Rebounds:'💪', Assists:'🎯' },
    nhl:  { game:'🏆', Goals:'🥅', Assists:'🎯', Points:'⭐', 'Goals+Assists':'⭐' },
    nfl:  { game:'🏆', 'Passing Yards':'🏈', 'Rushing Yards':'🏃', 'Receiving Yards':'📡', Points:'🏆' },
  };
  const ABBRS = {
    nba:  { Points:'PTS', Rebounds:'REB', Assists:'AST' },
    wnba: { Points:'PTS', Rebounds:'REB', Assists:'AST' },
    nhl:  { Goals:'G', Assists:'A', Points:'PTS', 'Goals+Assists':'GA' },
    nfl:  { 'Passing Yards':'PASS', 'Rushing Yards':'RUSH', 'Receiving Yards':'REC', Points:'PTS' },
  };
  const ORDER = {
    nba:  { game:0, Points:1, Rebounds:2, Assists:3 },
    wnba: { game:0, Points:1, Rebounds:2, Assists:3 },
    nhl:  { game:0, Goals:1, Assists:2, Points:3, 'Goals+Assists':3 },
    nfl:  { game:0, Points:1, 'Passing Yards':2, 'Rushing Yards':3, 'Receiving Yards':4 },
  };
  const icons   = ICONS[sport]  || {};
  const abbrs   = ABBRS[sport]  || {};
  const propOrd = ORDER[sport]  || {};

  const entries = Object.entries(allPicks).filter(([, p]) => p.sport === sport && p.date === date);
  const games   = new Map();

  for (const [id, p] of entries) {
    if (!p.type) {
      if ((p.conf||0) < 1) continue; // skip toss-up moneylines
      if (!games.has(id)) games.set(id, { gameId: id, matchup: p.matchup||id, legs: [] });
      games.get(id).legs.push({ id, pick: p.team||'', matchup:'', conf: p.conf||1, sport, propType:'game', result: p.result, icon:'🏆' });
    } else if (p.type === 'player') {
      const parts = id.split('_');
      if (parts.length < 2) continue;
      const gid = parts[1];
      if (!games.has(gid)) games.set(gid, { gameId: gid, matchup: p.gameMatchup||gid, legs: [] });
      const raw  = parseFloat(p.stat || 0) || parseFloat((p.stat||'').replace(/^(OVER|UNDER)\s+/i,'')) || 0;
      const line = toOULine(sport, p.prop, raw);
      const dir  = /^UNDER\s/i.test(p.stat||'') ? 'UNDER' : 'OVER';
      const abbr = abbrs[p.prop] || (p.prop||'PROP').replace(/\s+per\s+game/i,'').trim();
      const desc = line !== null ? `${dir} ${line} ${abbr}` : (p.stat||'').match(/^(OVER|UNDER)/i) ? p.stat : abbr;
      games.get(gid).legs.push({
        id, pick: lastName(p.player||''), description: desc,
        matchup:'', conf: p.conf||1, sport,
        propType: p.prop, result: p.result,
        icon: icons[p.prop] || '🏅',
      });
    }
  }

  const selectBest = (legs) => {
    const byProp = new Map();
    for (const leg of legs) {
      if (!byProp.has(leg.propType)) byProp.set(leg.propType, []);
      byProp.get(leg.propType).push(leg);
    }
    const result = [];
    const gamePick = byProp.get('game')?.[0];
    if (gamePick) result.push(gamePick);
    for (const [propType, propLegs] of byProp) {
      if (propType === 'game') continue;
      const best = [...propLegs].sort((a, b) => (b.conf||1) - (a.conf||1))[0];
      if (best) result.push(best);
    }
    return result
      .sort((a, b) => (propOrd[a.propType]||9) - (propOrd[b.propType]||9))
      .slice(0, 6);
  };

  return [...games.values()]
    .filter(g => g.legs.length > 0)
    .map(g => ({ ...g, legs: selectBest(g.legs) }))
    .filter(g => g.legs.length > 0)
    .sort((a, b) => a.matchup.localeCompare(b.matchup));
}

function getLineupPendingMatchups(date, allPicks) {
  if (date !== dateStrLocal()) return [];
  return Object.entries(allPicks)
    .filter(([id, p]) => p.sport === 'mlb' && !p.type && p.date === date &&
      !Object.keys(allPicks).some(k => k.startsWith(`plr_${id}_`)))
    .map(([, p]) => p.matchup).filter(Boolean);
}

function cleanLegDesc(leg) {
  const d = (leg.description || '').trim();
  if (!d) return '';
  // "OVER 27.5 PTS" - already has abbreviation
  if (/^(OVER|UNDER)\s+[\d.]+\s+\S/i.test(d)) return d;
  // "OVER 27.5" - missing abbreviation; look up prop from stored pick and append it
  if (/^(OVER|UNDER)\s+[\d.]+\s*$/i.test(d)) {
    const stored = leg.id ? (getPicks()[leg.id] || null) : null;
    if (stored?.prop) {
      const PROP_ABBRS = { Points:'PTS', Rebounds:'REB', Assists:'AST', Goals:'G', 'Goals+Assists':'GA',
                           'Passing Yards':'PASS', 'Rushing Yards':'RUSH', 'Receiving Yards':'REC' };
      return `${d} ${PROP_ABBRS[stored.prop] || stored.prop}`;
    }
    return d;
  }
  const ouEmbed = d.match(/(OVER|UNDER)\s+[\d.]+\s+\w+/i);
  if (ouEmbed) return ouEmbed[0];
  // "27.9 Points", "5.7 Assists", "18.0 Points" → convert to bet line
  const avgM = d.match(/^([\d.]+)\s+(.+)$/);
  if (avgM) {
    const n = parseFloat(avgM[1]);
    const prop = avgM[2].trim();
    const ABBRS = { Points:'PTS', Rebounds:'REB', Assists:'AST', Goals:'G', 'Goals+Assists':'GA',
                    'Passing Yards':'PASS', 'Rushing Yards':'RUSH', 'Receiving Yards':'REC' };
    const abbr = ABBRS[prop] || prop;
    const line = toOULine(leg.sport || '', prop, n);
    return line !== null ? `OVER ${line} ${abbr}` : abbr;
  }
  // "Goals leader", "Points leader" → drop "leader"
  const leaderM = d.match(/^(.+?)\s+leader$/i);
  if (leaderM) return leaderM[1];
  return d;
}

function renderTicketBlock(title, legs, allPicks, footer = '', ticketDate = '') {
  const row = (leg, i) => {
    const live   = allPicks[leg.id] || {};
    const result = live.result ?? leg.result ?? null;
    const badge  = result === 'win'  ? '<span class="sv-badge sv-badge-w">W</span>'
                 : result === 'loss' ? '<span class="sv-badge sv-badge-l">L</span>' : '';
    const conf   = Math.min(3, Math.max(1, leg.conf || 1));
    const dots   = '●'.repeat(conf) + '○'.repeat(3 - conf);
    const icon   = leg.icon || SPORT_ICONS[leg.sport] || '🏅';
    const match  = (leg.matchup || '').replace(/ @ /g, ' v ');
    const desc   = cleanLegDesc(leg);
    const bo5Tag = (leg.bo5 || live.bo5) ? ' <span class="tk-bo5-tag">BO5</span>' : '';
    const pickLine = desc
      ? `<span class="sv-tk-pick">${esc(leg.pick)}</span><span class="sv-tk-prop">${esc(desc)}${bo5Tag}</span>`
      : `<span class="sv-tk-pick">${esc(leg.pick)}</span>${bo5Tag}`;
    return `<div class="sv-tk-row${result==='win'?' sv-tk-win':result==='loss'?' sv-tk-loss':''}">
      <span class="sv-tk-num">${i+1}</span>
      <span class="sv-tk-icon">${icon}</span>
      <span class="sv-tk-match">${esc(match)}</span>
      <span class="sv-tk-arrow">→</span>
      ${pickLine}
      <span class="sv-tk-conf">${dots}</span>
      ${badge}
    </div>`;
  };
  const wins   = legs.filter(l => (allPicks[l.id]?.result ?? l.result) === 'win').length;
  const losses = legs.filter(l => (allPicks[l.id]?.result ?? l.result) === 'loss').length;
  const statusLine = (wins || losses) ? `<span class="sv-tk-status">${wins}W – ${losses}L</span>` : '';
  const rawDate = ticketDate || dateStrLocal(0);
  let dateLabel = '';
  try { dateLabel = new Date(rawDate + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }); } catch {}
  return `<div class="sv-ticket">
    <div class="sv-ticket-date-line">${dateLabel}</div>
    <div class="sv-ticket-hdr">${esc(title)} - ${legs.length} Leg${legs.length!==1?'s':''} ${statusLine}</div>
    <div class="sv-ticket-list">${legs.map(row).join('')}</div>
    ${footer}
  </div>`;
}

function renderTicketsPage() {
  const el = document.getElementById('tickets-area');
  if (!el) return;

  const off      = _ticketDateOffset;
  const date     = dateStrLocal(off);
  const allPicks = getPicks();
  const fullDate = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  const grid     = (cards) => `<div class="tp-grid">${cards.join('')}</div>`;

  const secretBtn = off === 0 && _isAdmin() ? `<button class="st-open-btn" onclick="showSecretTicket()">🔒 Secret Ticket</button>` : '';
  const dateNav = `<div class="tp-day-nav">
    <button class="tp-day-btn${off===-1?' tp-day-active':''}" onclick="_ticketDateOffset=-1;renderTicketsPage()">Yesterday</button>
    <button class="tp-day-btn${off===0?' tp-day-active':''}" onclick="_ticketDateOffset=0;renderTicketsPage()">Today</button>
    <button class="tp-day-btn${off===1?' tp-day-active':''}" onclick="_ticketDateOffset=1;renderTicketsPage()">Tomorrow</button>
    ${secretBtn}
  </div>`;

  // ── Today's Picks - Morning / Evening split tickets ──
  let todayPicksHTML = '';
  if (off === 0) {
    const morn = getMorningTicket();
    const eve  = getEveningTicket();
    let etHr = 0;
    try { etHr = parseInt(new Date().toLocaleString('en-US', { hour:'numeric', hour12:false, timeZone:'America/New_York' })) || 0; } catch {}
    const cards = [];
    if (morn?.legs?.length) cards.push(renderTicketBlock('🌤 Day Ticket', morn.legs.map(l => ({...l, matchup:(l.matchup||'').replace(/ @ /g,' v ')})), allPicks, '', morn.date));
    if (eve?.legs?.length)  cards.push(renderTicketBlock('🌙 Night Ticket', eve.legs.map(l => ({...l, matchup:(l.matchup||'').replace(/ @ /g,' v ')})), allPicks, '', eve.date));
    else if (!eve) cards.push(`<div class="sv-ticket sv-ticket-pending"><div class="sv-ticket-hdr">🌙 Night Ticket</div><div class="sv-pending-msg">Check back after 5:00 PM ET for tonight's picks</div></div>`);
    if (cards.length) {
      todayPicksHTML = `<div class="tp-sport-section">
        <div class="tp-sport-hdr">🎫 Today's Picks</div>
        ${grid(cards)}
      </div>`;
    }
  }

  // ── Yesterday's Picks - Morning / Evening archived tickets ──
  let ystTicketHTML = '';
  if (off === -1) {
    try {
      const ystMorn = JSON.parse(localStorage.getItem(_YST_MORN_TICKET_KEY) || 'null');
      const ystEve  = JSON.parse(localStorage.getItem(_YST_EVE_TICKET_KEY)  || 'null');
      const cards = [];
      if (ystMorn?.date === date && ystMorn.legs?.length)
        cards.push(renderTicketBlock('🌤 Day Ticket', ystMorn.legs.map(l => ({...l, matchup:(l.matchup||'').replace(/ @ /g,' v ')})), allPicks, '', ystMorn.date));
      if (ystEve?.date === date && ystEve.legs?.length)
        cards.push(renderTicketBlock('🌙 Night Ticket', ystEve.legs.map(l => ({...l, matchup:(l.matchup||'').replace(/ @ /g,' v ')})), allPicks, '', ystEve.date));
      if (!cards.length) {
        // Fall back to combined yesterday ticket
        const yst = JSON.parse(localStorage.getItem(_YST_TICKET_KEY) || 'null');
        if (yst?.date === date && yst.legs?.length)
          cards.push(renderTicketBlock('🎫 Daily Ticket', yst.legs.map(l => ({...l, matchup:(l.matchup||'').replace(/ @ /g,' v ')})), allPicks, '', yst.date));
      }
      if (cards.length) {
        ystTicketHTML = `<div class="tp-sport-section">
          <div class="tp-sport-hdr">🎫 Yesterday's Picks</div>
          ${grid(cards)}
        </div>`;
      } else {
        // Nothing in localStorage — kick off a Supabase fetch and show a loading state
        ystTicketHTML = `<div class="tp-sport-section">
          <div class="tp-sport-hdr">🎫 Yesterday's Picks</div>
          <div style="text-align:center;padding:30px;color:#888">Loading yesterday's picks…</div>
        </div>`;
        _fetchAndCacheYesterdayTickets(date);
      }
    } catch {}
  }

  // ── MLB ──
  const mlbPerGame = getMLBPerGameTickets(date, allPicks);
  const mlbHits    = getPicksForTicket('mlb_hits',    date, allPicks);
  const mlbRBI     = getPicksForTicket('mlb_rbi',     date, allPicks);
  const mlbHR      = getPicksForTicket('mlb_hr',      date, allPicks);
  const mlbKs      = getPicksForTicket('mlb_ks',      date, allPicks);
  const mlbDoubles = getPicksForTicket('mlb_doubles',  date, allPicks);
  const mlbXBH     = getPicksForTicket('mlb_xbh',     date, allPicks);
  const pending  = getLineupPendingMatchups(date, allPicks);

  // Count distinct games with lineups posted (need ≥3 for a meaningful combined ticket)
  const mlbGamesWithLineups = new Set(
    Object.entries(allPicks)
      .filter(([id, p]) => p.sport === 'mlb' && p.type === 'player' && p.date === date && id.startsWith('plr_'))
      .map(([id]) => id.split('_')[1])
  ).size;
  const showMLBAgg = mlbGamesWithLineups >= 3;

  const pendingNote = pending.length
    ? `<div class="tp-pending">⏳ Lineup pending: ${pending.map(m => esc(m)).join(' · ')}<br><span class="tp-pending-sub">Player prop picks fill in automatically once lineups post - they lock immediately when added${!showMLBAgg && mlbGamesWithLineups > 0 ? ` · Combined tickets unlock when 3+ lineups are in (${mlbGamesWithLineups}/3 so far)` : ''}</span></div>`
    : (!showMLBAgg && mlbGamesWithLineups > 0 ? `<div class="tp-pending">⏳ Combined tickets need 3+ lineups - ${mlbGamesWithLineups}/3 posted so far. Checking automatically.</div>` : '');

  const mlbAggCards = showMLBAgg ? [
    mlbHits.length    ? renderTicketBlock('🎯 1+ Hits',     mlbHits,    allPicks) : '',
    mlbRBI.length     ? renderTicketBlock('⚡ 1+ RBI',      mlbRBI,     allPicks) : '',
    mlbHR.length      ? renderTicketBlock('💣 To Hit HR',   mlbHR,      allPicks) : '',
    mlbDoubles.length ? renderTicketBlock('2️⃣ 1+ Double',   mlbDoubles, allPicks) : '',
    mlbXBH.length     ? renderTicketBlock('💥 1+ XBH',      mlbXBH,     allPicks) : '',
    mlbKs.length      ? renderTicketBlock('🔥 Pitcher Ks',  mlbKs,      allPicks) : '',
  ].filter(Boolean) : [];

  const toMLBCard = g => {
    const hasProps = g.legs.some(l => l.propType !== 'game');
    const pendFt   = !hasProps ? `<div class="tp-game-pending">⏳ Lineup not yet posted - props update automatically</div>` : '';
    return renderTicketBlock(esc(g.matchup.replace(/ @ /g,' v ')), g.legs, allPicks, pendFt);
  };
  const mlbPerGameCards = mlbPerGame.map(toMLBCard);
  const mlbHasAny = mlbPerGameCards.length || mlbAggCards.length;
  const mlbPerGameSection = mlbPerGameCards.length ? `<div class="tp-sub-hdr">Per Game</div>${grid(mlbPerGameCards)}` : '';

  const mlbHTML = `<div class="tp-sport-section">
    <div class="tp-sport-hdr">⚾ MLB</div>
    ${pendingNote}
    ${mlbAggCards.length ? `<div class="tp-sub-hdr">All-Games Combined</div>${grid(mlbAggCards)}` : ''}
    ${mlbPerGameSection}
    ${!mlbHasAny ? `<div class="tp-sport-empty">No MLB picks yet${off===0?' - visit MLB Picks tab to load data':''}</div>` : ''}
  </div>`;

  // ── Tennis ──
  const tnMain = getPicksForTicket('tennis_main', date, allPicks);
  const tnAll  = getPicksForTicket('tennis_all',  date, allPicks);
  const tnCards = [
    tnMain.length ? renderTicketBlock('🎾 Main Draws (Slam · Masters · 500 · 250)', tnMain, allPicks) : '',
    tnAll.length  ? renderTicketBlock('🎾 All Tournaments', tnAll, allPicks) : '',
  ].filter(Boolean);
  const tennisHTML = `<div class="tp-sport-section">
    <div class="tp-sport-hdr">🎾 Tennis</div>
    ${tnCards.length ? grid(tnCards) : `<div class="tp-sport-empty">No tennis picks yet${off===0?' - visit the Tennis tab':''}</div>`}
  </div>`;

  // ── Golf ──
  const { early: golfEarly, late: golfLate, singleTicket: golfSingle } = getGolfSplitTickets(date, allPicks);
  const golfCards = [];
  if (golfSingle) {
    if (golfEarly.length) golfCards.push(renderTicketBlock('⛳ Win Picks', golfEarly, allPicks));
  } else {
    if (golfEarly.length) golfCards.push(renderTicketBlock('⛳ Early Tee', golfEarly, allPicks));
    if (golfLate.length)  golfCards.push(renderTicketBlock('⛳ Late Tee',  golfLate,  allPicks));
  }
  const golfHTML = `<div class="tp-sport-section">
    <div class="tp-sport-hdr">⛳ Golf</div>
    ${golfCards.length ? grid(golfCards) : `<div class="tp-sport-empty">No golf picks yet${off===0?' - visit the Golf tab':''}</div>`}
  </div>`;

  // ── NBA ──
  const nbaLegs         = getPicksForTicket('nba', date, allPicks);
  const nbaPerGame      = getSportPerGameTickets(date, allPicks, 'nba');
  const nbaAggCards     = nbaLegs.length ? [renderTicketBlock('🏀 Best Bets', nbaLegs, allPicks)] : [];
  const nbaPerGameCards = nbaPerGame.map(g => renderTicketBlock(esc(g.matchup.replace(/ @ /g,' v ')), g.legs, allPicks));
  const nbaHasAny       = nbaAggCards.length || nbaPerGameCards.length;
  const nbaHTML = `<div class="tp-sport-section">
    <div class="tp-sport-hdr">🏀 NBA</div>
    ${nbaAggCards.length     ? `<div class="tp-sub-hdr">All-Games Combined</div>${grid(nbaAggCards)}` : ''}
    ${nbaPerGameCards.length ? `<div class="tp-sub-hdr">Per Game</div>${grid(nbaPerGameCards)}` : ''}
    ${!nbaHasAny ? `<div class="tp-sport-empty">No NBA picks yet${off===0?' - visit the NBA tab':''}</div>` : ''}
  </div>`;

  // ── WNBA ──
  const wnbaLegs         = getPicksForTicket('wnba', date, allPicks);
  const wnbaPerGame      = getSportPerGameTickets(date, allPicks, 'wnba');
  const wnbaAggCards     = wnbaLegs.length ? [renderTicketBlock('🏀 Best Bets', wnbaLegs, allPicks)] : [];
  const wnbaPerGameCards = wnbaPerGame.map(g => renderTicketBlock(esc(g.matchup.replace(/ @ /g,' v ')), g.legs, allPicks));
  const wnbaHasAny       = wnbaAggCards.length || wnbaPerGameCards.length;
  const wnbaHTML = `<div class="tp-sport-section">
    <div class="tp-sport-hdr">🏀 WNBA</div>
    ${wnbaAggCards.length     ? `<div class="tp-sub-hdr">All-Games Combined</div>${grid(wnbaAggCards)}` : ''}
    ${wnbaPerGameCards.length ? `<div class="tp-sub-hdr">Per Game</div>${grid(wnbaPerGameCards)}` : ''}
    ${!wnbaHasAny ? `<div class="tp-sport-empty">No WNBA picks yet${off===0?' - visit the WNBA tab':''}</div>` : ''}
  </div>`;

  // ── NHL ──
  const nhlLegs         = getPicksForTicket('nhl', date, allPicks);
  const nhlPerGame      = getSportPerGameTickets(date, allPicks, 'nhl');
  const nhlAggCards     = nhlLegs.length ? [renderTicketBlock('🏒 Best Bets', nhlLegs, allPicks)] : [];
  const nhlPerGameCards = nhlPerGame.map(g => renderTicketBlock(esc(g.matchup.replace(/ @ /g,' v ')), g.legs, allPicks));
  const nhlHasAny       = nhlAggCards.length || nhlPerGameCards.length;
  const nhlHTML = `<div class="tp-sport-section">
    <div class="tp-sport-hdr">🏒 NHL</div>
    ${nhlAggCards.length     ? `<div class="tp-sub-hdr">All-Games Combined</div>${grid(nhlAggCards)}` : ''}
    ${nhlPerGameCards.length ? `<div class="tp-sub-hdr">Per Game</div>${grid(nhlPerGameCards)}` : ''}
    ${!nhlHasAny ? `<div class="tp-sport-empty">No NHL picks yet${off===0?' - visit the NHL tab':''}</div>` : ''}
  </div>`;

  // ── NFL ──
  const nflLegs         = getPicksForTicket('nfl', date, allPicks);
  const nflPerGame      = getSportPerGameTickets(date, allPicks, 'nfl');
  const nflAggCards     = nflLegs.length ? [renderTicketBlock('🏈 Best Bets', nflLegs, allPicks)] : [];
  const nflPerGameCards = nflPerGame.map(g => renderTicketBlock(esc(g.matchup.replace(/ @ /g,' v ')), g.legs, allPicks));
  const nflHasAny       = nflAggCards.length || nflPerGameCards.length;
  const nflHTML = `<div class="tp-sport-section">
    <div class="tp-sport-hdr">🏈 NFL</div>
    ${nflAggCards.length     ? `<div class="tp-sub-hdr">All-Games Combined</div>${grid(nflAggCards)}` : ''}
    ${nflPerGameCards.length ? `<div class="tp-sub-hdr">Per Game</div>${grid(nflPerGameCards)}` : ''}
    ${!nflHasAny ? `<div class="tp-sport-empty">No NFL picks yet${off===0?' - NFL season runs Sep–Feb':''}</div>` : ''}
  </div>`;

  el.innerHTML = `<div class="tp-page">
    ${dateNav}
    <div class="tp-full-date">${fullDate}</div>
    ${off === 0 && !_svPreloadDone ? '<div class="tp-loading">⏳ Loading picks from all sports…</div>' : ''}
    ${todayPicksHTML}
    ${ystTicketHTML}
    ${mlbHTML}${tennisHTML}${golfHTML}${nbaHTML}${wnbaHTML}${nhlHTML}${nflHTML}
  </div>`;
}

function showSimpleView() {
  document.body.classList.add('simple-mode');
  document.getElementById('simple-view').classList.add('sv-active');
  renderSimpleView();
  preloadPicksForSimpleView();
}

function hideSimpleView(bypassGate) {
  if (!bypassGate) {
    if (_hasFullAccess()) {
      // fall through to dismiss
    } else if (_currentUserRole === 'banned') {
      return; // banned users stay on simple view, which shows a suspension notice
    } else if (_authReady && !_currentUser) {
      openAuthModal();
      return;
    } else if (_currentUser && _currentUserRole === null) {
      // Role still loading — show feedback, updateAuthUI will auto-dismiss once role arrives
      const btn = document.querySelector('.sv-full-btn');
      if (btn && !btn.disabled) { btn.disabled = true; btn.textContent = 'Checking…'; }
      return;
    } else {
      openUpgradeModal();
      return;
    }
  }
  document.body.classList.remove('simple-mode');
  document.getElementById('simple-view').classList.remove('sv-active');
  localStorage.setItem('sv_dismissed', dateStrLocal());
}

function renderSimpleView() {
  const el    = document.getElementById('sv-content');
  const today = dateStrLocal();

  document.getElementById('sv-date').textContent =
    new Date(today + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  const headline = document.querySelector('.sv-headline');
  if (headline) headline.textContent = "Today's Tickets";

  const allPicks = getPicks();
  const morn = getMorningTicket();
  const eve  = getEveningTicket();

  // Current ET hour for night-ticket timing message
  let etHour = 0;
  try { etHour = parseInt(new Date().toLocaleString('en-US', { hour:'numeric', hour12:false, timeZone:'America/New_York' })) || 0; } catch {}

  if (!morn && !eve) {
    let msg = '';
    if (!_svPreloadDone) {
      msg = `<div class="spinner" style="margin:0 auto 10px"></div>Building today's tickets…`;
    } else if (etHour < 1) {
      msg = `Today's ticket will be posted after 1 AM ET once all picks are confirmed.`;
    } else {
      msg = `Today's ticket hasn't been posted yet. Check back soon.`;
    }
    el.innerHTML = `<div class="sv-empty">${msg}</div>`;
    return;
  }

  const ticketRow = (leg, i) => {
    const live   = allPicks[leg.id] || {};
    const result = live.result;
    const badge  = result === 'win'  ? '<span class="sv-badge sv-badge-w">W</span>'
                 : result === 'loss' ? '<span class="sv-badge sv-badge-l">L</span>' : '';
    const conf   = Math.min(3, Math.max(1, leg.conf || 1));
    const dots   = '●'.repeat(conf) + '○'.repeat(3 - conf);
    const icon   = SPORT_ICONS[leg.sport] || '🏅';
    const match  = (leg.matchup || '').replace(/ @ /g, ' v ');
    const svDesc = cleanLegDesc(leg);
    const pickLine = svDesc
      ? `<span class="sv-tk-pick">${esc(leg.pick)}</span><span class="sv-tk-prop">${esc(svDesc)}</span>`
      : `<span class="sv-tk-pick">${esc(leg.pick)}</span>`;
    return `<div class="sv-tk-row${result==='win'?' sv-tk-win':result==='loss'?' sv-tk-loss':''}">
      <span class="sv-tk-num">${i+1}</span>
      <span class="sv-tk-icon">${icon}</span>
      <span class="sv-tk-match">${esc(match)}</span>
      <span class="sv-tk-arrow">→</span>
      ${pickLine}
      <span class="sv-tk-conf">${dots}</span>
      ${badge}
    </div>`;
  };

  const makeBlock = (label, ticket) => {
    const legs   = ticket.legs;
    const wins   = legs.filter(l => allPicks[l.id]?.result === 'win').length;
    const losses = legs.filter(l => allPicks[l.id]?.result === 'loss').length;
    const status = (wins || losses) ? `<span class="sv-tk-status">${wins}W – ${losses}L</span>` : '';
    let dateLabel = '';
    try { dateLabel = new Date((ticket.date || today) + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }); } catch {}
    return `<div class="sv-ticket">
      <div class="sv-ticket-date-line">${dateLabel}</div>
      <div class="sv-ticket-hdr">${esc(label)} - ${legs.length} Leg${legs.length!==1?'s':''} ${status}</div>
      <div class="sv-ticket-list">${legs.map(ticketRow).join('')}</div>
    </div>`;
  };

  const dayHTML   = morn ? makeBlock('🌤 Day Ticket', morn) : '';
  const nightHTML = eve
    ? makeBlock('🌙 Night Ticket', eve)
    : `<div class="sv-ticket sv-ticket-pending">
        <div class="sv-ticket-hdr">🌙 Night Ticket</div>
        <div class="sv-pending-msg">Check back after 5:00 PM ET for tonight's picks</div>
      </div>`;

  el.innerHTML = `<div class="sv-tickets-grid">${dayHTML}${nightHTML}</div>`;
}

// BFCache restore: reset checkout buttons that were disabled before navigating to Stripe
window.addEventListener('pageshow', (evt) => {
  if (evt.persisted) _resetCheckoutButtons();
});

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
function renderTZSelector() {
  const el = document.getElementById('tz-selector');
  if (!el) return;
  const cur = getUserTZ();
  el.innerHTML = TZ_OPTIONS.map(o =>
    `<button class="tz-btn${o.tz === cur ? ' tz-active' : ''}" data-tz="${o.tz}" onclick="setUserTZ('${o.tz}')">${o.label}</button>`
  ).join('');
}

function init() {
  // One-time ticket rebuild to pick up tennis picks + fix bad NHL stats
  if (!localStorage.getItem('_rebuild_v164')) {
    localStorage.removeItem('_ticket_built_v10');
    localStorage.setItem('_rebuild_v164', '1');
  }
  // One-time: purge tennis picks stored with today's date but event_date from the past
  if (!localStorage.getItem('_rebuild_v169')) {
    localStorage.setItem('_rebuild_v169', '1');
  }
  // One-time: un-grade any player picks that were wrongly marked loss during live play
  if (!localStorage.getItem('_rebuild_v182')) {
    const today = dateStrLocal(0);
    const picks = getPicks();
    let changed = false;
    for (const [id, p] of Object.entries(picks)) {
      if (p.type === 'player' && p.result === 'loss' && p.date === today) {
        picks[id].result = null;
        changed = true;
      }
    }
    if (changed) savePicks(picks);
    localStorage.setItem('_rebuild_v182', '1');
  }
  // One-time: clear old dateless golf pickIds (golf_NNNN_ovN) + force ticket rebuild
  if (!localStorage.getItem('_rebuild_v164b')) {
    const picks = getPicks();
    let changed = false;
    for (const id of Object.keys(picks)) {
      if (/^golf_\d+_ov\d+$/.test(id)) { delete picks[id]; changed = true; }
    }
    if (changed) savePicks(picks);
    localStorage.setItem('_rebuild_v164b', '1');
  }
  // One-time v211: drop stale device-local built-flags so every device re-reads Supabase
  if (!localStorage.getItem('_rebuild_v211')) {
    localStorage.removeItem('_day_built_v1');
    localStorage.removeItem('_night_built_v1');
    localStorage.setItem('_rebuild_v211', '1');
  }
  // One-time v213: clear both ticket flags so today's bad ticket is discarded on all devices
  // and a fresh one is built after 5am ET with complete pick data
  if (!localStorage.getItem('_rebuild_v213')) {
    localStorage.removeItem('_day_built_v1');
    localStorage.removeItem('_night_built_v1');
    localStorage.removeItem(_MORN_TICKET_KEY);
    localStorage.removeItem(_EVE_TICKET_KEY);
    localStorage.setItem('_rebuild_v213', '1');
  }
  // One-time v216: clear ticket cache so slam picks with the fixed minGap=2 get included
  if (!localStorage.getItem('_rebuild_v216')) {
    localStorage.removeItem('_day_built_v1');
    localStorage.removeItem('_night_built_v1');
    localStorage.removeItem(_MORN_TICKET_KEY);
    localStorage.removeItem(_EVE_TICKET_KEY);
    localStorage.setItem('_rebuild_v216', '1');
  }

  clearOldPicks();
  updatePicksDisplay();
  renderTZSelector();
  renderDateBar();
  const lastSport = localStorage.getItem('_baseline_sport') || 'tennis';
  switchSport(lastSport);
  // Read params BEFORE stripping — replaceState changes location.search immediately
  const _ckParam = new URLSearchParams(location.search).get('checkout');
  if (location.search) history.replaceState({}, '', location.pathname);
  if (_ckParam === 'success') {
    const _banner = document.createElement('div');
    _banner.className = 'checkout-activating';
    _banner.textContent = 'Payment received - activating your subscription...';
    document.body.appendChild(_banner);
    setTimeout(() => _banner.remove(), 8000);
  }

  // Always show simple view on load - initAuth will auto-hide for paid/admin who already dismissed today
  showSimpleView();
  initAuth();
  // Returning from a cancelled checkout: auto-reopen subscribe screen once auth has had time to settle
  if (_ckParam === 'cancel') setTimeout(() => { if (!_hasFullAccess()) openUpgradeModal(); }, 1200);

  // If returning from payment, poll until role flips to paid
  if (_ckParam === 'success') {
    setTimeout(() => { if (_currentUser) _pollForPaidRole(); }, 2000);
  }
}

init();
