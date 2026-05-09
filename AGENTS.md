# AGENTS.md

Context file for AI agents (Cursor, Claude Code, etc.) working on this
repo. Read this end-to-end before changing anything non-trivial.
[`README.md`](README.md) covers user-facing setup and operations; this file
covers the engineering thought process behind what's been built so future
changes don't accidentally break invariants.

## TL;DR

A self-updating LeetCode leaderboard for a small friend group, run for a
fixed competition window (default 3 months). Per-user score is

    score = Σ over {easy, medium, hard} of (current[d] − baseline[d]) × pointsPerDifficulty[d]

A daily GitHub Action queries LeetCode's public GraphQL endpoint for each
user and commits a snapshot to the repo. Vercel auto-deploys on every push,
so the static page (`public/`) and the two serverless functions (`api/`)
stay current. Friends join via a form that hits a Vercel Function, which
validates the LeetCode handle and commits the new user to `config.json`
through the GitHub Contents API. Friends sharing a LeetCode account use
"manual" mode and self-report their personal progress via a second
endpoint.

Everything lives on free tiers (Vercel Hobby + GitHub Actions). No
database. No OAuth. No background workers. The repo *is* the database.

## Architecture

```
GitHub Actions (07:00 UTC daily) ──→ leetcode.com/graphql ──→ public/data/*.json ──→ git push
                                                                       │
                                                                       ▼
                                                                Vercel auto-deploy
                                                                       │
        Friends' browser ──── GET / ────────────────────────────────────┘
        Friends' browser ──── POST /api/join ──→ Vercel Function (api/join.js)
                                                  │  validate handle via leetcode.com/graphql
                                                  └──→ PUT public/config.json via GitHub API
        Friends' browser ──── POST /api/update ─→ Vercel Function (api/update.js)
                                                  │  verify user is mode:manual
                                                  └──→ PUT public/data/manual.json via GitHub API
```

The repo is the source of truth for **everything that persists**: roster,
historical snapshots, baselines, manual self-reports. Functions never write
anywhere else. This means:

- Every state change produces a git commit, so audit history is free.
- Two simultaneous writes (e.g. two friends joining at once) can race on
  the GitHub Contents API's `sha` parameter; the second one will get a 409
  and need to retry. We don't have a retry loop yet — see "open issues".
- Restoring state = `git revert`.

## Repo layout (one line each)

| Path | Purpose |
| --- | --- |
| [`public/index.html`](public/index.html) | Single-page UI shell. |
| [`public/app.js`](public/app.js) | All client logic: data fetch, score math, leaderboard render, chart, forms. |
| [`public/style.css`](public/style.css) | Dark-themed styling. |
| [`public/config.json`](public/config.json) | Roster + dates + point weights. Edited by `api/join.js` and humans. |
| `public/data/baseline.json` | Each auto user's solved counts at competition start. **Once set, never overwritten.** |
| `public/data/latest.json` | Most recent snapshot. Overwritten daily. |
| `public/data/snapshots/<date>.json` | Append-only history. |
| `public/data/index.json` | List of snapshot dates. |
| `public/data/timeline.json` | Combined snapshot history used by the chart. |
| `public/data/manual.json` | Manual users' self-reported deltas. Edited by `api/update.js` and humans. |
| [`api/join.js`](api/join.js) | `POST /api/join` — validates handle, appends/updates user in config.json. |
| [`api/update.js`](api/update.js) | `POST /api/update` — manual users self-report counts. |
| [`scripts/fetch.mjs`](scripts/fetch.mjs) | Daily snapshot script. Run via `npm run snapshot`. |
| [`.github/workflows/snapshot.yml`](.github/workflows/snapshot.yml) | Cron + manual dispatch for the snapshot script. |
| [`vercel.json`](vercel.json) | Tells Vercel `outputDirectory: public` (so `api/` is detected as functions). |
| [`package.json`](package.json) | Node 20, no dependencies. (We use the platform `fetch` everywhere.) |

## Data model

### `public/config.json`

```jsonc
{
  "startDate": "2026-05-10",      // YYYY-MM-DD, UTC. Inclusive.
  "endDate":   "2026-08-10",      // YYYY-MM-DD, UTC. Inclusive.
  "points":    { "easy": 1, "medium": 3, "hard": 5 },
  "title":     "...",
  "users": [
    { "name": "Alice", "leetcode": "alice123" },                    // auto (default)
    { "name": "Bob",   "leetcode": "shared",    "mode": "manual" }  // manual
  ]
}
```

Mutated by `api/join.js` (append + update mode/name on re-join). The
admin can also edit by hand. **Lowercased handle is the unique key.**

### `public/data/baseline.json`

```jsonc
{
  "startDate": "2026-05-10",
  "users": {
    "alice123": { "easy": 60, "medium": 141, "hard": 52, "setOn": "2026-05-10" }
    // Manual users never appear here — their score formula doesn't use a baseline.
  }
}
```

