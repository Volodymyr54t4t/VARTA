// Клієнтська логіка панелі учня VARTA

const $ = (id) => document.getElementById(id);

const PAGE_TITLES = {
  dashboard: "Dashboard",
  competitions: "Конкурси",
  submit: "Подати заявку",
  applications: "Мої заявки",
  results: "Результати",
  diplomas: "Дипломи",
  notifications: "Сповіщення",
  profile: "Профіль",
};

const APP_STATUS = {
  submitted: "Очікує",
  accepted: "Прийнято",
  rejected: "Відхилено",
};

const PLACE_CLASS = { 1: "gold", 2: "silver", 3: "bronze" };

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
  diplomas: loadDiplomas,
  notifications: loadNotifications,
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

// ---- Інформація про учня / школу --------------------------------------------
async function loadMe() {
  const { user } = await getJSON("/api/me");
  $("userEmail").textContent = user.email;
  $("pEmail").value = user.email;
  $("pName").value = user.full_name || "";
  $("pPhone").value = user.phone || "";

  const { info } = await getJSON("/api/student/me");
  if (info && info.school_name) {
    const klass = info.class ? ` · ${info.class}` : "";
    $("schoolName").textContent = `${info.school_name} · ${info.city_name}${klass}`;
    $("noSchoolBanner").classList.add("hidden");
  } else {
    $("schoolName").textContent = "Школу не призначено";
    $("noSchoolBanner").classList.remove("hidden");
  }
}

// ---- Dashboard --------------------------------------------------------------
async function loadDashboard() {
  const { stats } = await getJSON("/api/student/stats");
  const cards = [
    ["Моїх заявок", stats.applications],
    ["Прийнято", stats.accepted],
    ["Очікують", stats.pending],
    ["Відхилено", stats.rejected],
    ["Дипломів", stats.diplomas],
    ["Середній бал", stats.avgScore],
  ];
  $("statCards").innerHTML = cards
    .map(([lbl, num]) => `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`)
    .join("");
}

