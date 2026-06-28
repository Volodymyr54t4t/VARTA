// ============================================================================
//  VARTA — головний файл серверу
//  Модуль авторизації: реєстрація, підтвердження email, вхід,
//  відновлення пароля.  Стек: NodeJS + Express + PostgreSQL (Neon)
// ============================================================================

import "dotenv/config";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Доступні ролі системи (див. схему). За замовчуванням нові користувачі — "guest".
const ROLES = [
  "guest",
  "admin",
  "methodist",
  "zavuch",
  "teacher",
  "student",
  "jury",
  "system",
];

// ----------------------------------------------------------------------------
//  Підключення до бази даних
// ----------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ----------------------------------------------------------------------------
//  Ініціалізація схеми бази даних
// ----------------------------------------------------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      email           VARCHAR(255) UNIQUE NOT NULL,
      password        VARCHAR(255) NOT NULL,
      role            VARCHAR(32)  NOT NULL DEFAULT 'guest',
      status          VARCHAR(32)  NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      full_name   VARCHAR(255),
      phone       VARCHAR(64),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Токени для підтвердження email та відновлення пароля
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token       VARCHAR(128) UNIQUE NOT NULL,
      type        VARCHAR(32)  NOT NULL, -- 'verify' | 'reset'
      expires_at  TIMESTAMPTZ  NOT NULL,
      used        BOOLEAN      NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);

  // ---- Адмінські таблиці (див. схему "1. АДМІН") ----
  // Області
  await pool.query(`
    CREATE TABLE IF NOT EXISTS regions (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) UNIQUE NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Міста (належать області)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cities (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      region_id   INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (name, region_id)
    );
  `);

  // Школи (належать місту)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schools (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      city_id     INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      address     VARCHAR(255),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Запити на підтвердження ролей
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_roles_requests (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role        VARCHAR(32) NOT NULL,
      status      VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending | approved | rejected
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Логи системи
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id          SERIAL PRIMARY KEY,
      action      VARCHAR(255) NOT NULL,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      details     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Налаштування системи (ключ-значення)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key         VARCHAR(128) PRIMARY KEY,
      value       TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ---- Універсальний адміністратор ----
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@varta.com").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "C240809v";
  const adminHash = await bcrypt.hash(adminPassword, 10);
  const existingAdmin = await pool.query("SELECT id FROM users WHERE email = $1", [adminEmail]);
  if (existingAdmin.rowCount === 0) {
    const a = await pool.query(
      `INSERT INTO users (email, password, role, status)
       VALUES ($1, $2, 'admin', 'active') RETURNING id`,
      [adminEmail, adminHash]
    );
    await pool.query(
      `INSERT INTO user_profiles (user_id, full_name) VALUES ($1, $2)`,
      [a.rows[0].id, "Адміністратор VARTA"]
    );
    console.log(`[v0] Створено універсального адміністратора: ${adminEmail}`);
  } else {
    // Гарантуємо, що роль/статус/пароль адміна актуальні
    await pool.query(
      `UPDATE users SET role = 'admin', status = 'active', password = $2 WHERE email = $1`,
      [adminEmail, adminHash]
    );
  }

  console.log("[v0] База даних готова: users, user_profiles, auth_tokens, regions, cities, schools, user_roles_requests, system_logs, system_settings");
}

// Запис дії в журнал системи
async function logAction(action, userId = null, details = null) {
  try {
    await pool.query(
      `INSERT INTO system_logs (action, user_id, details) VALUES ($1, $2, $3)`,
      [action, userId, details]
    );
  } catch (err) {
    console.log("[v0] Не вдалося записати лог:", err.message);
  }
}

// ----------------------------------------------------------------------------
//  Допоміжні функції
// ----------------------------------------------------------------------------
function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function signSession(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

async function createAuthToken(userId, type, hours = 24) {
  const token = makeToken();
  const expires = new Date(Date.now() + hours * 3600 * 1000);
  await pool.query(
    `INSERT INTO auth_tokens (user_id, token, type, expires_at) VALUES ($1,$2,$3,$4)`,
    [userId, token, type, expires]
  );
  return token;
}

// У реальному застосунку тут була б відправка листа через SMTP.
// Без налаштованого поштового сервісу повертаємо посилання у відповіді (demo).
function buildLink(pathName, token) {
  return `${APP_URL}${pathName}?token=${token}`;
}

// ----------------------------------------------------------------------------
//  Express-застосунок
// ----------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

// --- Мідлвер автентифікації (перевірка JWT із httpOnly cookie) ---------------
function authRequired(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: "Не авторизовано" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Сесія недійсна або застаріла" });
  }
}

// --- Мідлвер контролю ролей --------------------------------------------------
function roleRequired(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ error: "Недостатньо прав" });
    }
    next();
  };
}

