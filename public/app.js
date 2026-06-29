// Клієнтська логіка форм авторизації VARTA

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

const STATUS_LABELS = {
    pending: "Очікує підтвердження",
    active: "Активний",
};

function showMsg(el, type, html) {
    el.className = `msg show ${type}`;
    el.innerHTML = html;
}

function clearMsg(el) {
    el.className = "msg";
    el.innerHTML = "";
}

async function api(path, body) {
    const res = await fetch(path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return {
        ok: res.ok,
        data
    };
}

// ---- Перемикання форм -------------------------------------------------------
const forms = {
    login: $("loginForm"),
    register: $("registerForm"),
    forgot: $("forgotForm"),
};

function show(which) {
    Object.values(forms).forEach((f) => f.classList.add("hidden"));
    forms[which].classList.remove("hidden");
    $("tab-login").classList.toggle("active", which === "login");
    $("tab-register").classList.toggle("active", which === "register");
}

$("tab-login").onclick = () => show("login");
$("tab-register").onclick = () => show("register");
$("toForgot").onclick = () => show("forgot");
$("backToLogin").onclick = () => show("login");

// ---- Реєстрація -------------------------------------------------------------
forms.register.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("register-msg");
    clearMsg(msg);
    const {
        ok,
        data
    } = await api("/api/register", {
        full_name: $("reg-name").value.trim(),
        email: $("reg-email").value.trim(),
        password: $("reg-password").value,
    });
    if (!ok) return showMsg(msg, "err", data.error || "Помилка реєстрації");

    let html = `${data.message}`;
    if (data.verifyLink) {
        html += `<br /><br />Demo-посилання підтвердження:<br /><a href="${data.verifyLink}">${data.verifyLink}</a>`;
    }
    showMsg(msg, "ok", html);
    forms.register.reset();
});

// ---- Вхід -------------------------------------------------------------------
forms.login.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("login-msg");
    clearMsg(msg);
    const {
        ok,
        data
    } = await api("/api/login", {
        email: $("login-email").value.trim(),
        password: $("login-password").value,
    });
    if (!ok) return showMsg(msg, "err", data.error || "Помилка входу");
    renderAccount(data.user);
});

// ---- Відновлення пароля -----------------------------------------------------
forms.forgot.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("forgot-msg");
    clearMsg(msg);
    const {
        ok,
        data
    } = await api("/api/forgot-password", {
        email: $("forgot-email").value.trim(),
    });
    if (!ok) return showMsg(msg, "err", data.error || "Помилка");
    let html = data.message;
    if (data.resetLink) {
        html += `<br /><br />Demo-посилання відновлення:<br /><a href="${data.resetLink}">${data.resetLink}</a>`;
    }
    showMsg(msg, "ok", html);
});

// Домашня сторінка для кожної ролі (куди перекидати одразу після входу)
const ROLE_HOME = {
    admin: "/admin.html",
    system: "/admin.html",
    methodist: "/methodist.html",
    zavuch: "/zavuch.html",
    teacher: "/teacher.html",
};

// ---- Акаунт -----------------------------------------------------------------
function renderAccount(user) {
    // Якщо для ролі є власна панель — одразу перенаправляємо туди
    const home = ROLE_HOME[user.role];
    if (home) {
        window.location.replace(home);
        return;
    }
    $("authView").classList.add("hidden");
    $("accountView").classList.remove("hidden");
    $("acc-email").textContent = user.email;
    $("acc-role").textContent = ROLE_LABELS[user.role] || user.role;
    $("acc-status").textContent = STATUS_LABELS[user.status] || user.status;
}

$("logoutBtn").onclick = async () => {
    await api("/api/logout", {});
    $("accountView").classList.add("hidden");
    $("authView").classList.remove("hidden");
    show("login");
};

// ---- Перевірка наявної сесії при завантаженні -------------------------------
(async function checkSession() {
    try {
        const res = await fetch("/api/me");
        if (res.ok) {
            const {
                user
            } = await res.json();
            renderAccount(user);
        }
    } catch {}
})();
