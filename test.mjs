/**
 * Run with:  node test.mjs
 *
 * Four things are worth testing here:
 *   1. that WHOOP still returns the fields we read      (contract, needs network)
 *   2. that the OAuth callback server actually works    (the step you can't retry easily)
 *   3. that unscored records become nulls, not zeros    (the easiest thing to get wrong)
 *   4. that the CLI starts however you invoke it        (direct, symlinked, imported)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ENDPOINTS, OAUTH, SCOPES,
  asRecovery, asSleep, asDay, asWorkout, mean, sparkline, localDay, shiftDay,
  codeFromLocalServer,
} from './whoop.mjs';

// ───────────────────────────────────────── 1. contract with the live WHOOP API

/**
 * Every field this CLI reads, grouped by the schema it comes from. If WHOOP
 * renames or drops one of these, this test fails instead of the CLI silently
 * reporting nulls for everything.
 */
const FIELDS_WE_READ = {
  UserBasicProfile:   ['first_name', 'last_name'],
  UserBodyMeasurement:['height_meter', 'weight_kilogram', 'max_heart_rate'],
  Cycle:              ['start', 'score_state', 'score'],
  CycleScore:         ['strain', 'kilojoule', 'average_heart_rate', 'max_heart_rate'],
  Recovery:           ['created_at', 'score_state', 'score'],
  RecoveryScore:      ['recovery_score', 'hrv_rmssd_milli', 'resting_heart_rate',
                       'spo2_percentage', 'skin_temp_celsius'],
  Sleep:              ['end', 'nap', 'score_state', 'score'],
  SleepScore:         ['stage_summary', 'sleep_performance_percentage',
                       'sleep_efficiency_percentage'],
  SleepStageSummary:  ['total_light_sleep_time_milli', 'total_slow_wave_sleep_time_milli',
                       'total_rem_sleep_time_milli', 'total_awake_time_milli',
                       'disturbance_count'],
  WorkoutV2:          ['start', 'end', 'sport_name', 'score_state', 'score'],
  WorkoutScore:       ['strain', 'average_heart_rate', 'max_heart_rate', 'kilojoule',
                       'distance_meter'],
};

const SPEC_URL = 'https://api.prod.whoop.com/developer/doc/openapi.json';

const spec = await fetch(SPEC_URL)
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);

test('WHOOP API contract', { skip: spec ? false : 'offline — could not fetch the OpenAPI spec' }, async (t) => {
  const schemas = spec.components.schemas;

  await t.test('every field we read still exists', () => {
    for (const [schema, fields] of Object.entries(FIELDS_WE_READ)) {
      assert.ok(schemas[schema], `schema ${schema} is gone`);
      for (const field of fields) {
        assert.ok(schemas[schema].properties?.[field], `${schema}.${field} is gone`);
      }
    }
  });

  await t.test('every endpoint we call still exists', () => {
    for (const path of Object.values(ENDPOINTS)) {
      assert.ok(spec.paths[path]?.get, `GET ${path} is gone`);
    }
  });

  await t.test('pagination works the way we assume', () => {
    for (const path of [ENDPOINTS.cycle, ENDPOINTS.recovery, ENDPOINTS.sleep, ENDPOINTS.workout]) {
      const params = Object.fromEntries(spec.paths[path].get.parameters.map((p) => [p.name, p]));
      assert.equal(params.limit.schema.maximum, 25, `${path}: page size changed`);
      assert.ok(params.nextToken, `${path}: nextToken param is gone`);
      assert.ok(params.start, `${path}: start param is gone`);
    }
    const page = spec.components.schemas.PaginatedCycleResponse.properties;
    assert.ok(page.records && page.next_token, 'response envelope changed');
  });

  await t.test('OAuth endpoints and scopes are unchanged', () => {
    const flow = spec.components.securitySchemes.OAuth.flows.authorizationCode;
    assert.equal(flow.authorizationUrl, OAUTH.AUTH_URL);
    assert.equal(flow.tokenUrl, OAUTH.TOKEN_URL);
    assert.equal(spec.servers[0].url, OAUTH.API_BASE);

    // `offline` is an auth-server scope and is deliberately absent from the API spec.
    for (const scope of SCOPES.filter((s) => s !== 'offline')) {
      assert.ok(flow.scopes[scope], `scope ${scope} is gone`);
    }
  });
});

// ───────────────────────────────────────── 2. the OAuth callback server

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Poll until something is accepting connections on this address. */
async function reachable(port, host) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ port, host });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/** Whether this machine has IPv6 loopback at all — CI containers often do not. */
const hasIPv6 = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});

