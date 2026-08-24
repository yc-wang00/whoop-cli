#!/usr/bin/env node
/**
 * whoop.mjs — read your WHOOP data from the terminal.
 *
 * Talks to the official WHOOP API v2 over OAuth 2.0. No dependencies, no build
 * step, no database: your data stays on WHOOP's servers and is fetched on demand.
 * The only thing stored locally is your access token.
 *
 * Setup is in README.md. Requires Node 18+.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(DIR, '.env');
const TOKEN_FILE = path.join(DIR, '.whoop-tokens.json');

const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API_BASE = 'https://api.prod.whoop.com/developer';

export const ENDPOINTS = {
  profile: '/v2/user/profile/basic',
  body: '/v2/user/measurement/body',
  recovery: '/v2/recovery',
  sleep: '/v2/activity/sleep',
  cycle: '/v2/cycle',
  workout: '/v2/activity/workout',
};
export const OAUTH = { AUTH_URL, TOKEN_URL, API_BASE };

// `offline` is what gets us a refresh token; without it you re-login every hour.
export const SCOPES = [
  'read:profile', 'read:body_measurement', 'read:cycles',
  'read:recovery', 'read:sleep', 'read:workout', 'offline',
];

const fail = (msg) => { console.error(`\x1b[31m${msg}\x1b[0m`); process.exit(1); };

// ───────────────────────────────────────────────────────────── credentials

/** Minimal .env reader — real environment variables win, so CI can override. */
function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

function credentials() {
  loadEnvFile();
  const { WHOOP_CLIENT_ID: clientId, WHOOP_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) {
    fail(
      'No WHOOP credentials found.\n\n' +
      `  1. Create an app at https://developer-dashboard.whoop.com\n` +
      `  2. cp .env.example .env\n` +
      `  3. Put your Client ID and Client Secret in ${ENV_FILE}\n`
    );
  }
  const redirectUri = process.env.WHOOP_REDIRECT_URI || 'http://localhost:8080/callback';
  return { clientId, clientSecret, redirectUri };
}

// ───────────────────────────────────────────────────────────── access tokens

/**
 * WHOOP access tokens last about an hour. We keep the refresh token next to it
 * and silently trade it for a new access token whenever the old one is stale,
 * so `login` is a one-time step.
 */
const readTokens = () =>
  fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) : null;

function saveTokens(tokens) {
  const stored = { ...tokens, obtained_at: Date.now() };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600); // `mode` above only applies on creation
  return stored;
}

/**
 * A 5xx here means WHOOP's own OAuth server hiccuped mid-request — unlike a
 * normal API 5xx, we don't know whether it processed the grant (and rotated
 * the refresh token) before failing to respond. Retrying quickly, before
 * anything else touches this refresh_token, is the best chance of recovering
 * without forcing the user back through the browser.
 */
async function requestTokens(form) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    const body = await res.text();
    if (res.ok) return JSON.parse(body);

    if (res.status >= 500 && attempt < 3) {
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      continue;
    }
    throw new Error(`WHOOP rejected the token request (${res.status}): ${body}`);
  }
}

let tokens = null;
// Commands like `me` and `summary` fire several `get()` calls at once via
// Promise.all, each independently calling accessToken(). If the token is
// expired, every one of them would otherwise start its own refresh request
// with the same refresh_token — WHOOP rotates it on the first request that
// lands, so every other concurrent request then gets rejected. Caching the
// in-flight refresh so concurrent callers await the same one closes that race.
let refreshing = null;

async function accessToken() {
  // Check credentials first: on a fresh clone the real problem is a missing
  // .env, and "run login" would just send you to the same error one step later.
  const { clientId, clientSecret } = credentials();

  tokens ??= readTokens();
  if (!tokens) fail('Not logged in. Run:  node whoop.mjs login');

  const expiresAt = tokens.obtained_at + (tokens.expires_in - 60) * 1000;
  if (Date.now() < expiresAt) return tokens.access_token;

  if (!tokens.refresh_token) fail('Session expired. Run:  node whoop.mjs login');

  refreshing ??= requestTokens({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  }).then(saveTokens).finally(() => { refreshing = null; });

  tokens = await refreshing;
  return tokens.access_token;
}

// ───────────────────────────────────────────────────────────── oauth login

