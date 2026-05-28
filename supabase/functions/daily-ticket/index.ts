import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── CONFIG ────────────────────────────────────────────────────
const TENNIS_BASE = 'https://api.api-tennis.com/tennis/';
const TENNIS_KEY  = 'cd7c6c012ab1258a9586729e58a45a320e4839f8076f31bcb74647e7207e50cc';
const ESPN_BASE   = 'https://site.api.espn.com/apis/site/v2/sports';

const CLAY_WEAK = new Set([
  'rybakina', 'medvedev', 'shapovalov', 'shelton',
  'opelka', 'isner', 'raonic', 'norrie',
]);

const TIER_BONUS: Record<string, number> = { slam: 10, masters: 5, '500': 2, '250': 0, chal: -1, itf: -3 };
const SPORT_BONUS: Record<string, number> = { mlb: 3, nba: 3, nhl: 3, soccer: 3, wnba: 2 };
const SPORT_ICON:  Record<string, string> = { tennis: '🎾', nba: '🏀', wnba: '🏀', mlb: '⚾', nhl: '🏒', nfl: '🏈', soccer: '⚽' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ── DATE HELPERS ──────────────────────────────────────────────
function dateStrET(offsetDays = 0): string {
  const d = new Date();
  // EDT = UTC-4 (close enough Apr-Nov); EST = UTC-5. Use -4 as safe default for early morning.
  const etMs = d.getTime() - 4 * 3600_000;
  const et   = new Date(etMs + offsetDays * 86_400_000);
  return et.toISOString().slice(0, 10);
}

function etHour(): number {
  return ((new Date().getUTCHours() - 4) + 24) % 24;
}

function isEveningGame(gameTimeISO: string | null, sport: string): boolean {
  if (['tennis', 'golf', 'soccer'].includes(sport)) return false;
  if (!gameTimeISO) return ['nba', 'wnba', 'nhl', 'nfl'].includes(sport);
  try {
    const dt  = new Date(gameTimeISO);
    const etH = ((dt.getUTCHours() - 4) + 24) % 24;
    return etH >= 17;
  } catch { return ['nba', 'wnba', 'nhl', 'nfl'].includes(sport); }
}

function lastName(full: string): string {
  return (full || '').trim().split(' ').slice(-1)[0] || full;
}

// ── RANKINGS ──────────────────────────────────────────────────
async function fetchRankIndex(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const [atpR, wtaR] = await Promise.allSettled([
      fetch(`${TENNIS_BASE}?method=get_standings&event_type=ATP&APIkey=${TENNIS_KEY}`).then(r => r.json()),
      fetch(`${TENNIS_BASE}?method=get_standings&event_type=WTA&APIkey=${TENNIS_KEY}`).then(r => r.json()),
    ]);
    for (const res of [atpR, wtaR]) {
      if (res.status !== 'fulfilled') continue;
      for (const p of (res.value?.result || [])) {
        if (p.player_key) map.set(String(p.player_key), parseInt(p.place ?? p.ranking ?? 999) || 999);
      }
    }
  } catch { /* ranking fetch failed - seeds will be used instead */ }
  return map;
}

