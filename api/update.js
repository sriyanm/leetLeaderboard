// Vercel Function: POST /api/update
//
// Body: { leetcode: string, easy: int, medium: int, hard: int, inviteCode: string }
//
// Lets a user in `mode: "manual"` self-report their problem-solving progress
// during the competition. Values are *deltas during the competition* (not
// absolute LeetCode totals), so users sharing a LeetCode account can still
// participate honestly.
//
// Required env vars (set in Vercel dashboard, same as /api/join):
//   GH_TOKEN     fine-grained PAT scoped to the repo, Contents: read & write
//   GH_REPO      "owner/repo"
//   GH_BRANCH    branch to commit to, defaults to "main"
//   INVITE_CODE  shared secret friends paste into the form

const GH_API = "https://api.github.com";
const CONFIG_PATH = "public/config.json";
const MANUAL_PATH = "public/data/manual.json";

const HANDLE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const COUNT_MAX = 10000;
const INVITE_MIN = 4;
const INVITE_MAX = 200;

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function bad(res, status, error) {
  return res.status(status).json({ ok: false, error });
}

function isValidCount(n) {
  return Number.isInteger(n) && n >= 0 && n <= COUNT_MAX;
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "leetleaderboard-update",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function readFile({ repo, branch, token, filePath }) {
  const url = `${GH_API}/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, { headers: ghHeaders(token) });
  if (r.status === 404) return { json: null, sha: null };
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`github get ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  const content = Buffer.from(j.content, "base64").toString("utf-8");
  return { json: JSON.parse(content), sha: j.sha };
}

async function writeFile({ repo, branch, token, filePath, value, sha, message }) {
  const url = `${GH_API}/repos/${repo}/contents/${filePath}`;
  const content = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf-8").toString("base64");
  const body = { message, content, branch };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`github put ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return bad(res, 405, "method_not_allowed");
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return bad(res, 400, "invalid_json"); }
  }
  if (!body || typeof body !== "object") return bad(res, 400, "invalid_body");

  const { leetcode, inviteCode } = body;
  const easy = Number(body.easy);
  const medium = Number(body.medium);
  const hard = Number(body.hard);

  if (typeof leetcode !== "string" || !HANDLE_RE.test(leetcode)) {
    return bad(res, 400, "invalid_handle");
  }
  if (!isValidCount(easy) || !isValidCount(medium) || !isValidCount(hard)) {
    return bad(res, 400, "invalid_counts");
  }
  if (
    typeof inviteCode !== "string" ||
    inviteCode.length < INVITE_MIN ||
    inviteCode.length > INVITE_MAX
  ) {
    return bad(res, 400, "invalid_invite");
  }

  const expectedInvite = process.env.INVITE_CODE;
  const ghToken = process.env.GH_TOKEN;
  const ghRepo = process.env.GH_REPO;
  const ghBranch = process.env.GH_BRANCH || "main";
  if (!expectedInvite || !ghToken || !ghRepo) {
    return bad(res, 500, "server_misconfigured");
  }

  if (!constantTimeEqual(inviteCode, expectedInvite)) {
    return bad(res, 403, "bad_invite");
  }

  // Confirm the user exists in config.json with mode=manual.
  let config;
  try {
    ({ json: config } = await readFile({
      repo: ghRepo, branch: ghBranch, token: ghToken, filePath: CONFIG_PATH,
    }));
  } catch (e) {
    console.error("github config read failed:", e);
    return bad(res, 502, "github_read_failed");
  }
  if (!config || !Array.isArray(config.users)) return bad(res, 500, "config_invalid");
  const lower = leetcode.toLowerCase();
  const user = config.users.find((u) => String(u.leetcode || "").toLowerCase() === lower);
  if (!user) return bad(res, 400, "not_joined");
  if (user.mode !== "manual") return bad(res, 400, "not_manual_mode");

  // Read current manual.json (404 means "doesn't exist yet, create new").
  let manual, manualSha;
  try {
    const r = await readFile({
      repo: ghRepo, branch: ghBranch, token: ghToken, filePath: MANUAL_PATH,
    });
    manual = r.json;
    manualSha = r.sha;
  } catch (e) {
    console.error("github manual.json read failed:", e);
    return bad(res, 502, "github_read_failed");
  }
  if (!manual || typeof manual !== "object") manual = { users: {} };
  if (!manual.users) manual.users = {};

  manual.users[user.leetcode] = {
    easy, medium, hard,
    updatedAt: new Date().toISOString(),
  };

  try {
    await writeFile({
      repo: ghRepo, branch: ghBranch, token: ghToken,
      filePath: MANUAL_PATH,
      value: manual,
      sha: manualSha,
      message: `update: ${user.leetcode} (${easy}E/${medium}M/${hard}H)`,
    });
  } catch (e) {
    console.error("github manual.json write failed:", e);
    return bad(res, 502, "github_write_failed");
  }

  return res.status(200).json({
    ok: true,
    user: { name: user.name, leetcode: user.leetcode },
    counts: { easy, medium, hard },
  });
}
