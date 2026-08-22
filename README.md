# whoop-cli

[![test](https://github.com/yc-wang00/whoop-cli/actions/workflows/test.yml/badge.svg)](https://github.com/yc-wang00/whoop-cli/actions/workflows/test.yml)

Read your WHOOP data from the terminal.

One file, no dependencies, no database. It talks to the official
[WHOOP API v2](https://developer.whoop.com/api) over OAuth 2.0 and prints what
it gets back. Your data stays on WHOOP's servers; the only thing kept locally is
your own access token.

```
$ node whoop.mjs summary --days 14

Jordan Blake · 2026-08-08 → 2026-08-21

  Recovery         67%   ▄▆▃▇▅▄▂▅▇▆▄▃▅▆
  Sleep           7.2h   ▅▃▇▆▄▂▆▇▅▄▃▆▅▇
  Day strain      12.2   ▃▅▂▇▄▆▃▅▂▆▄▇▃▅
  Resting HR     52bpm   ▄▃▅▂▆▄▃▅▂▄▆▃▄▂
  HRV             64ms   ▅▇▃▆▄▂▅▇▄▆▃▅▄▆

  Workouts           5   running ×3, weightlifting ×2
```

Every row is drawn against the same date axis, so a column is one day across all
of them. Blanks are days the strap wasn't worn.

## Requirements

An active WHOOP membership and [Node.js](https://nodejs.org) 18 or newer
(`node --version` to check). Nothing else to install.

## Setup

**1. Get the code.**

```bash
git clone https://github.com/yc-wang00/whoop-cli.git
cd whoop-cli
```

**2. Get a Client ID and Client Secret.**

Sign in at [developer-dashboard.whoop.com](https://developer-dashboard.whoop.com)
with your WHOOP account, create a team, then create an app:

- **Redirect URI** — `http://localhost:8080/callback` (exactly this)
- **Scopes** — tick all six `read:` scopes

The app is just a registration. It says "this program may ask me for access"; it
does not give anyone access to anything on its own.

> If someone has already given you a Client ID and Secret for their app, you can
> skip this step and use theirs. You still sign in with **your own** WHOOP
> account, and you still only ever see **your own** data — the credentials
> identify the program, not the person.

**3. Save the credentials.**

```bash
cp .env.example .env
```

Open `.env` and paste in the Client ID and Client Secret. This file is
gitignored — never commit it.

**4. Connect.**

```bash
node whoop.mjs login
```

Your browser opens WHOOP's own consent page. You approve, WHOOP redirects back,
and a token lands in `.whoop-tokens.json` (mode 600). It refreshes itself from
then on, so this is a one-time step.

## Usage

```bash
node whoop.mjs summary --days 14   # averages and trends
node whoop.mjs recovery            # recovery %, HRV, resting HR, SpO2, skin temp
node whoop.mjs sleep               # duration, stages, performance, efficiency
node whoop.mjs strain              # daily strain, calories, heart rate
node whoop.mjs workouts            # individual sessions
node whoop.mjs me                  # profile and body measurements
node whoop.mjs                     # full help
```

You can also put it on your PATH:

```bash
npm link          # then just: whoop summary --days 14
```

Windows are cheap — a full year takes about three seconds, so ask for the range
you actually want. WHOOP rate-limits per minute; if you hit it, the CLI says so
and waits.

Add `--json` to any command for machine-readable output, which is also how you
get a file you can keep, chart, or hand to someone:

```bash
node whoop.mjs summary --days 7 --json > my-week.json
```

Nothing is uploaded anywhere, so what leaves your machine is exactly what you
choose to export. A full `summary --json` includes body measurements, resting
heart rate, HRV and per-night sleep detail — look at the file before sending it.

## Checking it still works

```bash
npm test          # or: node test.mjs
```

The suite fetches WHOOP's live OpenAPI spec and asserts that every field this
CLI reads still exists, so if WHOOP renames something you get a failing test
instead of a screen full of nulls. It also stands up the real OAuth callback
server and checks that unscored days come back as blanks rather than zeros.

It needs network but no WHOOP account — run it before trusting a change. CI runs
the same suite on Node 18, 20, 22 and 24, plus weekly, so an API change shows up
as a red build rather than as a surprise.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `No WHOOP credentials found` | You skipped step 3, or `.env` has the wrong variable names |
| `Could not listen on port 8080` | Something else is using it — `node whoop.mjs login --manual` and paste the URL back |
| `WHOOP rejected the token` | Run `node whoop.mjs login` again |
| Browser says "redirect_uri mismatch" | The URI in `.env` and in the WHOOP dashboard must match character for character |
| Today's numbers are empty | WHOOP hasn't scored the current day yet; that's expected |

## What's in here

| File | |
| --- | --- |
| `whoop.mjs` | The whole program — auth, API calls, formatting |
| `test.mjs` | Contract, OAuth and formatting tests — `npm test` |
| `AGENTS.md` | Notes for coding agents working in this repo |
| `PRIVACY.md` | What this stores and what it never sends |
| `.env` | Your credentials (gitignored) |
| `.whoop-tokens.json` | Your access token, mode 600 (gitignored) |

Not affiliated with WHOOP.

## License

MIT
