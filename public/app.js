/* Auto Job Apps dashboard */

const $ = (sel) => document.querySelector(sel);

let paused = false;

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

function showLogin() {
  $("#login").classList.remove("hidden");
  $("#app").classList.add("hidden");
}

function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

/* ---------- Login ---------- */

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

/* ---------- Stats ---------- */

async function loadStats() {
  const s = await api("/stats");
  paused = s.paused;
  $("#stat-today").textContent = s.appliedToday;
  $("#stat-cap").textContent = s.dailyCap;
  $("#stat-total").textContent = s.appliedTotal;
  $("#stat-queued").textContent = s.byStatus.queued ?? 0;
  $("#stat-review").textContent = s.byStatus.needs_review ?? 0;
  $("#today-bar").style.width =
    Math.min(100, (s.appliedToday / Math.max(1, s.dailyCap)) * 100) + "%";
  $("#pause-badge").classList.toggle("hidden", !s.paused);
  $("#pause-toggle").textContent = s.paused ? "Resume" : "Pause";

  if (s.lastRun) {
    const when = new Date(s.lastRun.started_at + "Z").toLocaleString();
    $("#stat-lastrun").textContent = `${when} · +${s.lastRun.applied} applied`;
  }

  renderChart(s.daily);
}

function renderChart(daily) {
  const chart = $("#chart");
  chart.innerHTML = "";
  if (!daily || daily.length === 0) {
    chart.innerHTML = '<span class="empty">No applications yet — the chart will fill in as the bot works.</span>';
    return;
  }
  const byDay = Object.fromEntries(daily.map((d) => [d.day, d.n]));
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ day: d, n: byDay[d] ?? 0 });
  }
  const max = Math.max(...days.map((d) => d.n), 1);
  for (const d of days) {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = Math.max(3, (d.n / max) * 100) + "%";
    if (d.n === 0) bar.style.opacity = "0.25";
    bar.dataset.tip = `${d.day}: ${d.n}`;
    chart.appendChild(bar);
  }
}

/* ---------- Applications table ---------- */

async function loadJobs() {
  const status = $("#status-filter").value;
  const q = $("#search").value.trim();
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  const { applications } = await api(`/applications?${params}`);

  const tbody = $("#jobs-body");
  tbody.innerHTML = "";
  for (const j of applications) {
    const tr = document.createElement("tr");
    const date = j.applied_at ?? j.discovered_at;
    const detail = j.skip_reason || j.error || "";
    tr.innerHTML = `
      <td>${esc(j.company ?? "—")}</td>
      <td><a href="${esc(j.apply_url || j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></td>
      <td>${esc(j.source)}</td>
      <td>${esc(j.ats ?? "—")}</td>
      <td><span class="pill ${esc(j.status)}">${esc(j.status.replace("_", " "))}</span></td>
      <td>${esc(date ? date.slice(0, 16) : "—")}</td>
      <td>
        ${detail ? `<span class="reason">${esc(detail)}</span>` : ""}
        ${j.screenshot_key ? `<a href="/api/screenshot/${esc(j.screenshot_key)}" target="_blank">screenshot</a>` : ""}
      </td>
      <td class="row-actions">
        ${j.status === "needs_review" || j.status === "failed"
          ? `<button data-act="requeue" data-id="${j.id}">Retry</button>
             <button data-act="dismiss" data-id="${j.id}">Dismiss</button>`
          : ""}
      </td>`;
    tbody.appendChild(tr);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

$("#jobs-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  await api(`/jobs/${btn.dataset.id}/${btn.dataset.act}`, { method: "POST" });
  void loadJobs();
  void loadStats();
});

let searchTimer;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadJobs(), 300);
});
$("#status-filter").addEventListener("change", () => void loadJobs());

/* ---------- Controls ---------- */

$("#pause-toggle").addEventListener("click", async () => {
  await api("/config", { method: "PUT", body: JSON.stringify({ paused: !paused }) });
  void loadStats();
});

$("#run-now").addEventListener("click", async () => {
  const btn = $("#run-now");
  btn.disabled = true;
  btn.textContent = "Running…";
  await api("/run", { method: "POST" });
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Run now";
    void refreshAll();
  }, 15000);
});

/* ---------- Settings ---------- */

async function loadConfig() {
  const cfg = await api("/config");
  $("#cfg-cap").value = cfg.dailyCap;
  $("#cfg-include").value = cfg.includeKeywords.join(", ");
  $("#cfg-exclude").value = cfg.excludeKeywords.join(", ");
}

$("#cfg-save").addEventListener("click", async () => {
  const parseList = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
  await api("/config", {
    method: "PUT",
    body: JSON.stringify({
      dailyCap: parseInt($("#cfg-cap").value, 10) || 15,
      includeKeywords: parseList($("#cfg-include").value),
      excludeKeywords: parseList($("#cfg-exclude").value),
    }),
  });
  $("#cfg-saved").classList.remove("hidden");
  setTimeout(() => $("#cfg-saved").classList.add("hidden"), 2000);
});

/* ---------- Boot ---------- */

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

setInterval(() => {
  if (!$("#app").classList.contains("hidden")) void loadStats();
}, 60000);
