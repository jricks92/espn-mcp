// Compact game tools: list_games, get_box_score, get_play_by_play.
//
// ESPN's /summary response for one finished NFL game is ~1 MB of pretty-printed JSON
// (drives alone ~400 KiB, plus videos, odds, news). These tools fetch the same endpoints
// but return only the parts a model needs, as plain text.

import axios from 'axios';

const ESPN_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const HTTP_TIMEOUT_MS = 15000;

// Mirrors SPORTS_CONFIG in index.ts.
const LEAGUE_PATHS: Record<string, Record<string, string>> = {
  football: { nfl: 'football/nfl', college: 'football/college-football' },
  basketball: {
    nba: 'basketball/nba',
    wnba: 'basketball/wnba',
    'mens-college': 'basketball/mens-college-basketball',
    'womens-college': 'basketball/womens-college-basketball',
  },
  baseball: { mlb: 'baseball/mlb', college: 'baseball/college-baseball' },
  hockey: { nhl: 'hockey/nhl' },
};
const SOCCER_LEAGUES = ['eng.1', 'usa.1', 'esp.1', 'ger.1', 'fra.1', 'ita.1'];

function leaguePath(sport: string, league: string): string {
  if (sport === 'soccer') {
    if (!SOCCER_LEAGUES.includes(league)) {
      throw new Error(`Invalid soccer league: ${league}. Available: ${SOCCER_LEAGUES.join(', ')}`);
    }
    return `soccer/${league}`;
  }
  const leagues = LEAGUE_PATHS[sport];
  if (!leagues) throw new Error(`Invalid sport: ${sport}`);
  const path = leagues[league];
  if (!path) {
    throw new Error(`Invalid league for ${sport}: ${league}. Available: ${Object.keys(leagues).join(', ')}`);
  }
  return path;
}

async function espnGet(path: string, params: Record<string, string | number | undefined>) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  try {
    const response = await axios.get(`${ESPN_API_BASE}/${path}`, { params: clean, timeout: HTTP_TIMEOUT_MS });
    return response.data;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404 || status === 400) {
      throw new Error(`ESPN has no data for that request (HTTP ${status}). Check the gameId with list_games and that sport/league match the game.`);
    }
    throw err;
  }
}

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

async function getSummary(args: any) {
  const { sport, league, gameId } = args ?? {};
  if (!gameId) throw new Error('gameId is required (get it from list_games)');
  return espnGet(`${leaguePath(sport, league)}/summary`, { event: String(gameId) });
}

// --- header (shared by box score and play-by-play) ---------------------------------

function gameHeader(data: any): string {
  const comp = data?.header?.competitions?.[0];
  if (!comp) return '';
  const status = comp.status?.type?.detail ?? comp.status?.type?.description ?? '';
  const competitors: any[] = [...(comp.competitors ?? [])].sort((a, b) =>
    a.homeAway === 'away' ? -1 : b.homeAway === 'away' ? 1 : 0,
  );
  const names = competitors.map((c) => `${c.team?.displayName ?? c.team?.abbreviation} (${c.team?.abbreviation})`);
  const lines = [`${names.join(' at ')} — ${status}`];
  if (comp.date) lines.push(`Date: ${comp.date}`);
  const venue = data?.gameInfo?.venue;
  if (venue?.fullName) lines.push(`Venue: ${venue.fullName}${venue.address?.city ? `, ${venue.address.city}` : ''}`);

  const periods = Math.max(0, ...competitors.map((c) => (c.linescores ?? []).length));
  if (periods > 0) {
    const head = ['Team', ...Array.from({ length: periods }, (_, i) => String(i + 1)), 'T'];
    const rows = competitors.map((c) => [
      c.team?.abbreviation ?? '?',
      ...Array.from({ length: periods }, (_, i) => c.linescores?.[i]?.displayValue ?? '-'),
      c.score ?? '',
    ]);
    lines.push('', table(head, rows));
  } else {
    const scores = competitors.map((c) => `${c.team?.abbreviation} ${c.score ?? ''}`.trim());
    if (competitors.some((c) => c.score !== undefined && c.score !== '')) lines.push(scores.join('  '));
  }
  return lines.join('\n');
}

