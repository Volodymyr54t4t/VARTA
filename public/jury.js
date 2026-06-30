// Клієнтська логіка панелі журі VARTA

const $ = (id) => document.getElementById(id);

const PAGE_TITLES = {
  dashboard: "Dashboard",
  competitions: "Мої конкурси",
  review: "Оцінювання",
  profile: "Профіль",
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
  review: loadReview,
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

// ---- Інформація про суддю ---------------------------------------------------
async function loadMe() {
  const { user } = await getJSON("/api/me");
  $("userEmail").textContent = user.email;
  $("pEmail").value = user.email;
  $("pName").value = user.full_name || "";
  $("pPhone").value = user.phone || "";
}

// ---- Dashboard --------------------------------------------------------------
async function loadDashboard() {
  const { stats } = await getJSON("/api/jury/stats");
  const cards = [
    ["Моїх конкурсів", stats.competitions],
    ["Усього заявок", stats.applications],
    ["Оцінено", stats.scored],
    ["Очікують оцінки", stats.pending],
    ["Середній бал", stats.avgScore],
  ];
  $("statCards").innerHTML = cards
    .map(([lbl, num]) => `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`)
    .join("");
}

// ---- Мої конкурси -----------------------------------------------------------
async function loadCompetitions() {
  const { competitions } = await getJSON("/api/jury/competitions");
  $("competitionsBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td>${esc(c.title)}</td>
            <td>${fmtDate(c.starts_at)} — ${fmtDate(c.ends_at)}</td>
            <td>${c.applications}</td>
            <td>${c.scored} / ${c.applications}</td>
            <td><button class="btn sm" data-review="${c.id}">Оцінювати</button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Вас ще не призначено до конкурсів</td></tr>`;

  $("competitionsBody").querySelectorAll("[data-review]").forEach((b) => {
    b.onclick = () => {
      switchPage("review");
      setTimeout(() => {
        $("reviewCompetition").value = b.dataset.review;
        $("reviewCompetition").dispatchEvent(new Event("change"));
      }, 50);
    };
  });
}

// ---- Оцінювання -------------------------------------------------------------
async function loadReview() {
  const { competitions } = await getJSON("/api/jury/competitions");
  $("reviewCompetition").innerHTML = competitions.length
    ? competitions.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("")
    : `<option value="">Немає призначених конкурсів</option>`;
  await loadApplicationsForReview();
}

$("reviewCompetition").addEventListener("change", loadApplicationsForReview);

async function loadApplicationsForReview() {
  const cid = $("reviewCompetition").value;
  if (!cid) {
    $("reviewList").innerHTML = `<div class="empty">Оберіть конкурс</div>`;
    return;
  }
  const { applications } = await getJSON(`/api/jury/competitions/${cid}/applications`);
  if (!applications.length) {
    $("reviewList").innerHTML = `<div class="empty">У цьому конкурсі ще немає заявок</div>`;
    return;
  }
  $("reviewList").innerHTML = applications.map(renderReviewCard).join("");

  // Підключаємо обробники збереження балу
  $("reviewList").querySelectorAll(".score-form").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const aid = form.dataset.app;
      const score = form.querySelector(".score-input").value;
      const comment = form.querySelector(".comment-input").value;
      const { ok, data } = await send("POST", `/api/jury/applications/${aid}/score`, { score, comment });
      if (!ok) return toast("err", data.error || "Помилка");
      toast("ok", data.message);
      loadApplicationsForReview();
    });
  });
}

function renderReviewCard(a) {
  // Відповіді на поля форми (data_json: { "Назва поля": "значення" })
  const entries = a.data_json && typeof a.data_json === "object" ? Object.entries(a.data_json) : [];
  const answers = entries.length
    ? `<div class="answers">${entries
        .map(
          ([label, val]) =>
            `<div class="answer-row"><div class="a-label">${esc(label)}</div><div>${esc(val) || "—"}</div></div>`
        )
        .join("")}</div>`
    : `<p class="hint">Учень не заповнював додаткових полів.</p>`;

  // Файли
  const files = (a.files || []).length
    ? `<div class="answer-files">${a.files
        .map(
          (f) => `<a class="btn sm" href="${esc(f.file_url)}" target="_blank" rel="noopener">Файл</a>`
        )
        .join("")}</div>`
    : "";

  const scored = a.my_score != null;
  return `<div class="review-card ${scored ? "scored" : ""}">
    <div class="review-head">
      <div>
        <h3>${esc(a.title || "Без назви")}</h3>
        <div class="review-meta">
          <span class="chip">${esc(a.student_name || "Учасник")}</span>
          ${a.section_name ? `<span class="chip">${esc(a.section_name)}</span>` : ""}
          <span class="chip">${APP_STATUS[a.status] || a.status}</span>
          <span class="chip">${fmtDate(a.created_at)}</span>
        </div>
      </div>
      ${scored ? `<span class="status accepted">Ваш бал: ${a.my_score}</span>` : ""}
    </div>
    ${answers}
    ${files}
    <form class="score-form" data-app="${a.id}">
      <label>Бал (0–100)
        <input type="number" class="score-input" min="0" max="100" step="0.5" value="${a.my_score != null ? a.my_score : ""}" required />
      </label>
      <label class="comment-field">Коментар
        <input type="text" class="comment-input" placeholder="Необов'язково" value="${esc(a.my_comment || "")}" />
      </label>
      <button class="btn">${scored ? "Оновити" : "Зберегти"}</button>
    </form>
  </div>`;
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
