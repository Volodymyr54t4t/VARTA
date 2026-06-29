// Клієнтська логіка панелі журі VARTA

const $ = (id) => document.getElementById(id);

const PAGE_TITLES = {
  dashboard: "Dashboard",
  competitions: "Призначені конкурси",
  works: "Роботи",
  rating: "Рейтинг",
  comments: "Коментарі",
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

const JUDGE_ROLE = {
  judge: "Суддя",
  head: "Голова журі",
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
  works: loadWorks,
  rating: loadRating,
  comments: loadComments,
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

// Кеш списку конкурсів для фільтрів
let competitionsCache = [];

// ---- Інформація про журі ----------------------------------------------------
async function loadMe() {
  const { user } = await getJSON("/api/me");
  $("userEmail").textContent = user.email;
  $("pEmail").value = user.email;
  $("pName").value = user.full_name || "";
  $("pPhone").value = user.phone || "";

  const info = await getJSON("/api/jury/me");
  $("assignedInfo").textContent = `Конкурсів: ${info.assignedCount}`;
}

// ---- Dashboard --------------------------------------------------------------
async function loadDashboard() {
  const { stats } = await getJSON("/api/jury/stats");
  const cards = [
    ["Конкурсів", stats.competitions],
    ["Робіт усього", stats.works],
    ["Оцінено мною", stats.scored],
    ["Очікують оцінки", stats.pending],
    ["Середній бал", stats.avgScore],
  ];
  $("statCards").innerHTML = cards
    .map(([lbl, num]) => `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`)
    .join("");
}

// ---- Призначені конкурси ----------------------------------------------------
async function loadCompetitions() {
  const { competitions } = await getJSON("/api/jury/competitions");
  competitionsCache = competitions;
  $("competitionsBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td>${esc(c.title)}</td>
            <td>${fmtDate(c.starts_at)} — ${fmtDate(c.ends_at)}</td>
            <td>${JUDGE_ROLE[c.judge_role] || esc(c.judge_role)}</td>
            <td>${c.apps_count}</td>
            <td>${c.scored_count} / ${c.apps_count}</td>
            <td><button class="btn sm" data-works="${c.id}">Оцінити роботи</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">Вас ще не призначено до жодного конкурсу</td></tr>`;

  $("competitionsBody").querySelectorAll("[data-works]").forEach((b) => {
    b.onclick = () => {
      switchPage("works");
      setTimeout(() => {
        $("worksCompFilter").value = b.dataset.works;
        loadWorksTable();
      }, 60);
    };
  });
}

// ---- Роботи -----------------------------------------------------------------
async function ensureCompetitions() {
  if (!competitionsCache.length) {
    const { competitions } = await getJSON("/api/jury/competitions");
    competitionsCache = competitions;
  }
  return competitionsCache;
}

function fillCompFilter(selectId) {
  const sel = $(selectId);
  const current = sel.value;
  sel.innerHTML =
    `<option value="">Усі конкурси</option>` +
    competitionsCache.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("");
  if (current) sel.value = current;
}

async function loadWorks() {
  await ensureCompetitions();
  fillCompFilter("worksCompFilter");
  await loadWorksTable();
}

async function loadWorksTable() {
  const compId = $("worksCompFilter").value;
  const url = compId ? `/api/jury/applications?competition_id=${compId}` : "/api/jury/applications";
  const { applications } = await getJSON(url);
  $("worksBody").innerHTML = applications.length
    ? applications
        .map(
          (a) => `<tr>
            <td>${esc(a.title || "Без назви")}</td>
            <td>${esc(a.competition_title)}</td>
            <td>${esc(a.section_name || "—")}</td>
            <td>${esc(a.student_name || "—")}</td>
            <td>${a.files_count}</td>
            <td>${a.my_score != null ? `<strong>${a.my_score}</strong>` : '<span class="status submitted">Не оцінено</span>'}</td>
            <td><button class="btn sm" data-score="${a.id}">${a.my_score != null ? "Змінити" : "Оцінити"}</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty">Немає робіт для оцінювання</td></tr>`;

  $("worksBody").querySelectorAll("[data-score]").forEach((b) => {
    b.onclick = () => openScoreModal(b.dataset.score);
  });
}
$("worksCompFilter").addEventListener("change", loadWorksTable);

// ---- Модальне вікно оцінювання: Роботи → Оцінювання → Бали → Коментарі -------
let currentAppId = null;

async function openScoreModal(appId) {
  currentAppId = appId;
  const { application, files, fields, myResult } = await getJSON(`/api/jury/applications/${appId}`);

  $("scoreTitle").textContent = application.title || "Робота без назви";
  $("scoreSubtitle").textContent = `${application.competition_title}${application.section_name ? " · " + application.section_name : ""}`;

  // Деталі роботи: учасник, поля форми, файли
  const data = application.data_json || {};
  const fieldRows = Array.isArray(fields) && fields.length
    ? fields
        .map((f, i) => {
          const key = f.name || `field_${i}`;
          const label = esc(f.label || f.name || `Поле ${i + 1}`);
          const val = esc(data[key] ?? "—");
          return `<div class="kv"><span class="k">${label}</span><span class="v">${val || "—"}</span></div>`;
        })
        .join("")
    : "";

  const fileRows = files.length
    ? `<div class="kv-files"><span class="k">Файли</span><div class="v">${files
        .map((f) => `<a href="${esc(f.file_url)}" target="_blank" rel="noopener">${esc(f.file_type || "файл")}</a>`)
        .join(" · ")}</div></div>`
    : `<div class="kv"><span class="k">Файли</span><span class="v">—</span></div>`;

  $("scoreBody").innerHTML = `
    <div class="info-block">
      <div class="kv"><span class="k">Учасник</span><span class="v">${esc(application.student_name || "—")}</span></div>
      <div class="kv"><span class="k">Подано</span><span class="v">${fmtDate(application.created_at)}</span></div>
      ${fieldRows}
      ${fileRows}
    </div>`;

  // Заповнюємо поточну оцінку (якщо вже оцінено)
  $("scoreValue").value = myResult?.score != null ? myResult.score : "";
  $("scoreComment").value = myResult?.comment || "";

  $("scoreModal").classList.remove("hidden");
}

function closeScoreModal() {
  $("scoreModal").classList.add("hidden");
  currentAppId = null;
}
$("scoreClose").onclick = closeScoreModal;
$("scoreModal").addEventListener("click", (e) => {
  if (e.target === $("scoreModal")) closeScoreModal();
});

$("scoreForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentAppId) return;
  const score = Number($("scoreValue").value);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return toast("err", "Бал має бути від 0 до 100");
  }
  const { ok, data } = await send("POST", `/api/jury/applications/${currentAppId}/score`, {
    score,
    comment: $("scoreComment").value.trim(),
  });
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  closeScoreModal();
  loadWorksTable();
});

// ---- Рейтинг ----------------------------------------------------------------
async function loadRating() {
  await ensureCompetitions();
  fillCompFilter("ratingCompFilter");
  await loadRatingTable();
}

async function loadRatingTable() {
  const compId = $("ratingCompFilter").value;
  const url = compId ? `/api/jury/rating?competition_id=${compId}` : "/api/jury/rating";
  const { rating } = await getJSON(url);
  $("ratingBody").innerHTML = rating.length
    ? rating
        .map(
          (r, i) => `<tr>
            <td>${i + 1}</td>
            <td>${esc(r.title || "Без назви")}</td>
            <td>${esc(r.competition_title)}</td>
            <td>${esc(r.section_name || "—")}</td>
            <td>${esc(r.student_name || "—")}</td>
            <td>${r.avg_score != null ? `<strong>${r.avg_score}</strong>` : "—"}</td>
            <td>${r.judges_count}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty">Немає даних для рейтингу</td></tr>`;
}
$("ratingCompFilter").addEventListener("change", loadRatingTable);

// ---- Коментарі --------------------------------------------------------------
async function loadComments() {
  const { comments } = await getJSON("/api/jury/comments");
  $("commentsBody").innerHTML = comments.length
    ? comments
        .map(
          (c) => `<tr>
            <td>${esc(c.application_title || "Без назви")}</td>
            <td>${esc(c.competition_title)}</td>
            <td>${esc(c.student_name || "—")}</td>
            <td><strong>${c.score != null ? c.score : "—"}</strong></td>
            <td>${esc(c.comment || "—")}</td>
            <td>${fmtDate(c.created_at)}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">Ви ще не залишали коментарів</td></tr>`;
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
  const { ok, data } = await send("PUT", "/api/jury/profile", {
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