/** Stand the real callback server up and drive it like WHOOP's redirect would. */
async function callback(query, host = '127.0.0.1') {
  const port = await freePort();
  const state = 'test-state-value';

  // Settle into a plain object right away: the server rejects while we are still
  // awaiting the fetch below, and an unattached rejection would crash the run.
  const settled = codeFromLocalServer(`http://localhost:${port}/callback`, state)
    .then((code) => ({ code }), (error) => ({ error: error.message }));

  assert.ok(await reachable(port, host), `callback server never came up on ${host}`);

  const authority = host.includes(':') ? `[${host}]` : host;
  const url = new URL(`http://${authority}:${port}/callback`);
  for (const [k, v] of Object.entries({ state, ...query })) url.searchParams.set(k, v);
  const page = await fetch(url).then((r) => r.text());

  return { ...(await settled), page };
}

test('OAuth callback server', async (t) => {
  await t.test('accepts the redirect and hands back the code', async () => {
    const { code, page } = await callback({ code: 'auth-code-123' });
    assert.equal(code, 'auth-code-123');
    assert.match(page, /WHOOP connected/);
  });

  await t.test('rejects a mismatched state (CSRF guard)', async () => {
    const { code, error, page } = await callback({ code: 'stolen', state: 'wrong-state' });
    assert.equal(code, undefined, 'a forged redirect must not yield a code');
    assert.match(error, /state mismatch/);
    assert.match(page, /state mismatch/);
  });

  await t.test('surfaces the error WHOOP sends back', async () => {
    const { code, error } = await callback({ error: 'access_denied' });
    assert.equal(code, undefined);
    assert.match(error, /access_denied/);
  });

  await t.test('listens on both loopback stacks', { skip: hasIPv6 ? false : 'no IPv6 on this machine' }, async () => {
    // macOS resolves `localhost` to ::1 before 127.0.0.1. Binding IPv4 only means
    // the browser's redirect is refused and login hangs with no error anywhere.
    const port = await freePort();
    const settled = codeFromLocalServer(`http://localhost:${port}/callback`, 'test-state-value')
      .then(() => {}, () => {});

    const ipv4 = await reachable(port, '127.0.0.1');
    const ipv6 = await reachable(port, '::1');

    await fetch(`http://127.0.0.1:${port}/callback?code=x&state=test-state-value`); // let it shut down
    await settled;

    assert.ok(ipv4, 'IPv4 loopback unreachable');
    assert.ok(ipv6, 'IPv6 loopback unreachable — the browser would fail to connect');
  });

  await t.test('accepts the redirect over IPv6 too', { skip: hasIPv6 ? false : 'no IPv6 on this machine' }, async () => {
    const { code } = await callback({ code: 'ipv6-code' }, '::1');
    assert.equal(code, 'ipv6-code');
  });

  await t.test('escapes what WHOOP puts in the error parameter', async () => {
    // The error is echoed onto the success page, and it arrives in a query
    // string, so it must never reach the browser as markup.
    const { page } = await callback({ error: '<script>alert(1)</script>' });
    assert.ok(!page.includes('<script>'), 'error parameter rendered as raw HTML');
    assert.match(page, /&lt;script&gt;/);
  });

  await t.test('does not keep the process alive after finishing', () => {
    // The 5-minute login timeout must be unref'd, or `login` hangs the terminal
    // for five minutes after a successful connect.
    const timers = process.getActiveResourcesInfo().filter((r) => r === 'Timeout');
    assert.equal(timers.length, 0, 'a timer is still holding the event loop open');
  });
});

// ───────────────────────────────────────── 3. unscored records must be null

const SCORED_SLEEP = {
  end: '2026-08-21T14:00:00.000Z', nap: false, score_state: 'SCORED',
  score: {
    stage_summary: {
      total_in_bed_time_milli: 28_800_000, total_awake_time_milli: 1_800_000,
      total_light_sleep_time_milli: 14_400_000, total_slow_wave_sleep_time_milli: 5_400_000,
      total_rem_sleep_time_milli: 7_200_000, disturbance_count: 3,
    },
    sleep_performance_percentage: 92, sleep_efficiency_percentage: 94,
  },
};

