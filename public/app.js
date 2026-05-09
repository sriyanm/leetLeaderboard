// Frontend for the LeetCode Friends Leaderboard.
// Loads /config.json, /data/baseline.json, /data/latest.json, /data/timeline.json
// and renders a sorted leaderboard, a points-over-time chart, a competition
// countdown, and a join form that POSTs to /api/join.

const $ = (sel) => document.querySelector(sel);

const ERROR_MESSAGES = {
  invalid_name: "Please enter your name.",
  invalid_handle: "LeetCode usernames can only contain letters, numbers, _ and -.",
  invalid_invite: "Please enter the invite code your friends shared.",
  bad_invite: "That invite code is not correct.",
  handle_not_found: "We could not find that LeetCode username.",
  leetcode_unavailable: "LeetCode validation failed; please try again in a minute.",
  github_read_failed: "Could not read the leaderboard config; please try again.",
  github_write_failed: "Could not save your entry; please try again.",
  server_misconfigured: "The leaderboard isn't fully set up yet. Tell the admin.",
  invalid_body: "Bad request.",
  invalid_json: "Bad request.",
  method_not_allowed: "Bad request.",
};

async function fetchJson(path, fallback = null) {
  try {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) return fallback;
    return await r.json();
  } catch {
    return fallback;
  }
}

// ----- score math -----

function pointsForUser(handle, baseline, latest, weights) {
  const b = baseline?.users?.[handle];
  const c = latest?.counts?.[handle];
  if (!c) return null;
  const ref = b || { easy: 0, medium: 0, hard: 0 };
  const dE = Math.max(0, (c.easy   ?? 0) - (ref.easy   ?? 0));
  const dM = Math.max(0, (c.medium ?? 0) - (ref.medium ?? 0));
  const dH = Math.max(0, (c.hard   ?? 0) - (ref.hard   ?? 0));
  return {
    delta: { easy: dE, medium: dM, hard: dH },
    points: dE * weights.easy + dM * weights.medium + dH * weights.hard,
    hasBaseline: !!b,
  };
}

function rankRows(users, baseline, latest, weights) {
  const rows = [];
  for (const u of users) {
    const score = pointsForUser(u.leetcode, baseline, latest, weights);
    rows.push({
      name: u.name,
      handle: u.leetcode,
      delta: score?.delta || { easy: 0, medium: 0, hard: 0 },
      points: score?.points || 0,
      hasBaseline: score?.hasBaseline || false,
      hasData: !!score,
    });
  }
  rows.sort((a, b) =>
    b.points - a.points ||
    b.delta.hard - a.delta.hard ||
    b.delta.medium - a.delta.medium ||
    b.delta.easy - a.delta.easy ||
    a.name.localeCompare(b.name)
  );
  return rows;
}

// ----- rendering -----

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") e.className = v;
    else if (k === "html")  e.innerHTML = v;
    else if (v != null)     e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function renderHeader(config) {
  const title = config.title || "LeetCode Friends Leaderboard";
  $("#title").textContent = title;
  document.title = title;
  const fmt = (d) =>
    new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
    });
  if (config.startDate && config.endDate) {
    $("#window").textContent = `${fmt(config.startDate)}  →  ${fmt(config.endDate)}`;
  }
  const w = config.points || { easy: 1, medium: 3, hard: 5 };
  $("#legend").innerHTML =
    `<span class="dot" style="background:var(--easy)"></span>Easy = ${w.easy} pt` +
    `<span class="dot" style="background:var(--medium)"></span>Medium = ${w.medium} pts` +
    `<span class="dot" style="background:var(--hard)"></span>Hard = ${w.hard} pts`;
}

function renderStatus(config) {
  const today = new Date().toISOString().slice(0, 10);
  const pill = $("#status-pill");
  pill.hidden = false;
  if (today < config.startDate)      { pill.textContent = "Upcoming"; pill.className = "pill upcoming"; }
  else if (today > config.endDate)   { pill.textContent = "Ended";    pill.className = "pill ended"; }
  else                                { pill.textContent = "Live";     pill.className = "pill live"; }
}

function renderCountdown(config) {
  const cd = $("#countdown");
  if (!config.endDate) return;
  const target = new Date(config.endDate + "T23:59:59Z").getTime();
  const startMs = new Date((config.startDate || "1970-01-01") + "T00:00:00Z").getTime();
  cd.hidden = false;
  const tick = () => {
    const now = Date.now();
    const upcoming = now < startMs;
    const goal = upcoming ? startMs : target;
    const ms = Math.max(0, goal - now);
    const days  = Math.floor(ms / 86400000);
    const hours = Math.floor((ms / 3600000) % 24);
    const mins  = Math.floor((ms / 60000) % 60);
    const secs  = Math.floor((ms / 1000) % 60);
    $("#cd-days").textContent  = String(days).padStart(2, "0");
    $("#cd-hours").textContent = String(hours).padStart(2, "0");
    $("#cd-mins").textContent  = String(mins).padStart(2, "0");
    $("#cd-secs").textContent  = String(secs).padStart(2, "0");
  };
  tick();
  setInterval(tick, 1000);
}

function deltaCell(n, kind) {
  const cls = n > 0 ? `delta-${kind}` : "delta-zero";
  const sign = n > 0 ? "+" : "";
  return el("td", { className: `num ${cls}` }, `${sign}${n}`);
}

