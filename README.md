# LeetCode Friends Leaderboard

A self-updating LeetCode leaderboard for a small friend group. No login. No
database. Friends paste their LeetCode handle once and a daily GitHub Action
keeps the standings current. Designed for a fixed-window competition (e.g. 3
months).

- **Score = (currentSolved − baselineSolved) × pointsPerDifficulty**, summed
  across Easy / Medium / Hard. Defaults: 1 / 3 / 5.
- **Static frontend + serverless join endpoint**, both on Vercel's free Hobby
  tier.
- **Daily snapshot** via GitHub Actions, committed back to the repo. Each commit
  auto-redeploys via Vercel's GitHub integration.
- **Mid-competition joiners** start at 0 points (their baseline is set to their
  count at the moment they appear).

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

The endpoint validates the handle exists on LeetCode, then appends the entry to
`public/config.json` via the GitHub API. Vercel rebuilds automatically and
their slot appears on the leaderboard. Their actual score appears after the
next daily snapshot.

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

## Files

| Path | What it does |
| --- | --- |
| [`public/config.json`](public/config.json) | Friends list, dates, point weights. |
| [`public/data/baseline.json`](public/data/) | Frozen counts at competition start (per user). |
| [`public/data/latest.json`](public/data/) | Most recent snapshot. |
| [`public/data/snapshots/<date>.json`](public/data/) | Per-day snapshots. |
| [`public/data/timeline.json`](public/data/) | Combined timeline used by the chart. |
| [`public/index.html`](public/index.html), [`app.js`](public/app.js), [`style.css`](public/style.css) | Static frontend. |
| [`api/join.js`](api/join.js) | Vercel Function for self-service joins. |
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

- Only counts solved-problem totals; we can't see *which* problems each person
  solved without their session cookie.
- A user's baseline is set the first time the cron sees them on/after the
  start date. Joining 30 days in means they have 60 days to climb the
  board, starting at 0.
- The `INVITE_CODE` is the only gate on the join form. If it leaks, anyone can
  add themselves; rotate it via Vercel env vars if needed.