Created by [`scripts/fetch.mjs`](scripts/fetch.mjs) on the first cron run
where `today >= startDate`. Each user's entry is set on the first cron
that *sees* them in `counts`. **Never overwritten** — this preserves
"competition starts now" semantics even for late joiners.

### `public/data/snapshots/<date>.json` and `latest.json`

```jsonc
{
  "date":       "2026-05-09",
  "fetchedAt":  "2026-05-09T07:00:05.000Z",
  "counts": {
    "alice123":   { "easy": 60, "medium": 141, "hard": 52 },
    "shared":     { "easy": 4,  "medium": 1,   "hard": 0  }
  },
  "manual": ["shared"],          // who was in manual mode at this snapshot
  "errors": { "ghost":"not_found" }  // optional, only present if some fetch failed
}
```

Important: for **auto** users, `counts[handle]` is the absolute LeetCode
total at snapshot time. For **manual** users, `counts[handle]` is the
delta they self-reported (carried forward from `manual.json`). The
`manual` array tells the frontend which interpretation to use *per
snapshot* — this matters because users can switch mode mid-competition.

### `public/data/manual.json`

```jsonc
{
  "users": {
    "shared": { "easy": 4, "medium": 1, "hard": 0, "updatedAt": "2026-05-09T05:00:00Z" }
  }
}
```

Mutated by `api/update.js`. Values are deltas during the competition,
not absolute totals. Re-submission overwrites in place.

## Score math (the canonical version)

For each user `u` on the leaderboard:

```js
if (today < config.startDate)         points = 0;                       // pre-comp gate
else if (mode(u) === "manual") {
    const m = manual.users[u.leetcode];
    points = m ? Σ m[d] × points[d] : null;                              // null = "no submission yet"
}
else {  // auto mode
    const b = baseline.users[u.leetcode];
    const c = latest.counts[u.leetcode];
    if (!c)                            points = null;                    // no data yet
    else if (!b)                       points = 0;                       // pre-baseline → don't credit lifetime totals
    else                               points = Σ max(0, c[d] − b[d]) × points[d];
}
```

The chart applies the same logic per snapshot (using each snapshot's
`manual` array to decide which formula applies for that point in time),
and additionally filters out snapshots from before `startDate`.

This is the live implementation in
[`pointsForUser` in public/app.js](public/app.js).

## Critical invariants (do not break)

1. **Baseline is write-once.** `scripts/fetch.mjs` only writes a user's
   baseline if they don't already have one. Re-running the cron the day
   after a user joins must not slide their baseline forward; that would
   wipe their accumulated points.
2. **Manual users never get an auto baseline.** `fetch.mjs` skips them in
   the baseline loop. If you change this, manual users with an existing
   `baseline.json` entry would suddenly start having their score
   computed twice.
3. **Pre-competition score = 0** for everyone, regardless of mode. The
   frontend gate is `hasStarted = today >= config.startDate`. Without
   this gate, auto users' lifetime LeetCode totals leak in as deltas
   (the bug that was on the live site for a few hours on day 0).
4. **Snapshots embed mode at snapshot time.** Each snapshot's `manual`
   array is the authoritative list of who was manual *that day*. The
   chart must use this per-snapshot flag, not the user's current mode,
   or mode-switch users get a wildly wrong chart history.
5. **`config.json` is the unique-by-lowercased-handle list.** Both
   `api/join.js` and `api/update.js` look up users by
   `leetcode.toLowerCase()`. Don't introduce another comparison rule.
6. **Same-origin only.** The static site and the functions are deployed
   to the same Vercel domain, so neither function emits CORS headers.
   If you ever move them apart, add CORS — and then think hard about why
   you're doing that, because losing same-origin doubles the surface
   area.

## Design decisions and the why behind them

- **No OAuth, no LeetCode session cookies.** The public GraphQL
  `matchedUser(username)` query exposes E/M/H solved counts for any
  user. That's all the score formula needs. Adding OAuth would buy us
  per-problem detail (which problems they solved) but would require a
  full backend with persistent secrets. Friend-group scope doesn't
  warrant that.
- **Repo as database.** We need persistence for ~5 small JSON files for
  90 days. Postgres + a hosted plan is overkill. Committing to the repo
  gives us free persistence, audit history, and atomic writes
  (per-file). The downside is concurrent writes — see invariants #6 and
  the "open issues" section.
- **Vercel for everything.** Frontend + functions on the same domain
  removes CORS, simplifies the repo (`public/` + `api/`), and gets us a
  pre-deploy preview on every PR. Cloudflare Workers were also viable;
  picked Vercel because frontend hosting was already needed and Vercel
  bundles both.
