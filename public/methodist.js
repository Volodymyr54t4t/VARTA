// Клієнтська логіка панелі методиста VARTA

const $ = (id) => document.getElementById(id);

const STATUS_LABELS = {
  draft: "Чернетка",
  published: "Опубліковано",
  archived: "В архіві",
  submitted: "Подано",
  accepted: "Прийнято",
  rejected: "Відхилено",
};
const FIELD_TYPE_LABELS = {
  text: "Текст",
  textarea: "Багаторядковий",
  number: "Число",
  date: "Дата",
  file: "Файл",
};
const JUDGE_ROLE_LABELS = { judge: "Суддя", head: "Голова журі" };
const PAGE_TITLES = {
  dashboard: "Dashboard",
  competitions: "Всі конкурси",
  create: "Створити конкурс",
  templates: "Шаблони конкурсів",
  applications: "Заявки",
  results: "Результати",
  analytics: "Аналітика",
  jury: "Панель журі",
  rules: "Положення",
  archive: "Архів",
  profile: "Профіль",
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
  return new Date(s).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- Навігація --------------------------------------------------------------
const loaders = {
  dashboard: loadDashboard,
  competitions: loadCompetitions,
  create: () => {},
  templates: loadTemplates,
  applications: loadApplications,
  results: loadResults,
  analytics: loadAnalytics,
  jury: loadJury,
  rules: loadRulesPage,
  archive: loadArchive,
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

// ---- Dashboard --------------------------------------------------------------
async function loadDashboard() {
  const { stats } = await getJSON("/api/methodist/stats");
  const cards = [
    ["Усього конкурсів", stats.total],
    ["Опубліковано", stats.published],
    ["Чернеток", stats.drafts],
    ["В архіві", stats.archived],
    ["Заявок", stats.applications],
    ["Призначень журі", stats.judges],
  ];
  $("statCards").innerHTML = cards
    .map(([lbl, num]) => `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`)
    .join("");
}

// ---- Всі конкурси -----------------------------------------------------------
async function loadCompetitions() {
  const { competitions } = await getJSON("/api/methodist/competitions");
  $("competitionsBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td><strong>${esc(c.title)}</strong></td>
            <td><span class="status ${c.status}">${STATUS_LABELS[c.status] || c.status}</span></td>
            <td>${c.sections_count}</td>
            <td>${c.judges_count}</td>
            <td>${c.applications_count}</td>
            <td class="actions">
              <button class="btn sm" data-open="${c.id}">Налаштувати</button>
              <button class="btn sm danger" data-del-comp="${c.id}">Видалити</button>
            </td></tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">Конкурсів ще немає. Створіть перший на вкладці «Створити конкурс».</td></tr>`;
}
$("competitionsBody").addEventListener("click", async (e) => {
  const openId = e.target.getAttribute("data-open");
  const delId = e.target.getAttribute("data-del-comp");
  if (openId) return openModal(openId, "sections");
  if (delId) {
    if (!confirm("Видалити конкурс разом з усіма секціями, заявками та результатами?")) return;
    const { ok, data } = await send("DELETE", `/api/methodist/competitions/${delId}`);
    if (!ok) return toast("err", data.error || "Помилка");
    toast("ok", "Конкурс видалено");
    loadCompetitions();
  }
});

// ---- Створити конкурс -------------------------------------------------------
$("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { ok, data } = await send("POST", "/api/methodist/competitions", {
    title: $("cTitle").value.trim(),
    description: $("cDesc").value.trim(),
    starts_at: $("cStart").value || null,
    ends_at: $("cEnd").value || null,
  });
  if (!ok) return toast("err", data.error || "Помилка");
  $("createForm").reset();
  toast("ok", "Конкурс створено");
  switchPage("competitions");
  openModal(data.competition.id, "sections");
});

// ---- Шаблони ----------------------------------------------------------------
async function loadTemplates() {
  const { templates } = await getJSON("/api/methodist/templates");
  $("templatesBody").innerHTML = templates.length
    ? templates
        .map(
          (t) => `<tr>
            <td><strong>${esc(t.name)}</strong></td>
            <td>${esc(t.author || "—")}</td>
            <td>${fmtDate(t.created_at)}</td>
            <td class="actions">
              <button class="btn sm ok" data-use-tpl="${t.id}">Створити конкурс</button>
              <button class="btn sm danger" data-del-tpl="${t.id}">Видалити</button>
            </td></tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Шаблонів ще немає</td></tr>`;
}
$("templateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  let data_json = $("tData").value.trim() || "{}";
  const { ok, data } = await send("POST", "/api/methodist/templates", {
    name: $("tName").value.trim(),
    data_json,
  });
  if (!ok) return toast("err", data.error || "Помилка");
  $("templateForm").reset();
  toast("ok", "Шаблон збережено");
  loadTemplates();
});
$("templatesBody").addEventListener("click", async (e) => {
  const useId = e.target.getAttribute("data-use-tpl");
  const delId = e.target.getAttribute("data-del-tpl");
  if (useId) {
    const { ok, data } = await send("POST", `/api/methodist/templates/${useId}/use`, {});
    if (!ok) return toast("err", data.error || "Помилка");
    toast("ok", "Конкурс створено із шаблону");
    switchPage("competitions");
    openModal(data.competition.id, "sections");
  } else if (delId) {
    if (!confirm("Видалити шаблон?")) return;
    const { ok, data } = await send("DELETE", `/api/methodist/templates/${delId}`);
    if (!ok) return toast("err", data.error || "Помилка");
    toast("ok", "Шаблон видалено");
    loadTemplates();
  }
});

