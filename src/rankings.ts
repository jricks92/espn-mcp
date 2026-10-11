// Compact football tools: get_poll, get_standings, get_power_index.
//
// The upstream get_rankings tool returns ESPN's raw rankings payload (~555 KiB) and only the
// polls the site API exposes (AP, Coaches). CFP committee rankings and seedings are only on
// the core API, so polls are read from there. Standings and FPI use the site APIs.

import axios from 'axios';

const SITE_V2 = 'https://site.api.espn.com/apis/v2/sports/football';
const SITE_SITE_V2 = 'https://site.api.espn.com/apis/site/v2/sports/football';
const CORE_V2 = 'https://sports.core.api.espn.com/v2/sports/football/leagues';
const FITT_V3 = 'https://site.web.api.espn.com/apis/fitt/v3/sports/football';
const HTTP_TIMEOUT_MS = 15000;

const FOOTBALL_LEAGUES: Record<string, string> = { nfl: 'nfl', college: 'college-football' };

// ESPN core-API ranking ids (college football). Discovered from
// /seasons/{y}/types/{t}/weeks/{w}/rankings on 2026-10-11.
const POLLS: Record<string, { id: number; label: string }> = {
  ap: { id: 1, label: 'AP Top 25' },
  coaches: { id: 2, label: 'AFCA Coaches Poll' },
  cfp: { id: 21, label: 'College Football Playoff committee ranking' },
  'cfp-seeds': { id: 22, label: 'College Football Playoff seeding' },
  fcs: { id: 20, label: 'FCS Coaches Poll' },
};

// ESPN group ids for standings; 80 = FBS, 81 = FCS.
const CFB_DIVISIONS: Record<string, number> = { fbs: 80, fcs: 81 };

async function get(url: string, params: Record<string, string | number | undefined> = {}) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  try {
    const response = await axios.get(url, { params: clean, timeout: HTTP_TIMEOUT_MS });
    return response.data;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404 || status === 400) {
      throw new Error(`ESPN has no data for that request (HTTP ${status}). Check season/week/conference values.`);
    }
    throw err;
  }
}

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const fmt = (r: string[]) => r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(head), ...rows.map(fmt)].join('\n');
}

function footballLeague(league: string): string {
  const path = FOOTBALL_LEAGUES[league];
  if (!path) throw new Error(`Invalid football league: ${league}. Available: ${Object.keys(FOOTBALL_LEAGUES).join(', ')}`);
  return path;
}

// --- team-name lookup for core-API refs ------------------------------------------------

const teamCache = new Map<string, { at: number; byId: Map<string, { abbr: string; name: string }> }>();
const TEAM_CACHE_MS = 6 * 60 * 60 * 1000;

async function teamNames(leaguePath: string): Promise<Map<string, { abbr: string; name: string }>> {
  const hit = teamCache.get(leaguePath);
  if (hit && Date.now() - hit.at < TEAM_CACHE_MS) return hit.byId;
  // One request for every team in the league, instead of one request per ranked team.
  const data = await get(`${SITE_SITE_V2}/${leaguePath}/teams`, { limit: 1000 });
  const byId = new Map<string, { abbr: string; name: string }>();
  for (const t of data?.sports?.[0]?.leagues?.[0]?.teams ?? []) {
    const team = t.team ?? {};
    if (team.id) byId.set(String(team.id), { abbr: team.abbreviation ?? '?', name: team.displayName ?? team.name ?? '?' });
  }
  teamCache.set(leaguePath, { at: Date.now(), byId });
  return byId;
}

function teamIdFromRef(ref: string | undefined): string | undefined {
  return ref?.match(/\/teams\/(\d+)/)?.[1];
}

// --- get_poll -----------------------------------------------------------------------

async function currentCfbSeason(): Promise<number | undefined> {
  try {
    const data = await get(`${SITE_SITE_V2}/college-football/scoreboard`, { limit: 1 });
    const y = data?.leagues?.[0]?.season?.year ?? data?.season?.year;
    return typeof y === 'number' ? y : undefined;
  } catch {
    return undefined;
  }
}