function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const fmt = (r: string[]) => r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(head), ...rows.map(fmt)].join('\n');
}

// --- list_games ---------------------------------------------------------------------

export async function listGames(args: any) {
  const { sport, league, date, week, seasonType } = args ?? {};
  const params: Record<string, string | number | undefined> = { dates: date, week, seasontype: seasonType };
  // College football's default scoreboard is a curated subset; groups=80 asks for all FBS.
  if (sport === 'football' && league === 'college') params.groups = 80;
  if (week || date) params.limit = 400;
  const data = await espnGet(`${leaguePath(sport, league)}/scoreboard`, params);

  const events: any[] = data?.events ?? [];
  const label = [data?.leagues?.[0]?.abbreviation ?? league, data?.week?.number ? `week ${data.week.number}` : '', date ?? '']
    .filter(Boolean)
    .join(' ');
  if (events.length === 0) return text(`No games found for ${label}.`);

  const lines = [`${events.length} games — ${label}`, 'gameId | matchup | score | status | start (UTC)'];
  for (const e of events) {
    const comp = e.competitions?.[0];
    const cs: any[] = comp?.competitors ?? [];
    const away = cs.find((c) => c.homeAway === 'away') ?? cs[0];
    const home = cs.find((c) => c.homeAway === 'home') ?? cs[1];
    const rank = (c: any) => (c?.curatedRank?.current && c.curatedRank.current <= 25 ? `#${c.curatedRank.current} ` : '');
    const abbr = (c: any) => `${rank(c)}${c?.team?.abbreviation ?? '?'}`;
    const state = e.status?.type?.state; // pre | in | post
    const score = state === 'pre' ? '' : `${away?.score ?? ''}-${home?.score ?? ''}`;
    lines.push(`${e.id} | ${abbr(away)} @ ${abbr(home)} | ${score} | ${e.status?.type?.shortDetail ?? ''} | ${e.date ?? ''}`);
  }
  return text(lines.join('\n'));
}

// --- get_box_score ------------------------------------------------------------------