function renderBoard(rows, latest) {
  const tbody = $("#board-body");
  tbody.innerHTML = "";
  if (rows.length === 0) {
    tbody.appendChild(el("tr", { className: "empty" },
      el("td", { colspan: "6" }, "No one has joined yet. Be the first!")));
    return;
  }
  rows.forEach((r, i) => {
    const rank = i + 1;
    const tr = el("tr", { className: rank <= 3 ? `medal-${rank}` : "" });
    tr.appendChild(el("td", { className: "rank" }, String(rank)));

    const player = el("div", { className: "player" });
    player.appendChild(el("div", { className: "name" }, r.name));
    const handleA = el("a", { href: `https://leetcode.com/${r.handle}/`, target: "_blank", rel: "noopener" }, "@" + r.handle);
    player.appendChild(el("div", { className: "handle" }, handleA));
    tr.appendChild(el("td", {}, player));

    tr.appendChild(deltaCell(r.delta.easy,   "easy"));
    tr.appendChild(deltaCell(r.delta.medium, "medium"));
    tr.appendChild(deltaCell(r.delta.hard,   "hard"));
    tr.appendChild(el("td", { className: "num total" }, r.points.toFixed(0)));
    tbody.appendChild(tr);
  });

  if (latest?.fetchedAt) {
    const when = new Date(latest.fetchedAt).toLocaleString();
    $("#updated").textContent = `Updated ${when}`;
  }
}

// ----- chart -----

const CHART_COLORS = [
  "#ffa116", "#00b8a3", "#5b8def", "#ef4743", "#b06ab3",
  "#26d0a0", "#ff7d6b", "#a4c8ff", "#ffd86b", "#9aa0a6",
];

function buildChart(config, baseline, timeline, users) {
  const canvas = $("#chart");
  const wrap = $("#chart-wrap");
  const empty = $("#chart-empty");
  const w = config.points || { easy: 1, medium: 3, hard: 5 };
  const points = timeline?.points || [];

  if (points.length < 2) {
    empty.hidden = false;
    canvas.style.display = "none";
    return;
  }

  const labels = points.map((p) => p.date);
  const datasets = users
    .map((u, i) => {
      const base = baseline?.users?.[u.leetcode];
      const data = points.map((p) => {
        const c = p.counts?.[u.leetcode];
        if (!c) return null;
        const ref = base || { easy: 0, medium: 0, hard: 0 };
        const dE = Math.max(0, (c.easy   ?? 0) - (ref.easy   ?? 0));
        const dM = Math.max(0, (c.medium ?? 0) - (ref.medium ?? 0));
        const dH = Math.max(0, (c.hard   ?? 0) - (ref.hard   ?? 0));
        return dE * w.easy + dM * w.medium + dH * w.hard;
      });
      return {
        label: u.name,
        data,
        borderColor: CHART_COLORS[i % CHART_COLORS.length],
        backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + "22",
        spanGaps: true,
        tension: 0.25,
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
      };
    })
    .filter((d) => d.data.some((v) => v != null));

  if (datasets.length === 0) {
    empty.hidden = false;
    canvas.style.display = "none";
    return;
  }

  // eslint-disable-next-line no-undef
  new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { labels: { color: "#c8d0dc", boxWidth: 12, boxHeight: 12 } },
        tooltip: { backgroundColor: "#11141b", borderColor: "#232a3a", borderWidth: 1 },
      },
      scales: {
        x: {
          ticks: { color: "#8892a6", maxTicksLimit: 8 },
          grid:  { color: "rgba(255,255,255,0.04)" },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#8892a6", precision: 0 },
          grid:  { color: "rgba(255,255,255,0.04)" },
        },
      },
    },
  });
}

// ----- join form -----

function setMsg(text, kind) {
  const el = $("#f-msg");
  el.textContent = text || "";
  el.className = "form-msg" + (kind ? " " + kind : "");
}

function bindJoin(onJoined) {
  const form = $("#join-form");
  const btn = $("#f-submit");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#f-name").value.trim();
    const leetcode = $("#f-handle").value.trim();
    const inviteCode = $("#f-invite").value;
    if (!name || !leetcode || !inviteCode) {
      setMsg("Please fill in all three fields.", "err");
      return;
    }
    btn.disabled = true;
    setMsg("Validating with LeetCode…", "");
    try {
      const r = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, leetcode, inviteCode }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setMsg(ERROR_MESSAGES[j.error] || `Could not join (${r.status}).`, "err");
        return;
      }
      if (j.alreadyJoined) {
        setMsg(`@${leetcode} is already on the leaderboard.`, "ok");
      } else {
        setMsg(`Joined as @${leetcode}. Your stats will appear after the next daily snapshot.`, "ok");
        $("#f-name").value = "";
        $("#f-handle").value = "";
      }
      onJoined?.();
    } catch (err) {
      setMsg("Network error; please try again.", "err");
    } finally {
      btn.disabled = false;
    }
  });
}

// ----- main -----

async function load() {
  const [config, baseline, latest, timeline] = await Promise.all([
    fetchJson("/config.json"),
    fetchJson("/data/baseline.json"),
    fetchJson("/data/latest.json"),
    fetchJson("/data/timeline.json"),
  ]);

  if (!config) {
    $("#board-body").innerHTML =
      '<tr class="empty"><td colspan="6">Could not load configuration.</td></tr>';
    return;
  }

  renderHeader(config);
  renderStatus(config);
  renderCountdown(config);

  const users = Array.isArray(config.users) ? config.users : [];
  const weights = config.points || { easy: 1, medium: 3, hard: 5 };
  const rows = rankRows(users, baseline, latest, weights);
  renderBoard(rows, latest);
  buildChart(config, baseline, timeline, users);
}

bindJoin(() => {
  // The newly joined user won't appear until the next cron tick fetches
  // their first stats, but the message already explains that.
});
load();
