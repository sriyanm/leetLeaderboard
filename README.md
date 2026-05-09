# LeetCode Friends Leaderboard

A self-updating LeetCode leaderboard for a small friend group. No login. No
database. Friends paste their LeetCode handle once and a daily GitHub Action
keeps the standings current. Designed for a fixed-window competition (e.g. 3
months).

- **Score = (currentSolved − baselineSolved) × pointsPerDifficulty**, summed
  across Easy / Medium / Hard. Defaults: 1 / 3 / 5.
- **Static frontend + serverless join/update endpoints**, all on Vercel's free
  Hobby tier.
- **Daily snapshot** via GitHub Actions, committed back to the repo. Each commit
  auto-redeploys via Vercel's GitHub integration.
- **Mid-competition joiners** start at 0 points (their baseline is set to their
  count at the moment they appear).
- **Manual mode** for friends who share a LeetCode account: they self-report
  their personal progress instead of being auto-tracked.

## Architecture

```
GitHub Actions (07:00 UTC daily) ──→ leetcode.com/graphql ──→ public/data/*.json ──→ git push
                                                                       │
                                                                       ▼
                                                                Vercel (auto-deploy)
                                                                       │
        Friends' browser ──── GET / ────────────────────────────────────┘
        Friends' browser ──── POST /api/join ──→ Vercel Function
                                                  │  validate handle via leetcode.com/graphql
                                                  └──→ PUT public/config.json via GitHub API
```

## Setup (one-time, ~15 minutes)

### 1. Create the repo

