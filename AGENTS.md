# Agent notes — whoop-cli

A small CLI that reads the signed-in user's WHOOP data from the official API v2.
One file (`whoop.mjs`), no dependencies, no local database — every command is a
live API call, so the data is always current.

## Getting data

```bash
node whoop.mjs summary --days 14 --json   # best starting point: averages + daily series
node whoop.mjs recovery --days 30 --json  # recovery %, HRV, resting HR, SpO2, skin temp
node whoop.mjs sleep --days 30 --json     # duration, stages, performance, efficiency
node whoop.mjs strain --days 30 --json    # daily strain, calories, heart rate
node whoop.mjs workouts --days 90 --json  # individual sessions with sport and distance
node whoop.mjs me                         # profile, height, weight, max HR
node whoop.mjs raw /v2/cycle limit=5      # any endpoint: https://developer.whoop.com/api
```

Use `--json` whenever you need to compute, compare, or chart. The table output
is for a person to read, not for you to parse.

`summary --json` returns averages plus the full daily series in one call —
prefer it over several separate commands when a question spans more than one
metric.

## Things worth knowing

- **Null means unscored, not zero.** WHOOP scores a day after it ends, so the
  most recent record usually has null metrics. Leave those out of averages
  rather than counting them as 0.
- **A WHOOP day is wake-to-wake**, not midnight-to-midnight. `strain` rows are
  keyed by the day the cycle started, in the user's timezone at the time — not
  UTC.
- **`summary --json` puts every metric on one shared date axis** (`dates`, plus
  `series.*` arrays of the same length, `null` on days the strap wasn't worn).
  Use `series` for anything day-by-day; the per-record arrays are not aligned.
- **Naps are separate sleep records** (`nap: true`). Exclude them when talking
  about "last night's sleep"; `summary` already does.
- **One wide window beats many narrow ones.** Requests are paged 25 at a time,
  but the API is fast: measured 0.7s for 60 days, 0.9s for 90, 3.2s for a full
  year. Ask for the range you actually want in a single call.
- **Rate limits are per minute.** Pulling a year twice in a row trips a 429.
  The client waits it out and says so; don't loop over many wide windows.
- Sports come back as names (`running`, `weightlifting`). Distance is only
  present for sports that track it.

## Before changing anything

`node test.mjs` — it checks the field mappings against WHOOP's live OpenAPI
spec, exercises the OAuth callback server, and pins the null-vs-zero handling.
Run it after any edit; add a case when you add behaviour.

## Rules

- Never read, print, or commit `.env` or `.whoop-tokens.json`.
- If a command reports "Not logged in" or the token is rejected, ask the user to
  run `node whoop.mjs login` — it needs them to approve in a browser, you can't
  do it for them.
- Keep this codebase small and readable. People need to audit it before trusting
  it with their own WHOOP credentials. Don't add dependencies, caching layers,
  or config surface without a concrete reason.