/**
 * The browser half of OAuth: we send you to WHOOP, WHOOP asks *you* whether to
 * grant access, then redirects back to a throwaway server on localhost with a
 * one-time code. Your WHOOP password never touches this program.
 */
async function login({ manual }) {
  const { clientId, clientSecret, redirectUri } = credentials();
  const state = crypto.randomBytes(16).toString('hex'); // CSRF guard, must be 8+ chars

  const authorizeUrl = `${AUTH_URL}?` + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
  });

  console.log('\nApprove access in your browser:\n\n  ' + authorizeUrl + '\n');

  const code = manual
    ? await codeFromPastedUrl(state)
    : (openBrowser(authorizeUrl), await codeFromLocalServer(redirectUri, state));

  saveTokens(await requestTokens({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  }));

  console.log(`\n\x1b[32m✓ Connected.\x1b[0m Token saved to ${path.basename(TOKEN_FILE)}`);
  console.log('  Try:  node whoop.mjs summary\n');
}

function openBrowser(url) {
  // `start` is a cmd.exe builtin rather than an executable, so Windows needs the
  // shell. The empty "" is the window title start expects before the URL.
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];

  // Worst case the browser doesn't open and the user clicks the printed URL.
  try { spawn(command, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}

/** Fallback for when localhost can't be bound: paste the redirect URL by hand. */
async function codeFromPastedUrl(state) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('Paste the URL you landed on: ', r));
  rl.close();

  let params;
  try {
    params = new URL(answer.trim()).searchParams;
  } catch {
    return fail('That does not look like a URL. Copy the whole address bar, including https://');
  }

  if (params.get('state') !== state) fail('State mismatch — start over.');
  return params.get('code') ?? fail(`No code in that URL: ${params.get('error') ?? 'unknown error'}`);
}

/**
 * `localhost` does not mean one address. macOS resolves it to ::1 before
 * 127.0.0.1, so a server bound only to IPv4 never sees the browser's redirect —
 * the tab just fails to connect and login hangs forever. Bind both loopback
 * stacks and take whichever one the browser picks.
 */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

/** The error we echo back comes from the query string, so never trust it raw. */
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function codeFromLocalServer(redirectUri, state) {
  const port = Number(new URL(redirectUri).port || 80);
  const servers = [];

  let finish;
  const received = new Promise((resolve, reject) => {
    finish = (error, code) => {
      servers.forEach((server) => server.close());
      error ? reject(new Error(error)) : resolve(code);
    };
  });

  const handler = (req, res) => {
    const params = new URL(req.url, `http://localhost:${port}`).searchParams;
    if (!params.has('code') && !params.has('error')) return res.writeHead(404).end();

    const error = params.get('error') ?? (params.get('state') !== state ? 'state mismatch' : null);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      `<body style="font:16px system-ui;text-align:center;padding-top:20vh">
         <h2>${error ? '❌ ' + escapeHtml(error) : '✅ WHOOP connected'}</h2>
         <p>You can close this tab.</p>
       </body>`
    );
    finish(error, params.get('code'));
  };

  for (const host of LOOPBACK_HOSTS) {
    const server = http.createServer(handler);
    const bound = await new Promise((resolve) => {
      server.once('error', () => resolve(false)); // this stack is unavailable or taken
      server.listen(port, host, () => resolve(true));
    });
    if (bound) servers.push(server);
  }

  if (!servers.length) {
    throw new Error(`Could not listen on port ${port}.\nTry:  node whoop.mjs login --manual`);
  }

  console.log('Waiting for WHOOP to redirect back… (Ctrl-C to cancel)');

  // unref, or this timer holds the process open for five minutes after a
  // successful login and the terminal appears to hang.
  setTimeout(() => finish('Login timed out after 5 minutes.'), 300_000).unref();

  return received;
}

// ───────────────────────────────────────────────────────────── api client

/** How long to keep retrying a rate-limited request, in milliseconds. */
const RETRY_BUDGET_MS = 90_000;

let announcedThrottle = false;