// ── TENNIS PICKS ──────────────────────────────────────────────
async function fetchTennisPicks(today: string, rankIndex: Map<string, number>): Promise<any[]> {
  try {
    const res = await fetch(`${TENNIS_BASE}?method=get_fixtures&date_start=${today}&date_stop=${today}&APIkey=${TENNIS_KEY}`);
    if (!res.ok) return [];
    const json    = await res.json();
    const matches = Array.isArray(json.result) ? json.result : [];
    const picks: any[] = [];

    for (const m of matches) {
      const eventType = (m.event_type || '').toLowerCase();
      if (eventType.includes('double') || eventType.includes('junior') ||
          eventType.includes('boys')   || eventType.includes('girls')) continue;

      const tourney = m.tournament_name || '';
      if (/\b[WM](?:15|25|35|40)\b/i.test(tourney)) continue; // skip minor ITF

      // Determine tier
      const tl = tourney.toLowerCase();
      let tier = 'itf';
      if (['grand slam','australian open','french open','roland garros','wimbledon','us open'].some(t => tl.includes(t))) tier = 'slam';
      else if (tl.includes('masters')) tier = 'masters';
      else if (tl.includes('500'))     tier = '500';
      else if (tl.includes('250'))     tier = '250';
      else if (tl.includes('challenger')) tier = 'chal';

      // Player strength: rank converted to score (lower rank = higher score)
      const p1Key  = String(m.first_player_key  || '');
      const p2Key  = String(m.second_player_key || '');
      const s1     = parseInt(m.event_first_player_seed)  || 0;
      const s2     = parseInt(m.event_second_player_seed) || 0;
      const r1     = rankIndex.get(p1Key) || (s1 ? s1 * 2 : 300);
      const r2     = rankIndex.get(p2Key) || (s2 ? s2 * 2 : 300);
      let p1Score  = Math.max(1, 300 - r1);
      let p2Score  = Math.max(1, 300 - r2);

      // Clay weakness penalty
      const isClay = (m.tournament_surface || '').toLowerCase().includes('clay')
        || tl.includes('roland garros') || tl.includes('french open');
      if (isClay && CLAY_WEAK.has(lastName(m.event_first_player).toLowerCase()))  p1Score -= 40;
      if (isClay && CLAY_WEAK.has(lastName(m.event_second_player).toLowerCase())) p2Score -= 40;

      const gap = Math.abs(p1Score - p2Score);
      if (gap < 10) continue; // too close to call

      const winner     = p1Score > p2Score ? 1 : 2;
      const winnerFull = winner === 1 ? m.event_first_player : m.event_second_player;
      const pick       = lastName(winnerFull);
      const conf       = gap >= 80 ? 3 : gap >= 40 ? 2 : 1;
      const matchup    = `${m.event_first_player} vs ${m.event_second_player}`;

      picks.push({
        id:          `tn_${m.event_key}`,
        pick,
        description: matchup,
        matchup,
        conf,
        sport:       'tennis',
        type:        'game',
        tier,
        bo5:         false,
        score:       conf + (TIER_BONUS[tier] ?? 0),
        result:      null,
        icon:        '🎾',
      });
    }
    return picks;
  } catch { return []; }
}

// ── ESPN PICKS ────────────────────────────────────────────────
async function fetchESPNPicks(sport: string, league: string, sportKey: string): Promise<any[]> {
  try {
    const res = await fetch(`${ESPN_BASE}/${sport}/${league}/scoreboard`);
    if (!res.ok) return [];
    const json   = await res.json();
    const events = json.events || [];
    const picks: any[] = [];

    for (const ev of events) {
      const comp       = ev.competitions?.[0];
      if (!comp) continue;
      const statusName = comp.status?.type?.name || '';
      if (statusName === 'STATUS_FINAL' || statusName === 'STATUS_IN_PROGRESS') continue;

      const home = comp.competitors?.find((c: any) => c.homeAway === 'home');
      const away = comp.competitors?.find((c: any) => c.homeAway === 'away');
      if (!home || !away) continue;

      // Win probability: try ESPN predictor first, then moneyline odds
      let homeFrac = 0.5;
      const pred = comp.predictor;
      if (pred?.homeTeam?.gameProjection) {
        homeFrac = parseFloat(pred.homeTeam.gameProjection) / 100;
      } else if (pred?.awayTeam?.gameProjection) {
        homeFrac = 1 - parseFloat(pred.awayTeam.gameProjection) / 100;
      } else {
        const ml = comp.odds?.[0]?.homeTeamOdds?.moneyLine;
        if (ml) {
          const m = parseFloat(ml);
          homeFrac = m < 0 ? Math.abs(m) / (Math.abs(m) + 100) : 100 / (m + 100);
        }
      }

      const margin = Math.abs(homeFrac - 0.5);
      if (margin < 0.05) continue;

      const favIsHome = homeFrac >= 0.5;
      const favComp   = favIsHome ? home : away;
      const favPct    = Math.max(homeFrac, 1 - homeFrac);
      const favTeam   = (favComp.team?.abbreviation || favComp.team?.name || '').split(' ').pop() || '';
      const conf      = favPct >= 0.65 ? 3 : favPct >= 0.58 ? 2 : 1;
      const matchup   = `${away.team?.name || ''} @ ${home.team?.name || ''}`;
      const gameTime  = comp.date || null;

      picks.push({
        id:          String(ev.id),
        pick:        favTeam,
        description: matchup,
        matchup,
        conf,
        sport:       sportKey,
        type:        'game',
        gameTime,
        score:       conf + (SPORT_BONUS[sportKey] || 1),
        result:      null,
        icon:        SPORT_ICON[sportKey] || '🏅',
      });
    }
    return picks;
  } catch { return []; }
}

