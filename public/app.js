/* Auto Job Apps — interval-based dashboard */

const $ = (sel) => document.querySelector(sel);
const INTERVAL_MIN = 10;

let paused = false;
let lastRunTime = null;

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  return res.json();
}

function showLogin() { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); }
function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); }

/* ── Login ── */
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: $("#passcode").value }),
  });
  if (res.ok) {
    $("#login-error").classList.add("hidden");
    showApp();
    void refreshAll();
  } else {
    $("#login-error").classList.remove("hidden");
  }
});

/* ── Stats & Timeline ── */
async function loadStats() {
  const s = await api("/stats");
  paused = s.paused;
  $("#stat-today").textContent = s.appliedToday;
  $("#stat-cap").textContent = s.dailyCap;
  $("#stat-total").textContent = s.appliedTotal;
  $("#stat-review").textContent = s.byStatus.needs_review ?? 0;
  $("#today-bar").style.width = Math.min(100, (s.appliedToday / Math.max(1, s.dailyCap)) * 100) + "%";
  $("#pause-badge").classList.toggle("hidden", !s.paused);
  $("#pause-toggle").textContent = s.paused ? "Resume" : "Pause";

  if (s.lastRun) {
    lastRunTime = new Date(s.lastRun.started_at + "Z");
    const when = lastRunTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("#stat-lastrun").textContent = when;
    const result = s.lastRun.applied > 0
      ? `✓ ${s.lastRun.applied} applied`
      : s.lastRun.skipped > 0
        ? `${s.lastRun.skipped} skipped`
        : s.lastRun.failed > 0 ? "failed" : "idle";
    $("#stat-lastresult").textContent = result;
  }

  renderTimeline(s);
  updateNextRun();
}

function updateNextRun() {
  if (!lastRunTime) { $("#stat-nextrun").textContent = "—"; return; }
  const next = new Date(lastRunTime.getTime() + INTERVAL_MIN * 60 * 1000);
  const now = new Date();
  const diff = next - now;

  if (diff <= 0) {
    $("#stat-nextrun").textContent = "Due now";
    $("#stat-nextcountdown").textContent = "waiting for cron…";
  } else {
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    $("#stat-nextrun").textContent = next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("#stat-nextcountdown").textContent = `in ${mins}m ${secs}s`;
  }
}

function renderTimeline(s) {
  const timeline = $("#timeline");
  timeline.innerHTML = "";

  // Build map of hour:30-slot results from today's runs
  const runs = s.recentRuns || [];
  const slotMap = {};
  for (const r of runs) {
    const d = new Date(r.started_at + "Z");
    const slot = `${String(d.getHours()).padStart(2, "0")}:${String(Math.floor(d.getMinutes() / 30) * 30).padStart(2, "0")}`;
    const status = r.applied > 0 ? "applied" : r.skipped > 0 ? "skipped" : r.failed > 0 ? "failed" : "needs_review";
    const tip = r.applied > 0
      ? `✓ Applied` : r.skipped > 0 ? `${r.skipped} skipped` : r.failed > 0 ? `Failed` : "Ran";
    slotMap[slot] = { status, tip, time: d };
  }

  // Show slots from 6am to 10pm (32 slots at 30-min intervals)
  const now = new Date();
  const currentSlot = `${String(now.getHours()).padStart(2, "0")}:${String(Math.floor(now.getMinutes() / 30) * 30).padStart(2, "0")}`;

  for (let h = 6; h < 22; h++) {
    for (let m of [0, 30]) {
      const key = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const slot = document.createElement("div");
      slot.className = "interval-slot";

      if (slotMap[key]) {
        slot.classList.add(slotMap[key].status);
        slot.dataset.tip = `${key} — ${slotMap[key].tip}`;
      } else if (key < currentSlot) {
        slot.dataset.tip = `${key} — idle`;
      } else if (key === currentSlot) {
        slot.classList.add("now");
        slot.dataset.tip = `${key} — current interval`;
      } else {
        slot.classList.add("upcoming");
        slot.dataset.tip = `${key} — upcoming`;
      }
      timeline.appendChild(slot);
    }
  }
}