// ============================================================================
//  РОУТИ АВТОРИЗАЦІЇ
// ============================================================================

// --- Реєстрація користувача --------------------------------------------------
app.post("/api/register", async (req, res) => {
  try {
    const { email, password, full_name } = req.body || {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Некоректний email" });
    }
    if (typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "Пароль має містити щонайменше 6 символів" });
    }

    const exists = await pool.query("SELECT id FROM users WHERE email = $1", [
      email.toLowerCase(),
    ]);
    if (exists.rowCount > 0) {
      return res.status(409).json({ error: "Користувач з таким email вже існує" });
    }

    const hash = await bcrypt.hash(password, 10);

    // Кожному новому користувачу присвоюється роль "guest" (гість)
    const result = await pool.query(
      `INSERT INTO users (email, password, role, status)
       VALUES ($1, $2, 'guest', 'pending')
       RETURNING id, email, role, status, created_at`,
      [email.toLowerCase(), hash]
    );
    const user = result.rows[0];

    await pool.query(
      `INSERT INTO user_profiles (user_id, full_name) VALUES ($1, $2)`,
      [user.id, full_name || null]
    );

    // Створюємо токен підтвердження email
    const token = await createAuthToken(user.id, "verify", 24);
    const verifyLink = buildLink("/verify.html", token);

    console.log(`[v0] Реєстрація ${user.email} — посилання підтвердження: ${verifyLink}`);

    res.status(201).json({
      message: "Реєстрація успішна. Підтвердіть email, щоб увійти.",
      user,
      // Без поштового сервісу повертаємо посилання тут (demo-режим)
      verifyLink,
    });
  } catch (err) {
    console.log("[v0] Помилка реєстрації:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Підтвердження email -----------------------------------------------------
app.post("/api/verify", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "Відсутній токен" });

    const r = await pool.query(
      `SELECT * FROM auth_tokens WHERE token = $1 AND type = 'verify'`,
      [token]
    );
    const row = r.rows[0];
    if (!row || row.used || new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: "Токен недійсний або застарів" });
    }

    await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [row.user_id]);
    await pool.query("UPDATE auth_tokens SET used = true WHERE id = $1", [row.id]);

    res.json({ message: "Email підтверджено. Тепер ви можете увійти." });
  } catch (err) {
    console.log("[v0] Помилка підтвердження:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Вхід у систему ----------------------------------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !password) {
      return res.status(400).json({ error: "Вкажіть email та пароль" });
    }

    const r = await pool.query("SELECT * FROM users WHERE email = $1", [
      email.toLowerCase(),
    ]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: "Невірний email або пароль" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Невірний email або пароль" });

    if (user.status !== "active") {
      return res.status(403).json({ error: "Спочатку підтвердіть email" });
    }

    const session = signSession(user);
    res.cookie("session", session, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 3600 * 1000,
    });

    res.json({
      message: "Вхід виконано",
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
    });
  } catch (err) {
    console.log("[v0] Помилка входу:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Вихід -------------------------------------------------------------------
app.post("/api/logout", (req, res) => {
  res.clearCookie("session");
  res.json({ message: "Ви вийшли із системи" });
});

// --- Відновлення пароля: запит ------------------------------------------------
app.post("/api/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Некоректний email" });
    }

    const r = await pool.query("SELECT id, email FROM users WHERE email = $1", [
      email.toLowerCase(),
    ]);
    const user = r.rows[0];

    // Завжди відповідаємо однаково, щоб не розкривати наявність акаунта
    const generic = { message: "Якщо акаунт існує, ми надіслали посилання для відновлення." };
    if (!user) return res.json(generic);

    const token = await createAuthToken(user.id, "reset", 2);
    const resetLink = buildLink("/reset.html", token);
    console.log(`[v0] Відновлення пароля ${user.email} — посилання: ${resetLink}`);

    res.json({ ...generic, resetLink }); // resetLink повертаємо у demo-режимі
  } catch (err) {
    console.log("[v0] Помилка відновлення:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Відновлення пароля: встановлення нового ---------------------------------
app.post("/api/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token) return res.status(400).json({ error: "Відсутній токен" });
    if (typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "Пароль має містити щонайменше 6 символів" });
    }

    const r = await pool.query(
      `SELECT * FROM auth_tokens WHERE token = $1 AND type = 'reset'`,
      [token]
    );
    const row = r.rows[0];
    if (!row || row.used || new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: "Токен недійсний або застарів" });
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hash, row.user_id]);
    await pool.query("UPDATE auth_tokens SET used = true WHERE id = $1", [row.id]);

    res.json({ message: "Пароль успішно змінено. Тепер ви можете увійти." });
  } catch (err) {
    console.log("[v0] Помилка зміни пароля:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Поточний користувач (захищений роут) ------------------------------------
app.get("/api/me", authRequired, async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.email, u.role, u.status, u.created_at, p.full_name, p.phone
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = $1`,
    [req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Користувача не знайдено" });
  res.json({ user: r.rows[0] });
});

// ============================================================================
//  АДМІН-ПАНЕЛЬ (роль "admin" / "system")
// ============================================================================
const adminOnly = [authRequired, roleRequired("admin", "system")];

// --- Dashboard: зведена статистика -------------------------------------------
app.get("/api/admin/stats", adminOnly, async (req, res) => {
  try {
    const [users, guests, regions, cities, schools, requests] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS c FROM users"),
      pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'guest'"),
      pool.query("SELECT COUNT(*)::int AS c FROM regions"),
      pool.query("SELECT COUNT(*)::int AS c FROM cities"),
      pool.query("SELECT COUNT(*)::int AS c FROM schools"),
      pool.query("SELECT COUNT(*)::int AS c FROM user_roles_requests WHERE status = 'pending'"),
    ]);
    const byRole = await pool.query(
      "SELECT role, COUNT(*)::int AS c FROM users GROUP BY role ORDER BY role"
    );
    res.json({
      stats: {
        users: users.rows[0].c,
        guests: guests.rows[0].c,
        regions: regions.rows[0].c,
        cities: cities.rows[0].c,
        schools: schools.rows[0].c,
        pendingRequests: requests.rows[0].c,
      },
      byRole: byRole.rows,
    });
  } catch (err) {
    console.log("[v0] Помилка статистики:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// ---------------------------------------------------------------------------
//  УПРАВЛІННЯ КОРИСТУВАЧАМИ
// ---------------------------------------------------------------------------
app.get("/api/admin/users", adminOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.email, u.role, u.status, u.created_at, p.full_name
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
      ORDER BY u.created_at DESC`
  );
  res.json({ users: r.rows, roles: ROLES });
});

