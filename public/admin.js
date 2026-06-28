// Клієнтська логіка адмін-панелі VARTA

const $ = (id) => document.getElementById(id);

const ROLE_LABELS = {
  guest: "Гість",
  admin: "Адмін",
  methodist: "Методист",
  zavuch: "Завуч",
  teacher: "Вчитель",
  student: "Учень",
  jury: "Журі",
  system: "Система",
};
const STATUS_LABELS = { active: "Активний", pending: "Очікує", blocked: "Заблокований" };
const REQ_STATUS_LABELS = { pending: "Очікує", approved: "Схвалено", rejected: "Відхилено" };
const PAGE_TITLES = {
  dashboard: "Dashboard",
  regions: "Управління областями",
  cities: "Управління містами",
  schools: "Управління школами",
  users: "Управління користувачами",
  requests: "Запити на підтвердження ролей",
  settings: "Налаштування системи",
  logs: "Логи системи",
};

const ROLES = Object.keys(ROLE_LABELS);

// ---- HTTP-хелпери -----------------------------------------------------------
async function getJSON(url) {
  const res = await fetch(url);
  if (res.status === 401 || res.status === 403) {
    window.location.href = "/";
    throw new Error("unauthorized");
  }
  return res.json();
}
async function send(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

function toast(type, text) {
  const t = $("toast");
  t.className = `toast show ${type}`;
  t.textContent = text;
  setTimeout(() => (t.className = "toast"), 2800);
}

function fmtDate(s) {
  return new Date(s).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- Навігація --------------------------------------------------------------
const loaders = {
  dashboard: loadDashboard,
  regions: loadRegions,
  cities: loadCities,
  schools: loadSchools,
  users: loadUsers,
  requests: loadRequests,
  settings: loadSettings,
  logs: loadLogs,
};

function switchPage(page) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  document.querySelectorAll(".page").forEach((s) => s.classList.toggle("hidden", s.dataset.page !== page));
  $("pageTitle").textContent = PAGE_TITLES[page];
  loaders[page]?.();
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.onclick = () => switchPage(btn.dataset.page);
});

$("logoutBtn").onclick = async () => {
  await send("POST", "/api/logout", {});
  window.location.href = "/";
};

// ---- Dashboard --------------------------------------------------------------
async function loadDashboard() {
  const { stats, byRole } = await getJSON("/api/admin/stats");
  const cards = [
    ["Користувачів", stats.users],
    ["Гостей", stats.guests],
    ["Областей", stats.regions],
    ["Міст", stats.cities],
    ["Шкіл", stats.schools],
    ["Запитів на ролі", stats.pendingRequests],
  ];
  $("statCards").innerHTML = cards
    .map(([lbl, num]) => `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`)
    .join("");

  const max = Math.max(1, ...byRole.map((r) => r.c));
  $("roleBreakdown").innerHTML = byRole
    .map(
      (r) => `<div class="role-bar">
        <span>${ROLE_LABELS[r.role] || r.role}</span>
        <span class="track"><span class="fill" style="width:${(r.c / max) * 100}%"></span></span>
        <span>${r.c}</span></div>`
    )
    .join("");
}

// ---- Області ----------------------------------------------------------------
async function loadRegions() {
  const { regions } = await getJSON("/api/admin/regions");
  $("regionsBody").innerHTML = regions.length
    ? regions
        .map(
          (r) => `<tr><td>${esc(r.name)}</td><td>${r.cities_count}</td>
          <td class="actions"><button class="btn sm danger" data-del-region="${r.id}">Видалити</button></td></tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="empty">Областей ще немає</td></tr>`;
}
$("regionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("POST", "/api/admin/regions", { name: $("regionName").value.trim() });
  if (!ok) return toast("err", data.error || "Помилка");
  $("regionForm").reset();
  toast("ok", "Область додано");
  loadRegions();
});
$("regionsBody").addEventListener("click", async (e) => {
  const id = e.target.getAttribute("data-del-region");
  if (!id) return;
  if (!confirm("Видалити область разом з її містами та школами?")) return;
  const { ok, data } = await send("DELETE", `/api/admin/regions/${id}`);
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Видалено");
  loadRegions();
});

// ---- Міста ------------------------------------------------------------------
async function loadCities() {
  const [{ cities }, { regions }] = await Promise.all([
    getJSON("/api/admin/cities"),
    getJSON("/api/admin/regions"),
  ]);
  $("cityRegion").innerHTML =
    `<option value="" disabled selected>Оберіть область</option>` +
    regions.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  $("citiesBody").innerHTML = cities.length
    ? cities
        .map(
          (c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.region_name)}</td><td>${c.schools_count}</td>
          <td class="actions"><button class="btn sm danger" data-del-city="${c.id}">Видалити</button></td></tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Міст ще немає</td></tr>`;
}
$("cityForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("POST", "/api/admin/cities", {
    name: $("cityName").value.trim(),
    region_id: $("cityRegion").value,
  });
  if (!ok) return toast("err", data.error || "Помилка");
  $("cityName").value = "";
  toast("ok", "Місто додано");
  loadCities();
});
$("citiesBody").addEventListener("click", async (e) => {
  const id = e.target.getAttribute("data-del-city");
  if (!id) return;
  if (!confirm("Видалити місто разом зі школами?")) return;
  const { ok, data } = await send("DELETE", `/api/admin/cities/${id}`);
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Видалено");
  loadCities();
});

// ---- Школи ------------------------------------------------------------------
async function loadSchools() {
  const [{ schools }, { cities }] = await Promise.all([
    getJSON("/api/admin/schools"),
    getJSON("/api/admin/cities"),
  ]);
  $("schoolCity").innerHTML =
    `<option value="" disabled selected>Оберіть місто</option>` +
    cities.map((c) => `<option value="${c.id}">${esc(c.name)} (${esc(c.region_name)})</option>`).join("");
  $("schoolsBody").innerHTML = schools.length
    ? schools
        .map(
          (s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.city_name)}</td><td>${esc(s.region_name)}</td>
          <td>${esc(s.address || "—")}</td>
          <td class="actions"><button class="btn sm danger" data-del-school="${s.id}">Видалити</button></td></tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Шкіл ще немає</td></tr>`;
}
$("schoolForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("POST", "/api/admin/schools", {
    name: $("schoolName").value.trim(),
    city_id: $("schoolCity").value,
    address: $("schoolAddress").value.trim(),
  });
  if (!ok) return toast("err", data.error || "Помилка");
  $("schoolName").value = "";
  $("schoolAddress").value = "";
  toast("ok", "Школу додано");
  loadSchools();
});
$("schoolsBody").addEventListener("click", async (e) => {
  const id = e.target.getAttribute("data-del-school");
  if (!id) return;
  if (!confirm("Видалити школу?")) return;
  const { ok, data } = await send("DELETE", `/api/admin/schools/${id}`);
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Видалено");
  loadSchools();
});

