// Vercel Function: POST /api/join
//
// Body: { name: string, leetcode: string, inviteCode: string, mode?: "auto"|"manual" }
//
// `mode` defaults to "auto" (cron auto-fetches their stats from LeetCode).
// `mode: "manual"` opts the user out of the auto-fetch; they self-report
// progress via /api/update. Useful for users who share their LeetCode
// account with someone else.
//
// Re-joining with the same handle is allowed and updates name + mode (the
// invite code is the only auth gate, same as adding a brand-new user).
//
// Required env vars (set in Vercel dashboard):
//   GH_TOKEN     fine-grained PAT scoped to the repo, Contents: read & write
//   GH_REPO      "owner/repo"
//   GH_BRANCH    branch to commit to, defaults to "main"
//   INVITE_CODE  shared secret friends paste into the join form

const GH_API = "https://api.github.com";
const LC_GRAPHQL = "https://leetcode.com/graphql/";
const CONFIG_PATH = "public/config.json";

const HANDLE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const NAME_MAX = 50;
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

async function leetcodeUserExists(handle) {
  const r = await fetch(LC_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "leetleaderboard-join/1.0",
      "Referer": "https://leetcode.com",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      query:
        "query getUserProfile($username: String!) { matchedUser(username: $username) { username } }",
      variables: { username: handle },
    }),
  });
  if (!r.ok) throw new Error(`leetcode http ${r.status}`);
  const j = await r.json();
  return j?.data?.matchedUser != null;
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "leetleaderboard-join",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function readConfig({ repo, branch, token }) {
  const url = `${GH_API}/repos/${repo}/contents/${encodeURIComponent(
    CONFIG_PATH
  ).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, { headers: ghHeaders(token) });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`github get ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  const content = Buffer.from(j.content, "base64").toString("utf-8");
  return { config: JSON.parse(content), sha: j.sha };
}

async function writeConfig({ repo, branch, token, config, sha, message }) {
  const url = `${GH_API}/repos/${repo}/contents/${encodeURIComponent(
    CONFIG_PATH
  ).replace(/%2F/g, "/")}`;
  const content = Buffer.from(
    JSON.stringify(config, null, 2) + "\n",
    "utf-8"
  ).toString("base64");
  const r = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content, sha, branch }),
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

  // Vercel auto-parses JSON bodies when Content-Type is application/json. Fall
  // back to manual parse for safety (e.g. if a client sets text/plain).
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return bad(res, 400, "invalid_json");
    }
  }
  if (!body || typeof body !== "object") return bad(res, 400, "invalid_body");

  const { name, leetcode, inviteCode } = body;
  const mode = body.mode === "manual" ? "manual" : "auto";

  if (typeof name !== "string" || name.trim().length === 0 || name.length > NAME_MAX) {
    return bad(res, 400, "invalid_name");
  }
  if (typeof leetcode !== "string" || !HANDLE_RE.test(leetcode)) {
    return bad(res, 400, "invalid_handle");
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

  let exists = false;
  try {
    exists = await leetcodeUserExists(leetcode);
  } catch (e) {
    console.error("leetcode validation failed:", e);
    return bad(res, 502, "leetcode_unavailable");
  }
  if (!exists) return bad(res, 400, "handle_not_found");

  let config, sha;
  try {
    ({ config, sha } = await readConfig({ repo: ghRepo, branch: ghBranch, token: ghToken }));
  } catch (e) {
    console.error("github read failed:", e);
    return bad(res, 502, "github_read_failed");
  }

  if (!Array.isArray(config.users)) config.users = [];
  const lower = leetcode.toLowerCase();
  const trimmedName = name.trim();
  const existingIdx = config.users.findIndex(
    (u) => String(u.leetcode || "").toLowerCase() === lower
  );
  let action;
  if (existingIdx >= 0) {
    const existing = config.users[existingIdx];
    const existingMode = existing.mode === "manual" ? "manual" : "auto";
    const sameName = (existing.name || "") === trimmedName;
    if (existingMode === mode && sameName) {
      return res.status(200).json({
        ok: true,
        alreadyJoined: true,
        user: { name: trimmedName, leetcode, mode },
      });
    }
    const updated = { name: trimmedName, leetcode };
    if (mode === "manual") updated.mode = "manual";
    config.users[existingIdx] = updated;
    action = `update: ${leetcode} -> ${mode}`;
  } else {
    const newUser = { name: trimmedName, leetcode };
    if (mode === "manual") newUser.mode = "manual";
    config.users.push(newUser);
    action = `join: ${leetcode}${mode === "manual" ? " (manual)" : ""}`;
  }

  try {
    await writeConfig({
      repo: ghRepo,
      branch: ghBranch,
      token: ghToken,
      config,
      sha,
      message: action,
    });
  } catch (e) {
    console.error("github write failed:", e);
    return bad(res, 502, "github_write_failed");
  }

  return res.status(200).json({
    ok: true,
    user: { name: trimmedName, leetcode, mode },
    updated: existingIdx >= 0,
  });
}