async function latestPollWeek(pollId: number): Promise<{ season: number; type: number; week: number } | undefined> {
  // /rankings lists the most recent occurrence of every poll ESPN has, newest first per poll.
  const data = await get(`${CORE_V2}/college-football/rankings`);
  for (const item of data?.items ?? []) {
    const m = String(item.$ref ?? '').match(/seasons\/(\d+)\/types\/(\d+)\/weeks\/(\d+)\/rankings\/(\d+)/);
    if (m && Number(m[4]) === pollId) return { season: Number(m[1]), type: Number(m[2]), week: Number(m[3]) };
  }
  return undefined;
}

export async function getPoll(args: any) {
  const pollKey = String(args?.poll ?? 'ap').toLowerCase();
  const poll = POLLS[pollKey];
  if (!poll) throw new Error(`Invalid poll: ${pollKey}. Available: ${Object.keys(POLLS).join(', ')}`);
  const includeOthers = args?.includeOthers !== false;

  let season = args?.season !== undefined ? Number(args.season) : undefined;
  let week = args?.week !== undefined ? Number(args.week) : undefined;
  let type = args?.seasonType !== undefined ? Number(args.seasonType) : undefined;
  if (args?.final === true) { type = 3; week = 1; }

  let staleNote = '';
  if (week === undefined) {
    const latest = await latestPollWeek(poll.id);
    if (!latest) return text(`ESPN has no ${poll.label} available.`);
    // ESPN's "latest" CFP ranking in October is last December's. Say so instead of
    // presenting it as current.
    const thisSeason = await currentCfbSeason();
    if (season === undefined && thisSeason !== undefined && latest.season < thisSeason) {
      staleNote = `Note: no ${poll.label} has been released for ${thisSeason} yet` +
        (pollKey.startsWith('cfp') ? ' (the committee usually starts in early November)' : '') +
        `. Showing the most recent one, from ${latest.season}.`;
    }
    // If the caller asked for a past season, ESPN's "latest" pointer is no use; fall back to final.
    if (season !== undefined && season !== latest.season) {
      type = type ?? 3; week = 1;
    } else {
      season = latest.season; type = type ?? latest.type; week = latest.week;
    }
  }
  season = season ?? new Date().getUTCFullYear();
  type = type ?? 2;

  let data: any;
  try {
    data = await get(`${CORE_V2}/college-football/seasons/${season}/types/${type}/weeks/${week}/rankings/${poll.id}`);
  } catch (e) {
    if (pollKey === 'cfp' || pollKey === 'cfp-seeds') {
      return text(`No ${poll.label} for ${season} week ${week}. The committee usually publishes its first ranking in early November.`);
    }
    throw e;
  }

  const names = await teamNames('college-football');
  const label = (r: any) => {
    const id = teamIdFromRef(r?.team?.$ref);
    const t = id ? names.get(id) : undefined;
    return t ? `${t.name} (${t.abbr})` : `team ${id ?? '?'}`;
  };
  const prev = (r: any) => (r.previous ? String(r.previous) : 'NR');
  const pts = (r: any) => (r.points ? String(Math.round(r.points)) : '');
  const fpv = (r: any) => (r.firstPlaceVotes ? `(${r.firstPlaceVotes})` : '');

  const out: string[] = [
    `${data?.name ?? poll.label} — ${data?.occurrence?.displayValue ?? `week ${week}`}, ${season}`,
  ];
  if (data?.date) out.push(`Released: ${data.date}`);
  if (staleNote) out.push(staleNote);
  out.push('');
  const ranks: any[] = data?.ranks ?? [];
  if (!ranks.length) return text(`${out[0]}\n\nNo teams ranked.`);
  const showPoints = ranks.some((r) => r.points);
  out.push(
    table(
      ['#', 'Team', 'Record', 'Prev', ...(showPoints ? ['Pts', '1st'] : [])],
      ranks.map((r) => [
        String(r.current), label(r), r.record?.summary ?? '', prev(r), ...(showPoints ? [pts(r), fpv(r)] : []),
      ]),
    ),
  );
  if (includeOthers) {
    const others: any[] = (data?.others ?? []).filter((r: any) => r.points);
    if (others.length) out.push('', `Others receiving votes: ${others.map((r) => `${label(r)} ${pts(r)}`).join(', ')}`);
    const dropped: any[] = data?.droppedOut ?? [];
    if (dropped.length) out.push(`Dropped out: ${dropped.map((r) => `${label(r)} (was ${r.previous})`).join(', ')}`);
  }
  return text(out.join('\n'));
}