Push this codebase to a new GitHub repo (private or public — the leaderboard
URL is what's shared). Edit [`public/config.json`](public/config.json) before
the first deploy:

```json
{
  "startDate": "2026-05-10",
  "endDate":   "2026-08-10",
  "points":    { "easy": 1, "medium": 3, "hard": 5 },
  "title":     "LeetCode Friends Leaderboard",
  "users":     []
}
```

### 2. Create a fine-grained GitHub PAT

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained
tokens → Generate new token**.

- **Resource owner**: your account
- **Repository access**: only this repo
- **Repository permissions**: **Contents → Read and write**
- Set an expiry that comfortably covers the 3-month competition.

Copy the `github_pat_…` token; you'll paste it into Vercel next.

### 3. Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the repo.
2. Framework preset: **Other**. Output directory will already be
   `public` (set by [`vercel.json`](vercel.json)). Don't add a build command.
3. Before clicking Deploy, expand **Environment Variables** and add:

   | Name           | Value                                      |
   | -------------- | ------------------------------------------ |
   | `GH_TOKEN`     | the fine-grained PAT from step 2           |
   | `GH_REPO`      | `your-username/your-repo`                  |
   | `GH_BRANCH`    | `main` *(or whatever your default branch is)* |
   | `INVITE_CODE`  | any string you'll share with friends       |

4. Click **Deploy**. After ~30 seconds you'll have a live `*.vercel.app` URL.

### 4. Enable the daily snapshot

On the GitHub repo:

- **Actions** tab → enable workflows if you're prompted.
- **Settings → Actions → General → Workflow permissions**: confirm
  "Read and write permissions" is selected (so the workflow can commit).
- Optional: open **Actions → snapshot → Run workflow** to do the first run
  manually. After it finishes, you should see a `snapshot: …` commit and
  `public/data/latest.json` populated.

That's it. The cron will run every day at 07:00 UTC.

## How friends join

Send them the Vercel URL. They'll see the leaderboard and a join form at the
bottom. They paste:

- their name
- their LeetCode username
- the **invite code** you set (`INVITE_CODE`)
- a tracking **mode**: Auto (default) or Manual

The endpoint validates the handle exists on LeetCode, then appends the entry to
`public/config.json` via the GitHub API. Vercel rebuilds automatically and
their slot appears on the leaderboard. Their actual score appears after the
next daily snapshot (auto users) or as soon as they submit (manual users).

Re-joining with the same handle and a different mode is allowed: it just
flips the user between auto and manual.

### Switching from auto to manual mid-competition

If someone joined as auto, then later realizes they share their LeetCode
account and want to switch to manual:

1. Open the site, scroll to **Join the competition**.
2. Re-enter the same name and LeetCode handle they originally joined with.
3. Pick **Manual** for the tracking mode, paste the invite code, click Join.
   The endpoint detects the existing entry and flips its mode in
   `public/config.json`.
4. Use the **Update my progress** form to submit the count of problems they
   personally solved during the competition so far. Their score updates
   immediately on the leaderboard.

Their old auto-tracked chart history (from before the switch) keeps the
correct points value for those dates — the chart interprets each snapshot
according to whichever mode the user was in *at that snapshot*, not their
current mode.

### Auto mode (default)

The daily cron queries `leetcode.com/graphql` with the user's handle, reads
their global solved counts, and computes their delta from the baseline taken
at competition start. No action needed from the user after joining.

### Manual mode (for shared LeetCode accounts)

If multiple friends use the same LeetCode login, the auto-fetched solved count
includes everyone's submissions. Manual mode lets each friend self-report
their own progress instead.

A manual user joins as normal but selects "Manual" on the join form. Then they
use the **Update my progress** form to submit, at any time:

- their LeetCode username
- the totals of **Easy / Medium / Hard problems they personally solved
  during the competition** (i.e. deltas, not absolute LeetCode totals)
- the invite code

These values *replace* their previous submission, so each update should be a
running total from the start of the competition. The leaderboard updates
immediately after submission; their progress on the chart updates at the next
daily snapshot. Manual users are visually marked with a small `MANUAL` badge
in the standings table and a dashed line on the chart.

The two endpoints are:

- `POST /api/join` — `{name, leetcode, inviteCode, mode?}` where `mode` is
  `"auto"` (default) or `"manual"`.
- `POST /api/update` — `{leetcode, easy, medium, hard, inviteCode}`. Only
  works for users in manual mode.

## Local development

```bash
npm run snapshot   # runs scripts/fetch.mjs against the current public/config.json
```

To test the static site locally with the API, install the Vercel CLI and run
`vercel dev` from the repo root. You'll need a local `.env.local` with the
same env vars as above (use a throwaway PAT scoped to a test repo).

## Tweaks

- **Point values**: edit `public/config.json` → `points`. Takes effect on next
  page load (the math is done client-side).
- **Competition window**: edit `startDate` / `endDate` in `public/config.json`.
- **Snapshot time**: edit the `cron` line in
  [`.github/workflows/snapshot.yml`](.github/workflows/snapshot.yml). Format is
  standard cron in UTC.
- **Manual roster fix**: if someone joins with the wrong name or handle,
  edit `public/config.json` directly and commit. Don't delete from
  `baseline.json` unless you want to reset their baseline.

## Deploying changes

After the one-time setup, **just commit and push to `main`**. Vercel's GitHub
integration auto-redeploys on every push (~30 seconds), so:

- Frontend tweaks (`public/*.html`, `*.js`, `*.css`) are live as soon as Vercel
  finishes building.
- Function changes (`api/join.js`, `api/update.js`) deploy in the same flow;
  the existing env vars (`GH_TOKEN`, `GH_REPO`, `GH_BRANCH`, `INVITE_CODE`)
  are already set, no re-config needed.
- Workflow changes (`.github/workflows/snapshot.yml`) are picked up on the
  next scheduled run; no extra action.
- Schema changes to `public/config.json` (e.g. flipping a user to manual)
  take effect on next page load and next cron tick.

You only have to revisit Vercel/GitHub settings if you want to add a new env
var, change the cron cadence, or rotate the invite code.

## Files

| Path | What it does |
| --- | --- |
| [`public/config.json`](public/config.json) | Friends list, dates, point weights. Each user can have `mode: "manual"`. |
| [`public/data/baseline.json`](public/data/) | Frozen counts at competition start (auto users only). |
| [`public/data/latest.json`](public/data/) | Most recent daily snapshot. |
| [`public/data/manual.json`](public/data/) | Manual users' self-reported counts. |
| [`public/data/snapshots/<date>.json`](public/data/) | Per-day snapshots. |
| [`public/data/timeline.json`](public/data/) | Combined timeline used by the chart. |
| [`public/index.html`](public/index.html), [`app.js`](public/app.js), [`style.css`](public/style.css) | Static frontend. |
| [`api/join.js`](api/join.js) | `POST /api/join` — validates handle and adds user to config.json. |
| [`api/update.js`](api/update.js) | `POST /api/update` — manual users self-report counts. |
| [`scripts/fetch.mjs`](scripts/fetch.mjs) | Daily snapshot script (called by the workflow). |
| [`.github/workflows/snapshot.yml`](.github/workflows/snapshot.yml) | Daily cron + manual dispatch. |
| [`vercel.json`](vercel.json) | Tells Vercel to serve `public/` and treat `api/` as functions. |

## Costs

- **Vercel Hobby**: free, non-commercial. The function runs in the low double
  digits of invocations per month for a typical friend group.
- **GitHub Actions**: free for public repos; 2,000 free minutes/month for
  private repos. Each daily run takes ~15 seconds.
- **LeetCode**: the GraphQL endpoint is unauthenticated and rate-limit-friendly
  for daily polling at this scale. We send a `User-Agent` and `Referer`.

## Limitations

- Auto mode only counts solved-problem totals; we can't see *which* problems
  each person solved without their session cookie.
- A user's baseline is set the first time the cron sees them on/after the
  start date. Joining 30 days in means they have 60 days to climb the
  board, starting at 0.
- Manual mode is honor-system. The invite code is the only validation; manual
  users can submit any numbers. Trust your friends.
- The `INVITE_CODE` is the only gate on both forms. If it leaks, anyone can
  add themselves or update existing manual users; rotate it via Vercel env
  vars if needed.
