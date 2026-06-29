// Клієнтська логіка панелі завуча VARTA

const $ = (id) => document.getElementById(id);

const PAGE_TITLES = {
  dashboard: "Dashboard",
  teachers: "Вчителі школи",
  students: "Учні школи",
  stats: "Статистика школи",
  competitions: "Конкурси школи",
  profile: "Профіль",
};

const COMP_STATUS = {
  draft: "Чернетка",
  published: "Опубліковано",
  archived: "В архіві",
};

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
  if (!s) return "—";
  return new Date(s).toLocaleDateString("uk-UA", { dateStyle: "medium" });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

let hasSchool = false;

// ---- Навігація --------------------------------------------------------------
const loaders = {
  dashboard: loadDashboard,
  teachers: loadTeachers,
  students: loadStudents,
  stats: loadStats,
  competitions: loadCompetitions,
  profile: loadProfile,
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

// ---- Завантаження інформації про школу / користувача ------------------------
async function loadMe() {
  const { user } = await getJSON("/api/me");
  $("userEmail").textContent = user.email;
  $("pEmail").value = user.email;
  $("pName").value = user.full_name || "";
  $("pPhone").value = user.phone || "";

  const info = await getJSON("/api/zavuch/me");
  hasSchool = !!info.school;
  if (info.school) {
    $("schoolName").textContent = `${info.school.name} · ${info.school.city_name}`;
    $("schoolPicker").classList.add("hidden");
  } else {
    $("schoolName").textContent = "Школу не обрано";
    renderSchoolPicker(info.freeSchools);
  }
}

function renderSchoolPicker(schools) {
  const sel = $("schoolSelect");
  sel.innerHTML = schools.length
    ? schools.map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.city_name)}, ${esc(s.region_name)}</option>`).join("")
    : `<option value="">Немає вільних шкіл — зверніться до адміністратора</option>`;
  $("schoolPicker").classList.remove("hidden");
}

$("schoolForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const school_id = $("schoolSelect").value;
  if (!school_id) return toast("err", "Немає доступних шкіл");
  const { ok, data } = await send("POST", "/api/zavuch/school", { school_id });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  await loadMe();
  switchPage("dashboard");
});

// ---- Dashboard --------------------------------------------------------------
async function loadDashboard() {
  const { stats } = await getJSON("/api/zavuch/stats");
  if (!stats) {
    $("statCards").innerHTML = `<div class="card"><div class="lbl">Оберіть школу, щоб побачити статистику</div></div>`;
    return;
  }
  const cards = [
    ["Вчителів", stats.teachers],
    ["Підтверджено", stats.confirmedTeachers],
    ["Очікують", stats.pendingTeachers],
    ["Учнів", stats.students],
    ["Конкурсів", stats.competitions],
    ["Заявок", stats.applications],
  ];
  $("statCards").innerHTML = cards
    .map(([lbl, num]) => `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`)
    .join("");
}

// ---- Вчителі школи ----------------------------------------------------------
async function loadTeachers() {
  const { teachers } = await getJSON("/api/zavuch/teachers");
  $("teachersBody").innerHTML = teachers.length
    ? teachers
        .map(
          (t) => `<tr>
            <td>${esc(t.full_name || "—")}</td>
            <td>${esc(t.email)}</td>
            <td>${esc(t.phone || "—")}</td>
            <td><span class="status ${t.confirmed ? "accepted" : "submitted"}">${t.confirmed ? "Підтверджено" : "Очікує"}</span></td>
            <td>
              <div class="actions">
                <button class="btn sm ${t.confirmed ? "ghost" : "ok"}" data-confirm="${t.id}" data-val="${t.confirmed ? 0 : 1}">${t.confirmed ? "Зняти" : "Підтвердити"}</button>
                <button class="btn sm danger" data-del-teacher="${t.id}">Видалити</button>
              </div>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Немає вчителів</td></tr>`;

  $("teachersBody").querySelectorAll("[data-confirm]").forEach((b) => {
    b.onclick = async () => {
      const { ok, data } = await send("PATCH", `/api/zavuch/teachers/${b.dataset.confirm}`, { confirmed: b.dataset.val === "1" });
      if (!ok) return toast("err", data.error || "Помилка");
      toast("ok", data.message);
      loadTeachers();
    };
  });
  $("teachersBody").querySelectorAll("[data-del-teacher]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Видалити вчителя зі школи?")) return;
      const { ok, data } = await send("DELETE", `/api/zavuch/teachers/${b.dataset.delTeacher}`);
      if (!ok) return toast("err", data.error || "Помилка");
      toast("ok", data.message);
      loadTeachers();
    };
  });
}

$("teacherForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("teacherEmail").value.trim();
  const { ok, data } = await send("POST", "/api/zavuch/teachers", { email });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  $("teacherForm").reset();
  loadTeachers();
});

// ---- Учні школи -------------------------------------------------------------
async function loadStudents() {
  const { students } = await getJSON("/api/zavuch/students");
  $("studentsBody").innerHTML = students.length
    ? students
        .map(
          (s) => `<tr>
            <td>${esc(s.full_name || "—")}</td>
            <td>${esc(s.email)}</td>
            <td>${esc(s.class || "—")}</td>
            <td>${s.applications}</td>
            <td>
              <div class="actions">
                <button class="btn sm danger" data-del-student="${s.id}">Видалити</button>
              </div>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Немає учнів</td></tr>`;

  $("studentsBody").querySelectorAll("[data-del-student]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Видалити учня зі школи?")) return;
      const { ok, data } = await send("DELETE", `/api/zavuch/students/${b.dataset.delStudent}`);
      if (!ok) return toast("err", data.error || "Помилка");
      toast("ok", data.message);
      loadStudents();
    };
  });
}

$("studentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("studentEmail").value.trim();
  const klass = $("studentClass").value.trim();
  const { ok, data } = await send("POST", "/api/zavuch/students", { email, class: klass });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  $("studentForm").reset();
  loadStudents();
});

// ---- Статистика школи -------------------------------------------------------
async function loadStats() {
  const { stats } = await getJSON("/api/zavuch/stats");
  if (!stats) {
    $("statsBars").innerHTML = `<p class="empty-list">Оберіть школу, щоб побачити статистику.</p>`;
    return;
  }
  const rows = [
    ["Вчителів усього", stats.teachers],
    ["Підтверджених вчителів", stats.confirmedTeachers],
    ["Очікують підтвердження", stats.pendingTeachers],
    ["Учнів", stats.students],
    ["Конкурсів", stats.competitions],
    ["Заявок учнів", stats.applications],
  ];
  const max = Math.max(1, ...rows.map(([, n]) => n));
  $("statsBars").innerHTML = rows
    .map(
      ([lbl, n]) => `<div class="role-bar">
        <span>${lbl}</span>
        <span class="track"><span class="fill" style="width:${(n / max) * 100}%"></span></span>
        <span>${n}</span>
      </div>`
    )
    .join("");
}

// ---- Конкурси школи ---------------------------------------------------------
async function loadCompetitions() {
  const { competitions } = await getJSON("/api/zavuch/competitions");
  $("competitionsBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td>${esc(c.title)}</td>
            <td><span class="status ${c.status}">${COMP_STATUS[c.status] || c.status}</span></td>
            <td>${c.applications}</td>
            <td>${c.accepted}</td>
            <td>${c.rejected}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Учні школи ще не подавали заявок</td></tr>`;
}

// ---- Профіль ----------------------------------------------------------------
async function loadProfile() {
  // Дані вже завантажені в loadMe(); за потреби оновлюємо
  const { user } = await getJSON("/api/me");
  $("pEmail").value = user.email;
  $("pName").value = user.full_name || "";
  $("pPhone").value = user.phone || "";
}

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("PUT", "/api/zavuch/profile", {
    full_name: $("pName").value.trim(),
    phone: $("pPhone").value.trim(),
  });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
});

// ---- Старт ------------------------------------------------------------------
(async function init() {
  await loadMe();
  switchPage("dashboard");
})();