// --- get_standings ------------------------------------------------------------------

function stat(entry: any, ...names: string[]): string {
  // Records like "overall" and "vs. Conf." carry the value in summary or displayValue.
  for (const n of names) {
    const s = (entry.stats ?? []).find((x: any) => x.name === n || x.type === n);
    if (s) return s.summary ?? s.displayValue ?? '';
  }
  return '';
}

type Group = { name: string; keys: string[]; entries: any[] };

// Walk ESPN's standings tree. `keys` holds every name and abbreviation on the path
// (e.g. "National Football Conference", "NFC", "NFC North") so filters can use either.
function collectGroups(node: any, path: string[] = [], keys: string[] = []): Group[] {
  const here = [...path, node.name ?? node.abbreviation ?? ''].filter(Boolean);
  const hereKeys = [...keys, node.name, node.abbreviation, node.shortName].filter(Boolean);
  const out: Group[] = [];
  const entries: any[] = node?.standings?.entries ?? [];
  if (entries.length) out.push({ name: here.slice(-2).join(' — '), keys: hereKeys, entries });
  for (const c of node.children ?? []) out.push(...collectGroups(c, here, hereKeys));
  return out;
}

function matchesGroup(g: Group, filter: string): boolean {
  const f = filter.toLowerCase().trim();
  return g.name.toLowerCase().includes(f) || g.keys.some((k) => String(k).toLowerCase() === f || String(k).toLowerCase().includes(f));
}