// ---- Конкурси ---------------------------------------------------------------
async function loadCompetitions() {
  const { competitions } = await getJSON("/api/student/competitions");
  $("competitionsBody").innerHTML = competitions.length
    ? competitions
        .map(
          (c) => `<tr>
            <td>${esc(c.title)}</td>
            <td>${fmtDate(c.starts_at)} — ${fmtDate(c.ends_at)}</td>
            <td>${c.sections}</td>
            <td>${
              c.applied
                ? `<span class="status accepted">Подано</span>`
                : `<button class="btn sm" data-apply="${c.id}">Подати заявку</button>`
            }</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Немає опублікованих конкурсів</td></tr>`;

  $("competitionsBody").querySelectorAll("[data-apply]").forEach((b) => {
    b.onclick = () => {
      switchPage("submit");
      setTimeout(() => {
        $("subCompetition").value = b.dataset.apply;
        $("subCompetition").dispatchEvent(new Event("change"));
      }, 50);
    };
  });
}

// ---- Подати заявку ----------------------------------------------------------
async function loadSubmit() {
  const { competitions } = await getJSON("/api/student/competitions");
  const available = competitions.filter((c) => !c.applied);
  $("subCompetition").innerHTML = available.length
    ? available.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("")
    : `<option value="">Немає доступних конкурсів</option>`;
  await loadSections();
}

async function loadSections() {
  const compId = $("subCompetition").value;
  if (!compId) {
    $("subSection").innerHTML = `<option value="">—</option>`;
    $("subFormFields").innerHTML = "";
    return;
  }
  const { sections } = await getJSON(`/api/student/competitions/${compId}/sections`);
  $("subSection").innerHTML =
    `<option value="">Без секції</option>` +
    sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  await loadFormFields(compId);
}

// Поля форми, які задав методист під час створення конкурсу
async function loadFormFields(compId) {
  const { fields } = await getJSON(`/api/student/competitions/${compId}/form`);
  if (!fields || !fields.length) {
    $("subFormFields").innerHTML = "";
    return;
  }
  $("subFormFields").innerHTML = fields
    .map((f, i) => {
      const req = f.required ? "required" : "";
      const star = f.required ? ' <span class="req">*</span>' : "";
      const id = `field_${i}`;
      let control = "";
      if (f.type === "textarea") {
        control = `<textarea id="${id}" data-label="${esc(f.label)}" rows="4" ${req}></textarea>`;
      } else if (f.type === "file") {
        control = `<input type="file" id="${id}" data-label="${esc(f.label)}" data-file="1" name="${id}" ${req} />`;
      } else {
        const t = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
        control = `<input type="${t}" id="${id}" data-label="${esc(f.label)}" ${req} />`;
      }
      return `<label>${esc(f.label)}${star}${control}</label>`;
    })
    .join("");
}
$("subCompetition").addEventListener("change", loadSections);

$("submitForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const compId = $("subCompetition").value;
  if (!compId) return toast("err", "Оберіть конкурс");

  // Збираємо відповіді на поля форми конкурсу
  const data_json = {};
  const fd = new FormData();
  $("subFormFields")
    .querySelectorAll("[data-label]")
    .forEach((el) => {
      const label = el.getAttribute("data-label");
      if (el.dataset.file) {
        if (el.files && el.files[0]) {
          fd.append(el.id, el.files[0]);
        }
      } else {
        data_json[label] = el.value.trim();
      }
    });

  fd.append("competition_id", compId);
  fd.append("section_id", $("subSection").value || "");
  fd.append("title", $("subTitle").value.trim());
  fd.append("data_json", JSON.stringify(data_json));

  const res = await fetch("/api/student/applications", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  $("subTitle").value = "";
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
            <td><span class="status ${a.status}">${APP_STATUS[a.status] || a.status}</span></td>
            <td>${a.score != null ? a.score : "—"}</td>
            <td>${fmtDate(a.created_at)}</td>
            <td>${
              a.status === "submitted"
                ? `<button class="btn sm danger" data-withdraw="${a.id}">Відкликати</button>`
                : ""
            }</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty">Ви ще не подавали заявок</td></tr>`;

  $("applicationsBody").querySelectorAll("[data-withdraw]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Відкликати цю заявку?")) return;
      const { ok, data } = await send("DELETE", `/api/student/applications/${b.dataset.withdraw}`);
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

// ---- Дипломи ----------------------------------------------------------------
async function loadDiplomas() {
  const { diplomas } = await getJSON("/api/student/diplomas");
  $("diplomasBody").innerHTML = diplomas.length
    ? diplomas
        .map(
          (d) => `<tr>
            <td>${esc(d.competition_title)}</td>
            <td><span class="place ${PLACE_CLASS[d.place] || ""}">${d.place || "—"}</span></td>
            <td>${d.score != null ? d.score : "—"}</td>
            <td>${fmtDate(d.issued_at)}</td>
            <td>${
              d.file_url
                ? `<a class="btn sm" href="${esc(d.file_url)}" target="_blank" rel="noopener">Завантажити</a>`
                : `<span class="hint">Готується</span>`
            }</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">У вас ще немає дипломів</td></tr>`;
}

// ---- Сповіщення -------------------------------------------------------------
async function loadNotifications() {
  const { notifications } = await getJSON("/api/student/notifications");
  $("notificationsList").innerHTML = notifications.length
    ? notifications
        .map(
          (n) => `<div class="notif ${n.is_read ? "" : "unread"}">
            <p class="notif-msg">${esc(n.message)}</p>
            <span class="notif-date">${fmtDate(n.created_at)}</span>
          </div>`
        )
        .join("")
    : `<div class="empty">Сповіщень немає</div>`;
}

$("readAllBtn").onclick = async () => {
  const { ok, data } = await send("POST", "/api/student/notifications/read-all", {});
  if (!ok) return toast("err", data.error || "Помилка");
  toast("ok", data.message);
  loadNotifications();
};

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