// ── MAIN ──────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  // Auth: cron secret header OR Supabase anon/service JWT
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret) {
    const incoming = req.headers.get('x-cron-secret') || '';
    if (incoming !== cronSecret) return respond({ error: 'Unauthorized' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db          = createClient(supabaseUrl, serviceKey);

  const today = dateStrET();
  const hour  = etHour();

  // First-build-wins: check what already exists
  const { data: existing } = await db
    .from('baseline_tickets')
    .select('date')
    .in('date', [today + '_day', today + '_night']);

  const dayExists   = (existing || []).some((r: any) => r.date === today + '_day');
  const nightExists = (existing || []).some((r: any) => r.date === today + '_night');

  if (dayExists && (nightExists || hour < 17)) {
    return respond({ status: 'skipped', reason: 'tickets already exist', today });
  }

  // Fetch rankings first, then all picks in parallel
  const rankIndex = await fetchRankIndex();
  const [tennisPicks, nbaPicks, wnbaPicks, mlbPicks, nhlPicks] = await Promise.all([
    fetchTennisPicks(today, rankIndex),
    fetchESPNPicks('basketball', 'nba',  'nba'),
    fetchESPNPicks('basketball', 'wnba', 'wnba'),
    fetchESPNPicks('baseball',   'mlb',  'mlb'),
    fetchESPNPicks('hockey',     'nhl',  'nhl'),
  ]);

  const allPicks = [...tennisPicks, ...nbaPicks, ...wnbaPicks, ...mlbPicks, ...nhlPicks]
    .sort((a, b) => b.score - a.score);

  const mornPicks = allPicks.filter(p => !isEveningGame(p.gameTime ?? null, p.sport));
  const evePicks  = allPicks.filter(p =>  isEveningGame(p.gameTime ?? null, p.sport));

  const selectLegs = (arr: any[]): any[] | null => arr.length >= 2 ? arr.slice(0, 10) : null;

  const results: Record<string, any> = { today, hour, dayBuilt: false, nightBuilt: false };

  if (!dayExists) {
    const legs = selectLegs(mornPicks);
    if (legs) {
      await db.from('baseline_tickets').upsert(
        { date: today + '_day', morn_legs: legs, eve_legs: null },
        { onConflict: 'date', ignoreDuplicates: true }
      );
      results.dayBuilt  = true;
      results.mornCount = legs.length;
    } else {
      results.mornSkip = 'fewer than 2 picks available';
    }
  }

  if (!nightExists && hour >= 17) {
    const legs = selectLegs(evePicks);
    if (legs) {
      await db.from('baseline_tickets').upsert(
        { date: today + '_night', morn_legs: null, eve_legs: legs },
        { onConflict: 'date', ignoreDuplicates: true }
      );
      results.nightBuilt = true;
      results.eveCount   = legs.length;
    } else {
      results.eveSkip = 'fewer than 2 picks or before 5 PM ET';
    }
  }

  return respond({ status: 'ok', ...results });
});