export async function getStandings(args: any) {
  const league = String(args?.league ?? '');
  const leaguePath = footballLeague(league);
  const season = args?.season;
  const filter: string | undefined = args?.group ? String(args.group) : undefined;

  if (league === 'nfl') {
    const view = String(args?.view ?? 'division').toLowerCase();
    const data = await get(`${SITE_V2}/${leaguePath}/standings`, { season, level: view === 'conference' ? undefined : 3 });
    let groups = collectGroups(data).map((g) => ({ ...g, name: g.name.replace(/^National Football League — /, '') }));
    if (filter) groups = groups.filter((g) => matchesGroup(g, filter));
    if (!groups.length) return text(`No NFL standings group matches "${filter}".`);
    const out: string[] = [`NFL standings ${data?.season?.displayName ?? season ?? ''}`.trim()];
    for (const g of groups) {
      // ESPN's entry order is not reliably the standing (2025 AFC West came back LAC, KC, LV,
      // DEN with DEN 14-3 first). Conference view: playoff seed. Division view: win %, then
      // seed as the tiebreak, since seeds already encode the NFL tiebreakers.
      const seed = (e: any) => Number(stat(e, 'playoffSeed')) || 99;
      const pct = (e: any) => Number(stat(e, 'winPercent')) || 0;
      const ordered = [...g.entries].sort(view === 'conference'
        ? (a, b) => seed(a) - seed(b)
        : (a, b) => pct(b) - pct(a) || seed(a) - seed(b));
      const rows = ordered.map((e) => [
          e.team?.abbreviation ?? '?',
          stat(e, 'overall'), stat(e, 'winPercent'), stat(e, 'gamesBehind'),
          stat(e, 'Home'), stat(e, 'Road'), stat(e, 'vs. Div.', 'divisionRecord'), stat(e, 'vs. Conf.'),
          stat(e, 'pointsFor'), stat(e, 'pointsAgainst'), stat(e, 'differential', 'pointDifferential'),
          stat(e, 'streak'), stat(e, 'playoffSeed'),
        ]);
      out.push('', `== ${g.name} ==`, table(['Team', 'W-L-T', 'PCT', 'GB', 'Home', 'Away', 'Div', 'Conf', 'PF', 'PA', 'Diff', 'Strk', 'Seed'], rows));
    }
    return text(out.join('\n'));
  }

  // College football: FBS (default) or FCS, every conference unless filtered.
  const division = String(args?.division ?? 'fbs').toLowerCase();
  const groupId = CFB_DIVISIONS[division];
  if (!groupId) throw new Error(`Invalid division: ${division}. Available: fbs, fcs`);
  const data = await get(`${SITE_V2}/${leaguePath}/standings`, { season, group: groupId });
  let groups = collectGroups(data).map((g) => ({ ...g, name: g.name.replace(/^(FBS|FCS)[^—]* — /, '') }));
  if (filter) groups = groups.filter((g) => matchesGroup(g, filter));
  if (!groups.length) {
    const available = collectGroups(data).map((g) => g.name.replace(/^(FBS|FCS)[^—]* — /, ''));
    return text(`No conference matches "${filter}". Available: ${available.join('; ')}`);
  }
  const out: string[] = [`College football standings (${division.toUpperCase()}) ${data?.season?.displayName ?? season ?? ''}`.trim()];
  for (const g of groups) {
    // ESPN's entry order is not reliably the standing (2025 Big Ten listed ORE 8-1 above
    // OSU 9-0). Sort by conference win %, then ESPN's seed, which carries its tiebreakers.
    const seed = (e: any) => Number(stat(e, 'playoffSeed')) || 99;
    const lpct = (e: any) => Number(stat(e, 'leagueWinPercent')) || 0;
    const ordered = [...g.entries].sort((a, b) => lpct(b) - lpct(a) || seed(a) - seed(b));
    const rows = ordered.map((e) => [
      e.team?.displayName ?? e.team?.abbreviation ?? '?',
      stat(e, 'vs. Conf.'), stat(e, 'overall'), stat(e, 'Home'), stat(e, 'Away'),
      stat(e, 'vs AP Top 25'), stat(e, 'pointsFor'), stat(e, 'pointsAgainst'), stat(e, 'streak'),
    ]);
    out.push('', `== ${g.name} ==`, table(['Team', 'Conf', 'Overall', 'Home', 'Away', 'vs AP25', 'PF', 'PA', 'Strk'], rows));
  }
  return text(out.join('\n'));
}

// --- get_power_index ----------------------------------------------------------------

