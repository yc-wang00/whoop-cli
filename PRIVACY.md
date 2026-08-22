# Privacy Policy

**whoop-cli** is a command-line program that runs on your own computer. It has
no server, no account system, and no analytics.

## What it does with your data

When you run a command, it asks the WHOOP API for your data and prints it to
your terminal. That's the whole cycle. Nothing is written to disk except the
access token described below, and nothing is sent anywhere other than WHOOP's
own API.

## What is stored on your computer

| File | Contents |
| --- | --- |
| `.env` | Your WHOOP app's Client ID and Client Secret, which you create yourself |
| `.whoop-tokens.json` | Your OAuth access and refresh tokens, saved with file mode `600` (readable only by your user account) |

Both files are excluded from version control. Neither is transmitted anywhere.

Your WHOOP password is never seen by this program. Authentication happens on
WHOOP's own website, which hands back a token afterwards.

## What is shared

Nothing, unless you do it yourself. If you run a command with `--json` and
redirect the output to a file, that file contains your data and you decide who
receives it. There is no automatic upload, sync, or backup.

Note that a `summary --json` export includes body measurements, resting heart
rate, heart rate variability, and per-night sleep detail — not only workouts.
Look at the file before you send it.

## Revoking access

Revoke this app's access at any time from your WHOOP account settings. You can
also delete `.whoop-tokens.json`, which removes the credentials from your
machine immediately.

## Contact

This is a personal, non-commercial tool. Issues and questions belong in the
project's GitHub repository.
