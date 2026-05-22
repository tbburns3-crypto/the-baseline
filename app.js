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

// ── REST DAYS CACHE ──────────────────────────────────────────
// Populated by populateRestDaysCache() during preload.
// Key: "sport:ABBR" (e.g. "nba:BOS"), value: daysRest (1=B2B, 2=short, 3+=normal)
const _restDaysCache = new Map();

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

function recordPick(gameId, pickedTeam, matchup = '', sport = '', conf = 0, force = false, dateOverride = null) {
  const picks = getPicks();
  const existing = picks[gameId];
  // force = true lets a nuanced pick overwrite a simple W-L seed, but never overwrite a resolved result
  if (existing && (!force || existing.result !== null)) return;
  picks[gameId] = { team: pickedTeam, date: dateOverride || dateStrLocal(), result: existing?.result ?? null, matchup, sport, conf };
  savePicks(picks);
}

function recordPlayerPick(pickKey, sport, playerName, prop, stat, gameMatchup, gamePk) {
  const picks = getPicks();
  if (picks[pickKey]) return;
  picks[pickKey] = { type: 'player', sport, player: playerName, prop, stat, gameMatchup, gamePk: gamePk || null, date: dateStrLocal(), result: null };
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

  const PROP_ICON = { Hit:'🎯', HR:'💣', RBI:'⚡', Walk:'🚶', SB:'🏃', Points:'🏀', Rebounds:'📊', Assists:'🎽' };

  const makeRow = p => {
    const win = p.result === 'win';
    return `<div class="ph-row ${win ? 'ph-win' : 'ph-loss'}">
      <span class="ph-icon">${win ? '✓' : '✗'}</span>
      <span class="ph-matchup">${esc(p.matchup || p.team)}</span>
      <span class="ph-pick">→ ${esc(p.team)}</span>
    </div>`;
  };

  const makePendingRow = p => `<div class="ph-row ph-pending-row">
    <span class="ph-icon">⏳</span>
    <span class="ph-matchup">${esc(p.matchup || p.team)}</span>
    <span class="ph-pick">→ ${esc(p.team)}</span>
  </div>`;

  const makePlayerRow = p => {
    const win  = p.result === 'win';
    const icon = p.result === null ? '⏳' : (win ? '✓' : '✗');
    const cls  = p.result === null ? 'ph-pending-row' : (win ? 'ph-win' : 'ph-loss');
    return `<div class="ph-row ph-player-row ${cls}">
      <span class="ph-icon">${icon}</span>
      <span class="ph-matchup"><span class="ph-prop-badge">${PROP_ICON[p.prop]||''} ${esc(p.prop)}</span> ${esc(lastName(p.player || ''))}</span>
      <span class="ph-pick">${esc(p.gameMatchup || '')}</span>
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

  const todayUTC = dateStrLocal(0);
  const ystUTC   = dateStrLocal(-1);
  const fmtDayLabel = d => {
    if (d === todayUTC) return 'Today';
    if (d === ystUTC)   return 'Yesterday';
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
      const pendBadge = dayPending.length
        ? `<span class="ph-day-pend">${dayPending.length} pending</span>` : '';
      content += `<div class="ph-day-hdr">${fmtDayLabel(date)}${recordBadge}${pendBadge}</div>`;
      if (dayPending.length)  content += dayPending.map(renderPend).join('');
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
      return `<div class="ph-cal-row"><span class="ph-cal-dots">${dots}</span><span class="ph-cal-stat ph-cat-${cls}">${tiers[c].w}-${tiers[c].t-tiers[c].w} (${pct}%)</span></div>`;
    }).join('');
    content += `<div class="ph-cal-section"><div class="ph-sport-hdr">Accuracy by Confidence</div>${calRows}</div>`;
  }

  const modal = document.createElement('div');
  modal.id    = 'picks-history-modal';
  modal.className = 'ph-modal';
  modal.innerHTML = `<div class="ph-panel">
    <div class="ph-hdr">
      <span class="ph-title">${esc(sportLabel)} Pick History</span>
      <span class="ph-sub">last 14 days</span>
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

  const sportPicks = allVals.filter(p => (p.sport || 'tennis') === sport);
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

  // Banner — always visible, shows this sport's record only
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
    pbWins.textContent = '—';
    pbLoss.textContent = '—';
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
}
// Returns YYYY-MM-DD in the user's chosen timezone (default ET)
function dateStrLocal(offset = 0) {
  const d = new Date();
  if (offset) d.setDate(d.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { timeZone: getUserTZ() }).format(d);
}
// Format an ISO datetime string into a time string in the user's timezone
function fmtTimeTZ(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (!isNaN(d)) return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone: getUserTZ() });
  } catch {}
  return iso;
}

// ── UTILITIES ───────────────────────────────────────────────
function dateStr(offset = 0) {
  return dateStrLocal(offset); // use user-chosen TZ for all date math
}
// Tennis API uses UTC dates — use this for all tennis fetches and event_date comparisons
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
    const d = dateStrLocal(offset); // use user TZ — tennis date bar matches the user's "today"
    const results = await tennisFetch('get_fixtures', { date_start: d, date_stop: d });
    for (const m of results) S.matches.set(String(m.event_key), m);
    renderMatches(results);
    renderOverview(results);
    renderSidebar(results);
    // Picks just got recorded — refresh simple view if it's open
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

// Background-only rank load — no UI, just fills S.rankIndex then re-runs picks for cached matches.
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

    // Supplement with ESPN tennis rankings — updated much more frequently than api-tennis.com.
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
                // ESPN has this player ranked higher — use it (with synthetic points so ratio logic works)
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
  } catch { /* silent — rankings are best-effort for pick generation */ }
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
  } catch { /* silent — injury data is best-effort */ }
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

// Tournament-specific affinity — last name (lowercase) → partial tournament name → strength (1-4)
// Updated 2025: reflect current form, post-surgery players, new top-10 entrants
const TOURNAMENT_AFFINITY = {
  // ATP
  djokovic:  { 'australian open':2, 'wimbledon':2, 'us open':2, 'paris masters':2 }, // reduced — post-surgery 2024, less dominant in 2025
  alcaraz:   { 'roland garros':4, 'french open':4, 'wimbledon':3, 'us open':2, 'madrid':3, 'barcelona':2 },
  sinner:    { 'australian open':4, 'miami':2, 'us open':3, 'paris masters':2 },
  zverev:    { 'roland garros':3, 'paris masters':3, 'hamburg':2, 'french open':3 },
  tsitsipas: { 'monte carlo':2, 'barcelona':2, 'lyon':2 }, // reduced — less consistent 2024-25
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
  jabeur:    { 'wimbledon':2, 'roland garros':2 }, // reduced — injury history 2024
};

function isGrandSlam(m) {
  const n = (m.tournament_name || m.event_type_type || '').toLowerCase();
  return /wimbledon|us open|french open|roland.?garros|australian open/.test(n);
}

function isBestOf5(m) {
  return isGrandSlam(m) && matchCategory(m.event_type_type || '') === 'atp';
}

function tournamentTier(m) {
  const n = (m.tournament_name || '').toLowerCase();
  if (isGrandSlam(m)) return 'slam';
  if (/masters 1000|rolex|indian wells|miami open|madrid|rome|montreal|toronto|cincinnati|shanghai|paris masters|monte.?carlo/.test(n)) return 'masters';
  if (/500|dubai|acapulco|barcelona|halle|queen.?s|eastbourne|washington|osaka|beijing|vienna|basel|rotterdam/.test(n)) return '500';
  return '250';
}