function fmtNum(v: any, digits = 1): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '';
}
function fmtPct(v: any): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}%` : '';
}

export async function getPowerIndex(args: any) {
  const league = String(args?.league ?? '');
  const leaguePath = footballLeague(league);
  const limit = Math.min(Math.max(Number(args?.limit) || (league === 'nfl' ? 32 : 25), 1), 200);
  const data = await get(`${FITT_V3}/${leaguePath}/powerindex`, { region: 'us', lang: 'en', limit: 200, season: args?.season });

  // Category values are positional; map them by the parallel `names` arrays.
  const index = new Map<string, { cat: string; i: number }>();
  for (const c of data?.categories ?? []) (c.names ?? []).forEach((n: string, i: number) => index.set(n, { cat: c.name, i }));
  const val = (team: any, name: string) => {
    const at = index.get(name);
    if (!at) return undefined;
    return (team.categories ?? []).find((c: any) => c.name === at.cat)?.values?.[at.i];
  };

  const teams: any[] = [...(data?.teams ?? [])].sort((a, b) => (val(a, 'fpirank') ?? 999) - (val(b, 'fpirank') ?? 999)).slice(0, limit);
  if (!teams.length) return text('ESPN has no FPI data for that request.');
  const title = `ESPN Football Power Index (FPI) — ${league === 'nfl' ? 'NFL' : 'college football'} ${data?.requestedSeason?.displayName ?? data?.currentSeason?.displayName ?? ''}`.trim();
  const out: string[] = [title, data?.lastUpdated ? `Updated: ${data.lastUpdated}` : '', ''];

  const record = (t: any) => [val(t, 'numwins'), val(t, 'numlosses'), val(t, 'numties')].map((x) => (typeof x === 'number' ? String(x) : '?')).join('-').replace(/-0$/, '');
  const rows = teams.map((t) => {
    const base = [String(val(t, 'fpirank') ?? ''), t.team?.displayName ?? t.team?.abbreviation ?? '?', record(t), fmtNum(val(t, 'fpi')),
      fmtNum(val(t, 'projectedw')), fmtNum(val(t, 'projectedl'))];
    return league === 'nfl'
      ? [...base, fmtPct(val(t, 'probmakeplayoffs')), fmtPct(val(t, 'probwindiv')), fmtPct(val(t, 'probwintitle'))]
      : [...base, fmtPct(val(t, 'probwinconf')), fmtPct(val(t, 'probmakeplayoffs')), fmtPct(val(t, 'probwintitle'))];
  });
  const head = ['#', 'Team', 'W-L', 'FPI', 'Proj W', 'Proj L', ...(league === 'nfl' ? ['Playoff%', 'Win Div%', 'Win SB%'] : ['Win Conf%', 'Playoff%', 'Win Title%'])];
  out.push(table(head, rows));
  out.push('', 'FPI = expected point margin vs an average team on a neutral field. Projections are ESPN simulations.');
  return text(out.filter((l, i) => l !== '' || i > 1).join('\n'));
}

// --- tool definitions ---------------------------------------------------------------

export const rankingTools = [
  {
    name: 'get_poll',
    description:
      'College football poll as a compact table: AP Top 25, AFCA Coaches, College Football Playoff committee rankings (cfp), CFP seedings (cfp-seeds), or FCS Coaches. Defaults to the latest release. Includes record, previous rank, points and first-place votes, plus others receiving votes.',
    inputSchema: {
      type: 'object',
      properties: {
        poll: { type: 'string', enum: Object.keys(POLLS), description: 'Which poll (default ap)' },
        season: { type: 'number', description: 'Season year, e.g. 2025 (optional; default current)' },
        week: { type: 'number', description: 'Poll week (optional; default latest). Preseason is seasonType 1, week 1' },
        seasonType: { type: 'number', description: '1 preseason, 2 regular season, 3 final/postseason (optional)' },
        final: { type: 'boolean', description: 'Final poll of the season (optional)' },
        includeOthers: { type: 'boolean', description: 'Include others receiving votes and dropped-out teams (default true)' },
      },
    },
  },
  {
    name: 'get_standings',
    description:
      'Football standings as compact tables. NFL: by division (default) or conference, with W-L-T, PCT, games back, home/away, division and conference records, points and playoff seed. College: conference standings for FBS (default) or FCS, with conference and overall records. Filter to one division/conference with group, e.g. "AFC East", "NFC", "Big 12", "SEC", "Sun Belt".',
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'string', enum: Object.keys(FOOTBALL_LEAGUES), description: 'nfl or college' },
        group: { type: 'string', description: 'Only groups whose name contains this text (optional)' },
        season: { type: 'number', description: 'Season year (optional; default current)' },
        view: { type: 'string', enum: ['division', 'conference'], description: 'NFL only: group by division (default) or conference' },
        division: { type: 'string', enum: Object.keys(CFB_DIVISIONS), description: 'College only: fbs (default) or fcs' },
      },
      required: ['league'],
    },
  },
  {
    name: 'get_power_index',
    description:
      "ESPN Football Power Index (FPI) ranking for NFL or college football: FPI rating, record, projected wins/losses, and playoff/title probabilities. The NFL has no media polls; this is ESPN's analytic ranking.",
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'string', enum: Object.keys(FOOTBALL_LEAGUES), description: 'nfl or college' },
        limit: { type: 'number', description: 'How many teams (default 32 NFL, 25 college; max 200)' },
        season: { type: 'number', description: 'Season year (optional; default current)' },
      },
      required: ['league'],
    },
  },
];

export const rankingHandlers: Record<string, (args: any) => Promise<any>> = {
  get_poll: getPoll,
  get_standings: getStandings,
  get_power_index: getPowerIndex,
};
