// Клієнтська логіка панелі учня VARTA

const $ = (id) => document.getElementById(id);

const PAGE_TITLES = {
  dashboard: "Dashboard",
  competitions: "Всі конкурси",
  submit: "Подати заявку",
  applications: "Мої заявки",
  results: "Результати",
  portfolio: "Портфоліо",
  achievements: "Досягнення",
  certificates: "Сертифікати",
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

// ---- Навігація --------------------------------------------------------------
const loaders = {
  dashboard: loadDashboard,
  competitions: loadCompetitions,
  submit: loadSubmit,
  applications: loadApplications,
  results: loadResults,
  portfolio: loadPortfolio,
  achievements: loadAchievements,
  certificates: loadCertificates,
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

// ---- Інформація про учня ----------------------------------------------------
async function loadMe() {
  const { user } = await getJSON("/api/me");
  $("userEmail").textContent = user.email;
  $("pEmail").value = user.email;
  $("pName").value = user.full_name || "";
  $("pPhone").value = user.phone || "";

  const info = await getJSON("/api/student/me");
  if (info.student && info.student.school_name) {
    const cls = info.student.class ? ` · ${info.student.class}` : "";
    $("schoolName").textContent = `${info.student.school_name}${cls}`;
  } else {
    $("schoolName").textContent = "Школу не призначено";
  }
}

// ---- Dashboard --------------------------------------------------------------
async function loadDashboard() {
  const { stats } = await getJSON("/api/student/stats");
  const cards = [
    ["Заявок", stats.applications],
    ["Прийнято", stats.accepted],
    ["Очікують", stats.pending],
    ["Середній бал", stats.avgScore],
    ["Досягнень", stats.achievements],
    ["Сертифікатів", stats.certificates],
  ];
  $("statCards").innerHTML = cards
    .map(([lbl, num]) => `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`)
    .join("");
}

// ---- Всі конкурси -----------------------------------------------------------
async function loadCompetitions() {
  const { competitions } = await getJSON("/api/student/competitions");
  $("competitionsBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td>${esc(c.title)}</td>
            <td>${fmtDate(c.starts_at)} — ${fmtDate(c.ends_at)}</td>
            <td>${c.sections}</td>
            <td>${c.applied ? '<span class="status accepted">Подано</span>' : "—"}</td>
            <td>${c.applied ? "" : `<button class="btn sm" data-apply="${c.id}">Подати заявку</button>`}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Немає опублікованих конкурсів</td></tr>`;

  $("competitionsBody").querySelectorAll("[data-apply]").forEach((b) => {
    b.onclick = async () => {
      switchPage("submit");
      setTimeout(() => {
        $("subCompetition").value = b.dataset.apply;
        $("subCompetition").dispatchEvent(new Event("change"));
      }, 60);
    };
  });
}

// ---- Подати заявку: Конкурс → Секція → Форма → Файли → Відправка -------------
async function loadSubmit() {
  const { competitions } = await getJSON("/api/student/competitions");
  const available = competitions.filter((c) => !c.applied);
  $("subCompetition").innerHTML = available.length
    ? available.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("")
    : `<option value="">Немає доступних конкурсів</option>`;
  resetFiles();
  await loadForm();
}

// Завантажує секції + динамічні поля форми конкурсу
async function loadForm() {
  const compId = $("subCompetition").value;
  if (!compId) {
    $("subSection").innerHTML = `<option value="">—</option>`;
    $("dynamicFields").innerHTML = "";
    return;
  }
  const { sections, fields } = await getJSON(`/api/student/competitions/${compId}/form`);
  $("subSection").innerHTML =
    `<option value="">Без секції</option>` +
    sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");

  // Динамічні поля форми (з налаштувань конкурсу)
  $("dynamicFields").innerHTML = Array.isArray(fields) && fields.length
    ? fields
        .map((f, i) => {
          const label = esc(f.label || f.name || `Поле ${i + 1}`);
          const key = esc(f.name || `field_${i}`);
          if (f.type === "textarea") {
            return `<label>${label}<textarea data-field="${key}" placeholder="${label}"></textarea></label>`;
          }
          return `<label>${label}<input type="text" data-field="${key}" placeholder="${label}" /></label>`;
        })
        .join("")
    : "";
}
$("subCompetition").addEventListener("change", loadForm);

// Файли
function resetFiles() {
  $("fileRows").innerHTML = "";
  addFileRow();
}
function addFileRow() {
  const row = document.createElement("div");
  row.className = "inline-form file-row";
  row.innerHTML = `
    <input type="url" class="file-url" placeholder="Посилання на файл" />
    <select class="file-type">
      <option value="document">Документ</option>
      <option value="presentation">Презентація</option>
      <option value="image">Зображення</option>
      <option value="archive">Архів</option>
      <option value="other">Інше</option>
    </select>
    <button type="button" class="btn sm danger remove-file">✕</button>`;
  row.querySelector(".remove-file").onclick = () => row.remove();
  $("fileRows").appendChild(row);
}
$("addFileBtn").onclick = addFileRow;

$("submitForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const competition_id = $("subCompetition").value;
  if (!competition_id) return toast("err", "Оберіть конкурс");

  // Збираємо динамічні поля форми
  const data_json = {};
  $("dynamicFields").querySelectorAll("[data-field]").forEach((el) => {
    data_json[el.dataset.field] = el.value.trim();
  });
  // Збираємо файли
  const files = [];
  $("fileRows").querySelectorAll(".file-row").forEach((row) => {
    const url = row.querySelector(".file-url").value.trim();
    if (url) files.push({ file_url: url, file_type: row.querySelector(".file-type").value });
  });

  const body = {
    competition_id,
    section_id: $("subSection").value || null,
    title: $("subTitle").value.trim(),
    data_json,
    files,
  };
  const { ok, data } = await send("POST", "/api/student/applications", body);
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  $("subTitle").value = "";
  resetFiles();
  loadSubmit();
});

// ---- Мої заявки -------------------------------------------------------------
async function loadApplications() {
  const { applications } = await getJSON("/api/student/applications");
  $("applicationsBody").innerHTML = applications.length
    ? applications
        .map(
          (a) => `<tr>
            <td>${esc(a.competition_title)}</td>
            <td>${esc(a.section_name || "—")}</td>
            <td>${esc(a.title || "—")}</td>
            <td>${a.files}</td>
            <td><span class="status ${a.status}">${APP_STATUS[a.status] || a.status}</span></td>
            <td>${fmtDate(a.created_at)}</td>
            <td>${a.status === "submitted" ? `<button class="btn sm danger" data-cancel="${a.id}">Скасувати</button>` : ""}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty">Ви ще не подавали заявок</td></tr>`;

  $("applicationsBody").querySelectorAll("[data-cancel]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Скасувати заявку?")) return;
      const { ok, data } = await send("DELETE", `/api/student/applications/${b.dataset.cancel}`);
      if (!ok) return toast("err", data.error || "Помилка");
      toast("ok", data.message);
      loadApplications();
    };
  });
}