function inlineTennisPick(m, dateOverride = null) {
  // Don't generate picks for in-progress matches.
  // When dateOverride is set (pre-seeding tomorrow's picks), allow future dates.
  if (!dateOverride && m.event_date && m.event_date > dateStrLocal(0)) return '';
  if (isLive(m.event_status)) return '';

  // Skip doubles only — singles rankings are meaningless in doubles
  const cat = matchCategory(m.event_type || '');
  if (cat === 'doubles') return '';

  const pickId  = 'tn_' + m.event_key;
  const surface = m.event_surface ? ` (${m.event_surface})` : '';
  const matchup = `${lastName(m.event_first_player||'')} vs ${lastName(m.event_second_player||'')}${surface}`;

  // Injury check — ESPN news flags recent injuries, withdrawals, surgery
  const p1Ln  = lastName(m.event_first_player  || '').toLowerCase();
  const p2Ln  = lastName(m.event_second_player || '').toLowerCase();
  const p1Inj = _tennisInjuryMap.get(p1Ln);
  const p2Inj = _tennisInjuryMap.get(p2Ln);
  // If a player is confirmed injured (not just returning), skip them as the pick
  const p1Hurt = p1Inj && !p1Inj.returning;
  const p2Hurt = p2Inj && !p2Inj.returning;
  // If both are injured or the situation is murky, defer to other signals
  const injuryForcePick = (p1Hurt && !p2Hurt) ? p2Ln :
                          (p2Hurt && !p1Hurt) ? p1Ln : null;

  const s1 = parseInt(m.event_first_player_seed) || 0;
  const s2 = parseInt(m.event_second_player_seed) || 0;

  // Seeding: tournament directors factor in current fitness, not just ranking.
  // Any seed difference is a real signal — even in ITF/Challenger events.
  if (s1 || s2) {
    let seedPick = '';
    if (s1 && !s2)      seedPick = lastName(m.event_first_player || '');
    else if (s2 && !s1) seedPick = lastName(m.event_second_player || '');
    else if (s1 < s2)   seedPick = lastName(m.event_first_player || '');
    else if (s2 < s1)   seedPick = lastName(m.event_second_player || '');

    // Override seed pick if seed winner is injured and opponent is healthy
    const pick = (injuryForcePick && seedPick && seedPick.toLowerCase() !== injuryForcePick)
      ? (p1Hurt ? lastName(m.event_second_player||'') : lastName(m.event_first_player||''))
      : seedPick;

    const injNote = injuryForcePick && pick.toLowerCase() !== seedPick.toLowerCase()
      ? ` · opp. has injury news` : '';
    if (pick && pick !== '-') {
      // Seed gap confidence: top seed (1-4) vs unseeded or big gap = 2, smaller gap = 1
      const seedConf = injuryForcePick ? 2 : (s1 && s2 && Math.abs(s1 - s2) >= 4) ? 2 : 1;
      recordPick(pickId, pick, matchup, 'tennis', seedConf, false, dateOverride);
      return `<span class="match-pick-inline" title="Pick based on seeding${injNote} (click for full H2H analysis)">→ ${esc(pick)}</span>`;
    }
  }

  // If injury clearly overrides ranking — one player is injured, skip normal logic and pick healthy one
  if (injuryForcePick) {
    const pick = injuryForcePick === p1Ln ? lastName(m.event_first_player||'') : lastName(m.event_second_player||'');
    if (pick && pick !== '-') {
      recordPick(pickId, pick, matchup, 'tennis', 2, false, dateOverride);
      return `<span class="match-pick-inline match-pick-injury" title="Pick: opponent has recent injury news — ${(p1Hurt ? p1Inj : p2Inj).note}">→ ${esc(pick)} ⚕</span>`;
    }
  }

  // Points-ratio comparison: more honest than rank gap alone.
  // Rank #45 (820 pts) vs #50 (780 pts) = nearly identical → no pick.
  // Rank #100 (700 pts) vs #400 (120 pts) = massive real gap → pick.
  // A rising player at #400 with 500 pts beats a declining #100 at 480 pts in this ratio.
  const r1 = S.rankIndex.get(String(m.first_player_key  || ''));
  const r2 = S.rankIndex.get(String(m.second_player_key || ''));
  if (r1 && r2) {
    const pts1 = parseInt(r1.points) || 0;
    const pts2 = parseInt(r2.points) || 0;
    if (pts1 > 0 && pts2 > 0) {
      const ratio = Math.max(pts1, pts2) / Math.min(pts1, pts2);
      // Threshold: 1.5× normally, but lower to 1.3× when opponent has injury news (more confident)
      const threshold = (p1Hurt || p2Hurt) ? 1.3 : 1.5;
      if (ratio >= threshold) {
        let pick = pts1 > pts2 ? lastName(m.event_first_player || '') : lastName(m.event_second_player || '');
        // Override if ranking winner is injured and opponent is healthy
        if (injuryForcePick && pick.toLowerCase() !== injuryForcePick)
          pick = injuryForcePick === p1Ln ? lastName(m.event_first_player||'') : lastName(m.event_second_player||'');
        const injNote2 = (p1Hurt || p2Hurt) ? ' · opp. has injury news' : '';
        // Ratio confidence: 3x+ gap = 2, injury bonus adds 1
        const ratioConf = (injuryForcePick ? 1 : 0) + (ratio >= 3 ? 2 : 1);
        if (pick && pick !== '-') {
          recordPick(pickId, pick, matchup, 'tennis', Math.min(3, ratioConf), false, dateOverride);
          return `<span class="match-pick-inline" title="Pick: ${pts1} vs ${pts2} ranking pts${injNote2} (click for H2H)">→ ${esc(pick)}</span>`;
        }
      }
    } else if (r1.rank !== r2.rank) {
      // Fallback when points data missing: use rank but only when gap is very clear (top 50 vs 100+)
      const topRank = Math.min(r1.rank, r2.rank);
      const botRank = Math.max(r1.rank, r2.rank);
      if (topRank <= 50 && botRank >= 100) {
        const pick = r1.rank < r2.rank ? lastName(m.event_first_player || '') : lastName(m.event_second_player || '');
        if (pick && pick !== '-') {
          recordPick(pickId, pick, matchup, 'tennis', 1, false, dateOverride);
          return `<span class="match-pick-inline" title="Pick: #${r1.rank} vs #${r2.rank} (click for H2H + form analysis)">→ ${esc(pick)} #${topRank}</span>`;
        }
      }
    }
  }
  return '';
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
    : `<span class="status time-status">${esc(fmtTime12(m.event_time))}</span>`;

  const setsHTML = sets.map((s, i) => {
    const cur = live && i === sets.length - 1;
    return `<span class="set-score ${cur ? 'current-set' : ''}">${esc(s.p1)}<br>${esc(s.p2)}</span>`;
  }).join('');

  const gameHTML = live && m.event_game_result
    ? `<span class="game-score">${esc(m.event_game_result).replace('-','<br>')}</span>`
    : '';

  const p1serve = serve === '1' ? '<span class="serve-dot">●</span>' : '';
  const p2serve = serve === '2' ? '<span class="serve-dot">●</span>' : '';

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
          ${p1serve}<span class="player-name">${esc(m.event_first_player||'-')}</span>${injBadge(m.event_first_player)}
        </div>
        <div class="player p2 ${serve==='2'?'serving':''}">
          ${p2serve}<span class="player-name">${esc(m.event_second_player||'-')}</span>${injBadge(m.event_second_player)}
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

  // Fatigue: last match was yesterday — possible carry-over fatigue
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
    verdictHTML = `<div class="gp-pick-verdict gp-verdict-toss">Even matchup — too close to call${leanHTML}</div>`;
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
  const serve    = String(m.event_serve ?? '');

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
  loadFixtures(offset);
}

// ── SPORT / VIEW SWITCHING ───────────────────────────────────
function stopScoresTimer() {
  if (S.scoresTimer) { clearInterval(S.scoresTimer); S.scoresTimer = null; }
}

