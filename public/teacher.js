// Клієнтська логіка панелі вчителя VARTA

const $ = (id) => document.getElementById(id);

const PAGE_TITLES = {
  dashboard: "Dashboard",
  students: "Мої учні",
  competitions: "Всі конкурси",
  "my-competitions": "Мої конкурси",
  submit: "Подати учня",
  results: "Результати",
  analytics: "Аналітика",
  profile: "Профіль",
};

const COMP_STATUS = {
  draft: "Чернетка",
  published: "Опубліковано",
  archived: "В архіві",
};

const APP_STATUS = {
  submitted: "Очікує",
  accepted: "Прийнято",
  rejected: "Відхилено",
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

// Кеш учнів — використовуємо у формі подання
let myStudents = [];

// ---- Навігація --------------------------------------------------------------
const loaders = {
  dashboard: loadDashboard,
  students: loadStudents,
  competitions: loadCompetitions,
  "my-competitions": loadMyCompetitions,
  submit: loadSubmit,
  results: loadResults,
  analytics: loadAnalytics,
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

// ---- Інформація про вчителя / школу -----------------------------------------
async function loadMe() {
  const { user } = await getJSON("/api/me");
  $("userEmail").textContent = user.email;
  $("pEmail").value = user.email;
  $("pName").value = user.full_name || "";
  $("pPhone").value = user.phone || "";

  const info = await getJSON("/api/teacher/me");
  if (info.school) {
    $("schoolName").textContent = `${info.school.name} · ${info.school.city_name}`;
  } else {
    $("schoolName").textContent = "Школу не призначено";
  }
  // Банер "очікує підтвердження" для непідтверджених вчителів
  $("pendingBanner").classList.toggle("hidden", info.confirmed !== false);
}

// ---- Dashboard --------------------------------------------------------------
async function loadDashboard() {
  const { stats } = await getJSON("/api/teacher/stats");
  const cards = [
    ["Моїх учнів", stats.students],
    ["Заявок", stats.applications],
    ["Прийнято", stats.accepted],
    ["Відхилено", stats.rejected],
    ["Очікують", stats.pending],
    ["Середній бал", stats.avgScore],
  ];
  $("statCards").innerHTML = cards
    .map(([lbl, num]) => `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`)
    .join("");
}

// ---- Мої учні ---------------------------------------------------------------
async function loadStudents() {
  const { students } = await getJSON("/api/teacher/students");
  myStudents = students;
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
                <button class="btn sm danger" data-unlink="${s.id}">Відкріпити</button>
              </div>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">У вас ще немає учнів</td></tr>`;

  $("studentsBody").querySelectorAll("[data-unlink]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Відкріпити учня від себе?")) return;
      const { ok, data } = await send("DELETE", `/api/teacher/students/${b.dataset.unlink}`);
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
  const { ok, data } = await send("POST", "/api/teacher/students", { email, class: klass });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  $("studentForm").reset();
  loadStudents();
});