/** One authenticated GET, retrying the failures that are worth retrying. */
async function get(endpoint, params = {}) {
  const url = new URL(API_BASE + endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value);
  }

  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });

    // 429 = rate limited, 5xx = WHOOP hiccup. Both are worth waiting out. WHOOP
    // meters per minute, so back off in seconds and be patient rather than
    // burning four quick retries inside the same closed window.
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      const pause = retryAfter || Math.min(2000 * 2 ** attempt, 30_000);

      if (waited + pause <= RETRY_BUDGET_MS) {
        if (res.status === 429 && !announcedThrottle) {
          announcedThrottle = true;
          console.error('\x1b[2mWHOOP is rate limiting us — waiting it out…\x1b[0m');
        }
        await sleep(pause);
        waited += pause;
        continue;
      }

      if (res.status === 429) {
        fail('WHOOP is still rate limiting after 90s.\n' +
             'Wait a minute, or ask for a shorter window with --days.');
      }
    }

    if (res.status === 401) fail('WHOOP rejected the token. Run:  node whoop.mjs login');
    if (!res.ok) fail(`WHOOP returned ${res.status} for ${endpoint}\n${await res.text()}`);

    return res.json();
  }
}

/** Collections come back 25 at a time; follow next_token until we have the window. */
async function getAll(endpoint, days) {
  const start = new Date(Date.now() - days * 86_400_000).toISOString();
  const records = [];
  let nextToken;

  const seen = new Set();
  do {
    const page = await get(endpoint, { limit: 25, start, nextToken });
    records.push(...(page?.records ?? []));

    nextToken = page?.next_token;
    if (nextToken && seen.has(nextToken)) break; // WHOOP repeated itself; stop rather than spin
    if (nextToken) seen.add(nextToken);
  } while (nextToken);

  return records;
}

// ───────────────────────────────────────────────────────────── presentation

const hours = (ms) => (ms == null ? null : +(ms / 3_600_000).toFixed(1));
const round = (n, places = 0) => (n == null ? null : +n.toFixed(places));
const calories = (kj) => (kj == null ? null : Math.round(kj / 4.184));
/**
 * WHOOP timestamps are UTC, and every record carries the UTC offset that was in
 * effect for you at the time. Slicing the ISO string instead would put anyone
 * east of UTC on the wrong day, every day.
 */
export function localDay(iso, offset) {
  if (!iso) return null;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset ?? '');
  const minutes = match ? (match[1] === '-' ? -1 : 1) * (+match[2] * 60 + +match[3]) : 0;
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString().slice(0, 10);
}

export const shiftDay = (day, by) =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() + by * 86_400_000).toISOString().slice(0, 10);

export function mean(values) {
  const numbers = values.filter((v) => typeof v === 'number');
  return numbers.length ? round(numbers.reduce((a, b) => a + b) / numbers.length, 1) : null;
}

/** Tiny inline chart, oldest value on the left. */
export function sparkline(values) {
  const bars = '▁▂▃▄▅▆▇█';
  const numbers = values.filter((v) => typeof v === 'number');
  if (numbers.length < 2) return '';

  const low = Math.min(...numbers);
  const span = Math.max(...numbers) - low || 1;
  return values
    .map((v) => (typeof v === 'number' ? bars[Math.round(((v - low) / span) * (bars.length - 1))] : ' '))
    .join('');
}

/**
 * WHOOP nests every metric under `score`, which is null until a record is
 * scored (today's data, or the night you're still sleeping through). These
 * mappers flatten that away and leave nulls where WHOOP has nothing yet.
 */
export const asRecovery = (r) => ({
  date: localDay(r.created_at, r.timezone_offset),
  recovery: round(r.score?.recovery_score),
  hrv_ms: round(r.score?.hrv_rmssd_milli, 1),
  resting_hr: r.score?.resting_heart_rate ?? null,
  spo2: round(r.score?.spo2_percentage, 1),
  skin_temp_c: round(r.score?.skin_temp_celsius, 1),
});

export const asSleep = (s) => {
  const stages = s.score?.stage_summary ?? {};
  const asleep = s.score
    ? (stages.total_light_sleep_time_milli ?? 0) +
      (stages.total_slow_wave_sleep_time_milli ?? 0) +
      (stages.total_rem_sleep_time_milli ?? 0)
    : null;

  return {
    date: localDay(s.end, s.timezone_offset),
    nap: s.nap,
    asleep_h: hours(asleep),
    rem_h: hours(stages.total_rem_sleep_time_milli),
    deep_h: hours(stages.total_slow_wave_sleep_time_milli),
    awake_h: hours(stages.total_awake_time_milli),
    performance: round(s.score?.sleep_performance_percentage),
    efficiency: round(s.score?.sleep_efficiency_percentage),
    disturbances: stages.disturbance_count ?? null,
  };
};