// ---- Заявки -----------------------------------------------------------------
async function loadApplications() {
  const { applications } = await getJSON("/api/methodist/applications");
  $("applicationsBody").innerHTML = applications.length
    ? applications
        .map((a) => {
          const opts = ["submitted", "accepted", "rejected"]
            .map((s) => `<option value="${s}" ${s === a.status ? "selected" : ""}>${STATUS_LABELS[s]}</option>`)
            .join("");
          return `<tr>
            <td>${esc(a.title || "Заявка #" + a.id)}</td>
            <td>${esc(a.competition_title)}</td>
            <td>${esc(a.section_name || "—")}</td>
            <td>${esc(a.student_name || a.student_email || "—")}</td>
            <td>${a.files_count}</td>
            <td><select data-app-status="${a.id}">${opts}</select></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="empty">Заявок ще немає</td></tr>`;
}
$("applicationsBody").addEventListener("change", async (e) => {
  const id = e.target.getAttribute("data-app-status");
  if (!id) return;
  const { ok, data } = await send("PATCH", `/api/methodist/applications/${id}`, { status: e.target.value });
  toast(ok ? "ok" : "err", ok ? "Статус оновлено" : data.error || "Помилка");
});

// ---- Результати -------------------------------------------------------------
async function loadResults() {
  const { results } = await getJSON("/api/methodist/results");
  $("resultsBody").innerHTML = results.length
    ? results
        .map(
          (r) => `<tr>
            <td>${esc(r.competition_title)}</td>
            <td>${esc(r.application_title || "Заявка #" + r.application_id)}</td>
            <td>${esc(r.student_name || "—")}</td>
            <td>${esc(r.judge_name || r.judge_email || "—")}</td>
            <td><strong>${r.score ?? "—"}</strong></td>
            <td>${esc(r.comment || "—")}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">Результатів ще немає</td></tr>`;
}

// ---- Аналітика --------------------------------------------------------------
function renderBars(containerId, rows, labelKey, valueKey, labelMap) {
  const max = Math.max(1, ...rows.map((r) => r[valueKey]));
  $(containerId).innerHTML = rows.length
    ? rows
        .map((r) => {
          const label = labelMap ? labelMap[r[labelKey]] || r[labelKey] : r[labelKey];
          return `<div class="role-bar">
            <span>${esc(label)}</span>
            <span class="track"><span class="fill" style="width:${(r[valueKey] / max) * 100}%"></span></span>
            <span>${r[valueKey]}</span></div>`;
        })
        .join("")
    : `<div class="empty-list">Немає даних</div>`;
}
async function loadAnalytics() {
  const { byStatus, appsByComp, appsByStatus } = await getJSON("/api/methodist/analytics");
  renderBars("analyticsStatus", byStatus, "status", "c", STATUS_LABELS);
  renderBars("analyticsApps", appsByComp, "title", "applications");
  renderBars("analyticsAppStatus", appsByStatus, "status", "c", STATUS_LABELS);
}

// ---- Панель журі ------------------------------------------------------------
async function loadJury() {
  const { competitions } = await getJSON("/api/methodist/competitions");
  $("juryBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td><strong>${esc(c.title)}</strong></td>
            <td><span class="status ${c.status}">${STATUS_LABELS[c.status] || c.status}</span></td>
            <td>${c.judges_count}</td>
            <td class="actions"><button class="btn sm" data-jury-open="${c.id}">Призначити журі</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Конкурсів ще немає</td></tr>`;
}
$("juryBody").addEventListener("click", (e) => {
  const id = e.target.getAttribute("data-jury-open");
  if (id) openModal(id, "judges");
});

// ---- Положення (сторінка) ---------------------------------------------------
async function loadRulesPage() {
  const { competitions } = await getJSON("/api/methodist/competitions");
  $("rulesBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td><strong>${esc(c.title)}</strong></td>
            <td><span class="status ${c.status}">${STATUS_LABELS[c.status] || c.status}</span></td>
            <td class="actions"><button class="btn sm" data-rules-open="${c.id}">Редагувати положення</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="empty">Конкурсів ще немає</td></tr>`;
}
$("rulesBody").addEventListener("click", (e) => {
  const id = e.target.getAttribute("data-rules-open");
  if (id) openModal(id, "rules");
});

// ---- Архів ------------------------------------------------------------------
async function loadArchive() {
  const { competitions } = await getJSON("/api/methodist/competitions?archived=1");
  $("archiveBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td><strong>${esc(c.title)}</strong></td>
            <td>${c.applications_count}</td>
            <td>${fmtDate(c.created_at)}</td>
            <td class="actions"><button class="btn sm ghost" data-restore="${c.id}">Відновити</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Архів порожній</td></tr>`;
}
$("archiveBody").addEventListener("click", async (e) => {
  const id = e.target.getAttribute("data-restore");
  if (!id) return;
  const { ok, data } = await send("POST", `/api/methodist/competitions/${id}/restore`, {});
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Конкурс відновлено");
  loadArchive();
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
  const { ok, data } = await send("PUT", "/api/methodist/profile", {
    full_name: $("pName").value.trim(),
    phone: $("pPhone").value.trim(),
  });
  toast(ok ? "ok" : "err", ok ? "Профіль збережено" : data.error || "Помилка");
});

// ============================================================================
//  МОДАЛЬНЕ ВІКНО НАЛАШТУВАННЯ КОНКУРСУ
// ============================================================================
let current = null; // { competition, sections, form, rules, judges }
let fieldsState = []; // поточні поля форми, що редагуються

async function openModal(id, tab = "sections") {
  const data = await getJSON(`/api/methodist/competitions/${id}`);
  current = data;
  fieldsState = Array.isArray(data.form.fields_json) ? [...data.form.fields_json] : [];
  $("modalTitle").textContent = data.competition.title;
  const st = data.competition.status;
  $("modalStatus").className = `status ${st}`;
  $("modalStatus").textContent = STATUS_LABELS[st] || st;
  // Положення
  $("rulesContent").value = data.rules.content || "";
  $("rulesFile").value = data.rules.file_url || "";
  // Кнопка публікації
  $("publishBtn").classList.toggle("hidden", st === "published");
  renderSections();
  renderFields();
  renderJudges();
  await loadJudgeOptions();
  switchTab(tab);
  $("modal").classList.remove("hidden");
}
function closeModal() {
  $("modal").classList.add("hidden");
  current = null;
}
$("modalClose").onclick = closeModal;
$("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});

function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.tab !== tab));
}
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => switchTab(t.dataset.tab);
});

// ---- Секції (в модалі) ------------------------------------------------------
function renderSections() {
  const list = current.sections;
  $("sectionsList").innerHTML = list.length
    ? list
        .map(
          (s) => `<li>
            <span><strong>${esc(s.name)}</strong>${s.description ? `<span class="meta"> — ${esc(s.description)}</span>` : ""}</span>
            <button class="btn sm danger" data-del-section="${s.id}">Видалити</button>
          </li>`
        )
        .join("")
    : `<div class="empty-list">Секцій ще немає</div>`;
}
$("sectionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!current) return;
  const { ok, data } = await send("POST", `/api/methodist/competitions/${current.competition.id}/sections`, {
    name: $("sectionName").value.trim(),
    description: $("sectionDesc").value.trim(),
  });
  if (!ok) return toast("err", data.error || "Помилка");
  current.sections.push(data.section);
  $("sectionForm").reset();
  renderSections();
  toast("ok", "Секцію додано");
});
$("sectionsList").addEventListener("click", async (e) => {
  const id = e.target.getAttribute("data-del-section");
  if (!id) return;
  const { ok, data } = await send("DELETE", `/api/methodist/sections/${id}`);
  if (!ok) return toast("err", data.error || "Помилка");
  current.sections = current.sections.filter((s) => String(s.id) !== id);
  renderSections();
  toast("ok", "Секцію видалено");
});

// ---- Форма (в модалі) -------------------------------------------------------
function renderFields() {
  $("fieldsList").innerHTML = fieldsState.length
    ? fieldsState
        .map(
          (f, i) => `<li>
            <span><strong>${esc(f.label)}</strong>
              <span class="tag">${FIELD_TYPE_LABELS[f.type] || f.type}</span>
              ${f.required ? '<span class="tag">обов\'язкове</span>' : ""}</span>
            <button class="btn sm danger" data-del-field="${i}">Видалити</button>
          </li>`
        )
        .join("")
    : `<div class="empty-list">Полів ще немає</div>`;
}
$("fieldForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const label = $("fieldLabel").value.trim();
  if (!label) return;
  fieldsState.push({ label, type: $("fieldType").value, required: $("fieldRequired").checked });
  $("fieldForm").reset();
  renderFields();
});
$("fieldsList").addEventListener("click", (e) => {
  const i = e.target.getAttribute("data-del-field");
  if (i === null) return;
  fieldsState.splice(Number(i), 1);
  renderFields();
});
$("saveFormBtn").onclick = async () => {
  if (!current) return;
  const { ok, data } = await send("PUT", `/api/methodist/competitions/${current.competition.id}/form`, {
    fields_json: fieldsState,
  });
  if (!ok) return toast("err", data.error || "Помилка");
  current.form = data.form;
  toast("ok", "Форму збережено");
};

// ---- Положення (в модалі) ---------------------------------------------------
$("rulesForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!current) return;
  const { ok, data } = await send("PUT", `/api/methodist/competitions/${current.competition.id}/rules`, {
    content: $("rulesContent").value,
    file_url: $("rulesFile").value.trim(),
  });
  if (!ok) return toast("err", data.error || "Помилка");
  current.rules = data.rules;
  toast("ok", "Положення збережено");
});

// ---- Журі (в модалі) --------------------------------------------------------
async function loadJudgeOptions() {
  const { judges } = await getJSON("/api/methodist/judges");
  const assigned = new Set(current.judges.map((j) => j.user_id));
  const available = judges.filter((j) => !assigned.has(j.id));
  $("judgeUser").innerHTML = available.length
    ? `<option value="" disabled selected>Оберіть суддю</option>` +
      available.map((j) => `<option value="${j.id}">${esc(j.full_name || j.email)}</option>`).join("")
    : `<option value="" disabled selected>Немає доступних суддів (роль «Журі»)</option>`;
}
function renderJudges() {
  $("judgesList").innerHTML = current.judges.length
    ? current.judges
        .map(
          (j) => `<li>
            <span><strong>${esc(j.full_name || j.email)}</strong>
              <span class="tag">${JUDGE_ROLE_LABELS[j.role] || j.role}</span></span>
            <button class="btn sm danger" data-del-judge="${j.id}">Зняти</button>
          </li>`
        )
        .join("")
    : `<div class="empty-list">Суддів ще не призначено</div>`;
}
$("judgeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!current || !$("judgeUser").value) return;
  const { ok, data } = await send("POST", `/api/methodist/competitions/${current.competition.id}/judges`, {
    user_id: $("judgeUser").value,
    role: $("judgeRole").value,
  });
  if (!ok) return toast("err", data.error || "Помилка");
  current.judges.push(data.judge);
  // Підтягуємо ім'я для відображення
  const opt = $("judgeUser").selectedOptions[0];
  current.judges[current.judges.length - 1].full_name = opt ? opt.textContent : null;
  renderJudges();
  await loadJudgeOptions();
  toast("ok", "Суддю призначено");
});
$("judgesList").addEventListener("click", async (e) => {
  const id = e.target.getAttribute("data-del-judge");
  if (!id) return;
  const { ok, data } = await send("DELETE", `/api/methodist/judges/${id}`);
  if (!ok) return toast("err", data.error || "Помилка");
  current.judges = current.judges.filter((j) => String(j.id) !== id);
  renderJudges();
  await loadJudgeOptions();
  toast("ok", "Суддю знято");
});

// ---- Публікація / Архів -----------------------------------------------------
$("publishBtn").onclick = async () => {
  if (!current) return;
  const { ok, data } = await send("POST", `/api/methodist/competitions/${current.competition.id}/publish`, {});
  if (!ok) return toast("err", data.error || "Помилка");
  current.competition = data.competition;
  $("modalStatus").className = "status published";
  $("modalStatus").textContent = STATUS_LABELS.published;
  $("publishBtn").classList.add("hidden");
  toast("ok", "Конкурс опубліковано");
  refreshCurrentPage();
};
$("archiveBtn").onclick = async () => {
  if (!current) return;
  if (!confirm("Перемістити конкурс в архів?")) return;
  const { ok, data } = await send("POST", `/api/methodist/competitions/${current.competition.id}/archive`, {});
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", "Конкурс в архіві");
  closeModal();
  refreshCurrentPage();
};

function refreshCurrentPage() {
  const active = document.querySelector(".nav-item.active");
  if (active) loaders[active.dataset.page]?.();
}

// ---- Старт ------------------------------------------------------------------
(async function init() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) return (window.location.href = "/");
    const { user } = await res.json();
    if (!["methodist", "admin", "system"].includes(user.role)) return (window.location.href = "/");
    $("userEmail").textContent = user.email;
    switchPage("dashboard");
  } catch {
    window.location.href = "/";
  }
})();