function loadSportScores(sport) {
  if (sport === 'soccer')   loadSoccerScores();
  else if (sport === 'golf')    loadGolfLeaderboard();
  else if (sport === 'lottery') loadLottery();
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
  } else if (sport === 'lottery') {
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
    loadTennisInjuryNews(); // fire-and-forget: ESPN news injury flags — re-runs picks once loaded
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
      const panelId = S.sport === 'golf' ? 'view-golf-leaderboard' : S.sport === 'lottery' ? 'view-lottery' : 'view-other-scores';
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

// Records pick + immediately resolves if game is finished. Pre-game only — never mid-game.
// dateOverride: pass dateStrLocal(1) when pre-loading tomorrow's games so picks get the right date.
function autoRecordAndResolvePick(g, dateOverride = null) {
  if (!g.awayRec && !g.homeRec) return;
  const { fin, live } = gameRowState(g);
  if (!live && !fin) {
    const sc   = parseSeriesContext(g.series);
    // Playoffs: home court worth more (crowd, refs, routines) — bump by extra 2%
    const playoffMult = sc.isPlayoff ? 1.02 : 1.0;
    const boost    = (HOME_BOOST[g.sport] || 1.025) * playoffMult;
    const momentum = seriesMomentumAdj(sc, g.homeTeam, g.homeAbbr, g.awayTeam, g.awayAbbr);
    const homeRM   = restMult(getDaysRest(g.homeAbbr, g.sport));
    const awayRM   = restMult(getDaysRest(g.awayAbbr, g.sport));
    const homeWPr  = smartWP(g.homeRecs || { total: g.homeRec }, true,  g.sport) * momentum.home * homeRM;
    const awayWPr  = smartWP(g.awayRecs || { total: g.awayRec }, false, g.sport) * momentum.away * awayRM;
    const rawHome  = homeWPr * boost;
    const total    = awayWPr + rawHome;
    const homeFrac = rawHome / total;
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

  // Finished game — show W/L result against the stored pre-game pick
  if (fin) {
    if (!stored || stored.result === null) return '';
    return stored.result === 'win'
      ? `<span class="game-pick-inline pick-win" title="Pick correct">✓ ${esc(stored.team)}</span>`
      : `<span class="game-pick-inline pick-loss" title="Pick wrong">✗ ${esc(stored.team)}</span>`;
  }

  // Live game — freeze the pre-game pick, never recalculate mid-game
  if (live) {
    if (!stored) return '';
    return `<span class="game-pick-inline pick-locked" title="Pre-game pick (locked)">→ ${esc(stored.team)}</span>`;
  }

  // Pre-game — show smart win probability (with playoff context + rest/B2B)
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

// Determine which team leads the series and return their edge multiplier
function seriesMomentumAdj(sc, homeTeam, homeAbbr, awayTeam, awayAbbr) {
  if (!sc.isPlayoff || !sc.leader) return { home: 1.0, away: 1.0 };
  const ll = sc.leader.toLowerCase();
  // Match by partial name or abbreviation (ESPN uses city or nickname in series leader)
  const homeMatch = homeTeam.toLowerCase().split(' ').some(w => ll.includes(w)) ||
                    homeAbbr.toLowerCase() === ll;
  return homeMatch
    ? { home: 1.015, away: 1.0 }   // home team leads series → small momentum edge
    : { home: 1.0,   away: 1.015 };
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
  if (margin >= 0.14) return 2;
  if (margin >= 0.08) return 1;
  return 0;
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

  // 2. Home advantage (4% regular season, 6% playoffs — crowd + routine + refs)
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

  // 8. Pitcher last start quality (MLB)
  if (sport === 'mlb' && (awayLastStartERA !== null || homeLastStartERA !== null)) {
    const ase = parseFloat(awayERA || 4.20), hse = parseFloat(homeERA || 4.20);
    if (awayLastStartERA !== null) { const d = awayLastStartERA - ase; if (d < -1.5) aScore += 0.025; else if (d > 2.5) aScore -= 0.025; }
    if (homeLastStartERA !== null) { const d = homeLastStartERA - hse; if (d < -1.5) hScore += 0.025; else if (d > 2.5) hScore -= 0.025; }
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
    ? `<div class="gp-pick-verdict gp-verdict-toss">🎲 Toss-up — too close to call <em class="gp-verdict-lean">(leaning towards ${esc(pickTeam)})</em></div>`
    : `<div class="gp-pick-verdict">📌 ${gap > 0.14 ? 'Strong lean' : gap > 0.08 ? 'Lean' : 'Slight lean'}: <span class="gp-pick-team">${esc(pickTeam)}</span>${fTotal > 0 ? ` <span class="gp-pick-count">${fWins}/${fTotal} factors</span>` : ''}</div>`;

  const factorsHTML = factors.map(f => {
    const myWin = pickIsHome ? f.winner === 'home' : f.winner === 'away';
    const isTie = f.winner === 'tie';
    let cls  = isTie ? 'gp-pf-tie' : myWin ? 'gp-pf-win' : 'gp-pf-loss';
    if (f.label === 'Weather') cls += f.extreme ? ' gp-pf-weather-warn' : ' gp-pf-weather';
    const icon = isTie ? '~' : myWin ? '✓' : '✗';
    return `<div class="gp-pfactor ${cls}"><span class="gp-pf-icon">${icon}</span><span class="gp-pf-label">${esc(f.label)}</span><span class="gp-pf-detail">${f.detail}</span></div>`;
  }).join('');

  const pickedConf = gap < 0.025 ? 1 : gap > 0.14 ? 3 : gap > 0.08 ? 2 : 1;
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

  // Pitcher rate stats — adjusted for recent form + bullpen drag + last start + rest
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
      hitScore, hrScore, rbiScore, bbScore, sbScore, hScore,
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
    if (!fin && !live) {
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
    ${momentumLine}
    ${oddsLine}
    ${pitcherLine}
    ${wxLine}
    ${projLine}
    ${pitWarnLine}
    ${picksHTML}
  </div>`;
}

// ── TENNIS PICKS PAGE ────────────────────────────────────────
async function loadTennisPicksPage() {
  const seq  = _loadSeq;
  const area = document.getElementById('mlb-picks-area');
  area.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><p>Loading picks…</p></div>`;

  try {
    const d = dateStrLocal(S.dateOffset);
    const results = await tennisFetch('get_fixtures', { date_start: d, date_stop: d });
    for (const m of results) {
      S.matches.set(String(m.event_key), m);
      inlineTennisPick(m);
      if (isFinished(m.event_status) && m.event_winner) {
        let wln = '';
        if (m.event_winner === 'First Player')       wln = lastName(m.event_first_player || '');
        else if (m.event_winner === 'Second Player') wln = lastName(m.event_second_player || '');
        else                                          wln = lastName(m.event_winner);
        if (wln) resolvePick('tn_' + m.event_key, wln);
      }
    }
  } catch {}

  let tennisPicks = Object.values(getPicks()).filter(p => (p.sport || 'tennis') === 'tennis');
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

  let todayHTML = '';
  if (!tennisPicks.length) {
    todayHTML = '<div class="empty-state muted">No picks recorded yet today.<br>Picks generate for seeded/ranked matches.</div>';
  } else {
    if (pending.length) {
      todayHTML += `<div class="ph-sport-hdr ph-pending-hdr">Today — Pending (${pending.length})</div>`;
      todayHTML += pending.map(makeRow).join('');
    }
    if (resolved.length) {
      const w = resolved.filter(p => p.result === 'win').length;
      todayHTML += `<div class="ph-sport-hdr">Today — Results ${w}W ${resolved.length - w}L</div>`;
      todayHTML += resolved.map(makeRow).join('');
    }
  }

  if (_loadSeq !== seq) return;
  area.innerHTML = `
    <div class="pc-data-note">Picks use seedings · rankings · H2H · surface form · fatigue · round weighting</div>
    <div class="ph-list">${todayHTML}</div>
    <div class="tp-tomorrow-section">
      <div class="tp-tmrw-hdr">
        <span class="tp-tmrw-title">Tomorrow's Preview</span>
        <span class="tp-tmrw-sub">H2H analysis · top ATP &amp; WTA matches</span>
      </div>
      <div id="tomorrow-preview-area"><div class="loading-spinner" style="padding:16px"><div class="spinner"></div></div></div>
    </div>`;
  updatePicksDisplay();

  // Load tomorrow's H2H analysis in the background
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

    // Only ATP/WTA singles with player keys — cap at 10 to limit API calls
    const eligible = results.filter(m => {
      const cat = matchCategory(m.event_type_type || '');
      return ['atp','wta'].includes(cat) && m.first_player_key && m.second_player_key;
    }).slice(0, 10);

    if (!eligible.length) {
      area.innerHTML = '<div class="tp-empty">No tomorrow matches found yet — check back later today.</div>';
      return;
    }

    // Pre-fetch H2H for all eligible matches in parallel
    await Promise.allSettled(eligible.map(m => fetchH2HCached(m.first_player_key, m.second_player_key)));

    const cards = eligible.map(m => buildTomorrowPickCard(m)).join('');
    if (_loadSeq !== seq) return;
    area.innerHTML = cards || '<div class="tp-empty">No analysis available.</div>';
  } catch (err) {
    const area2 = document.getElementById('tomorrow-preview-area');
    if (area2) area2.innerHTML = `<div class="tp-empty">Could not load tomorrow's matches — ${esc(err.message)}</div>`;
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

  // H2H on surface (weight 3 — most predictive)
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

  // Record the pick with full analysis
  if (pickName && m.event_date && m.event_date >= dateStrLocal(0)) {
    const pickId  = 'tn_' + m.event_key;
    const surfTag = surface ? ` (${surface})` : '';
    const matchup = `${l1} vs ${l2}${surfTag}`;
    recordPick(pickId, lastName(pickName), matchup, 'tennis', conf, true); // force=true: H2H analysis overrides inline seed pick
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
      <span class="tp-match-time">${esc(fmtTime12(m.event_time || ''))}</span>
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
  // Match on displayName (ESPN uses 'Points', 'Rebounds', 'Assists' — not the name field)
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
          recordPlayerPick(pickKey, g.sport || 'nba', top.athlete.displayName, 'Points', `${top.displayValue} PPG`, matchup, null);
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
      // Pre-fetch game summaries in parallel — contains season leaders per team
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

    const pickResult = buildPickSection(awayAbbr, homeAbbr, {
      awayRec: espnGame.awayRec || '', homeRec: espnGame.homeRec || '',
      awayERA: awayPD?.season?.era ?? null, homeERA: homePD?.season?.era ?? null,
      awayLastStartERA: awayPD?.lastStartERA ?? null, homeLastStartERA: homePD?.lastStartERA ?? null,
      awayRestDays: awayPD?.restDays ?? null, homeRestDays: homePD?.restDays ?? null,
      awayAbbr, homeAbbr,
      sport: 'mlb', weather: mlbGame.weather || null, weatherFmt: 'mlb'
    });
    const pickHTML = pickResult.html;
    // Force-update with the nuanced multi-factor pick — pre-game only, never live or finished
    const _gs = gameRowState(espnGame);
    if (pickResult.team && !_gs.fin && !_gs.live) {
      recordPick(String(espnGame.id), pickResult.team, gameMatchup, 'mlb', pickResult.conf, true);
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
    // Force-update with nuanced pick (form + H2H + series) so simple W-L seed is replaced
    if (pickResult.team && !gameRowState(game).fin) {
      recordPick(String(game.id), pickResult.team, `${game.awayTeam} @ ${game.homeTeam}`, game.sport || '', pickResult.conf, true);
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

function formatTeeTime(raw) {
  try { const d = new Date(raw); if (!isNaN(d)) return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone: getUserTZ() }); } catch {}
  return String(raw);
}

// ESPN embeds tee time inside linescores statistics rather than at the competitor root.
// Search ALL linescores rounds and ALL stat categories in case it's not in [0].
function extractTeeTime(p) {
  if (p.teeTime) return p.teeTime;
  try {
    for (const ls of (p.linescores || [])) {
      for (const cat of (ls.statistics?.categories || [])) {
        for (const stat of (cat.stats || [])) {
          const dv = String(stat.displayValue || '');
          // Match any string that looks like a date/time (contains colon-separated time + year)
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

// Returns { groups: [...], upcomingGroups: [...] }
// groups: players with hole data, keyed by (teeTime + startingNine) for split-tee correctness.
// upcomingGroups: players yet to tee off, grouped by tee time (starting nine unknown until play).
function groupByTeeTime(players, round = 1) {
  const definite = new Map();
  const upcoming = new Map();

  for (const p of players) {
    const holeScores = p.linescores?.[round - 1]?.linescores || [];
    const t = extractTeeTime(p);

    if (holeScores.length === 0) {
      if (t) {
        if (!upcoming.has(t)) upcoming.set(t, { time: t, nine: 'unknown', players: [], upcoming: true });
        upcoming.get(t).players.push(p);
      }
      continue;
    }

    if (!t) continue;

    // Use first hole period to determine starting nine (split-tee disambiguation)
    const nine = holeScores[0].period >= 10 ? 'back' : 'front';
    const key  = `${t}||${nine}`;
    if (!definite.has(key)) definite.set(key, { time: t, nine, players: [] });
    definite.get(key).players.push(p);
  }

  const groups = [...definite.values()]
    .filter(g => g.players.length >= 1)
    .sort((a, b) => new Date(a.time) - new Date(b.time) || a.nine.localeCompare(b.nine));

  const upcomingGroups = [...upcoming.values()]
    .filter(g => g.players.length >= 1)
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

  const makeRow = p => {
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
      : `<span class="golf-thru-pre">—</span>`;
    return `<div class="golf-player-row">
      <span class="gc-pos">${esc(posDisp)}</span>
      <span class="gc-name">${esc(name)}</span>
      <span class="gc-score ${scoreCls}">${esc(total)}</span>
      <span class="gc-today ${todayCls}">${esc(today)}</span>
      <span class="gc-thru">${thruHTML}</span>
    </div>`;
  };

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
    inner += `<div class="${sepCls}">${esc(sepLabel)}</div>${players.map(makeRow).join('')}`;
  }
  for (const group of upcomingGroups) {
    const players = [...group.players].sort((a, b) => (+a.order || 9999) - (+b.order || 9999));
    inner += `<div class="golf-group-lb-sep golf-group-lb-sep-pre">⏰ ${esc(formatTeeTime(group.time))}</div>${players.map(makeRow).join('')}`;
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
        const round   = comp.status?.period || 1;
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
        const { groups, upcomingGroups } = groupByTeeTime(allComp, round);

        // Live groups first (by best leaderboard position), finished groups at the bottom (by tee time)
        const bestPos = g => Math.min(...g.players.map(p => parseInt(p.order) || 9999));
        const liveG   = groups.filter(g =>  g.players.some(p => playerRoundStatus(p, round) === 'live'))
                              .sort((a, b) => bestPos(a) - bestPos(b));
        const doneG   = groups.filter(g =>  g.players.every(p => playerRoundStatus(p, round) === 'finished'))
                              .sort((a, b) => new Date(a.time) - new Date(b.time));
        const activeG = [...liveG, ...doneG];

        html += `<div class="golf-tournament">
          <div class="golf-tourn-header">
            <div class="golf-tourn-name">${tour.icon} ${esc(ev.name || ev.shortName || tour.label)}</div>
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
    area.innerHTML = `<div class="pp-error" style="padding:16px">Could not load golf — ${esc(err.message)}</div>`;
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

// ── GOLF 3-BALL PICKS ─────────────────────────────────────────
function buildGolfGroupPickCard(group, round, isLive, tourKey, eventId) {
  const players = group.players.slice(0, 3);
  if (players.length < 2) return '';

  const getSA = p => { const s = p.statistics?.find(x => ['SA','AVG','scoringAverage'].includes(x.abbreviation||x.name)); return s ? parseFloat(s.displayValue) || 0 : 0; };
  const getTodayNum = p => { const t = p.linescores?.[round-1]?.displayValue; return t ? (t === 'E' ? 0 : parseInt(t) || 0) : null; };

  const avgSA = players.reduce((s,p) => s + (getSA(p)||70), 0) / players.length;

  // Determine group state BEFORE scoring so we know if pick should be locked
  const statuses     = players.map(p => playerRoundStatus(p, round));
  const groupStarted = statuses.some(s => s === 'live' || s === 'finished');
  const pickId       = `golf_${eventId}_${group.time.replace(/\D/g,'')}`;
  const existingPick = getPicks()[pickId];

  const scored = players.map(p => {
    const sa  = getSA(p);
    const pos = parseInt(p.order) || 999;
    const todayNum = getTodayNum(p);
    let score = 0;
    const factors = [];

    // Leaderboard position (pre-round tournament standing — stable)
    const posPts = pos <= 3 ? 5 : pos <= 10 ? 4 : pos <= 25 ? 3 : pos <= 50 ? 2 : pos <= 80 ? 1 : 0;
    if (posPts > 0 && pos < 999) { score += posPts; factors.push(`#${pos}`); }

    // Scoring average vs group (season stat — stable)
    if (sa > 0 && avgSA > 0) {
      const diff = sa - avgSA;
      if (diff < -0.4) { score += 2; factors.push(`${sa.toFixed(1)} avg`); }
      else if (diff < 0) { score += 1; factors.push(`${sa.toFixed(1)} avg`); }
    }

    // Live round score intentionally excluded — using it shifts the pick to whoever
    // is hot at that moment and causes the displayed pick to change mid-round.
    // Picks are based on pre-round data only. todayNum still captured for display.

    const total = p.score || 'E';
    const totalNum = total === 'E' ? 0 : parseInt(total) || 0;
    return { p, score, factors, sa, pos, total, totalNum, todayNum };
  });

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  const pickName = winner.p.athlete?.shortName || winner.p.athlete?.displayName || '?';

  const gap  = winner.score - (scored[1]?.score || 0);
  const conf = gap >= 4 ? 3 : gap >= 2 ? 2 : 1;

  // Pre-game only — only record picks for groups that haven't teed off yet.
  const matchup = players.map(p => (p.athlete?.shortName||'-').split(' ').pop()).join(' v ');
  if (!groupStarted) recordPick(pickId, pickName.split(' ').pop(), matchup, 'golf', conf);

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
    const name = p.athlete?.shortName || p.athlete?.displayName || '-';
    const lastName = name.split(' ').pop().toLowerCase();
    const holes = p.linescores?.[round-1]?.linescores?.length || 0;
    const thru  = holes === 18 ? 'F' : holes > 0 ? String(holes) : '-';
    const scoreCls = totalNum < 0 ? 'golf-under' : totalNum > 0 ? 'golf-over' : 'golf-even';
    const todayStr = todayNum !== null ? (todayNum > 0 ? `+${todayNum}` : todayNum === 0 ? 'E' : String(todayNum)) : '-';
    const isPick = idx === 0;
    const chips  = factors.map(f => `<span class="golf-pick-chip">${esc(f)}</span>`).join('');
    return `<div class="golf-pick-row ${isPick ? 'golf-pick-winner' : ''}">
      ${isPick ? '<span class="golf-pick-arrow">→</span>' : '<span class="golf-pick-arrow"></span>'}
      <span class="golf-pick-name">${esc(name)}</span>
      <span class="golf-pick-score ${scoreCls}">${esc(total)}</span>
      <span class="golf-pick-today">${esc(todayStr)}</span>
      <span class="golf-pick-thru">${esc(thru)}</span>
      <span class="golf-pick-factors">${chips}</span>
    </div>`;
  });

  const preLabel = groupStarted && existingPick ? '<span class="golf-pick-pre-label">Pre-round pick</span> ' : '';
  return `<div class="golf-pick-card">
    <div class="golf-pick-time">⏰ ${esc(formatTeeTime(group.time))}</div>
    <div class="golf-pick-hdr"><span>PLAYER</span><span>TOT</span><span>TODAY</span><span>THRU</span><span>FACTORS</span></div>
    ${rows.join('')}
    <div class="golf-pick-verdict">${preLabel}Pick: <strong>${esc(displayName)}</strong> ${confDots}</div>
  </div>`;
}

async function loadGolfPicksPage() {
  const seq  = _loadSeq;
  const area = document.getElementById('mlb-picks-area');
  area.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Loading golf groups…</p></div>';
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
        const comp  = ev.competitions?.[0]; if (!comp) continue;
        const state = comp.status?.type?.state || '';
        const round = comp.status?.period || 1;
        const isLive = state === 'in';
        const allComp = comp.competitors || [];
        const { groups, upcomingGroups } = groupByTeeTime(allComp, round);
        if (!groups.length && !upcomingGroups.length) continue;
        const preHdr = upcomingGroups.length > 0
          ? `<div class="golf-group-status-hdr">⏰ Pre-Round — ${upcomingGroups.length} group${upcomingGroups.length !== 1 ? 's' : ''} · approx. pairings</div>` : '';
        html += `<div class="golf-picks-section">
          <div class="golf-picks-event-hdr">${tour.icon} ${esc(ev.name || tour.label)} · Round ${round} ${isLive ? '<span class="live-badge">LIVE</span>' : ''}</div>
          ${groups.map(g => buildGolfGroupPickCard(g, round, isLive, tour.key, ev.id)).join('')}
          ${preHdr}
          ${upcomingGroups.map(g => buildGolfGroupPickCard(g, round, isLive, tour.key, ev.id)).join('')}
        </div>`;
      }
    }
    if (_loadSeq !== seq) return;
    const note = '<div class="pc-data-note">3-ball picks · world ranking · scoring avg · tournament position · round score</div>';
    area.innerHTML = note + (html || '<div class="empty-state"><p>No active golf groups available.</p><p class="muted">Picks appear when a tournament is in progress or tee times are posted.</p></div>');
    updatePicksDisplay();
  } catch (err) {
    area.innerHTML = `<div class="error-state"><div class="error-icon">⚠</div><p>Could not load golf picks: ${esc(err.message)}</p></div>`;
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

// ── OHIO LOTTERY ─────────────────────────────────────────────
// Multi-state games: official APIs (via CORS proxy since they don't set CORS headers)
const LOTTERY_MM_URL = 'https://corsproxy.io/?https://www.megamillions.com/cmspages/getwinningnumbers.aspx';
const LOTTERY_PB_URL = 'https://corsproxy.io/?https://www.powerball.com/api/v1/numbers/powerball/recent/limit/1';
// NY Open Data fallbacks (free, CORS-friendly, no key required)
const LOTTERY_MM_FALLBACK = 'https://data.ny.gov/resource/5xaw-6ayf.json?$limit=1&$order=draw_date+DESC';
const LOTTERY_PB_FALLBACK = 'https://data.ny.gov/resource/d6yy-54nr.json?$limit=1&$order=draw_date+DESC';
// Ohio Lottery: try multiple candidate endpoints, fall back to HTML parse of their page
const LOTTERY_OHIO_CANDIDATES = [
  'https://corsproxy.io/?https://www.ohiolottery.com/Winning-Numbers/WinningNumbersJson',
  'https://corsproxy.io/?https://www.ohiolottery.com/GamesPagesAjax/WinningNumbers',
  'https://corsproxy.io/?https://www.ohiolottery.com/api/winningnumbers/getall',
];

// Display order — Ohio games first, multi-state at bottom
const LOTTERY_ORDER = [
  'Pick 3', 'Pick 4', 'Pick 5',
  'Rolling Cash 5', 'Classic Lotto', 'Lucky for Life',
  'Mega Millions', 'Powerball',
];

function lottoBall(n, cls = '') {
  return `<span class="lotto-ball${cls ? ' ' + cls : ''}">${esc(String(n))}</span>`;
}

function renderLotteryCard(game) {
  const balls      = (game.numbers || []).map(n => lottoBall(n)).join('');
  const specialBall = game.special != null
    ? `<span class="lotto-sep">+</span>${lottoBall(game.special, game.specialCls || 'lotto-ball-special')}`
    : '';
  const multBadge = game.multiplier
    ? `<span class="lotto-mult">${esc(game.multiplier)}</span>`
    : '';
  const jackpot = game.jackpot
    ? `<div class="lottery-next">💰 Next jackpot: <b>${esc(game.jackpot)}</b></div>`
    : '';
  const nextDraw = game.nextDraw
    ? `<div class="lottery-next">Next draw: ${esc(game.nextDraw)}</div>`
    : '';
  return `<div class="lottery-card">
    <div class="lottery-card-hdr">
      <span class="lottery-game-icon">${game.icon}</span>
      <span class="lottery-game-name">${esc(game.name)}</span>
      <span class="lottery-draw-date">${esc(game.date || '')}</span>
    </div>
    <div class="lottery-numbers">${balls}${specialBall}${multBadge}</div>
    ${jackpot}${nextDraw}
  </div>`;
}

function lotteryGameOrder(name) {
  const i = LOTTERY_ORDER.findIndex(n => name.toLowerCase().includes(n.toLowerCase()));
  return i < 0 ? 99 : i;
}

// Try Ohio Lottery JSON endpoints in sequence, then fall back to HTML parse
async function fetchOhioLotteryGames() {
  // Strategy 1: try known JSON endpoints
  for (const url of LOTTERY_OHIO_CANDIDATES) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json') && !ct.includes('javascript')) continue;
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data?.games || data?.results || data?.data || []);
      if (list.length > 0 && (list[0].GameName || list[0].gameName || list[0].name)) return list;
    } catch {}
  }
  // Strategy 2: parse the winning-numbers page for embedded JSON
  try {
    const html = await fetch('https://corsproxy.io/?https://www.ohiolottery.com/Winning-Numbers/All-Games').then(r => r.text());
    const doc  = new DOMParser().parseFromString(html, 'text/html');
    for (const s of doc.querySelectorAll('script:not([src])')) {
      const c = s.textContent || '';
      // Look for JSON arrays that look like game result records
      const m = c.match(/(\[\s*\{[^<]{50,}?\}[\s,]*\{[^<]{10,}?\}\s*\])/s);
      if (m) {
        try {
          const arr = JSON.parse(m[1]);
          if (Array.isArray(arr) && arr.length > 0 && (arr[0].GameName || arr[0].WinningNumbers)) return arr;
        } catch {}
      }
    }
  } catch {}
  return null; // all strategies failed
}

async function fetchLotteryGames() {
  const [ohioData, mmR, pbR, mmFbR, pbFbR] = await Promise.allSettled([
    fetchOhioLotteryGames(),
    fetch(LOTTERY_MM_URL).then(r => r.json()),
    fetch(LOTTERY_PB_URL).then(r => r.json()),
    fetch(LOTTERY_MM_FALLBACK).then(r => r.json()),
    fetch(LOTTERY_PB_FALLBACK).then(r => r.json()),
  ]);

  const games = [];
  const ohioList = ohioData.status === 'fulfilled' ? (ohioData.value || []) : [];

  for (const g of ohioList) {
    const name = g.GameName || g.gameName || g.name || '';
    if (!name) continue;
    const low = name.toLowerCase();
    if (low.includes('keno') || low.includes('mega') || low.includes('powerball')) continue;
    const numStr = g.WinningNumbers || g.winningNumbers || g.numbers || '';
    const nums   = String(numStr).split(/[-,\s]+/).map(s => s.trim()).filter(n => /^\d+$/.test(n));
    if (!nums.length) continue;
    const fireStr = g.Fireball || g.fireball || '';
    const icon = low.includes('pick 3') ? '3️⃣' : low.includes('pick 4') ? '4️⃣'
               : low.includes('pick 5') ? '5️⃣' : low.includes('rolling') ? '🎱'
               : low.includes('classic') ? '🎰' : low.includes('lucky') ? '🍀' : '🎲';
    games.push({ name, icon, numbers: nums, special: fireStr || null, specialCls: 'lotto-ball-fire', multiplier: null, date: g.DrawDate || g.drawDate || '' });
  }

  const mmRow = (() => {
    if (mmR.status === 'fulfilled') {
      const v = mmR.value;
      if (v?.WinningNumber1) return { type: 'official', v };
    }
    if (mmFbR.status === 'fulfilled') {
      const arr = mmFbR.value;
      return Array.isArray(arr) && arr[0] ? { type: 'ny', v: arr[0] } : null;
    }
    return null;
  })();
  if (mmRow) {
    const { type, v } = mmRow;
    const nums  = type === 'official'
      ? [v.WinningNumber1, v.WinningNumber2, v.WinningNumber3, v.WinningNumber4, v.WinningNumber5].filter(Boolean)
      : String(v.winning_numbers || '').split(/\s+/).filter(Boolean);
    const mb    = type === 'official' ? v.MegaBall   : v.mega_ball;
    const mult  = type === 'official' ? (v.MegaPlier ? `${v.MegaPlier}x Megaplier` : null)
                                      : (v.multiplier ? `${v.multiplier}x Megaplier` : null);
    const date  = type === 'official' ? (v.DrawDate || '')
                                      : (v.draw_date ? new Date(v.draw_date).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '');
    games.push({ name:'Mega Millions', icon:'💰', numbers:nums, special:mb||null, specialCls:'lotto-ball-mega', multiplier:mult, date });
  }

  const pbRow = (() => {
    if (pbR.status === 'fulfilled') {
      const v = pbR.value;
      const row = Array.isArray(v) ? v[0] : v;
      if (row?.field1 || row?.winning_numbers) return { type: 'official', v: row };
    }
    if (pbFbR.status === 'fulfilled') {
      const arr = pbFbR.value;
      return Array.isArray(arr) && arr[0] ? { type: 'ny', v: arr[0] } : null;
    }
    return null;
  })();
  if (pbRow) {
    const { type, v } = pbRow;
    const nums  = type === 'official' && v.field1
      ? [v.field1, v.field2, v.field3, v.field4, v.field5].filter(Boolean)
      : String(v.winning_numbers || '').split(/\s+/).filter(Boolean);
    const pb    = type === 'official' ? (v.field6 || v.powerball) : v.powerball;
    const mult  = type === 'official' ? (v.multiplier || null)
                                      : (v.multiplier ? `${v.multiplier}x Power Play` : null);
    const date  = type === 'official' ? (v.date || v.drawDate || '')
                                      : (v.draw_date ? new Date(v.draw_date).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '');
    games.push({ name:'Powerball', icon:'⚡', numbers:nums, special:pb||null, specialCls:'lotto-ball-special', multiplier:mult, date });
  }

  games.sort((a, b) => lotteryGameOrder(a.name) - lotteryGameOrder(b.name));
  return { games, ohioList };
}

async function loadLottery() {
  const seq  = _loadSeq;
  const area = document.getElementById('lottery-area');
  if (!area) return;
  if (!area.querySelector('.lottery-card')) {
    area.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Loading lottery numbers…</p></div>';
  }

  const { games, ohioList } = await fetchLotteryGames();

  if (_loadSeq !== seq) return;

  const OHIO_GAMES = [
    { name:'Pick 3', icon:'3️⃣', slug:'Pick-3' }, { name:'Pick 4', icon:'4️⃣', slug:'Pick-4' },
    { name:'Pick 5', icon:'5️⃣', slug:'Pick-5' }, { name:'Rolling Cash 5', icon:'🎱', slug:'Rolling-Cash-5' },
    { name:'Classic Lotto', icon:'🎰', slug:'Classic-Lotto' }, { name:'Lucky for Life', icon:'🍀', slug:'Lucky-for-Life' },
  ];
  const ohioHasData = ohioList.length > 0;
  const ohioSection = ohioHasData ? '' : `<div class="lottery-ohio-links">
    <div class="lottery-ohio-hdr">🏛 Ohio Games — tap to view on OhioLottery.com</div>
    ${OHIO_GAMES.map(g => `<a class="lottery-ohio-link" href="https://www.ohiolottery.com/Games/${g.slug}/Winning-Numbers" target="_blank" rel="noopener">${g.icon} ${g.name}</a>`).join('')}
  </div>`;

  area.innerHTML = `<div class="lottery-section">${ohioSection}${games.map(renderLotteryCard).join('')}</div>`;

  const t = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone: getUserTZ() });
  setConn('connected', `Lottery updated ${t}`);
}

// ── SIMPLE VIEW (Picks of the Day) ───────────────────────────
const SPORT_ICONS  = { tennis:'🎾', mlb:'⚾', nba:'🏀', wnba:'🏀', nfl:'🏈', nhl:'🏒', soccer:'⚽', golf:'⛳' };
const SPORT_LABELS = { tennis:'Tennis', mlb:'Baseball', nba:'NBA', wnba:'WNBA', nfl:'Football', nhl:'Hockey', soccer:'Soccer', golf:'Golf' };

let _svPreloadedAt = 0;   // timestamp of last completed preload (0 = never)
let _svLotteryHTML = '';
let _svDateOffset  = 0;   // 0=today, -1=yesterday, +1=tomorrow
const _DAILY_TOP_KEY = '_baseline_top';

function getLockedTopPicks() {
  try {
    const s = localStorage.getItem(_DAILY_TOP_KEY);
    if (!s) return null;
    const obj = JSON.parse(s);
    if (obj.date !== dateStrLocal()) return null;
    return obj.bySport || null;
  } catch { return null; }
}

function lockTopPicks() {
  if (getLockedTopPicks()) return;
  const today = dateStrLocal();
  const allPicksMap = getPicks();
  const gamePicks = Object.entries(allPicksMap)
    .filter(([, p]) => p.date === today && !p.type && p.team)
    .sort((a, b) => (b[1].conf || 0) - (a[1].conf || 0));
  const SPORT_LIMITS = { tennis: 6, mlb: 3, nba: 3, wnba: 2, nfl: 3, nhl: 3, soccer: 3, golf: 6 };
  const bySport = {};
  for (const [id, p] of gamePicks) {
    const s = p.sport || 'tennis';
    const limit = SPORT_LIMITS[s] || 2;
    if (!bySport[s]) bySport[s] = [];
    if (bySport[s].length >= limit) continue;
    bySport[s].push(id);
  }
  const totalPicks = Object.values(bySport).reduce((n, a) => n + a.length, 0);
  if (totalPicks < 2) return;
  localStorage.setItem(_DAILY_TOP_KEY, JSON.stringify({ date: today, bySport }));
}

function resetDailyPicks() {
  _svPreloadedAt = 0;
  preloadPicksForSimpleView();
}

function svNavigate(delta) {
  _svDateOffset = Math.max(-7, Math.min(1, _svDateOffset + delta));
  renderSimpleView();
}

// Silently fetch today's tennis matches and record picks — used by the preload
// so tennis shows on the front page even if the user hasn't visited the Tennis tab.
async function preloadTennisPicksQuiet() {
  try {
    await preloadRankIndex();
    const d = dateStrLocal(0);
    const results = await tennisFetch('get_fixtures', { date_start: d, date_stop: d });
    for (const m of results) {
      S.matches.set(String(m.event_key), m);
      inlineTennisPick(m);
      if (isFinished(m.event_status) && m.event_winner) {
        let wln = '';
        if (m.event_winner === 'First Player')       wln = lastName(m.event_first_player  || '');
        else if (m.event_winner === 'Second Player') wln = lastName(m.event_second_player || '');
        else                                          wln = lastName(m.event_winner);
        if (wln) resolvePick('tn_' + m.event_key, wln);
      }
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

  // Populate rest-days cache for NBA/WNBA/NHL B2B detection before recording picks
  try { await populateRestDaysCache(); } catch (e) {}

  // MLB handled separately below — loadMLBPicksPage records the nuanced team+player picks.
  // Avoid running autoRecordAndResolvePick for MLB here to prevent a stale simple-seed
  // (based on win% alone) from conflicting with the pitcher/form analysis pick.
  for (const sport of ['nba', 'nfl', 'nhl', 'wnba']) {
    try {
      const games = await espnGames(sport, 0);
      games.forEach(g => autoRecordAndResolvePick(g));
      const cfg = sportCfg[sport];
      if (cfg) {
        const upcoming = games.filter(g => !gameRowState(g).fin).slice(0, 4);
        for (const g of upcoming) {
          try {
            const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${cfg.path}/summary?event=${g.id}`);
            const j   = await res.json();
            const matchup = `${g.awayTeam} @ ${g.homeTeam}`;
            for (const tl of (j.leaders || [])) {
              for (const cat of (tl.leaders || [])) {
                const catName = (cat.displayName || cat.shortDisplayName || '').toLowerCase();
                if (!cfg.cats.some(c => catName.includes(c))) continue;
                const top = (cat.leaders || [])[0];
                if (!top?.athlete?.displayName) continue;
                const pid  = top.athlete.id || top.athlete.displayName.replace(/\W+/g,'');
                const name = top.athlete.shortName || top.athlete.displayName;
                const label = cat.displayName || cat.shortDisplayName || catName;
                recordPlayerPick(`plr_${g.id}_${pid}_${catName.replace(/\s+/g,'_')}`,
                  sport, name, label, top.displayValue || '-', matchup, null);
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

  try {
    const { games } = await fetchLotteryGames();
    if (games.length) _svLotteryHTML = games.map(renderLotteryCard).join('');
  } catch (e) {}

  // Pre-seed tomorrow's picks so the "Tomorrow →" view is ready.
  // These games are all pre-game; stamp them with tomorrow's date so they show up correctly.
  const tomorrowDate = dateStrLocal(1);
  for (const sport of ['nba', 'nfl', 'nhl', 'wnba', 'mlb']) {
    try {
      const games = await espnGames(sport, 1);
      games.forEach(g => autoRecordAndResolvePick(g, tomorrowDate));
    } catch (e) {}
  }
  try {
    const tennisD = dateStrLocal(1);
    const results = await tennisFetch('get_fixtures', { date_start: tennisD, date_stop: tennisD });
    for (const m of results) inlineTennisPick(m, tomorrowDate);
  } catch (e) {}

  // All sports done — render once.
  if (isActive()) renderSimpleView();
}

function showSimpleView() {
  document.body.classList.add('simple-mode');
  document.getElementById('simple-view').classList.add('sv-active');
  renderSimpleView();
  preloadPicksForSimpleView();
}

function hideSimpleView() {
  document.body.classList.remove('simple-mode');
  document.getElementById('simple-view').classList.remove('sv-active');
  localStorage.setItem('sv_dismissed', dateStrLocal());
}

function renderSimpleView() {
  const targetDate  = dateStrLocal(_svDateOffset);
  const isToday     = _svDateOffset === 0;
  const allPicksMap = getPicks();

  // Update date display and headline
  const dateLabel = _svDateOffset === 0 ? 'Today'
    : _svDateOffset === -1 ? 'Yesterday'
    : _svDateOffset ===  1 ? 'Tomorrow'
    : new Date(targetDate + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' });

  document.getElementById('sv-date').textContent =
    new Date(targetDate + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

  const headline = document.querySelector('.sv-headline');
  if (headline) headline.textContent = dateLabel + "'s Picks";

  // Date navigation bar
  const prevLabel = _svDateOffset <= -2 ? '← Earlier' : '← Yesterday';
  const nextLabel = _svDateOffset === 0  ? 'Tomorrow →' : 'Today →';
  const dateNavHTML = `<div class="sv-date-nav">
    <button class="sv-nav-btn" onclick="svNavigate(-1)">${prevLabel}</button>
    <span class="sv-nav-label">${dateLabel}</span>
    <button class="sv-nav-btn" onclick="svNavigate(1)"${_svDateOffset >= 1 ? ' disabled' : ''}>${nextLabel}</button>
  </div>`;

  // Player picks for target date, indexed by matchup
  const plrByMatchup = {};
  for (const p of Object.values(allPicksMap)) {
    if (p.type !== 'player' || p.date !== targetDate) continue;
    const key = (p.gameMatchup || '').toLowerCase().trim();
    if (!plrByMatchup[key]) plrByMatchup[key] = [];
    plrByMatchup[key].push(p);
  }

  const makePlrSection = (matchupKey) => {
    const plrs = plrByMatchup[matchupKey] || [];
    if (!plrs.length) return '';
    const byCat = {};
    for (const pp of plrs) {
      const cat = pp.prop || '?';
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(pp);
    }
    const rows = Object.entries(byCat).map(([cat, plist]) => {
      const items = plist.slice(0, 2).map(pp => {
        const pr = pp.result === 'win'  ? '<span class="sv-plr-r sv-plr-w">W</span>'
                 : pp.result === 'loss' ? '<span class="sv-plr-r sv-plr-l">L</span>' : '';
        return `<span class="sv-plr-chip">${esc(pp.player)} <em>${esc(pp.stat)}</em>${pr}</span>`;
      }).join('');
      return `<div class="sv-plr-cat"><span class="sv-plr-cat-lbl">${esc(cat)}</span>${items}</div>`;
    }).join('');
    return `<div class="sv-plr-section"><div class="sv-plr-hdr">Players to Watch</div>${rows}</div>`;
  };

  // All game picks for the target date, sorted by conf desc
  const allGamePicks = Object.values(allPicksMap)
    .filter(p => p.date === targetDate && !p.type && p.team)
    .sort((a, b) => (b.conf || 0) - (a.conf || 0));

  if (!allGamePicks.length) {
    const msg = isToday
      ? `<div class="sv-empty"><div class="spinner" style="margin:0 auto 10px"></div>Loading today's picks…</div>`
      : _svDateOffset === 1
      ? `<div class="sv-empty"><div class="spinner" style="margin:0 auto 10px"></div>Loading tomorrow's picks…</div>`
      : `<div class="sv-empty">No picks recorded for this date.</div>`;
    document.getElementById('sv-content').innerHTML = dateNavHTML + msg;
    return;
  }

  const SPORT_LIMITS = { tennis: 6, mlb: 3, nba: 3, wnba: 2, nfl: 3, nhl: 3, soccer: 3, golf: 6 };

  // Build per-sport pick arrays (top picks by conf, capped by SPORT_LIMITS)
  const picksBySport = {};
  for (const p of allGamePicks) {
    const s = p.sport || 'tennis';
    if (!picksBySport[s]) picksBySport[s] = [];
    const limit = SPORT_LIMITS[s] || 2;
    if (picksBySport[s].length < limit) picksBySport[s].push(p);
  }

  const makePickRow = (p) => {
    const conf = Math.min(3, Math.max(1, p.conf || 1));
    const dots = '●'.repeat(conf) + '○'.repeat(3 - conf);
    const badge = p.result === 'win'  ? '<span class="sv-badge sv-badge-w">W</span>'
                : p.result === 'loss' ? '<span class="sv-badge sv-badge-l">L</span>' : '';
    const matchupShort = (p.matchup || '').replace(/ @ /g, ' v ');
    const key = (p.matchup || '').toLowerCase().trim();
    const plrSection = makePlrSection(key);
    const cls = ['sv-pick-row',
      p.result === 'win' ? 'sv-row-win' : p.result === 'loss' ? 'sv-row-loss' : '',
      plrSection ? 'sv-has-plrs' : ''
    ].filter(Boolean).join(' ');
    const clickAttr = plrSection ? `onclick="this.classList.toggle('sv-expanded')"` : '';
    return `<div class="${cls}" ${clickAttr}>
      <div class="sv-row-main">
        <span class="sv-row-match">${esc(matchupShort)}</span>
        <span class="sv-row-arrow">→</span>
        <span class="sv-row-team">${esc(p.team)}</span>
        <span class="sv-conf">${dots}</span>
        ${badge}${plrSection ? '<span class="sv-tap-hint">▾</span>' : ''}
      </div>
      ${plrSection}
    </div>`;
  };

  const makeSportSection = (sport) => {
    const picks = picksBySport[sport] || [];
    if (!picks.length) return '';
    const icon = SPORT_ICONS[sport] || '🏅';
    const label = SPORT_LABELS[sport] || sport;
    return `<div class="sv-sport-section">
      <div class="sv-sport-hdr">${icon} ${label}</div>
      <div class="sv-picks-list">${picks.map(makePickRow).join('')}</div>
    </div>`;
  };

  // 2-column layout: Tennis + Golf left, team sports right
  const tennisHTML = makeSportSection('tennis');
  const golfHTML   = makeSportSection('golf');
  const leftHTML   = [tennisHTML, golfHTML].filter(Boolean).join('');
  const TEAM_SPORTS = ['mlb', 'nba', 'wnba', 'nfl', 'nhl', 'soccer'];
  const otherHTML  = TEAM_SPORTS.map(makeSportSection).filter(Boolean).join('');

  let gridHTML;
  if (leftHTML && otherHTML) {
    gridHTML = `<div class="sv-sections-grid">
      <div class="sv-left-col">${leftHTML}</div>
      <div class="sv-right-col">${otherHTML}</div>
    </div>`;
  } else {
    gridHTML = `<div class="sv-sections-grid sv-single-col">${leftHTML || otherHTML}</div>`;
  }

  // Top 10 ticket — max 2 per sport, sorted by conf desc
  const ticketCounts = {};
  const top10 = [...allGamePicks]
    .filter(p => {
      const s = p.sport || 'tennis';
      if ((ticketCounts[s] || 0) >= 2) return false;
      ticketCounts[s] = (ticketCounts[s] || 0) + 1;
      return true;
    })
    .slice(0, 10);

  const ticketRow = (p, i) => {
    const conf = Math.min(3, Math.max(1, p.conf || 1));
    const dots = '●'.repeat(conf) + '○'.repeat(3 - conf);
    const badge = p.result === 'win'  ? '<span class="sv-badge sv-badge-w">W</span>'
                : p.result === 'loss' ? '<span class="sv-badge sv-badge-l">L</span>' : '';
    const icon  = SPORT_ICONS[p.sport || 'tennis'] || '🏅';
    const match = (p.matchup || '').replace(/ @ /g, ' v ');
    return `<div class="sv-tk-row${p.result==='win'?' sv-tk-win':p.result==='loss'?' sv-tk-loss':''}">
      <span class="sv-tk-num">${i+1}</span>
      <span class="sv-tk-icon">${icon}</span>
      <span class="sv-tk-match">${esc(match)}</span>
      <span class="sv-tk-arrow">→</span>
      <span class="sv-tk-pick">${esc(p.team)}</span>
      <span class="sv-tk-conf">${dots}</span>
      ${badge}
    </div>`;
  };

  const ticketLabel = _svDateOffset === 0 ? "Today's Ticket"
    : _svDateOffset === -1 ? "Yesterday's Ticket"
    : dateLabel + "'s Ticket";
  const ticketHTML = top10.length >= 2
    ? `<div class="sv-ticket"><div class="sv-ticket-hdr">🎫 ${ticketLabel} — Top ${top10.length}</div><div class="sv-ticket-list">${top10.map(ticketRow).join('')}</div></div>`
    : '';

  const lotteryBlock = isToday && _svLotteryHTML
    ? `<div class="sv-lottery-block"><div class="sv-sport-hdr" style="margin-bottom:6px">🎰 Lottery</div><div class="sv-lottery-cards">${_svLotteryHTML}</div></div>`
    : '';

  document.getElementById('sv-content').innerHTML = dateNavHTML + gridHTML + ticketHTML + lotteryBlock;
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
function renderTZSelector() {
  const el = document.getElementById('tz-selector');
  if (!el) return;
  const cur = getUserTZ();
  el.innerHTML = TZ_OPTIONS.map(o =>
    `<button class="tz-btn${o.tz === cur ? ' tz-active' : ''}" data-tz="${o.tz}" onclick="setUserTZ('${o.tz}')">${o.label}</button>`
  ).join('');
}

function init() {
  clearOldPicks();
  updatePicksDisplay();
  renderTZSelector();
  renderDateBar();
  switchSport('tennis'); // always boot tennis — loads data behind the overlay
  const svDismissed = localStorage.getItem('sv_dismissed');
  if (svDismissed !== dateStrLocal()) {
    showSimpleView();
  }
}

init();