export const asDay = (c) => ({
  date: localDay(c.start, c.timezone_offset),
  strain: round(c.score?.strain, 1),
  calories: calories(c.score?.kilojoule),
  avg_hr: c.score?.average_heart_rate ?? null,
  max_hr: c.score?.max_heart_rate ?? null,
});

export const asWorkout = (w) => ({
  date: localDay(w.start, w.timezone_offset),
  sport: w.sport_name ?? 'unknown',
  strain: round(w.score?.strain, 1),
  duration_h: w.end && w.start ? hours(new Date(w.end) - new Date(w.start)) : null,
  avg_hr: w.score?.average_heart_rate ?? null,
  max_hr: w.score?.max_heart_rate ?? null,
  calories: calories(w.score?.kilojoule),
  km: w.score?.distance_meter == null ? null : round(w.score.distance_meter / 1000, 2),
});

function show(data, asJson) {
  if (asJson) return console.log(JSON.stringify(data, null, 2));
  if (Array.isArray(data) && !data.length) return console.log('No records in that window.');
  console.table(data);
}

// ───────────────────────────────────────────────────────────── commands

/** The shareable one-screen view: how the last N days actually went. */
async function summary(days, asJson) {
  const [profile, body, recoveries, sleeps, cycles, workouts] = await Promise.all([
    get(ENDPOINTS.profile),
    get(ENDPOINTS.body),
    getAll(ENDPOINTS.recovery, days),
    getAll(ENDPOINTS.sleep, days),
    getAll(ENDPOINTS.cycle, days),
    getAll(ENDPOINTS.workout, days),
  ]);

  const strain = cycles.map(asDay);
  const nights = sleeps.map(asSleep).filter((s) => !s.nap);
  const sessions = workouts.map(asWorkout);

  // A recovery record carries no timezone of its own, so date it by the cycle it
  // scores. That also guarantees recovery and strain land on the same row.
  const dayOfCycle = new Map(cycles.map((c) => [c.id, localDay(c.start, c.timezone_offset)]));
  const recovery = recoveries.map((r) => {
    const mapped = asRecovery(r);
    return { ...mapped, date: dayOfCycle.get(r.cycle_id) ?? mapped.date };
  });

  // One shared date axis. Without it each row is a different length starting on a
  // different day, and reading down a column silently compares unrelated days.
  const latest = [recovery, nights, strain, sessions]
    .flat().map((r) => r.date).filter(Boolean).sort().at(-1);
  const dates = latest
    ? Array.from({ length: days }, (_, i) => shiftDay(latest, i - days + 1))
    : [];

  /** Line a series up with the axis, leaving a hole where there is no record. */
  const along = (rows, field) => {
    const byDate = new Map(rows.map((r) => [r.date, r]));
    return dates.map((d) => byDate.get(d)?.[field] ?? null);
  };

  const series = {
    recovery: along(recovery, 'recovery'),
    sleep_h: along(nights, 'asleep_h'),
    sleep_performance: along(nights, 'performance'),
    strain: along(strain, 'strain'),
    resting_hr: along(recovery, 'resting_hr'),
    hrv_ms: along(recovery, 'hrv_ms'),
    calories: along(strain, 'calories'),
  };

  const inWindow = sessions.filter((w) => dates.includes(w.date));
  const bySport = inWindow.reduce((acc, w) => ({ ...acc, [w.sport]: (acc[w.sport] ?? 0) + 1 }), {});

  const report = {
    name: [profile.first_name, profile.last_name].filter(Boolean).join(' '),
    days,
    dates,
    averages: Object.fromEntries(Object.entries(series).map(([k, v]) => [k, mean(v)])),
    workouts: { total: inWindow.length, by_sport: bySport },
    body: {
      height_cm: body.height_meter ? Math.round(body.height_meter * 100) : null,
      weight_kg: round(body.weight_kilogram, 1),
      max_hr: body.max_heart_rate,
    },
  };

  if (asJson) {
    return console.log(JSON.stringify(
      { ...report, series, recovery, nights, strain, sessions: inWindow }, null, 2));
  }

  const line = (label, key, unit) => {
    const value = report.averages[key];
    const shown = value == null ? '—' : `${value}${unit}`;
    console.log(`  ${label.padEnd(13)}${shown.padStart(7)}   \x1b[36m${sparkline(series[key])}\x1b[0m`);
  };

  console.log(`\n\x1b[1m${report.name}\x1b[0m \x1b[2m· ${dates[0]} → ${dates.at(-1)}\x1b[0m\n`);
  line('Recovery', 'recovery', '%');
  line('Sleep', 'sleep_h', 'h');
  line('Day strain', 'strain', '');
  line('Resting HR', 'resting_hr', 'bpm');
  line('HRV', 'hrv_ms', 'ms');

  const sports = Object.entries(bySport).map(([sport, n]) => `${sport} \u00d7${n}`).join(', ');
  console.log(`\n  ${'Workouts'.padEnd(13)}${String(inWindow.length).padStart(7)}   \x1b[2m${sports}\x1b[0m\n`);
}