// ---- Користувачі ------------------------------------------------------------
async function loadUsers() {
  const { users } = await getJSON("/api/admin/users");
  $("usersBody").innerHTML = users.length
    ? users
        .map((u) => {
          const roleOpts = ROLES.map(
            (r) => `<option value="${r}" ${r === u.role ? "selected" : ""}>${ROLE_LABELS[r]}</option>`
          ).join("");
          const statusOpts = ["active", "pending", "blocked"]
            .map((s) => `<option value="${s}" ${s === u.status ? "selected" : ""}>${STATUS_LABELS[s]}</option>`)
            .join("");
          return `<tr>
            <td>${esc(u.email)}</td>
            <td>${esc(u.full_name || "—")}</td>
            <td><select data-role-user="${u.id}">${roleOpts}</select></td>
            <td><select data-status-user="${u.id}">${statusOpts}</select></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="4" class="empty">Користувачів немає</td></tr>`;
}
$("usersBody").addEventListener("change", async (e) => {
  const roleId = e.target.getAttribute("data-role-user");
  const statusId = e.target.getAttribute("data-status-user");
  if (roleId) {
    const { ok, data } = await send("PATCH", `/api/admin/users/${roleId}/role`, { role: e.target.value });
    toast(ok ? "ok" : "err", ok ? "Роль оновлено" : data.error || "Помилка");
  } else if (statusId) {
    const { ok, data } = await send("PATCH", `/api/admin/users/${statusId}/status`, { status: e.target.value });
    toast(ok ? "ok" : "err", ok ? "Статус оновлено" : data.error || "Помилка");
  }
}); 

// ---- Запити на ролі ---------------------------------------------------------
async function loadRequests() {
  const { requests } = await getJSON("/api/admin/role-requests");
  $("requestsBody").innerHTML = requests.length
    ? requests
        .map((r) => {
          const actions =
            r.status === "pending"
              ? `<div class="actions">
                   <button class="btn sm ok" data-approve="${r.id}">Схвалити</button>
                   <button class="btn sm danger" data-reject="${r.id}">Відхилити</button></div>`
              : "—";
          return `<tr>
            <td>${esc(r.full_name || r.email)}<br><small>${esc(r.email)}</small></td>
            <td>${ROLE_LABELS[r.role] || r.role}</td>
            <td><span class="status ${r.status}">${REQ_STATUS_LABELS[r.status] || r.status}</span></td>
            <td>${fmtDate(r.created_at)}</td>
            <td>${actions}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="empty">Запитів немає</td></tr>`;
}
$("requestsBody").addEventListener("click", async (e) => {
  const approve = e.target.getAttribute("data-approve");
  const reject = e.target.getAttribute("data-reject");
  const id = approve || reject;
  if (!id) return;
  const decision = approve ? "approved" : "rejected";
  const { ok, data } = await send("PATCH", `/api/admin/role-requests/${id}`, { decision });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Рішення збережено");
  loadRequests();
}); 

// ---- Налаштування -----------------------------------------------------------
async function loadSettings() {
  const { settings } = await getJSON("/api/admin/settings");
  $("settingsBody").innerHTML = settings.length
    ? settings
        .map((s) => `<tr><td>${esc(s.key)}</td><td>${esc(s.value || "—")}</td><td>${fmtDate(s.updated_at)}</td></tr>`)
        .join("")
    : `<tr><td colspan="3" class="empty">Налаштувань ще немає</td></tr>`;
}
$("settingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("PUT", "/api/admin/settings", {
    key: $("settingKey").value.trim(),
    value: $("settingValue").value,
  });
  if (!ok) return toast("err", data.error || "Помилка");
  $("settingForm").reset();
  toast("ok", "Збережено");
  loadSettings();
});

// ---- Логи -------------------------------------------------------------------
async function loadLogs() {
  const { logs } = await getJSON("/api/admin/logs");
  $("logsBody").innerHTML = logs.length
    ? logs
        .map(
          (l) => `<tr><td>${fmtDate(l.created_at)}</td><td>${esc(l.action)}</td>
          <td>${esc(l.details || "—")}</td><td>${esc(l.actor || "система")}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Логів ще немає</td></tr>`;
}

// ---- Старт ------------------------------------------------------------------
(async function init() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) return (window.location.href = "/");
    const { user } = await res.json();
    if (user.role !== "admin" && user.role !== "system") return (window.location.href = "/");
    $("adminEmail").textContent = user.email;
    switchPage("dashboard");
  } catch {
    window.location.href = "/";
  }
})();