// ---- Всі конкурси -----------------------------------------------------------
async function loadCompetitions() {
  const { competitions } = await getJSON("/api/teacher/competitions");
  $("competitionsBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td>${esc(c.title)}</td>
            <td>${fmtDate(c.starts_at)} — ${fmtDate(c.ends_at)}</td>
            <td>${c.sections}</td>
            <td><button class="btn sm" data-apply="${c.id}">Подати учня</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Немає опублікованих конкурсів</td></tr>`;

  $("competitionsBody").querySelectorAll("[data-apply]").forEach((b) => {
    b.onclick = async () => {
      switchPage("submit");
      // Після завантаження форми обираємо конкурс
      setTimeout(() => {
        $("subCompetition").value = b.dataset.apply;
        $("subCompetition").dispatchEvent(new Event("change"));
      }, 50);
    };
  });
}

// ---- Мої конкурси -----------------------------------------------------------
async function loadMyCompetitions() {
  const { competitions } = await getJSON("/api/teacher/my-competitions");
  $("myCompetitionsBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td>${esc(c.title)}</td>
            <td><span class="status ${c.status}">${COMP_STATUS[c.status] || c.status}</span></td>
            <td>${c.applications}</td>
            <td>${c.accepted}</td>
            <td>${c.rejected}</td>
            <td>${c.pending}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">Ваші учні ще не подавали заявок</td></tr>`;
}

// ---- Подати учня ------------------------------------------------------------
async function loadSubmit() {
  const [{ competitions }, { students }] = await Promise.all([
    getJSON("/api/teacher/competitions"),
    getJSON("/api/teacher/students"),
  ]);
  myStudents = students;
  $("subCompetition").innerHTML = competitions.length
    ? competitions.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("")
    : `<option value="">Немає доступних конкурсів</option>`;
  $("subStudent").innerHTML = students.length
    ? students.map((s) => `<option value="${s.user_id}">${esc(s.full_name || s.email)}${s.class ? " — " + esc(s.class) : ""}</option>`).join("")
    : `<option value="">Спершу закріпіть учнів</option>`;
  await loadSections();
}

async function loadSections() {
  const compId = $("subCompetition").value;
  if (!compId) {
    $("subSection").innerHTML = `<option value="">—</option>`;
    return;
  }
  const { sections } = await getJSON(`/api/teacher/competitions/${compId}/sections`);
  $("subSection").innerHTML =
    `<option value="">Без секції</option>` +
    sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
}
$("subCompetition").addEventListener("change", loadSections);

$("submitForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    competition_id: $("subCompetition").value,
    section_id: $("subSection").value || null,
    student_id: $("subStudent").value,
    title: $("subTitle").value.trim(),
  };
  if (!body.competition_id || !body.student_id) return toast("err", "Оберіть конкурс і учня");
  const { ok, data } = await send("POST", "/api/teacher/applications", body);
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  $("subTitle").value = "";
});

// ---- Результати -------------------------------------------------------------
async function loadResults() {
  const { results } = await getJSON("/api/teacher/results");
  $("resultsBody").innerHTML = results.length
    ? results
        .map(
          (r) => `<tr>
            <td>${esc(r.student_name || r.student_email)}</td>
            <td>${esc(r.competition_title)}</td>
            <td>${esc(r.section_name || "—")}</td>
            <td><span class="status ${r.status}">${APP_STATUS[r.status] || r.status}</span></td>
            <td>${r.score != null ? r.score : "—"}</td>
            <td>${esc(r.judge_name || "—")}</td>
            <td>${esc(r.comment || "—")}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty">Поки що немає результатів</td></tr>`;
}

// ---- Аналітика --------------------------------------------------------------
async function loadAnalytics() {
  const { stats } = await getJSON("/api/teacher/stats");
  const rows = [
    ["Моїх учнів", stats.students],
    ["Подано заявок", stats.applications],
    ["Прийнято", stats.accepted],
    ["Відхилено", stats.rejected],
    ["Очікують розгляду", stats.pending],
    ["Оцінено", stats.scored],
  ];
  const max = Math.max(1, ...rows.map(([, n]) => n));
  $("analyticsBars").innerHTML =
    rows
      .map(
        ([lbl, n]) => `<div class="role-bar">
          <span>${lbl}</span>
          <span class="track"><span class="fill" style="width:${(n / max) * 100}%"></span></span>
          <span>${n}</span>
        </div>`
      )
      .join("") +
    `<div class="role-bar"><span>Середній бал</span><span class="track"><span class="fill" style="width:${(Number(stats.avgScore) / 100) * 100}%"></span></span><span>${stats.avgScore}</span></div>`;
}

// ---- Профіль ----------------------------------------------------------------
async function loadProfile() {
  const { user } = await getJSON("/api/me");
  $("pEmail").value = user.email;
  $("pName").value = user.full_name || "";
  $("pPhone").value = user.phone || "";
}

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("PUT", "/api/teacher/profile", {
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