// ---- Результати -------------------------------------------------------------
async function loadResults() {
  const { results } = await getJSON("/api/student/results");
  $("resultsBody").innerHTML = results.length
    ? results
        .map(
          (r) => `<tr>
            <td>${esc(r.competition_title)}</td>
            <td>${esc(r.section_name || "—")}</td>
            <td><span class="status ${r.status}">${APP_STATUS[r.status] || r.status}</span></td>
            <td>${r.score != null ? r.score : "—"}</td>
            <td>${esc(r.judge_name || "—")}</td>
            <td>${esc(r.comment || "—")}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">Поки що немає результатів</td></tr>`;
}

// ---- Портфоліо --------------------------------------------------------------
async function loadPortfolio() {
  const { items } = await getJSON("/api/student/portfolio");
  $("portfolioBody").innerHTML = items.length
    ? items
        .map(
          (it) => `<tr>
            <td>${esc(it.title)}</td>
            <td>${esc(it.description || "—")}</td>
            <td>${it.file_url ? `<a href="${esc(it.file_url)}" target="_blank" rel="noopener">Відкрити</a>` : "—"}</td>
            <td><button class="btn sm danger" data-del="${it.id}">Видалити</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Портфоліо порожнє</td></tr>`;

  $("portfolioBody").querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const { ok, data } = await send("DELETE", `/api/student/portfolio/${b.dataset.del}`);
      if (!ok) return toast("err", data.error || "Помилка");
      toast("ok", data.message);
      loadPortfolio();
    };
  });
}

$("portfolioForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("POST", "/api/student/portfolio", {
    title: $("pfTitle").value.trim(),
    description: $("pfDesc").value.trim(),
    file_url: $("pfUrl").value.trim(),
  });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  $("portfolioForm").reset();
  loadPortfolio();
});

// ---- Досягнення -------------------------------------------------------------
async function loadAchievements() {
  const { achievements } = await getJSON("/api/student/achievements");
  $("achievementsBody").innerHTML = achievements.length
    ? achievements
        .map(
          (a) => `<tr>
            <td>${esc(a.title)}</td>
            <td>${esc(a.description || "—")}</td>
            <td>${a.date ? fmtDate(a.date) : "—"}</td>
            <td><button class="btn sm danger" data-del="${a.id}">Видалити</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Досягнень ще немає</td></tr>`;

  $("achievementsBody").querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const { ok, data } = await send("DELETE", `/api/student/achievements/${b.dataset.del}`);
      if (!ok) return toast("err", data.error || "Помилка");
      toast("ok", data.message);
      loadAchievements();
    };
  });
}

$("achievementForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("POST", "/api/student/achievements", {
    title: $("acTitle").value.trim(),
    description: $("acDesc").value.trim(),
    date: $("acDate").value || null,
  });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  $("achievementForm").reset();
  loadAchievements();
});

// ---- Сертифікати ------------------------------------------------------------
async function loadCertificates() {
  const { certificates } = await getJSON("/api/student/certificates");
  $("certificatesBody").innerHTML = certificates.length
    ? certificates
        .map(
          (c) => `<tr>
            <td>${esc(c.name)}</td>
            <td>${c.file_url ? `<a href="${esc(c.file_url)}" target="_blank" rel="noopener">Відкрити</a>` : "—"}</td>
            <td>${c.issued_at ? fmtDate(c.issued_at) : "—"}</td>
            <td><button class="btn sm danger" data-del="${c.id}">Видалити</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Сертифікатів ще немає</td></tr>`;

  $("certificatesBody").querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const { ok, data } = await send("DELETE", `/api/student/certificates/${b.dataset.del}`);
      if (!ok) return toast("err", data.error || "Помилка");
      toast("ok", data.message);
      loadCertificates();
    };
  });
}

$("certificateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("POST", "/api/student/certificates", {
    name: $("ctName").value.trim(),
    file_url: $("ctUrl").value.trim(),
    issued_at: $("ctDate").value || null,
  });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  $("certificateForm").reset();
  loadCertificates();
});

// ---- Профіль ----------------------------------------------------------------
async function loadProfile() {
  const { user } = await getJSON("/api/me");
  $("pEmail").value = user.email;
  $("pName").value = user.full_name || "";
  $("pPhone").value = user.phone || "";
}

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("PUT", "/api/student/profile", {
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