// Зміна ролі користувача (адмін призначає роль гостям та іншим)
app.patch("/api/admin/users/:id/role", adminOnly, async (req, res) => {
  try {
    const { role } = req.body || {};
    const userId = parseInt(req.params.id, 10);
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: "Невідома роль" });
    }
    const r = await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role, status`,
      [role, userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Користувача не знайдено" });
    await logAction("Зміна ролі користувача", req.user.id, `user #${userId} → ${role}`);
    res.json({ message: "Роль оновлено", user: r.rows[0] });
  } catch (err) {
    console.log("[v0] Помилка зміни ролі:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// Зміна статусу користувача (active / pending / blocked)
app.patch("/api/admin/users/:id/status", adminOnly, async (req, res) => {
  try {
    const { status } = req.body || {};
    const userId = parseInt(req.params.id, 10);
    if (!["active", "pending", "blocked"].includes(status)) {
      return res.status(400).json({ error: "Невідомий статус" });
    }
    const r = await pool.query(
      `UPDATE users SET status = $1 WHERE id = $2 RETURNING id, email, role, status`,
      [status, userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Користувача не знайдено" });
    await logAction("Зміна статусу користувача", req.user.id, `user #${userId} → ${status}`);
    res.json({ message: "Статус оновлено", user: r.rows[0] });
  } catch (err) {
    console.log("[v0] Помилка зміни статусу:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// ---------------------------------------------------------------------------
//  УПРАВЛІННЯ ОБЛАСТЯМИ
// ---------------------------------------------------------------------------
app.get("/api/admin/regions", adminOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT r.*, (SELECT COUNT(*)::int FROM cities c WHERE c.region_id = r.id) AS cities_count
       FROM regions r ORDER BY r.name`
  );
  res.json({ regions: r.rows });
});

app.post("/api/admin/regions", adminOnly, async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву області" });
    const r = await pool.query(
      "INSERT INTO regions (name) VALUES ($1) RETURNING *",
      [name]
    );
    await logAction("Створено область", req.user.id, name);
    res.status(201).json({ region: r.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Така область вже існує" });
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

app.delete("/api/admin/regions/:id", adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query("DELETE FROM regions WHERE id = $1 RETURNING name", [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Область не знайдено" });
  await logAction("Видалено область", req.user.id, r.rows[0].name);
  res.json({ message: "Область видалено" });
});

// ---------------------------------------------------------------------------
//  УПРАВЛІННЯ МІСТАМИ
// ---------------------------------------------------------------------------
app.get("/api/admin/cities", adminOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT c.*, r.name AS region_name,
            (SELECT COUNT(*)::int FROM schools s WHERE s.city_id = c.id) AS schools_count
       FROM cities c JOIN regions r ON r.id = c.region_id
      ORDER BY r.name, c.name`
  );
  res.json({ cities: r.rows });
});

app.post("/api/admin/cities", adminOnly, async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    const region_id = parseInt(req.body?.region_id, 10);
    if (!name || !region_id) return res.status(400).json({ error: "Вкажіть назву та область" });
    const r = await pool.query(
      "INSERT INTO cities (name, region_id) VALUES ($1, $2) RETURNING *",
      [name, region_id]
    );
    await logAction("Створено місто", req.user.id, name);
    res.status(201).json({ city: r.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Таке місто вже існує в цій області" });
    if (err.code === "23503") return res.status(400).json({ error: "Область не існує" });
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

app.delete("/api/admin/cities/:id", adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query("DELETE FROM cities WHERE id = $1 RETURNING name", [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Місто не знайдено" });
  await logAction("Видалено місто", req.user.id, r.rows[0].name);
  res.json({ message: "Місто видалено" });
});

// ---------------------------------------------------------------------------
//  УПРАВЛІННЯ ШКОЛАМИ
// ---------------------------------------------------------------------------
app.get("/api/admin/schools", adminOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT s.*, c.name AS city_name, r.name AS region_name
       FROM schools s
       JOIN cities c ON c.id = s.city_id
       JOIN regions r ON r.id = c.region_id
      ORDER BY r.name, c.name, s.name`
  );
  res.json({ schools: r.rows });
});

app.post("/api/admin/schools", adminOnly, async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    const city_id = parseInt(req.body?.city_id, 10);
    const address = (req.body?.address || "").trim() || null;
    if (!name || !city_id) return res.status(400).json({ error: "Вкажіть назву та місто" });
    const r = await pool.query(
      "INSERT INTO schools (name, city_id, address) VALUES ($1, $2, $3) RETURNING *",
      [name, city_id, address]
    );
    await logAction("Створено школу", req.user.id, name);
    res.status(201).json({ school: r.rows[0] });
  } catch (err) {
    if (err.code === "23503") return res.status(400).json({ error: "Місто не існує" });
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

app.delete("/api/admin/schools/:id", adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query("DELETE FROM schools WHERE id = $1 RETURNING name", [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Школу не знайдено" });
  await logAction("Видалено школу", req.user.id, r.rows[0].name);
  res.json({ message: "Школу видалено" });
});

// ---------------------------------------------------------------------------
//  ЗАПИТИ НА ПІДТВЕРДЖЕННЯ РОЛЕЙ
// ---------------------------------------------------------------------------
app.get("/api/admin/role-requests", adminOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT rr.*, u.email, p.full_name
       FROM user_roles_requests rr
       JOIN users u ON u.id = rr.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      ORDER BY rr.created_at DESC`
  );
  res.json({ requests: r.rows });
});

app.patch("/api/admin/role-requests/:id", adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { decision } = req.body || {}; // 'approved' | 'rejected'
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "Невідоме рішення" });
    }
    const rr = await pool.query("SELECT * FROM user_roles_requests WHERE id = $1", [id]);
    if (rr.rowCount === 0) return res.status(404).json({ error: "Запит не знайдено" });
    const request = rr.rows[0];

    await pool.query("UPDATE user_roles_requests SET status = $1 WHERE id = $2", [decision, id]);

    // У разі схвалення — призначаємо роль користувачу
    if (decision === "approved") {
      await pool.query("UPDATE users SET role = $1 WHERE id = $2", [request.role, request.user_id]);
    }
    await logAction(
      `Запит на роль ${decision === "approved" ? "схвалено" : "відхилено"}`,
      req.user.id,
      `request #${id} (${request.role})`
    );
    res.json({ message: "Рішення збережено" });
  } catch (err) {
    console.log("[v0] Помилка обробки запиту:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// ---------------------------------------------------------------------------
//  НАЛАШТУВАННЯ СИСТЕМИ
// ---------------------------------------------------------------------------
app.get("/api/admin/settings", adminOnly, async (req, res) => {
  const r = await pool.query("SELECT key, value, updated_at FROM system_settings ORDER BY key");
  res.json({ settings: r.rows });
});

app.put("/api/admin/settings", adminOnly, async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: "Вкажіть ключ налаштування" });
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value ?? null]
    );
    await logAction("Оновлено налаштування системи", req.user.id, key);
    res.json({ message: "Налаштування збережено" });
  } catch (err) {
    console.log("[v0] Помилка налаштувань:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// ---------------------------------------------------------------------------
//  ЛОГИ СИСТЕМИ
// ---------------------------------------------------------------------------
app.get("/api/admin/logs", adminOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT l.id, l.action, l.details, l.created_at, u.email AS actor
       FROM system_logs l
       LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.created_at DESC
      LIMIT 200`
  );
  res.json({ logs: r.rows });
});

// ----------------------------------------------------------------------------
//  Запуск серверу
// ----------------------------------------------------------------------------
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[v0] VARTA сервер запущено на ${APP_URL}`);
    });
  })
  .catch((err) => {
    console.log("[v0] Не вдалося ініціалізувати БД:", err.message);
    process.exit(1);
  });