export async function getBoxScore(args: any) {
  const data = await getSummary(args);
  const out: string[] = [gameHeader(data)];
  const box = data?.boxscore ?? {};

  // Team stats: football/basketball/hockey/soccer use a flat label list; baseball nests groups.
  const teams: any[] = box.teams ?? [];
  const pregame = data?.header?.competitions?.[0]?.status?.type?.state === 'pre';
  if (teams.length) {
    out.push('', pregame ? '== Season averages (game not started) ==' : '== Team stats ==');
    const flat = teams.every((t) => (t.statistics ?? []).every((s: any) => s.label !== undefined || s.displayValue !== undefined));
    if (flat) {
      const labels: string[] = (teams[0].statistics ?? []).map((s: any) => s.label ?? s.name);
      const rows = labels.map((label, i) => [label, ...teams.map((t) => t.statistics?.[i]?.displayValue ?? '')]);
      out.push(table(['', ...teams.map((t) => t.team?.abbreviation ?? '?')], rows));
    } else {
      for (const t of teams) {
        for (const g of t.statistics ?? []) {
          if (!Array.isArray(g.stats) || g.name === 'records') continue;
          const s = g.stats.map((x: any) => `${x.abbreviation ?? x.name} ${x.displayValue}`).join(', ');
          out.push(`${t.team?.abbreviation} ${g.displayName ?? g.name}: ${s}`);
        }
      }
    }
  }

  // Player stats: football groups (passing, rushing, ...), basketball one group, hockey
  // forwards/defense/goalies, baseball batting/pitching.
  const players: any[] = box.players ?? [];
  for (const team of players) {
    out.push('', `== ${team.team?.displayName ?? team.team?.abbreviation} ==`);
    for (const g of team.statistics ?? []) {
      const athletes: any[] = g.athletes ?? [];
      if (!athletes.length) continue;
      const labels: string[] = g.labels ?? [];
      const title = g.text ?? g.name ?? (labels.includes('AB') ? 'batting' : labels.includes('IP') ? 'pitching' : '');
      if (title) out.push(`-- ${title} --`);
      const rows = athletes.map((a) => {
        const pos = a.position?.abbreviation ? ` ${a.position.abbreviation}` : '';
        const flag = a.didNotPlay ? ` (DNP${a.reason ? `: ${a.reason}` : ''})` : '';
        return [`${a.athlete?.displayName ?? '?'}${pos}${flag}`, ...(a.stats ?? [])];
      });
      out.push(table(['Player', ...labels], rows));
      if (Array.isArray(g.totals) && g.totals.some((x: string) => x)) out.push(`Totals: ${g.totals.join(' ')}`);
    }
  }

  // Soccer has no boxscore.players; per-player stats live under rosters.
  if (!players.length && Array.isArray(data?.rosters)) {
    for (const r of data.rosters) {
      const roster: any[] = (r.roster ?? []).filter((p: any) => p.starter || p.subbedIn);
      if (!roster.length) continue;
      const keys = ['totalGoals', 'goalAssists', 'totalShots', 'shotsOnTarget', 'saves', 'foulsCommitted', 'yellowCards', 'redCards'];
      const abbr = new Map<string, string>();
      for (const p of roster) for (const s of p.stats ?? []) abbr.set(s.name, s.abbreviation ?? s.name);
      const present = keys.filter((k) => abbr.has(k));
      out.push('', `== ${r.team?.displayName ?? r.team?.abbreviation}${r.formation ? ` (${r.formation})` : ''} ==`);
      const rows = roster.map((p) => {
        const byName = new Map((p.stats ?? []).map((s: any) => [s.name, s.displayValue]));
        const tag = p.starter ? '' : ' (sub)';
        return [`${p.athlete?.displayName ?? '?'} ${p.position?.abbreviation ?? ''}${tag}`, ...present.map((k) => String(byName.get(k) ?? ''))];
      });
      out.push(table(['Player', ...present.map((k) => abbr.get(k)!)], rows));
    }
  }

  if (out.length === 1) out.push('', 'No box score available for this game yet.');
  return text(out.join('\n'));
}

// --- get_play_by_play ---------------------------------------------------------------

function scoreTag(p: any): string {
  return p.scoringPlay ? ` [SCORE ${p.awayScore}-${p.homeScore}]` : '';
}

export async function getPlayByPlay(args: any) {
  const { period, scoringOnly, maxPlays } = args ?? {};
  const limit = Math.min(Math.max(Number(maxPlays) || 400, 1), 1000);
  const wantPeriod = period === undefined || period === null || period === '' ? undefined : Number(period);
  const data = await getSummary(args);
  const out: string[] = [gameHeader(data)];
  let emitted = 0;
  let truncated = false;

  const drives = data?.drives;
  if (drives && (drives.previous || drives.current)) {
    // Football: group by drive, keep down & distance.
    const all: any[] = [...(drives.previous ?? []), ...(drives.current ? [drives.current] : [])];
    out.push('', 'Score shown as away-home. Format: Q clock | down & distance | play');
    for (const d of all) {
      let plays: any[] = d.plays ?? [];
      if (wantPeriod !== undefined) plays = plays.filter((p) => p.period?.number === wantPeriod);
      if (scoringOnly) plays = plays.filter((p) => p.scoringPlay);
      if (!plays.length) continue;
      if (emitted >= limit) { truncated = true; break; }
      out.push('', `## ${d.team?.abbreviation ?? d.team?.displayName ?? '?'} drive: ${d.description ?? ''} — ${d.displayResult ?? d.result ?? 'in progress'}${d.start?.text ? ` (start ${d.start.text})` : ''}`);
      for (const p of plays) {
        if (emitted >= limit) { truncated = true; break; }
        const dd = p.start?.downDistanceText ? `${p.start.downDistanceText} | ` : '';
        out.push(`Q${p.period?.number ?? '?'} ${p.clock?.displayValue ?? ''} | ${dd}${p.text ?? p.type?.text ?? ''}${scoreTag(p)}`);
        emitted++;
      }
    }
  } else if (Array.isArray(data?.plays) && data.plays.length) {
    // Basketball, hockey, baseball: flat play list.
    let plays: any[] = data.plays;
    if (wantPeriod !== undefined) plays = plays.filter((p) => p.period?.number === wantPeriod);
    if (scoringOnly) plays = plays.filter((p) => p.scoringPlay);
    out.push('', 'Score shown as away-home.');
    for (const p of plays) {
      if (emitted >= limit) { truncated = true; break; }
      const clock = p.clock?.displayValue ? ` ${p.clock.displayValue}` : '';
      out.push(`P${p.period?.number ?? '?'}${clock} | ${p.text ?? p.type?.text ?? ''}${scoreTag(p)}`);
      emitted++;
    }
  } else if (Array.isArray(data?.keyEvents) && data.keyEvents.length) {
    // Soccer: key events (goals, cards, subs).
    let evs: any[] = data.keyEvents;
    if (scoringOnly) evs = evs.filter((e) => e.scoringPlay);
    out.push('');
    for (const e of evs) {
      if (emitted >= limit) { truncated = true; break; }
      out.push(`${e.clock?.displayValue ?? ''} | ${e.type?.text ?? ''}${e.text ? ` | ${e.text}` : ''}`);
      emitted++;
    }
  }

  if (emitted === 0) {
    const state = data?.header?.competitions?.[0]?.status?.type?.state;
    out.push('', state === 'pre' ? 'Game has not started; no plays yet.' : 'No plays match the filters.');
  }
  if (truncated) out.push('', `[Stopped after ${limit} plays. Use period=N or maxPlays to see more.]`);
  return text(out.join('\n'));
}