const COMMANDS = {
  login: (args) => login({ manual: args.manual }),

  summary: (args) => summary(args.days ?? 7, args.json),

  me: async (args) => {
    const [profile, body] = await Promise.all([
      get(ENDPOINTS.profile),
      get(ENDPOINTS.body),
    ]);
    show({ ...profile, ...body }, args.json);
  },

  recovery: async (args) => show((await getAll(ENDPOINTS.recovery, args.days ?? 7)).map(asRecovery), args.json),

  sleep: async (args) => show((await getAll(ENDPOINTS.sleep, args.days ?? 7)).map(asSleep), args.json),

  strain: async (args) => show((await getAll(ENDPOINTS.cycle, args.days ?? 7)).map(asDay), args.json),

  workouts: async (args) => show((await getAll(ENDPOINTS.workout, args.days ?? 30)).map(asWorkout), args.json),

  // Escape hatch: hit any documented endpoint directly. https://developer.whoop.com/api
  raw: async (args) => {
    const [endpoint, ...pairs] = args.rest;
    if (!endpoint) fail('Usage:  node whoop.mjs raw /v2/cycle limit=5');
    const params = Object.fromEntries(pairs.filter((p) => p.includes('=')).map((p) => p.split('=')));
    console.log(JSON.stringify(await get(endpoint, params), null, 2));
  },
};

const HELP = `
whoop.mjs — your WHOOP data in the terminal

  login [--manual]      Connect your WHOOP account (once)
  summary [--days 7]    Averages and trends for the last N days
  recovery [--days 7]   Recovery %, HRV, resting HR, SpO2, skin temp
  sleep [--days 7]      Duration, stages, performance, efficiency
  strain [--days 7]     Daily strain, calories, heart rate
  workouts [--days 30]  Individual sessions
  me                    Profile and body measurements
  raw <endpoint>        Any WHOOP endpoint, e.g. raw /v2/cycle limit=5

  --json                Machine-readable output instead of tables

Setup instructions: README.md
`;

// ───────────────────────────────────────────────────────────── entry point

function parseArgs(argv) {
  const days = argv.indexOf('--days');
  return {
    json: argv.includes('--json'),
    manual: argv.includes('--manual'),
    days: days === -1 ? null : Number(argv[days + 1]),
    rest: argv.slice(1).filter((a) => !a.startsWith('--')),
  };
}

function run(argv) {
  const name = argv[0];
  const command = COMMANDS[name];

  if (!command) {
    // No command at all, or an explicit --help, is a successful request for help.
    // An unrecognised command is a mistake, and scripts need to see that.
    const askedForHelp = !name || name === '--help' || name === '-h' || name === 'help';
    if (askedForHelp) return console.log(HELP);

    console.error(`Unknown command: ${name}`);
    console.error(HELP);
    process.exit(1);
  }

  const args = parseArgs(argv);
  if (args.days !== null && !(args.days > 0)) fail('--days needs a positive number.');
  return command(args).catch((e) => fail(e.message));
}

/**
 * True when this file was executed rather than imported (test.mjs imports it).
 * Both sides go through realpath: process.argv[1] keeps the symlink you typed,
 * while import.meta.url is already resolved, so a `whoop -> whoop.mjs` symlink
 * on your PATH would otherwise look like an import and silently do nothing.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) run(process.argv.slice(2));
