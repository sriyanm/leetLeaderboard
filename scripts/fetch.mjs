#!/usr/bin/env node
// Daily snapshot script. Reads public/config.json, queries LeetCode's public
// GraphQL endpoint for each user's solved counts, and writes:
//   public/data/latest.json           - most recent snapshot (overwritten)
//   public/data/snapshots/<date>.json - per-day snapshot (append-only)
//   public/data/baseline.json         - frozen counts at competition start
//   public/data/index.json            - list of snapshot dates
//   public/data/timeline.json         - combined per-day counts for the chart
//
// Users with `mode: "manual"` are skipped for the LeetCode fetch; their
// values come from public/data/manual.json (written by /api/update) and
// represent deltas during the competition rather than absolute totals.
//
// Run via `node scripts/fetch.mjs` or `npm run snapshot`.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CFG_PATH = path.join(ROOT, "public", "config.json");
const DATA_DIR = path.join(ROOT, "public", "data");
const SNAP_DIR = path.join(DATA_DIR, "snapshots");
const BASELINE_PATH = path.join(DATA_DIR, "baseline.json");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const INDEX_PATH = path.join(DATA_DIR, "index.json");
const TIMELINE_PATH = path.join(DATA_DIR, "timeline.json");
const MANUAL_PATH = path.join(DATA_DIR, "manual.json");

const GRAPHQL = "https://leetcode.com/graphql/";
const QUERY = `query getUserProfile($username: String!) {
  matchedUser(username: $username) {
    username
    submitStatsGlobal { acSubmissionNum { difficulty count } }
  }
}`;

async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(p, "utf-8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n");
}

async function fetchUserStats(username) {
  const r = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "leetleaderboard-cron/1.0 (+https://github.com)",
      "Referer": "https://leetcode.com",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables: { username } }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const matched = j?.data?.matchedUser;
  // LeetCode emits a GraphQL error alongside `matchedUser: null` for unknown
  // handles; treat that as a clean "not found" rather than a hard error.
  if (!matched) return null;
  if (j.errors) throw new Error(`GraphQL: ${JSON.stringify(j.errors)}`);
  const out = { easy: 0, medium: 0, hard: 0 };
  for (const e of matched.submitStatsGlobal?.acSubmissionNum || []) {
    if (e.difficulty === "Easy") out.easy = e.count;
    else if (e.difficulty === "Medium") out.medium = e.count;
    else if (e.difficulty === "Hard") out.hard = e.count;
  }
  return out;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const config = await readJson(CFG_PATH);
  if (!config) throw new Error(`missing ${path.relative(ROOT, CFG_PATH)}`);
  const users = Array.isArray(config.users) ? config.users : [];
  const today = todayUTC();
  const startDate = config.startDate;
  const competitionStarted = startDate && today >= startDate;

  if (users.length === 0) {
    console.log("no users in config; nothing to do");
    return;
  }

  const manualData = (await readJson(MANUAL_PATH)) || { users: {} };
  if (!manualData.users) manualData.users = {};

  const counts = {};
  const errors = {};
  const manualHandles = new Set();
  for (const u of users) {
    const handle = u.leetcode;
    if (!handle) continue;
    if (u.mode === "manual") {
      manualHandles.add(handle);
      const m = manualData.users[handle];
      if (m) {
        counts[handle] = { easy: m.easy | 0, medium: m.medium | 0, hard: m.hard | 0 };
        console.log(`  ${handle} (manual): E${m.easy} M${m.medium} H${m.hard}`);
      } else {
        console.log(`  ${handle} (manual): no submissions yet`);
      }
      continue;
    }
    try {
      const stats = await fetchUserStats(handle);
      if (stats) {
        counts[handle] = stats;
        console.log(`  ${handle}: E${stats.easy} M${stats.medium} H${stats.hard}`);
      } else {
        errors[handle] = "not_found";
        console.warn(`  ${handle}: not found on leetcode`);
      }
    } catch (e) {
      errors[handle] = String(e.message || e);
      console.warn(`  ${handle}: ${errors[handle]}`);
    }
    // Be polite to leetcode.com.
    await sleep(400);
  }

  const snapshot = {
    date: today,
    fetchedAt: new Date().toISOString(),
    counts,
    ...(manualHandles.size ? { manual: [...manualHandles] } : {}),
    ...(Object.keys(errors).length ? { errors } : {}),
  };

  await writeJson(LATEST_PATH, snapshot);
  await writeJson(path.join(SNAP_DIR, `${today}.json`), snapshot);

  // Update snapshot index and combined timeline (sorted ascending).
  let dates = [];
  try {
    const files = await fs.readdir(SNAP_DIR);
    dates = files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch {
    dates = [today];
  }
  await writeJson(INDEX_PATH, { dates });

  const timeline = [];
  for (const d of dates) {
    try {
      const snap = await readJson(path.join(SNAP_DIR, `${d}.json`));
      if (snap) {
        timeline.push({
          date: snap.date || d,
          counts: snap.counts || {},
          ...(Array.isArray(snap.manual) && snap.manual.length ? { manual: snap.manual } : {}),
        });
      }
    } catch {
      // ignore unreadable snapshots
    }
  }
  await writeJson(TIMELINE_PATH, { points: timeline });

  // Baseline: lock in counts on/after startDate. Each user gets their baseline
  // set on the first run where they appear in counts; later joiners get a
  // baseline equal to the snapshot when they first show up (so they start at
  // 0 points, not negative).
  if (competitionStarted) {
    const baseline = (await readJson(BASELINE_PATH)) || {
      startDate,
      users: {},
    };
    if (!baseline.users) baseline.users = {};
    if (!baseline.startDate) baseline.startDate = startDate;
    let changed = false;
    for (const u of users) {
      const handle = u.leetcode;
      if (!handle) continue;
      // Manual users don't use baseline; their submitted values are deltas.
      if (u.mode === "manual") continue;
      if (!counts[handle]) continue;
      if (baseline.users[handle]) continue;
      baseline.users[handle] = { ...counts[handle], setOn: today };
      changed = true;
      console.log(`  baseline set for ${handle}`);
    }
    if (changed) await writeJson(BASELINE_PATH, baseline);
  } else {
    console.log(`competition starts ${startDate} (today ${today}); skipping baseline`);
  }

  const ok = Object.keys(counts).length;
  console.log(`snapshot ${today}: ${ok}/${users.length} users`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