// --- tool definitions ---------------------------------------------------------------

const sportProp = { type: 'string', enum: ['football', 'basketball', 'baseball', 'hockey', 'soccer'], description: 'The sport' };
const leagueProp = {
  type: 'string',
  description: 'League: football nfl|college; basketball nba|wnba|mens-college|womens-college; baseball mlb|college; hockey nhl; soccer eng.1|usa.1|esp.1|ger.1|fra.1|ita.1',
};
const gameIdProp = { type: 'string', description: 'ESPN game/event id, from list_games' };

export const statsTools = [
  {
    name: 'list_games',
    description:
      'Compact list of games with ESPN game ids, matchups, scores and status. Use this to find the gameId for get_box_score and get_play_by_play. Defaults to the current day/week. College football returns all FBS games.',
    inputSchema: {
      type: 'object',
      properties: {
        sport: sportProp,
        league: leagueProp,
        date: { type: 'string', description: 'Date YYYYMMDD, or range YYYYMMDD-YYYYMMDD (optional)' },
        week: { type: 'number', description: 'Week number, football only (optional)' },
        seasonType: { type: 'number', description: '1 preseason, 2 regular season, 3 postseason (optional)' },
      },
      required: ['sport', 'league'],
    },
  },
  {
    name: 'get_box_score',
    description:
      'Box score for one game: line score by period, team stats, and per-player stat tables (football: passing, rushing, receiving, defense, kicking, etc.). Works for live and finished games.',
    inputSchema: {
      type: 'object',
      properties: { sport: sportProp, league: leagueProp, gameId: gameIdProp },
      required: ['sport', 'league', 'gameId'],
    },
  },
  {
    name: 'get_play_by_play',
    description:
      'Play-by-play for one game. Football is grouped by drive with down & distance for every play. Optional filters: period (quarter) and scoringOnly. Live games include plays so far.',
    inputSchema: {
      type: 'object',
      properties: {
        sport: sportProp,
        league: leagueProp,
        gameId: gameIdProp,
        period: { type: 'number', description: 'Only this quarter/period/inning (optional)' },
        scoringOnly: { type: 'boolean', description: 'Only scoring plays (optional)' },
        maxPlays: { type: 'number', description: 'Maximum plays to return, default 400, max 1000' },
      },
      required: ['sport', 'league', 'gameId'],
    },
  },
];

export const statsHandlers: Record<string, (args: any) => Promise<any>> = {
  list_games: listGames,
  get_box_score: getBoxScore,
  get_play_by_play: getPlayByPlay,
};