/* ── Activity table ── */
async function loadJobs() {
  const { applications } = await api("/applications?limit=15");
  const tbody = $("#jobs-body");
  tbody.innerHTML = "";

  for (const j of applications) {
    const tr = document.createElement("tr");
    const date = j.applied_at ?? j.discovered_at;
    const time = date ? new Date(date + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
    const detail = j.skip_reason || j.error || "";
    const statusClass = j.status === "applied" ? "applied"
      : j.status === "skipped" || j.status === "needs_review" ? "needs_review"
      : j.status === "failed" ? "failed" : "queued";

    tr.innerHTML = `
      <td>${esc(time)}</td>
      <td>${esc(j.company ?? "—")}</td>
      <td>${esc(j.title)}</td>
      <td><span class="pill ${esc(statusClass)}">${esc(j.status.replace("_", " "))}</span></td>
      <td>
        ${detail ? `<span class="reason">${esc(detail)}</span>` : ""}
        ${j.screenshot_key ? `<a href="/api/screenshot/${esc(j.screenshot_key)}" target="_blank" class="shot-link">screenshot</a>` : ""}
      </td>`;
    tbody.appendChild(tr);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/* ── Queue Board ── */
async function loadQueueBoard() {
  try {
    const { jobs } = await api("/queue-board");
    $("#queue-count").textContent = `${jobs.length} jobs`;
    const tbody = $("#queue-body");
    tbody.innerHTML = "";
    for (const j of jobs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(j.company ?? "—")}</td>
        <td>${esc(j.title)}</td>
        <td>${esc(j.source)}</td>
        <td>${esc(j.ats ?? "—")}</td>
        <td>${esc(j.location ?? "—")}</td>`;
      tbody.appendChild(tr);
    }
  } catch { /* skip if endpoint fails */ }
}

/* ── Watchlist ── */
async function loadWatchlist() {
  try {
    const { watchlist } = await api("/watchlist");
    const grid = $("#watchlist-grid");
    grid.innerHTML = "";
    let total = 0;
    for (const [ats, companies] of Object.entries(watchlist)) {
      const label = document.createElement("div");
      label.className = "watchlist-ats-label";
      label.textContent = `${ats} (${companies.length})`;
      grid.appendChild(label);
      for (const c of companies) {
        const tag = document.createElement("span");
        tag.className = `watchlist-tag ${ats}`;
        tag.textContent = c.slug;
        grid.appendChild(tag);
        total++;
      }
    }
    $("#watchlist-stats").textContent = `${total} companies across ${Object.keys(watchlist).length} ATS platforms`;
  } catch { /* skip if endpoint fails */ }
}

/* ── Controls ── */
$("#pause-toggle").addEventListener("click", async () => {
  await api("/config", { method: "PUT", body: JSON.stringify({ paused: !paused }) });
  void loadStats();
});

/* ── Settings ── */
async function loadConfig() {
  const cfg = await api("/config");
  $("#cfg-cap").value = cfg.dailyCap;
  $("#cfg-terms").value = cfg.searchTerms.join(", ");
  $("#cfg-include").value = cfg.includeKeywords.join(", ");
  $("#cfg-exclude").value = cfg.excludeKeywords.join(", ");
}

$("#cfg-save").addEventListener("click", async () => {
  const parseList = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
  await api("/config", {
    method: "PUT",
    body: JSON.stringify({
      dailyCap: parseInt($("#cfg-cap").value, 10) || 15,
      searchTerms: parseList($("#cfg-terms").value),
      includeKeywords: parseList($("#cfg-include").value),
      excludeKeywords: parseList($("#cfg-exclude").value),
    }),
  });
  $("#cfg-saved").classList.remove("hidden");
  setTimeout(() => $("#cfg-saved").classList.add("hidden"), 2000);
  void loadStats();
});

/* ── Boot ── */
async function refreshAll() {
  await Promise.all([loadStats(), loadJobs(), loadConfig()]);
}

(async () => {
  try {
    await loadStats();
    showApp();
    await Promise.all([loadJobs(), loadConfig()]);
  } catch {
    /* 401 -> login shown */
  }
})();

// Refresh stats every 30s for countdown accuracy
setInterval(() => {
  if (!$("#app").classList.contains("hidden")) {
    updateNextRun();
    void loadStats();
  }
}, 30000);