- **No build step.** The page is plain HTML/CSS/JS, the functions are
  plain Node ES modules, and the snapshot script is a single `.mjs`. No
  TypeScript, no bundler, no `tsconfig`. This is deliberate: zero build
  config means anyone can drop into the codebase and read it; it also
  removes the "Vercel build is broken" failure mode entirely.
- **Auto vs manual modes.** A friend pointed out that they share a
  LeetCode account with someone else, so the auto-fetched count would
  include the other person's submissions. Rather than add OAuth or some
  per-account authentication, we let them flip a flag and self-report
  deltas. Trust model: the invite code gates writes, friends are honest.
- **Single invite code, no per-user secrets.** Friends are nine people,
  not nine thousand. A shared code paste is the right friction for the
  trust model.
- **Score formula deliberately ignores rank/percentile/streak/etc.** Easy
  to reason about, easy to spot-check by hand. If you want a fancier
  scoring rule, add it as a config option, don't hardcode.
- **Chart is Chart.js from CDN, not a bundled lib.** Same reason as no
  build step: the page is "view source"-able.

## Gotchas and bugs we already hit

These are the real footguns, in order of how badly they bit us:

1. **LeetCode emits `errors` alongside `data.matchedUser: null` for
   unknown handles.** Don't `throw new Error(JSON.stringify(j.errors))`
   if `data.matchedUser` is null — treat it as a clean "not found".
   Both [`scripts/fetch.mjs`](scripts/fetch.mjs) and
   [`api/join.js`](api/join.js) check `matchedUser != null` first.
2. **Pre-competition score inflation.** When `baseline.json` doesn't
   exist yet (because the cron correctly skipped baseline pre-comp),
   the frontend used to fall back to `{0,0,0}` as the baseline, which
   meant lifetime LeetCode totals leaked in as deltas. Fix is in
   `pointsForUser`: missing baseline → 0 points, not "current minus
   zero". Same fix needs to be in the chart (filter snapshots to
   `date >= startDate`, return null for points where no baseline
   exists).
3. **Mode switch breaks chart history.** If a user goes auto → manual
   mid-competition, their old auto-era snapshots store absolute totals
   and their new manual-era snapshots store deltas. The chart cannot
   use the user's *current* mode for all snapshots — it must use each
   snapshot's `manual` array (recorded by `fetch.mjs` at snapshot
   time).
4. **Manual to auto switch leaves stale baseline.** If a user goes
   manual → auto, their old auto-era `baseline.json` entry resumes
   being used. They'd get credit for any solves they did during the
   manual stretch (because `current − oldBaseline` includes everything
   solved in between). Recommended: don't let users switch back to
   auto. If absolutely necessary, manually clear their `baseline.json`
   entry first.
5. **GitHub API needs `User-Agent` and `X-GitHub-Api-Version` headers**
   or it 403s. See `ghHeaders()` in
   [`api/join.js`](api/join.js).
6. **LeetCode GraphQL needs `User-Agent` and `Referer: https://leetcode.com`**
   or it 403s. See the `fetch` call in
   [`scripts/fetch.mjs`](scripts/fetch.mjs).
7. **Cleanup carelessness can wipe live state.** If you smoke-test by
   editing `public/config.json` and `public/data/*` locally, restore
   them before committing. `git checkout -- public/config.json
   public/data` is the safest reset. *Do not* run `rm -rf public/data
   && reset config to []` and forget to check `git status` before
   pushing.
8. **GitHub Actions cron drift.** Scheduled workflows can be delayed
   up to 15 minutes during peak load on GitHub. At daily cadence this
   is invisible; sub-hourly schedules will see it. Don't promise
   real-time anything.

## Common task recipes

### Add a new public-facing field to the config

1. Update [`public/config.json`](public/config.json) with the new field
   and a sensible default.
2. Update [`public/app.js`](public/app.js) to read it (add a fallback
   in case old configs don't have it; mid-flight schema upgrades are a
   reality).
3. Document it in [`README.md`](README.md) under "Tweaks".
4. If the field also needs to be respected by the snapshot script, edit
   [`scripts/fetch.mjs`](scripts/fetch.mjs) too.

### Add a new endpoint

1. Create `api/<name>.js`. Use plain JS, no TypeScript. Export a default
   `async function handler(req, res)`.
2. Always check `req.method`, validate the body, and use
   `constantTimeEqual` for any secret comparison.
3. Use the GitHub Contents API for any persistence. Read with `?ref=`
   plus `Accept: application/vnd.github+json`. Write with `PUT` and the
   sha you got from the read.
4. Same env vars as existing functions: `GH_TOKEN`, `GH_REPO`,
   `GH_BRANCH`, `INVITE_CODE`. Don't add new env vars unless you really
   need them; if you do, document them in
   [`README.md`](README.md) and warn the user they'll have to add them
   in Vercel before the next deploy.