test('record mapping', async (t) => {
  await t.test('dates come from the record\'s own UTC offset', () => {
    // A cycle that starts at 02:17 local in PDT is still that same local day…
    assert.equal(localDay('2026-08-21T09:17:42.430Z', '-07:00'), '2026-08-21');
    // …but 02:00 UTC is the evening *before* in PDT, which slicing the ISO
    // string would get wrong.
    assert.equal(localDay('2026-08-21T02:00:00.000Z', '-07:00'), '2026-08-20');
    // And waking at 07:00 in UTC+8 is the previous day in UTC — this is the case
    // that would put anyone in Asia on the wrong day, every single day.
    assert.equal(localDay('2026-08-20T23:00:00.000Z', '+08:00'), '2026-08-21');

    assert.equal(localDay(null, '-07:00'), null);
    assert.equal(localDay('2026-08-21T12:00:00.000Z', undefined), '2026-08-21'); // falls back to UTC
  });

  await t.test('the date axis walks backwards across month ends', () => {
    assert.equal(shiftDay('2026-09-01', -1), '2026-08-31');
    assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
    assert.equal(shiftDay('2026-08-21', 0), '2026-08-21');
  });

  await t.test('sleep stages add up to time asleep', () => {
    const s = asSleep(SCORED_SLEEP);
    assert.equal(s.asleep_h, 7.5); // 4h light + 1.5h deep + 2h REM
    assert.equal(s.deep_h, 1.5);
    assert.equal(s.rem_h, 2);
    assert.equal(s.date, '2026-08-21');
    assert.equal(s.performance, 92);
  });

  await t.test('an unscored night is null, never zero', () => {
    const s = asSleep({ ...SCORED_SLEEP, score_state: 'PENDING_SCORE', score: null });
    assert.equal(s.asleep_h, null);
    assert.equal(s.deep_h, null);
    assert.equal(s.performance, null);
  });

  await t.test('an unscored day is null, never zero', () => {
    const d = asDay({ start: '2026-08-21T11:00:00.000Z', score_state: 'PENDING_SCORE', score: null });
    assert.equal(d.strain, null);
    assert.equal(d.calories, null);
  });

  await t.test('an unscored recovery is null, never zero', () => {
    const r = asRecovery({ created_at: '2026-08-21T11:00:00.000Z', score_state: 'PENDING_SCORE', score: null });
    assert.equal(r.recovery, null);
    assert.equal(r.hrv_ms, null);
  });

  await t.test('workouts without distance report null, not NaN', () => {
    const w = asWorkout({
      start: '2026-08-21T11:00:00.000Z', end: '2026-08-21T12:00:00.000Z',
      sport_name: 'weightlifting', score_state: 'SCORED',
      score: { strain: 11.2, kilojoule: 1673.6 },
    });
    assert.equal(w.km, null);
    assert.equal(w.duration_h, 1);
    assert.equal(w.calories, 400);
  });

  await t.test('averages skip unscored days instead of counting them as zero', () => {
    assert.equal(mean([80, 60, null, undefined]), 70);
    assert.equal(mean([null, null]), null);
  });

  await t.test('sparkline leaves a gap for missing days', () => {
    // Every row in `summary` is drawn against one shared date axis, so a missing
    // day has to hold its column — otherwise the rows stop lining up and reading
    // down a column compares unrelated days.
    assert.equal(sparkline([1, null, 5]).length, 3);
    assert.equal(sparkline([1, null, 5])[1], ' ');
    assert.equal(sparkline([7]), ''); // one point is not a trend
  });
});

// ───────────────────────────────────────── 4. however you invoke it

const CLI = fileURLToPath(new URL('./whoop.mjs', import.meta.url));
const runCli = (script) => execFileSync(process.execPath, [script], { encoding: 'utf8' });

test('entry point', async (t) => {
  await t.test('prints help when run directly', () => {
    assert.match(runCli(CLI), /your WHOOP data in the terminal/);
  });

  await t.test('still runs through a symlink', () => {
    // `ln -s whoop.mjs ~/bin/whoop` is the obvious way to install this, and the
    // symlinked path does not match the resolved module path on its own.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-cli-'));
    try {
      const link = path.join(dir, 'whoop');
      fs.symlinkSync(CLI, link);
      assert.match(runCli(link), /your WHOOP data in the terminal/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('exits 0 for help and 1 for a typo', () => {
    const status = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });

    assert.equal(status().status, 0, 'no arguments should print help and succeed');
    assert.equal(status('--help').status, 0);
    assert.equal(status('help').status, 0);

    const typo = status('recovry');
    assert.equal(typo.status, 1, 'an unknown command must not report success');
    assert.match(typo.stderr, /Unknown command: recovry/);
  });

  await t.test('importing it does not start the CLI', () => {
    const out = execFileSync(
      process.execPath,
      ['-e', `import(${JSON.stringify(CLI)}).then(() => process.stdout.write('quiet'))`],
      { encoding: 'utf8' }
    );
    assert.equal(out, 'quiet');
  });
});