5. Same-origin POST from the frontend, no CORS.

### Add a new field to snapshots

1. Edit [`scripts/fetch.mjs`](scripts/fetch.mjs) to write the field. Be
   careful that old snapshots in `public/data/snapshots/` won't have
   the field — your reader must tolerate its absence.
2. Edit `buildChart` / `pointsForUser` in
   [`public/app.js`](public/app.js) if it's needed for the score or
   chart.
3. Old snapshots are *not* rewritten. Use forward-compatible defaults.

### Change the cron schedule

Edit the `cron:` line in
[`.github/workflows/snapshot.yml`](.github/workflows/snapshot.yml).
Common options live in [`README.md`](README.md). Sub-hourly is a bad
idea (LeetCode rate-limits and the chart fills with noise).

### Change the score formula

Update **all four** places that compute scores or chart points:

1. `pointsForUser` in [`public/app.js`](public/app.js) (current
   leaderboard).
2. The data-mapping inside `buildChart` in
   [`public/app.js`](public/app.js) (chart history).
3. Any tooltip logic in
   [`public/app.js`](public/app.js) (legend, etc.).
4. Update the canonical formula in this file (the "Score math" section
   above) so future agents stay aligned.

The cron does *not* compute scores; it only stores raw counts. Don't
move score math into the cron — it would freeze old scores on the day
the snapshot was taken, breaking config-driven tweaks like changing
point weights mid-competition.

## Local development

There is no `vercel dev` requirement for most tasks. The fastest loop is:

```bash
# 1. Fetch real LeetCode data into public/data/
node scripts/fetch.mjs

# 2. Serve public/ on a local port
python3 -m http.server 4173 --bind 127.0.0.1 -d public

# 3. Open http://127.0.0.1:4173 and verify the changes
```

When testing changes to `api/*.js` you do need `vercel dev`, plus a
`.env.local` with the four env vars and a throwaway PAT scoped to a test
repo. Most changes can be reasoned about and reviewed without it.

If you use the Cursor browser MCP for visual smoke tests, prefer
`browser_reload` after data changes; the JS files are cached
aggressively by the browser even though our `fetchJson` uses
`cache: "no-store"` for JSON.

## Deployment

Push to `main`. That's it.

- Frontend changes (`public/*`) → Vercel rebuild → live in ~30s.
- Function changes (`api/*`) → same.
- Workflow changes (`.github/workflows/*`) → picked up on next run.
- `public/config.json` schema changes → live on next page load + next
  cron tick.

Env vars and Vercel project settings only need to be touched if you
add a new env var. Otherwise, no Vercel dashboard interaction needed.

## What's explicitly out of scope

Don't add these without first questioning whether they're worth the
complexity:

- True OAuth / per-user authentication.
- Per-problem detail (which exact problems were solved). Requires
  session cookies; not worth it for the score formula we use.
- Self-service *removal* of users. Manual edit + commit is safer.
- Per-problem point overrides (e.g. "this contest problem is worth 10").
- Real-time updates (websockets). Daily cron is the right cadence.
- A separate admin UI. Editing JSON or hitting GitHub directly is fine
  for a friend-group tool.
- Mobile app. The site is responsive.

## Open issues / known limitations

- **Concurrent writes can race.** The GitHub Contents API uses a `sha`
  for optimistic concurrency. If two friends submit `/api/join` within
  the same ~500 ms window, the second gets a 409. We don't retry.
  Acceptable today; if it becomes a real issue, wrap the read+write in
  a small retry loop with a fresh `sha`.
- **Pre-competition cron noise.** The cron still runs daily before
  `startDate`, which produces no-op-ish snapshots showing lifetime
  totals. The frontend filters those out, but the snapshot files
  themselves are mildly wasteful. Acceptable; not worth the complexity
  of a date check in the workflow.
- **Manual user honor system.** Anyone with the invite code can submit
  any numbers for any manual user. We accept this for the trust model.
- **Single invite code rotation.** Changing `INVITE_CODE` in Vercel
  works but takes effect only on next function cold start. For
  practical purposes, expect ~1 minute of stale code acceptance.

## When in doubt

1. Read [`README.md`](README.md) for user-facing context.
2. Read [`public/app.js`](public/app.js) (it's all in one file).
3. Read [`scripts/fetch.mjs`](scripts/fetch.mjs) — it's the second
   biggest file and the one most likely to surprise you (cron edge
   cases, baseline write-once semantics, manual-user inclusion).
4. Don't change invariants (the "Critical invariants" list above)
   without understanding why they exist.
5. If a change touches scoring or baselines, run a real
   `node scripts/fetch.mjs` against live LeetCode handles and walk the
   numbers by hand before committing. The "delta math" is easy to break
   by accident, and it's easy to spot-check by hand on three users.
