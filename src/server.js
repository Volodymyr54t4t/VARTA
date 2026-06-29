// ============================================================================
//  VARTA — головний файл серверу
//  Модуль авторизації: реєстрація, підтвердження email, вхід,
//  відновлення пароля.  Стек: NodeJS + Express + PostgreSQL (Neon)
// ============================================================================

import "dotenv/config";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
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

  // Школи (належать місту). zavuch_id — завуч, що керує школою.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schools (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      city_id     INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      address     VARCHAR(255),
      zavuch_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Для вже створених баз — додаємо колонку завуча, якщо її ще немає
  await pool.query(
    `ALTER TABLE schools ADD COLUMN IF NOT EXISTS zavuch_id INTEGER REFERENCES users(id) ON DELETE SET NULL`
  );

  // ---- Таблиці завуча (див. схему "3. ЗАВУЧ") ----
  // Вчителі школи (завуч підтверджує)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teachers (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      school_id   INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      confirmed   BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, school_id)
    );
  `);

  // Учні школи (завуч контролює, вчитель створює/закріплює)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      school_id   INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      class       VARCHAR(32),
      teacher_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, school_id)
    );
  `);
  // Для вже створених баз — додаємо колонку вчителя, якщо її ще немає (див. схему "4. ВЧИТЕЛЬ")
  await pool.query(
    `ALTER TABLE students ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL`
  );

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

  // ---- Таблиці методиста (див. схему "2. МЕТОДИСТ") ----
  // Конкурси
  await pool.query(`
    CREATE TABLE IF NOT EXISTS competitions (
      id           SERIAL PRIMARY KEY,
      title        VARCHAR(255) NOT NULL,
      description  TEXT,
      status       VARCHAR(32)  NOT NULL DEFAULT 'draft', -- draft | published | archived
      methodist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      starts_at    DATE,
      ends_at      DATE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Секції конкурсу
  await pool.query(`
    CREATE TABLE IF NOT EXISTS competition_sections (
      id             SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      name           VARCHAR(255) NOT NULL,
      description    TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Форма подання заявки (поля у форматі JSON)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS competition_forms (
      id             SERIAL PRIMARY KEY,
      competition_id INTEGER UNIQUE NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      fields_json    JSONB NOT NULL DEFAULT '[]',
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Положення конкурсу
  await pool.query(`
    CREATE TABLE IF NOT EXISTS competition_rules (
      id             SERIAL PRIMARY KEY,
      competition_id INTEGER UNIQUE NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      content        TEXT,
      file_url       VARCHAR(512),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Файли, прикріплені до положення конкурсу
  await pool.query(`
    CREATE TABLE IF NOT EXISTS competition_rule_files (
      id             SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      file_url       VARCHAR(512) NOT NULL,
      file_name      VARCHAR(255),
      file_type      VARCHAR(128),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Призначене журі
  await pool.query(`
    CREATE TABLE IF NOT EXISTS competition_judges (
      id             SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role           VARCHAR(64) NOT NULL DEFAULT 'judge', -- head | judge
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (competition_id, user_id)
    );
  `);

  // Шаблони конкурсів
  await pool.query(`
    CREATE TABLE IF NOT EXISTS competition_templates (
      id           SERIAL PRIMARY KEY,
      name         VARCHAR(255) NOT NULL,
      data_json    JSONB NOT NULL DEFAULT '{}',
      methodist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Заявки учнів
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id             SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      student_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      section_id     INTEGER REFERENCES competition_sections(id) ON DELETE SET NULL,
      title          VARCHAR(255),
      data_json      JSONB NOT NULL DEFAULT '{}',
      status         VARCHAR(32) NOT NULL DEFAULT 'submitted', -- submitted | accepted | rejected
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Файли заявок
  await pool.query(`
    CREATE TABLE IF NOT EXISTS application_files (
      id             SERIAL PRIMARY KEY,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      file_url       VARCHAR(512) NOT NULL,
      file_type      VARCHAR(64),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Результати оцінювання
  await pool.query(`
    CREATE TABLE IF NOT EXISTS results (
      id             SERIAL PRIMARY KEY,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      judge_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      score          NUMERIC(5,2),
      comment        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ---- Таблиці системи (див. схему "7. СИСТЕМА") ----
  // Дипломи (видаються переможцям після підрахунку рейтингу)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS diplomas (
      id             SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      student_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
      place          INTEGER,
      score          NUMERIC(5,2),
      file_url       VARCHAR(512),
      issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Протоколи (підсумковий документ конкурсу)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS protocols (
      id             SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      content        TEXT,
      file_url       VARCHAR(512),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Елементи архіву (дипломи, протоколи, конкурси тощо)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS archive_items (
      id          SERIAL PRIMARY KEY,
      type        VARCHAR(64) NOT NULL, -- competition | protocol | diploma
      related_id  INTEGER,
      title       VARCHAR(255),
      file_url    VARCHAR(512),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Статистика (агреговані дані у форматі JSON)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statistics (
      id          SERIAL PRIMARY KEY,
      type        VARCHAR(64) NOT NULL,
      data_json   JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Сповіщення користувачів
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      message     TEXT NOT NULL,
      is_read     BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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

  console.log("[v0] База даних готова: users, user_profiles, auth_tokens, regions, cities, schools, user_roles_requests, system_logs, system_settings, competitions, competition_sections, competition_forms, competition_rules, competition_rule_files, competition_judges, competition_templates, applications, application_files, results, diplomas, protocols, archive_items, statistics, notifications");
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

// --- Завантаження файлів (положення, файли заявок) ---------------------------
const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_").slice(-80);
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${safe}`);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // до 10 МБ
});

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

// ============================================================================
//  ПАНЕЛЬ МЕТОДИСТА (роль "methodist", з доступом для admin/system)
//  Можливості: створення конкурсів, секцій, форм, положень,
//  призначення журі, публікація, шаблони, заявки, результати, аналітика.
// ============================================================================
const methodistOnly = [authRequired, roleRequired("methodist", "admin", "system")];

// Перевіряє, що конкурс належить поточному методисту (admin/system — без обмежень).
async function ownedCompetition(req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query("SELECT * FROM competitions WHERE id = $1", [id]);
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Конкурс не знайдено" });
    return null;
  }
  const competition = r.rows[0];
  const privileged = req.user.role === "admin" || req.user.role === "system";
  if (!privileged && competition.methodist_id !== req.user.id) {
    res.status(403).json({ error: "Це не ваш конкурс" });
    return null;
  }
  return competition;
}

// --- Dashboard: зведена статистика методиста ---------------------------------
app.get("/api/methodist/stats", methodistOnly, async (req, res) => {
  try {
    const mine = req.user.role === "methodist" ? "WHERE methodist_id = $1" : "";
    const params = req.user.role === "methodist" ? [req.user.id] : [];
    const [total, published, drafts, archived] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM competitions ${mine}`, params),
      pool.query(`SELECT COUNT(*)::int AS c FROM competitions ${mine ? mine + " AND" : "WHERE"} status = 'published'`, params),
      pool.query(`SELECT COUNT(*)::int AS c FROM competitions ${mine ? mine + " AND" : "WHERE"} status = 'draft'`, params),
      pool.query(`SELECT COUNT(*)::int AS c FROM competitions ${mine ? mine + " AND" : "WHERE"} status = 'archived'`, params),
    ]);
    const apps = await pool.query(
      `SELECT COUNT(*)::int AS c FROM applications a
         JOIN competitions c ON c.id = a.competition_id
        ${req.user.role === "methodist" ? "WHERE c.methodist_id = $1" : ""}`,
      params
    );
    const judges = await pool.query(
      `SELECT COUNT(*)::int AS c FROM competition_judges cj
         JOIN competitions c ON c.id = cj.competition_id
        ${req.user.role === "methodist" ? "WHERE c.methodist_id = $1" : ""}`,
      params
    );
    res.json({
      stats: {
        total: total.rows[0].c,
        published: published.rows[0].c,
        drafts: drafts.rows[0].c,
        archived: archived.rows[0].c,
        applications: apps.rows[0].c,
        judges: judges.rows[0].c,
      },
    });
  } catch (err) {
    console.log("[v0] Помилка статистики методиста:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Аналітика ---------------------------------------------------------------
app.get("/api/methodist/analytics", methodistOnly, async (req, res) => {
  try {
    const mineJoin = req.user.role === "methodist" ? "AND c.methodist_id = $1" : "";
    const params = req.user.role === "methodist" ? [req.user.id] : [];
    const byStatus = await pool.query(
      `SELECT status, COUNT(*)::int AS c FROM competitions
        ${req.user.role === "methodist" ? "WHERE methodist_id = $1" : ""}
        GROUP BY status ORDER BY status`,
      params
    );
    const appsByComp = await pool.query(
      `SELECT c.title, COUNT(a.id)::int AS applications
         FROM competitions c
         LEFT JOIN applications a ON a.competition_id = c.id
        WHERE 1=1 ${mineJoin}
        GROUP BY c.id, c.title
        ORDER BY applications DESC
        LIMIT 10`,
      params
    );
    const appsByStatus = await pool.query(
      `SELECT a.status, COUNT(*)::int AS c
         FROM applications a JOIN competitions c ON c.id = a.competition_id
        WHERE 1=1 ${mineJoin}
        GROUP BY a.status ORDER BY a.status`,
      params
    );
    res.json({ byStatus: byStatus.rows, appsByComp: appsByComp.rows, appsByStatus: appsByStatus.rows });
  } catch (err) {
    console.log("[v0] Помилка аналітики:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// ---------------------------------------------------------------------------
//  КОНКУРСИ
// ---------------------------------------------------------------------------
app.get("/api/methodist/competitions", methodistOnly, async (req, res) => {
  try {
    const archived = req.query.archived === "1";
    const conds = [];
    const params = [];
    if (req.user.role === "methodist") {
      params.push(req.user.id);
      conds.push(`c.methodist_id = $${params.length}`);
    }
    conds.push(archived ? "c.status = 'archived'" : "c.status <> 'archived'");
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const r = await pool.query(
      `SELECT c.*, p.full_name AS methodist_name,
              (SELECT COUNT(*)::int FROM competition_sections s WHERE s.competition_id = c.id) AS sections_count,
              (SELECT COUNT(*)::int FROM competition_judges j WHERE j.competition_id = c.id) AS judges_count,
              (SELECT COUNT(*)::int FROM applications a WHERE a.competition_id = c.id) AS applications_count
         FROM competitions c
         LEFT JOIN user_profiles p ON p.user_id = c.methodist_id
         ${where}
        ORDER BY c.created_at DESC`,
      params
    );
    res.json({ competitions: r.rows });
  } catch (err) {
    console.log("[v0] Помилка списку конкурсів:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

app.post("/api/methodist/competitions", methodistOnly, async (req, res) => {
  try {
    const title = (req.body?.title || "").trim();
    const description = (req.body?.description || "").trim() || null;
    const starts_at = req.body?.starts_at || null;
    const ends_at = req.body?.ends_at || null;
    if (!title) return res.status(400).json({ error: "Вкажіть назву конкурсу" });
    const r = await pool.query(
      `INSERT INTO competitions (title, description, methodist_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title, description, req.user.id, starts_at, ends_at]
    );
    // Створюємо порожню форму, щоб одразу можна було її редагувати
    await pool.query(
      `INSERT INTO competition_forms (competition_id, fields_json) VALUES ($1, '[]')
       ON CONFLICT (competition_id) DO NOTHING`,
      [r.rows[0].id]
    );
    await logAction("Створено конкурс", req.user.id, title);
    res.status(201).json({ competition: r.rows[0] });
  } catch (err) {
    console.log("[v0] Помилка створення конкурсу:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// Повна інформація про конкурс (секції, форма, положення, журі)
app.get("/api/methodist/competitions/:id", methodistOnly, async (req, res) => {
  const competition = await ownedCompetition(req, res);
  if (!competition) return;
  const [sections, form, rules, ruleFiles, judges] = await Promise.all([
    pool.query("SELECT * FROM competition_sections WHERE competition_id = $1 ORDER BY id", [competition.id]),
    pool.query("SELECT * FROM competition_forms WHERE competition_id = $1", [competition.id]),
    pool.query("SELECT * FROM competition_rules WHERE competition_id = $1", [competition.id]),
    pool.query("SELECT * FROM competition_rule_files WHERE competition_id = $1 ORDER BY id", [competition.id]),
    pool.query(
      `SELECT cj.*, u.email, pr.full_name
         FROM competition_judges cj
         JOIN users u ON u.id = cj.user_id
         LEFT JOIN user_profiles pr ON pr.user_id = u.id
        WHERE cj.competition_id = $1 ORDER BY cj.id`,
      [competition.id]
    ),
  ]);
  res.json({
    competition,
    sections: sections.rows,
    form: form.rows[0] || { fields_json: [] },
    rules: rules.rows[0] || { content: "", file_url: "" },
    ruleFiles: ruleFiles.rows,
    judges: judges.rows,
  });
});

app.patch("/api/methodist/competitions/:id", methodistOnly, async (req, res) => {
  const competition = await ownedCompetition(req, res);
  if (!competition) return;
  const title = (req.body?.title ?? competition.title).trim();
  const description = req.body?.description ?? competition.description;
  const starts_at = req.body?.starts_at ?? competition.starts_at;
  const ends_at = req.body?.ends_at ?? competition.ends_at;
  if (!title) return res.status(400).json({ error: "Назва не може бути порожньою" });
  const r = await pool.query(
    `UPDATE competitions SET title=$1, description=$2, starts_at=$3, ends_at=$4 WHERE id=$5 RETURNING *`,
    [title, description, starts_at, ends_at, competition.id]
  );
  res.json({ competition: r.rows[0] });
});

// Публікація конкурсу (потрібні секції, форма та хоча б один суддя)
app.post("/api/methodist/competitions/:id/publish", methodistOnly, async (req, res) => {
  const competition = await ownedCompetition(req, res);
  if (!competition) return;
  const sections = await pool.query("SELECT COUNT(*)::int AS c FROM competition_sections WHERE competition_id=$1", [competition.id]);
  const judges = await pool.query("SELECT COUNT(*)::int AS c FROM competition_judges WHERE competition_id=$1", [competition.id]);
  if (sections.rows[0].c === 0) return res.status(400).json({ error: "Додайте принаймні одну секцію перед публікацією" });
  if (judges.rows[0].c === 0) return res.status(400).json({ error: "Призначте принаймні одного суддю перед публікацією" });
  const r = await pool.query("UPDATE competitions SET status='published' WHERE id=$1 RETURNING *", [competition.id]);
  await logAction("Опубліковано конкурс", req.user.id, competition.title);
  res.json({ competition: r.rows[0] });
});

app.post("/api/methodist/competitions/:id/archive", methodistOnly, async (req, res) => {
  const competition = await ownedCompetition(req, res);
  if (!competition) return;
  const r = await pool.query("UPDATE competitions SET status='archived' WHERE id=$1 RETURNING *", [competition.id]);
  await logAction("Архівовано конкурс", req.user.id, competition.title);
  res.json({ competition: r.rows[0] });
});

app.post("/api/methodist/competitions/:id/restore", methodistOnly, async (req, res) => {
  const competition = await ownedCompetition(req, res);
  if (!competition) return;
  const r = await pool.query("UPDATE competitions SET status='draft' WHERE id=$1 RETURNING *", [competition.id]);
  await logAction("Відновлено конкурс з архіву", req.user.id, competition.title);
  res.json({ competition: r.rows[0] });
});

app.delete("/api/methodist/competitions/:id", methodistOnly, async (req, res) => {
  const competition = await ownedCompetition(req, res);
  if (!competition) return;
  await pool.query("DELETE FROM competitions WHERE id=$1", [competition.id]);
  await logAction("Видалено конкурс", req.user.id, competition.title);
  res.json({ message: "Конкурс видалено" });
});

// ---------------------------------------------------------------------------
//  СЕКЦІЇ
// ---------------------------------------------------------------------------
app.post("/api/methodist/competitions/:id/sections", methodistOnly, async (req, res) => {
  const competition = await ownedCompetition(req, res);
  if (!competition) return;
  const name = (req.body?.name || "").trim();
  const description = (req.body?.description || "").trim() || null;
  if (!name) return res.status(400).json({ error: "Вкажіть назву секції" });
  const r = await pool.query(
    "INSERT INTO competition_sections (competition_id, name, description) VALUES ($1,$2,$3) RETURNING *",
    [competition.id, name, description]
  );
  res.status(201).json({ section: r.rows[0] });
});

app.delete("/api/methodist/sections/:id", methodistOnly, async (req, res) => {
  const sid = parseInt(req.params.id, 10);
  const s = await pool.query(
    `SELECT s.*, c.methodist_id FROM competition_sections s
       JOIN competitions c ON c.id = s.competition_id WHERE s.id = $1`,
    [sid]
  );
  if (s.rowCount === 0) return res.status(404).json({ error: "Секцію не знайдено" });
  const privileged = req.user.role === "admin" || req.user.role === "system";
  if (!privileged && s.rows[0].methodist_id !== req.user.id) return res.status(403).json({ error: "Недостатньо прав" });
  await pool.query("DELETE FROM competition_sections WHERE id=$1", [sid]);
  res.json({ message: "Секцію видалено" });
});

// ---------------------------------------------------------------------------
//  ФОРМА ПОДАННЯ
// ---------------------------------------------------------------------------
app.put("/api/methodist/competitions/:id/form", methodistOnly, async (req, res) => {
  const competition = await ownedCompetition(req, res);
  if (!competition) return;
  const fields = Array.isArray(req.body?.fields_json) ? req.body.fields_json : [];
  const r = await pool.query(
    `INSERT INTO competition_forms (competition_id, fields_json, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (competition_id) DO UPDATE SET fields_json = EXCLUDED.fields_json, updated_at = now()
     RETURNING *`,
    [competition.id, JSON.stringify(fields)]
  );
  res.json({ form: r.rows[0] });
});

// ---------------------------------------------------------------------------
//  ПОЛОЖЕННЯ
// ---------------------------------------------------------------------------
app.put("/api/methodist/competitions/:id/rules", methodistOnly, async (req, res) => {
  const competition = await ownedCompetition(req, res);
  if (!competition) return;
  const content = req.body?.content ?? "";
  const file_url = (req.body?.file_url || "").trim() || null;
  const r = await pool.query(
    `INSERT INTO competition_rules (competition_id, content, file_url, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (competition_id) DO UPDATE SET content = EXCLUDED.content, file_url = EXCLUDED.file_url, updated_at = now()
     RETURNING *`,
    [competition.id, content, file_url]
  );
  res.json({ rules: r.rows[0] });
});

// Завантаження файлу до положення конкурсу
app.post(
  "/api/methodist/competitions/:id/rules/files",
  authRequired,
  roleRequired("methodist", "admin", "system"),
  upload.single("file"),
  async (req, res) => {
    const competition = await ownedCompetition(req, res);
    if (!competition) {
      // Видаляємо завантажений файл, якщо доступ заборонено
      if (req.file) fs.unlink(req.file.path, () => {});
      return;
    }
    if (!req.file) return res.status(400).json({ error: "Файл не надіслано" });
    const fileUrl = `/uploads/${req.file.filename}`;
    const r = await pool.query(
      `INSERT INTO competition_rule_files (competition_id, file_url, file_name, file_type)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [competition.id, fileUrl, req.file.originalname, req.file.mimetype]
    );
    // Гарантуємо наявність запису положення
    await pool.query(
      `INSERT INTO competition_rules (competition_id, content) VALUES ($1, '')
       ON CONFLICT (competition_id) DO NOTHING`,
      [competition.id]
    );
    await logAction("Додано файл до положення", req.user.id, `competition #${competition.id}: ${req.file.originalname}`);
    res.status(201).json({ file: r.rows[0] });
  }
);

// Видалення файлу положення
app.delete("/api/methodist/rule-files/:id", methodistOnly, async (req, res) => {
  const fid = parseInt(req.params.id, 10);
  const f = await pool.query(
    `SELECT rf.*, c.methodist_id FROM competition_rule_files rf
       JOIN competitions c ON c.id = rf.competition_id WHERE rf.id = $1`,
    [fid]
  );
  if (f.rowCount === 0) return res.status(404).json({ error: "Файл не знайдено" });
  const privileged = req.user.role === "admin" || req.user.role === "system";
  if (!privileged && f.rows[0].methodist_id !== req.user.id) return res.status(403).json({ error: "Недостатньо прав" });
  // Видаляємо файл з диска (ігноруємо помилку, якщо файлу вже немає)
  const diskPath = path.join(__dirname, "..", "public", f.rows[0].file_url.replace(/^\//, ""));
  fs.unlink(diskPath, () => {});
  await pool.query("DELETE FROM competition_rule_files WHERE id = $1", [fid]);
  res.json({ message: "Файл видалено" });
});

// Multer-помилки (наприклад, перевищення розміру файлу)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "Файл завеликий (макс. 10 МБ)" : "Помилка завантаження файлу";
    return res.status(400).json({ error: msg });
  }
  next(err);
});

// ---------------------------------------------------------------------------
//  ЖУРІ
// ---------------------------------------------------------------------------
// Список користувачів, які можуть бути суддями (роль jury)
app.get("/api/methodist/judges", methodistOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.email, p.full_name
       FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.role = 'jury' AND u.status = 'active'
      ORDER BY p.full_name NULLS LAST, u.email`
  );
  res.json({ judges: r.rows });
});

app.post("/api/methodist/competitions/:id/judges", methodistOnly, async (req, res) => {
  const competition = await ownedCompetition(req, res);
  if (!competition) return;
  const user_id = parseInt(req.body?.user_id, 10);
  const role = (req.body?.role || "judge").trim();
  if (!user_id) return res.status(400).json({ error: "Оберіть суддю" });
  try {
    const r = await pool.query(
      "INSERT INTO competition_judges (competition_id, user_id, role) VALUES ($1,$2,$3) RETURNING *",
      [competition.id, user_id, role]
    );
    await logAction("Призначено суддю", req.user.id, `competition #${competition.id}, user #${user_id}`);
    res.status(201).json({ judge: r.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Цього суддю вже призначено" });
    if (err.code === "23503") return res.status(400).json({ error: "Користувача не існує" });
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

app.delete("/api/methodist/judges/:id", methodistOnly, async (req, res) => {
  const jid = parseInt(req.params.id, 10);
  const j = await pool.query(
    `SELECT cj.*, c.methodist_id FROM competition_judges cj
       JOIN competitions c ON c.id = cj.competition_id WHERE cj.id = $1`,
    [jid]
  );
  if (j.rowCount === 0) return res.status(404).json({ error: "Запис не знайдено" });
  const privileged = req.user.role === "admin" || req.user.role === "system";
  if (!privileged && j.rows[0].methodist_id !== req.user.id) return res.status(403).json({ error: "Недостатньо прав" });
  await pool.query("DELETE FROM competition_judges WHERE id=$1", [jid]);
  res.json({ message: "Суддю знято" });
});

// ---------------------------------------------------------------------------
//  ШАБЛОНИ КОНКУРСІВ
// ---------------------------------------------------------------------------
app.get("/api/methodist/templates", methodistOnly, async (req, res) => {
  const params = req.user.role === "methodist" ? [req.user.id] : [];
  const r = await pool.query(
    `SELECT t.*, p.full_name AS author
       FROM competition_templates t
       LEFT JOIN user_profiles p ON p.user_id = t.methodist_id
      ${req.user.role === "methodist" ? "WHERE t.methodist_id = $1" : ""}
      ORDER BY t.created_at DESC`,
    params
  );
  res.json({ templates: r.rows });
});

app.post("/api/methodist/templates", methodistOnly, async (req, res) => {
  const name = (req.body?.name || "").trim();
  let data = req.body?.data_json ?? {};
  if (!name) return res.status(400).json({ error: "Вкажіть назву шаблону" });
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return res.status(400).json({ error: "Невірний формат JSON" }); }
  }
  const r = await pool.query(
    "INSERT INTO competition_templates (name, data_json, methodist_id) VALUES ($1,$2,$3) RETURNING *",
    [name, JSON.stringify(data), req.user.id]
  );
  res.status(201).json({ template: r.rows[0] });
});

// Створити конкурс на основі шаблону
app.post("/api/methodist/templates/:id/use", methodistOnly, async (req, res) => {
  const tid = parseInt(req.params.id, 10);
  const t = await pool.query("SELECT * FROM competition_templates WHERE id=$1", [tid]);
  if (t.rowCount === 0) return res.status(404).json({ error: "Шаблон не знайдено" });
  const data = t.rows[0].data_json || {};
  const title = (data.title || t.rows[0].name).trim();
  const comp = await pool.query(
    `INSERT INTO competitions (title, description, methodist_id, starts_at, ends_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [title, data.description || null, req.user.id, data.starts_at || null, data.ends_at || null]
  );
  const competitionId = comp.rows[0].id;
  // Секції з шаблону
  if (Array.isArray(data.sections)) {
    for (const sec of data.sections) {
      const name = typeof sec === "string" ? sec : sec?.name;
      if (name) await pool.query("INSERT INTO competition_sections (competition_id, name) VALUES ($1,$2)", [competitionId, name]);
    }
  }
  // Форма з шаблону
  await pool.query(
    `INSERT INTO competition_forms (competition_id, fields_json) VALUES ($1,$2)
     ON CONFLICT (competition_id) DO UPDATE SET fields_json = EXCLUDED.fields_json`,
    [competitionId, JSON.stringify(Array.isArray(data.fields) ? data.fields : [])]
  );
  await logAction("Створено конкурс із шаблону", req.user.id, title);
  res.status(201).json({ competition: comp.rows[0] });
});

app.delete("/api/methodist/templates/:id", methodistOnly, async (req, res) => {
  const tid = parseInt(req.params.id, 10);
  const t = await pool.query("SELECT * FROM competition_templates WHERE id=$1", [tid]);
  if (t.rowCount === 0) return res.status(404).json({ error: "Шаблон не знайдено" });
  const privileged = req.user.role === "admin" || req.user.role === "system";
  if (!privileged && t.rows[0].methodist_id !== req.user.id) return res.status(403).json({ error: "Недостатньо прав" });
  await pool.query("DELETE FROM competition_templates WHERE id=$1", [tid]);
  res.json({ message: "Шаблон видалено" });
});

// ---------------------------------------------------------------------------
//  ЗАЯВКИ
// ---------------------------------------------------------------------------
app.get("/api/methodist/applications", methodistOnly, async (req, res) => {
  const params = req.user.role === "methodist" ? [req.user.id] : [];
  const r = await pool.query(
    `SELECT a.*, c.title AS competition_title, s.name AS section_name,
            sp.full_name AS student_name, su.email AS student_email,
            (SELECT COUNT(*)::int FROM application_files f WHERE f.application_id = a.id) AS files_count
       FROM applications a
       JOIN competitions c ON c.id = a.competition_id
       LEFT JOIN competition_sections s ON s.id = a.section_id
       LEFT JOIN users su ON su.id = a.student_id
       LEFT JOIN user_profiles sp ON sp.user_id = a.student_id
      ${req.user.role === "methodist" ? "WHERE c.methodist_id = $1" : ""}
      ORDER BY a.created_at DESC`,
    params
  );
  res.json({ applications: r.rows });
});

app.patch("/api/methodist/applications/:id", methodistOnly, async (req, res) => {
  const aid = parseInt(req.params.id, 10);
  const { status } = req.body || {};
  if (!["submitted", "accepted", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Невідомий статус" });
  }
  const a = await pool.query(
    `SELECT a.id, c.methodist_id FROM applications a
       JOIN competitions c ON c.id = a.competition_id WHERE a.id = $1`,
    [aid]
  );
  if (a.rowCount === 0) return res.status(404).json({ error: "Заявку не знайдено" });
  const privileged = req.user.role === "admin" || req.user.role === "system";
  if (!privileged && a.rows[0].methodist_id !== req.user.id) return res.status(403).json({ error: "Недостатньо прав" });
  const r = await pool.query("UPDATE applications SET status=$1 WHERE id=$2 RETURNING *", [status, aid]);
  res.json({ application: r.rows[0] });
});

// ---------------------------------------------------------------------------
//  РЕЗУЛЬТАТИ
// ---------------------------------------------------------------------------
app.get("/api/methodist/results", methodistOnly, async (req, res) => {
  const params = req.user.role === "methodist" ? [req.user.id] : [];
  const r = await pool.query(
    `SELECT res.*, a.title AS application_title, c.title AS competition_title,
            jp.full_name AS judge_name, ju.email AS judge_email,
            sp.full_name AS student_name
       FROM results res
       JOIN applications a ON a.id = res.application_id
       JOIN competitions c ON c.id = a.competition_id
       LEFT JOIN users ju ON ju.id = res.judge_id
       LEFT JOIN user_profiles jp ON jp.user_id = res.judge_id
       LEFT JOIN user_profiles sp ON sp.user_id = a.student_id
      ${req.user.role === "methodist" ? "WHERE c.methodist_id = $1" : ""}
      ORDER BY res.created_at DESC`,
    params
  );
  res.json({ results: r.rows });
});

// ---------------------------------------------------------------------------
//  ПР��ФІЛЬ
// ---------------------------------------------------------------------------
app.put("/api/methodist/profile", methodistOnly, async (req, res) => {
  const full_name = (req.body?.full_name || "").trim() || null;
  const phone = (req.body?.phone || "").trim() || null;
  const upd = await pool.query(
    "UPDATE user_profiles SET full_name=$2, phone=$3 WHERE user_id=$1 RETURNING id",
    [req.user.id, full_name, phone]
  );
  if (upd.rowCount === 0) {
    await pool.query(
      "INSERT INTO user_profiles (user_id, full_name, phone) VALUES ($1,$2,$3)",
      [req.user.id, full_name, phone]
    );
  }
  res.json({ message: "Профіль збережено" });
});

// ============================================================================
//  ПАНЕЛЬ ЗАВУЧА (роль "zavuch", з доступом для admin/system)
//  Можливості: підтвердження вчителів, контроль учнів,
//  статистика школи, конкурси школи, профіль.
// ============================================================================
const zavuchOnly = [authRequired, roleRequired("zavuch", "admin", "system")];

// Повертає школу, якою керує поточний завуч.
// Для admin/system — школа з ?school_id або перша наявна.
async function getZavuchSchool(req) {
  const privileged = req.user.role === "admin" || req.user.role === "system";
  if (privileged) {
    const sid = parseInt(req.query.school_id, 10);
    if (sid) {
      const r = await pool.query("SELECT * FROM schools WHERE id = $1", [sid]);
      return r.rows[0] || null;
    }
    const r = await pool.query("SELECT * FROM schools ORDER BY id LIMIT 1");
    return r.rows[0] || null;
  }
  const r = await pool.query(
    "SELECT * FROM schools WHERE zavuch_id = $1 ORDER BY id LIMIT 1",
    [req.user.id]
  );
  return r.rows[0] || null;
}

// Знаходить користувача за email (для додавання вчителя/учня)
async function findUserByEmail(email) {
  const r = await pool.query("SELECT id, email FROM users WHERE email = $1", [
    (email || "").toLowerCase(),
  ]);
  return r.rows[0] || null;
}

// --- Поточна школа завуча + перелік шкіл для вибору --------------------------
app.get("/api/zavuch/me", zavuchOnly, async (req, res) => {
  try {
    const school = await getZavuchSchool(req);
    // Школи, ще не закріплені за жодним завучем (для першого вибору)
    const free = await pool.query(
      `SELECT s.id, s.name, c.name AS city_name, r.name AS region_name
         FROM schools s
         JOIN cities c ON c.id = s.city_id
         JOIN regions r ON r.id = c.region_id
        WHERE s.zavuch_id IS NULL
        ORDER BY r.name, c.name, s.name`
    );
    let schoolInfo = null;
    if (school) {
      const info = await pool.query(
        `SELECT s.*, c.name AS city_name, r.name AS region_name
           FROM schools s
           JOIN cities c ON c.id = s.city_id
           JOIN regions r ON r.id = c.region_id
          WHERE s.id = $1`,
        [school.id]
      );
      schoolInfo = info.rows[0];
    }
    res.json({ school: schoolInfo, freeSchools: free.rows, role: req.user.role });
  } catch (err) {
    console.log("[v0] Помилка /zavuch/me:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Закріпити школу за завучем (перший вхід) --------------------------------
app.post("/api/zavuch/school", zavuchOnly, async (req, res) => {
  try {
    const schoolId = parseInt(req.body?.school_id, 10);
    if (!schoolId) return res.status(400).json({ error: "Оберіть школу" });
    const privileged = req.user.role === "admin" || req.user.role === "system";

    const s = await pool.query("SELECT * FROM schools WHERE id = $1", [schoolId]);
    if (s.rowCount === 0) return res.status(404).json({ error: "Школу не знайдено" });
    if (!privileged && s.rows[0].zavuch_id && s.rows[0].zavuch_id !== req.user.id) {
      return res.status(409).json({ error: "Школа вже має завуча" });
    }
    await pool.query("UPDATE schools SET zavuch_id = $1 WHERE id = $2", [req.user.id, schoolId]);
    await logAction("Завуч закріпив школу", req.user.id, s.rows[0].name);
    res.json({ message: "Школу закріплено за вами" });
  } catch (err) {
    console.log("[v0] Помилка /zavuch/school:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Dashboard: статистика школи ---------------------------------------------
app.get("/api/zavuch/stats", zavuchOnly, async (req, res) => {
  try {
    const school = await getZavuchSchool(req);
    if (!school) return res.json({ stats: null });
    const [teachers, confirmed, pending, students, competitions, applications] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS c FROM teachers WHERE school_id = $1", [school.id]),
      pool.query("SELECT COUNT(*)::int AS c FROM teachers WHERE school_id = $1 AND confirmed = true", [school.id]),
      pool.query("SELECT COUNT(*)::int AS c FROM teachers WHERE school_id = $1 AND confirmed = false", [school.id]),
      pool.query("SELECT COUNT(*)::int AS c FROM students WHERE school_id = $1", [school.id]),
      pool.query(
        `SELECT COUNT(DISTINCT a.competition_id)::int AS c FROM applications a
          WHERE a.student_id IN (SELECT user_id FROM students WHERE school_id = $1)`,
        [school.id]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM applications a
          WHERE a.student_id IN (SELECT user_id FROM students WHERE school_id = $1)`,
        [school.id]
      ),
    ]);
    res.json({
      stats: {
        teachers: teachers.rows[0].c,
        confirmedTeachers: confirmed.rows[0].c,
        pendingTeachers: pending.rows[0].c,
        students: students.rows[0].c,
        competitions: competitions.rows[0].c,
        applications: applications.rows[0].c,
      },
    });
  } catch (err) {
    console.log("[v0] Помилка статистики завуча:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// ---------------------------------------------------------------------------
//  ВЧИТЕЛІ ШКОЛИ
// ---------------------------------------------------------------------------
app.get("/api/zavuch/teachers", zavuchOnly, async (req, res) => {
  const school = await getZavuchSchool(req);
  if (!school) return res.json({ teachers: [] });
  const r = await pool.query(
    `SELECT t.id, t.confirmed, t.created_at, u.email, p.full_name, p.phone
       FROM teachers t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE t.school_id = $1
      ORDER BY t.confirmed ASC, p.full_name NULLS LAST, u.email`,
    [school.id]
  );
  res.json({ teachers: r.rows });
});

// Додати вчителя за email (користувач має існувати)
app.post("/api/zavuch/teachers", zavuchOnly, async (req, res) => {
  try {
    const school = await getZavuchSchool(req);
    if (!school) return res.status(400).json({ error: "Спочатку оберіть школу" });
    const user = await findUserByEmail(req.body?.email);
    if (!user) return res.status(404).json({ error: "Користувача з таким email не знайдено" });
    const exists = await pool.query(
      "SELECT id FROM teachers WHERE user_id = $1 AND school_id = $2",
      [user.id, school.id]
    );
    if (exists.rowCount > 0) return res.status(409).json({ error: "Вчитель уже у списку школи" });
    await pool.query(
      "INSERT INTO teachers (user_id, school_id, confirmed) VALUES ($1, $2, false)",
      [user.id, school.id]
    );
    await logAction("Завуч додав вчителя", req.user.id, user.email);
    res.status(201).json({ message: "Вчителя додано (очікує підтвердження)" });
  } catch (err) {
    console.log("[v0] Помилка додавання вчителя:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// Підтвердити / зняти підтвердження вчителя
app.patch("/api/zavuch/teachers/:id", zavuchOnly, async (req, res) => {
  try {
    const school = await getZavuchSchool(req);
    if (!school) return res.status(400).json({ error: "Школу не визначено" });
    const id = parseInt(req.params.id, 10);
    const confirmed = !!req.body?.confirmed;
    const t = await pool.query(
      "SELECT * FROM teachers WHERE id = $1 AND school_id = $2",
      [id, school.id]
    );
    if (t.rowCount === 0) return res.status(404).json({ error: "Вчителя не знайдено" });
    await pool.query("UPDATE teachers SET confirmed = $1 WHERE id = $2", [confirmed, id]);
    // Підтвердж��ний вчитель отримує роль "teacher"
    if (confirmed) {
      await pool.query(
        "UPDATE users SET role = 'teacher' WHERE id = $1 AND role IN ('guest','teacher')",
        [t.rows[0].user_id]
      );
    }
    await logAction(
      confirmed ? "Завуч підтвердив вчителя" : "Завуч зняв підтвердження вчителя",
      req.user.id,
      `teacher #${id}`
    );
    res.json({ message: confirmed ? "Вчителя підтверджено" : "Підтвердження знято" });
  } catch (err) {
    console.log("[v0] Помилка підтвердження вчителя:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

app.delete("/api/zavuch/teachers/:id", zavuchOnly, async (req, res) => {
  const school = await getZavuchSchool(req);
  if (!school) return res.status(400).json({ error: "Школу не визначено" });
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    "DELETE FROM teachers WHERE id = $1 AND school_id = $2 RETURNING id",
    [id, school.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Вчителя не знайдено" });
  res.json({ message: "Вчителя видалено зі школи" });
});

// ---------------------------------------------------------------------------
//  УЧНІ ШКОЛИ
// ---------------------------------------------------------------------------
app.get("/api/zavuch/students", zavuchOnly, async (req, res) => {
  const school = await getZavuchSchool(req);
  if (!school) return res.json({ students: [] });
  const r = await pool.query(
    `SELECT st.id, st.class, st.created_at, u.email, p.full_name,
            (SELECT COUNT(*)::int FROM applications a WHERE a.student_id = u.id) AS applications
       FROM students st
       JOIN users u ON u.id = st.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE st.school_id = $1
      ORDER BY st.class NULLS LAST, p.full_name NULLS LAST, u.email`,
    [school.id]
  );
  res.json({ students: r.rows });
});

app.post("/api/zavuch/students", zavuchOnly, async (req, res) => {
  try {
    const school = await getZavuchSchool(req);
    if (!school) return res.status(400).json({ error: "Спочатку оберіть школу" });
    const user = await findUserByEmail(req.body?.email);
    if (!user) return res.status(404).json({ error: "Користувача з таким email не знайдено" });
    const klass = (req.body?.class || "").trim() || null;
    const exists = await pool.query(
      "SELECT id FROM students WHERE user_id = $1 AND school_id = $2",
      [user.id, school.id]
    );
    if (exists.rowCount > 0) return res.status(409).json({ error: "Учень уже у списку школи" });
    await pool.query(
      "INSERT INTO students (user_id, school_id, class) VALUES ($1, $2, $3)",
      [user.id, school.id, klass]
    );
    await pool.query(
      "UPDATE users SET role = 'student' WHERE id = $1 AND role = 'guest'",
      [user.id]
    );
    await logAction("Завуч додав учня", req.user.id, user.email);
    res.status(201).json({ message: "Учня додано до школи" });
  } catch (err) {
    console.log("[v0] Помилка додавання учня:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

app.patch("/api/zavuch/students/:id", zavuchOnly, async (req, res) => {
  const school = await getZavuchSchool(req);
  if (!school) return res.status(400).json({ error: "Школу не визначено" });
  const id = parseInt(req.params.id, 10);
  const klass = (req.body?.class || "").trim() || null;
  const r = await pool.query(
    "UPDATE students SET class = $1 WHERE id = $2 AND school_id = $3 RETURNING id",
    [klass, id, school.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Учня не знайдено" });
  res.json({ message: "Дані учня оновлено" });
});

app.delete("/api/zavuch/students/:id", zavuchOnly, async (req, res) => {
  const school = await getZavuchSchool(req);
  if (!school) return res.status(400).json({ error: "Школу не визначено" });
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    "DELETE FROM students WHERE id = $1 AND school_id = $2 RETURNING id",
    [id, school.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Учня не знайдено" });
  res.json({ message: "Учня видалено зі школи" });
});

// ---------------------------------------------------------------------------
//  КОНКУРСИ ШКОЛИ (у яких беруть участь учні школи)
// ---------------------------------------------------------------------------
app.get("/api/zavuch/competitions", zavuchOnly, async (req, res) => {
  const school = await getZavuchSchool(req);
  if (!school) return res.json({ competitions: [] });
  const r = await pool.query(
    `SELECT c.id, c.title, c.status, c.starts_at, c.ends_at,
            COUNT(a.id)::int AS applications,
            COUNT(*) FILTER (WHERE a.status = 'accepted')::int AS accepted,
            COUNT(*) FILTER (WHERE a.status = 'rejected')::int AS rejected
       FROM competitions c
       JOIN applications a ON a.competition_id = c.id
      WHERE a.student_id IN (SELECT user_id FROM students WHERE school_id = $1)
      GROUP BY c.id
      ORDER BY c.created_at DESC`,
    [school.id]
  );
  res.json({ competitions: r.rows });
});

// ---------------------------------------------------------------------------
//  ПРОФІЛЬ ЗАВУЧА
// ---------------------------------------------------------------------------
app.put("/api/zavuch/profile", zavuchOnly, async (req, res) => {
  const full_name = (req.body?.full_name || "").trim() || null;
  const phone = (req.body?.phone || "").trim() || null;
  const upd = await pool.query(
    "UPDATE user_profiles SET full_name = $2, phone = $3 WHERE user_id = $1 RETURNING id",
    [req.user.id, full_name, phone]
  );
  if (upd.rowCount === 0) {
    await pool.query(
      "INSERT INTO user_profiles (user_id, full_name, phone) VALUES ($1,$2,$3)",
      [req.user.id, full_name, phone]
    );
  }
  res.json({ message: "Профіль збережено" });
});

// ============================================================================
//  ПАНЕЛЬ ВЧИТЕЛЯ (роль "teacher", з доступом для admin/system)
//  Можливості (див. схему "4. ВЧИТЕЛЬ"):
//  Створює учнів → Допомагає подати заявку → Переглядає результати.
//  Сторінки: Dashboard, Мої учні, Всі конкурси, Мої конкурси,
//  Подати учня, Результати, Аналітика, Профіль.
// ============================================================================
const teacherOnly = [authRequired, roleRequired("teacher", "admin", "system")];

// Школа, до якої прикріплено вчителя (через таблицю teachers, confirmed = true).
// Для admin/system — перша школа або ?school_id.
async function getTeacherSchool(req) {
  const privileged = req.user.role === "admin" || req.user.role === "system";
  if (privileged) {
    const sid = parseInt(req.query.school_id, 10);
    if (sid) {
      const r = await pool.query("SELECT * FROM schools WHERE id = $1", [sid]);
      return r.rows[0] || null;
    }
    const r = await pool.query("SELECT * FROM schools ORDER BY id LIMIT 1");
    return r.rows[0] || null;
  }
  const r = await pool.query(
    `SELECT s.* FROM schools s
       JOIN teachers t ON t.school_id = s.id
      WHERE t.user_id = $1 AND t.confirmed = true
      ORDER BY s.id LIMIT 1`,
    [req.user.id]
  );
  return r.rows[0] || null;
}

// --- Інформація про вчителя: школа + статус підтвердження --------------------
app.get("/api/teacher/me", teacherOnly, async (req, res) => {
  try {
    const privileged = req.user.role === "admin" || req.user.role === "system";
    const school = await getTeacherSchool(req);
    let confirmed = privileged;
    if (!privileged) {
      const t = await pool.query(
        "SELECT confirmed FROM teachers WHERE user_id = $1 ORDER BY id LIMIT 1",
        [req.user.id]
      );
      confirmed = t.rows[0]?.confirmed === true;
    }
    let schoolInfo = null;
    if (school) {
      const info = await pool.query(
        `SELECT s.id, s.name, c.name AS city_name, r.name AS region_name
           FROM schools s
           JOIN cities c ON c.id = s.city_id
           JOIN regions r ON r.id = c.region_id
          WHERE s.id = $1`,
        [school.id]
      );
      schoolInfo = info.rows[0];
    }
    res.json({ school: schoolInfo, confirmed, role: req.user.role });
  } catch (err) {
    console.log("[v0] Помилка /teacher/me:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Dashboard / Аналітика: статистика вчителя -------------------------------
app.get("/api/teacher/stats", teacherOnly, async (req, res) => {
  try {
    const teacherId = req.user.id;
    const school = await getTeacherSchool(req);
    const privileged = req.user.role === "admin" || req.user.role === "system";
    // Для admin/system показуємо по школі, інакше — по закріплених учнях вчителя
    const studentFilter = privileged && school
      ? { sql: "school_id = $1", val: [school.id] }
      : { sql: "teacher_id = $1", val: [teacherId] };

    const [students, apps, accepted, rejected, pending, scored, avg] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM students WHERE ${studentFilter.sql}`, studentFilter.val),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM applications
          WHERE student_id IN (SELECT user_id FROM students WHERE ${studentFilter.sql})`,
        studentFilter.val
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM applications
          WHERE status = 'accepted' AND student_id IN (SELECT user_id FROM students WHERE ${studentFilter.sql})`,
        studentFilter.val
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM applications
          WHERE status = 'rejected' AND student_id IN (SELECT user_id FROM students WHERE ${studentFilter.sql})`,
        studentFilter.val
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM applications
          WHERE status = 'submitted' AND student_id IN (SELECT user_id FROM students WHERE ${studentFilter.sql})`,
        studentFilter.val
      ),
      pool.query(
        `SELECT COUNT(DISTINCT r.application_id)::int AS c FROM results r
          WHERE r.application_id IN (
            SELECT id FROM applications
             WHERE student_id IN (SELECT user_id FROM students WHERE ${studentFilter.sql}))`,
        studentFilter.val
      ),
      pool.query(
        `SELECT COALESCE(ROUND(AVG(r.score), 2), 0) AS avg FROM results r
          WHERE r.application_id IN (
            SELECT id FROM applications
             WHERE student_id IN (SELECT user_id FROM students WHERE ${studentFilter.sql}))`,
        studentFilter.val
      ),
    ]);
    res.json({
      stats: {
        students: students.rows[0].c,
        applications: apps.rows[0].c,
        accepted: accepted.rows[0].c,
        rejected: rejected.rows[0].c,
        pending: pending.rows[0].c,
        scored: scored.rows[0].c,
        avgScore: Number(avg.rows[0].avg),
      },
    });
  } catch (err) {
    console.log("[v0] Помилка статистики вчителя:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// ---------------------------------------------------------------------------
//  МОЇ УЧНІ — вчитель створює/закріплює учнів
// ---------------------------------------------------------------------------
app.get("/api/teacher/students", teacherOnly, async (req, res) => {
  const privileged = req.user.role === "admin" || req.user.role === "system";
  const school = await getTeacherSchool(req);
  // Закріплені за вчителем учні; для admin/system — усі учні школи
  const where = privileged && school ? "st.school_id = $1" : "st.teacher_id = $1";
  const val = privileged && school ? [school.id] : [req.user.id];
  const r = await pool.query(
    `SELECT st.id, st.class, st.created_at, u.id AS user_id, u.email, p.full_name,
            (SELECT COUNT(*)::int FROM applications a WHERE a.student_id = u.id) AS applications
       FROM students st
       JOIN users u ON u.id = st.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ${where}
      ORDER BY st.class NULLS LAST, p.full_name NULLS LAST, u.email`,
    val
  );
  res.json({ students: r.rows });
});

// Закріпити існуючого учня (за email) за собою. Якщо учня ще немає у школі — створити.
app.post("/api/teacher/students", teacherOnly, async (req, res) => {
  try {
    const school = await getTeacherSchool(req);
    if (!school) return res.status(400).json({ error: "Вас не закріплено за школою" });
    const email = (req.body?.email || "").toLowerCase().trim();
    const klass = (req.body?.class || "").trim() || null;
    if (!isValidEmail(email)) return res.status(400).json({ error: "Некоректний email" });

    const u = await pool.query("SELECT id, email FROM users WHERE email = $1", [email]);
    if (u.rowCount === 0) {
      return res.status(404).json({ error: "Користувача з таким email не знайдено. Спершу він має зареєструватися." });
    }
    const userId = u.rows[0].id;
    const existing = await pool.query(
      "SELECT id FROM students WHERE user_id = $1 AND school_id = $2",
      [userId, school.id]
    );
    if (existing.rowCount > 0) {
      // вже у школі — лише закріплюємо за вчителем
      await pool.query(
        "UPDATE students SET teacher_id = $1, class = COALESCE($2, class) WHERE id = $3",
        [req.user.id, klass, existing.rows[0].id]
      );
    } else {
      await pool.query(
        "INSERT INTO students (user_id, school_id, class, teacher_id) VALUES ($1,$2,$3,$4)",
        [userId, school.id, klass, req.user.id]
      );
    }
    await pool.query("UPDATE users SET role = 'student' WHERE id = $1 AND role = 'guest'", [userId]);
    await logAction("Вчитель закріпив учня", req.user.id, email);
    res.status(201).json({ message: "Учня закріплено за вами" });
  } catch (err) {
    console.log("[v0] Помилка створення учня вчителем:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

app.patch("/api/teacher/students/:id", teacherOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const klass = (req.body?.class || "").trim() || null;
  const privileged = req.user.role === "admin" || req.user.role === "system";
  const where = privileged ? "id = $2" : "id = $2 AND teacher_id = $1";
  const val = privileged ? [req.user.id, id] : [req.user.id, id];
  const r = await pool.query(
    `UPDATE students SET class = $3 WHERE ${where} RETURNING id`,
    [...val, klass]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Учня не знайдено" });
  res.json({ message: "Дані учня оновлено" });
});

// Відкріпити учня від себе (не видаляє зі школи)
app.delete("/api/teacher/students/:id", teacherOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    "UPDATE students SET teacher_id = NULL WHERE id = $1 AND teacher_id = $2 RETURNING id",
    [id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Учня не знайдено серед ваших" });
  res.json({ message: "Учня відкріплено" });
});

// ---------------------------------------------------------------------------
//  ВСІ КОНКУРСИ — опубліковані конкурси, доступні для подання
// ---------------------------------------------------------------------------
app.get("/api/teacher/competitions", teacherOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT c.id, c.title, c.description, c.status, c.starts_at, c.ends_at,
            (SELECT COUNT(*)::int FROM competition_sections s WHERE s.competition_id = c.id) AS sections
       FROM competitions c
      WHERE c.status = 'published'
      ORDER BY c.starts_at NULLS LAST, c.created_at DESC`
  );
  res.json({ competitions: r.rows });
});

// Секції конкретного конкурсу (для форми подання)
app.get("/api/teacher/competitions/:id/sections", teacherOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    "SELECT id, name, description FROM competition_sections WHERE competition_id = $1 ORDER BY name",
    [id]
  );
  res.json({ sections: r.rows });
});

// ---------------------------------------------------------------------------
//  МОЇ КОНКУРСИ — конкурси, у яких беруть участь учні вчителя
// ---------------------------------------------------------------------------
app.get("/api/teacher/my-competitions", teacherOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT c.id, c.title, c.status, c.starts_at, c.ends_at,
            COUNT(a.id)::int AS applications,
            COUNT(*) FILTER (WHERE a.status = 'accepted')::int AS accepted,
            COUNT(*) FILTER (WHERE a.status = 'rejected')::int AS rejected,
            COUNT(*) FILTER (WHERE a.status = 'submitted')::int AS pending
       FROM competitions c
       JOIN applications a ON a.competition_id = c.id
      WHERE a.student_id IN (SELECT user_id FROM students WHERE teacher_id = $1)
      GROUP BY c.id
      ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  res.json({ competitions: r.rows });
});

// ---------------------------------------------------------------------------
//  ПОДАТИ УЧНЯ — вчитель допомагає подати заявку від імені учня
// ---------------------------------------------------------------------------
app.post("/api/teacher/applications", teacherOnly, async (req, res) => {
  try {
    const competitionId = parseInt(req.body?.competition_id, 10);
    const studentId = parseInt(req.body?.student_id, 10); // user_id учня
    const sectionId = req.body?.section_id ? parseInt(req.body.section_id, 10) : null;
    const title = (req.body?.title || "").trim() || null;
    if (!competitionId || !studentId) {
      return res.status(400).json({ error: "Оберіть конкурс і учня" });
    }
    // Перевіряємо, що учень закріплений за вчителем (для admin/system — пропускаємо)
    const privileged = req.user.role === "admin" || req.user.role === "system";
    if (!privileged) {
      const own = await pool.query(
        "SELECT id FROM students WHERE user_id = $1 AND teacher_id = $2",
        [studentId, req.user.id]
      );
      if (own.rowCount === 0) {
        return res.status(403).json({ error: "Цей учень не закріплений за вами" });
      }
    }
    const comp = await pool.query(
      "SELECT id, status FROM competitions WHERE id = $1",
      [competitionId]
    );
    if (comp.rowCount === 0) return res.status(404).json({ error: "Конкурс не знайдено" });
    if (comp.rows[0].status !== "published") {
      return res.status(400).json({ error: "Подання можливе лише до опублікованих конкурсів" });
    }
    const ins = await pool.query(
      `INSERT INTO applications (competition_id, student_id, section_id, title, status)
       VALUES ($1,$2,$3,$4,'submitted') RETURNING id`,
      [competitionId, studentId, sectionId, title]
    );
    await logAction("Вчитель подав заявку учня", req.user.id, `application #${ins.rows[0].id}`);
    res.status(201).json({ message: "Заявку подано", id: ins.rows[0].id });
  } catch (err) {
    console.log("[v0] Помилка подання заявки вчителем:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// ---------------------------------------------------------------------------
//  РЕЗУЛЬТАТИ — вчитель переглядає оцінки заявок своїх учн��в
// ---------------------------------------------------------------------------
app.get("/api/teacher/results", teacherOnly, async (req, res) => {
  const privileged = req.user.role === "admin" || req.user.role === "system";
  const where = privileged ? "1=1" : "st.teacher_id = $1";
  const val = privileged ? [] : [req.user.id];
  const r = await pool.query(
    `SELECT a.id AS application_id, a.title, a.status, a.created_at,
            c.title AS competition_title,
            sec.name AS section_name,
            p.full_name AS student_name, u.email AS student_email,
            r.score, r.comment,
            jp.full_name AS judge_name
       FROM applications a
       JOIN students st ON st.user_id = a.student_id
       JOIN users u ON u.id = a.student_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
       JOIN competitions c ON c.id = a.competition_id
       LEFT JOIN competition_sections sec ON sec.id = a.section_id
       LEFT JOIN results r ON r.application_id = a.id
       LEFT JOIN user_profiles jp ON jp.user_id = r.judge_id
      WHERE ${where}
      ORDER BY a.created_at DESC`,
    val
  );
  res.json({ results: r.rows });
});

// ---------------------------------------------------------------------------
//  ПРОФІЛЬ ВЧИТЕЛЯ
// ---------------------------------------------------------------------------
app.put("/api/teacher/profile", teacherOnly, async (req, res) => {
  const full_name = (req.body?.full_name || "").trim() || null;
  const phone = (req.body?.phone || "").trim() || null;
  const upd = await pool.query(
    "UPDATE user_profiles SET full_name = $2, phone = $3 WHERE user_id = $1 RETURNING id",
    [req.user.id, full_name, phone]
  );
  if (upd.rowCount === 0) {
    await pool.query(
      "INSERT INTO user_profiles (user_id, full_name, phone) VALUES ($1,$2,$3)",
      [req.user.id, full_name, phone]
    );
  }
  res.json({ message: "Профіль збережено" });
});

// ============================================================================
//  ПАНЕЛЬ УЧНЯ (роль "student") — див. схему "3. УЧЕНЬ"
//  Учень: переглядає конкурси, подає власні заявки, бачить результати/дипломи
// ============================================================================
const studentOnly = [authRequired, roleRequired("student", "admin", "system")];

// --- Інформація про учня: школа, клас, закріплений учитель -------------------
app.get("/api/student/me", studentOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT st.class,
              s.name AS school_name, c.name AS city_name, reg.name AS region_name,
              tp.full_name AS teacher_name
         FROM students st
         LEFT JOIN schools s ON s.id = st.school_id
         LEFT JOIN cities c ON c.id = s.city_id
         LEFT JOIN regions reg ON reg.id = c.region_id
         LEFT JOIN user_profiles tp ON tp.user_id = st.teacher_id
        WHERE st.user_id = $1
        ORDER BY st.id LIMIT 1`,
      [req.user.id]
    );
    res.json({ info: r.rows[0] || null });
  } catch (err) {
    console.log("[v0] Помилка /student/me:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Dashboard: статистика учня ----------------------------------------------
app.get("/api/student/stats", studentOnly, async (req, res) => {
  try {
    const uid = req.user.id;
    const [apps, accepted, rejected, pending, scored, avg, diplomas] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS c FROM applications WHERE student_id = $1", [uid]),
      pool.query("SELECT COUNT(*)::int AS c FROM applications WHERE student_id = $1 AND status = 'accepted'", [uid]),
      pool.query("SELECT COUNT(*)::int AS c FROM applications WHERE student_id = $1 AND status = 'rejected'", [uid]),
      pool.query("SELECT COUNT(*)::int AS c FROM applications WHERE student_id = $1 AND status = 'submitted'", [uid]),
      pool.query(
        `SELECT COUNT(DISTINCT r.application_id)::int AS c FROM results r
          WHERE r.application_id IN (SELECT id FROM applications WHERE student_id = $1)`,
        [uid]
      ),
      pool.query(
        `SELECT COALESCE(ROUND(AVG(r.score), 2), 0) AS avg FROM results r
          WHERE r.application_id IN (SELECT id FROM applications WHERE student_id = $1)`,
        [uid]
      ),
      pool.query("SELECT COUNT(*)::int AS c FROM diplomas WHERE student_id = $1", [uid]),
    ]);
    res.json({
      stats: {
        applications: apps.rows[0].c,
        accepted: accepted.rows[0].c,
        rejected: rejected.rows[0].c,
        pending: pending.rows[0].c,
        scored: scored.rows[0].c,
        avgScore: Number(avg.rows[0].avg),
        diplomas: diplomas.rows[0].c,
      },
    });
  } catch (err) {
    console.log("[v0] Помилка статистики учня:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Опубліковані конкурси ----------------------------------------------------
app.get("/api/student/competitions", studentOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT c.id, c.title, c.description, c.status, c.starts_at, c.ends_at,
            (SELECT COUNT(*)::int FROM competition_sections s WHERE s.competition_id = c.id) AS sections,
            EXISTS (SELECT 1 FROM applications a WHERE a.competition_id = c.id AND a.student_id = $1) AS applied
       FROM competitions c
      WHERE c.status = 'published'
      ORDER BY c.starts_at NULLS LAST, c.created_at DESC`,
    [req.user.id]
  );
  res.json({ competitions: r.rows });
});

// --- Секції конкурсу ----------------------------------------------------------
app.get("/api/student/competitions/:id/sections", studentOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    "SELECT id, name, description FROM competition_sections WHERE competition_id = $1 ORDER BY name",
    [id]
  );
  res.json({ sections: r.rows });
});

// --- Форма подання конкурсу (поля, які створив методист) ----------------------
app.get("/api/student/competitions/:id/form", studentOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    "SELECT fields_json FROM competition_forms WHERE competition_id = $1",
    [id]
  );
  const fields = r.rowCount > 0 && Array.isArray(r.rows[0].fields_json) ? r.rows[0].fields_json : [];
  res.json({ fields });
});

// --- Подати власну заявку -----------------------------------------------------
//  upload.any() дозволяє приймати як звичайний JSON, так і multipart/form-data
//  (коли у формі конкурсу є поля типу "файл").
app.post("/api/student/applications", studentOnly, upload.any(), async (req, res) => {
  try {
    const competitionId = parseInt(req.body?.competition_id, 10);
    const sectionId = req.body?.section_id ? parseInt(req.body.section_id, 10) : null;
    const title = (req.body?.title || "").trim() || null;
    if (!competitionId) return res.status(400).json({ error: "Оберіть конкурс" });

    // Відповіді на поля форми конкурсу
    let dataJson = {};
    if (req.body?.data_json) {
      try {
        const parsed = JSON.parse(req.body.data_json);
        if (parsed && typeof parsed === "object") dataJson = parsed;
      } catch {
        dataJson = {};
      }
    }

    const comp = await pool.query("SELECT id, status, title FROM competitions WHERE id = $1", [competitionId]);
    if (comp.rowCount === 0) return res.status(404).json({ error: "Конкурс не знайдено" });
    if (comp.rows[0].status !== "published") {
      return res.status(400).json({ error: "Подання можливе лише до опублікованих конкурсів" });
    }
    const dup = await pool.query(
      "SELECT id FROM applications WHERE competition_id = $1 AND student_id = $2",
      [competitionId, req.user.id]
    );
    if (dup.rowCount > 0) {
      return res.status(409).json({ error: "Ви вже подали заявку на цей конкурс" });
    }

    // Перевірка обов'язкових полів форми
    const formRow = await pool.query(
      "SELECT fields_json FROM competition_forms WHERE competition_id = $1",
      [competitionId]
    );
    const fields = formRow.rowCount > 0 && Array.isArray(formRow.rows[0].fields_json) ? formRow.rows[0].fields_json : [];
    const fileMap = {};
    (req.files || []).forEach((f) => {
      fileMap[f.fieldname] = f;
    });
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f.required) continue;
      if (f.type === "file") {
        if (!fileMap[`field_${i}`]) {
          return res.status(400).json({ error: `Завантажте файл: «${f.label}»` });
        }
      } else {
        const val = dataJson[f.label];
        if (val == null || String(val).trim() === "") {
          return res.status(400).json({ error: `Заповніть поле: «${f.label}»` });
        }
      }
    }

    const ins = await pool.query(
      `INSERT INTO applications (competition_id, student_id, section_id, title, data_json, status)
       VALUES ($1,$2,$3,$4,$5,'submitted') RETURNING id`,
      [competitionId, req.user.id, sectionId, title, JSON.stringify(dataJson)]
    );
    const applicationId = ins.rows[0].id;

    // Зберігаємо завантажені файли
    for (const file of req.files || []) {
      await pool.query(
        `INSERT INTO application_files (application_id, file_url, file_type) VALUES ($1,$2,$3)`,
        [applicationId, `/uploads/${file.filename}`, file.mimetype]
      );
    }

    await logAction("Учень подав заявку", req.user.id, `application #${applicationId}`);
    res.status(201).json({ message: "Заявку подано", id: applicationId });
  } catch (err) {
    console.log("[v0] Помилка подання заявки учнем:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Мої заявки ---------------------------------------------------------------
app.get("/api/student/applications", studentOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT a.id, a.title, a.status, a.created_at,
            c.title AS competition_title,
            sec.name AS section_name,
            (SELECT ROUND(AVG(res.score), 2) FROM results res WHERE res.application_id = a.id) AS score
       FROM applications a
       JOIN competitions c ON c.id = a.competition_id
       LEFT JOIN competition_sections sec ON sec.id = a.section_id
      WHERE a.student_id = $1
      ORDER BY a.created_at DESC`,
    [req.user.id]
  );
  res.json({ applications: r.rows });
});

// --- Відкликати заявку (лише поки на розгляді) --------------------------------
app.delete("/api/student/applications/:id", studentOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const own = await pool.query(
    "SELECT id, status FROM applications WHERE id = $1 AND student_id = $2",
    [id, req.user.id]
  );
  if (own.rowCount === 0) return res.status(404).json({ error: "Заявку не знайдено" });
  if (own.rows[0].status !== "submitted") {
    return res.status(400).json({ error: "Відкликати можна лише заявку, що очікує розгляду" });
  }
  await pool.query("DELETE FROM applications WHERE id = $1", [id]);
  res.json({ message: "Заявку відкликано" });
});

// --- Результати моїх заявок ---------------------------------------------------
app.get("/api/student/results", studentOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT a.id AS application_id, a.title, a.status,
            c.title AS competition_title,
            sec.name AS section_name,
            res.score, res.comment,
            jp.full_name AS judge_name
       FROM applications a
       JOIN competitions c ON c.id = a.competition_id
       LEFT JOIN competition_sections sec ON sec.id = a.section_id
       LEFT JOIN results res ON res.application_id = a.id
       LEFT JOIN user_profiles jp ON jp.user_id = res.judge_id
      WHERE a.student_id = $1
      ORDER BY a.created_at DESC`,
    [req.user.id]
  );
  res.json({ results: r.rows });
});

// --- Мої дипломи --------------------------------------------------------------
app.get("/api/student/diplomas", studentOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT d.id, d.place, d.score, d.file_url, d.issued_at,
            c.title AS competition_title
       FROM diplomas d
       JOIN competitions c ON c.id = d.competition_id
      WHERE d.student_id = $1
      ORDER BY d.issued_at DESC`,
    [req.user.id]
  );
  res.json({ diplomas: r.rows });
});

// --- Мої сповіщення -----------------------------------------------------------
app.get("/api/student/notifications", studentOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT id, message, is_read, created_at FROM notifications
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ notifications: r.rows });
});

app.post("/api/student/notifications/read-all", studentOnly, async (req, res) => {
  await pool.query("UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false", [req.user.id]);
  res.json({ message: "Усі сповіщення прочитано" });
});

// --- Профіль учня -------------------------------------------------------------
app.put("/api/student/profile", studentOnly, async (req, res) => {
  const full_name = (req.body?.full_name || "").trim() || null;
  const phone = (req.body?.phone || "").trim() || null;
  const upd = await pool.query(
    "UPDATE user_profiles SET full_name = $2, phone = $3 WHERE user_id = $1 RETURNING id",
    [req.user.id, full_name, phone]
  );
  if (upd.rowCount === 0) {
    await pool.query(
      "INSERT INTO user_profiles (user_id, full_name, phone) VALUES ($1,$2,$3)",
      [req.user.id, full_name, phone]
    );
  }
  res.json({ message: "Профіль збережено" });
});

// ============================================================================
//  ПАНЕЛЬ СИСТЕМИ (роль "system" / "admin") — див. схему "7. СИСТЕМА"
//  Автоматизований конвеєр: Результати → Рейтинг → Дипломи → Протоколи → Архів
// ============================================================================
const systemOnly = [authRequired, roleRequired("system", "admin")];

// --- Dashboard: зведена статистика модуля -----------------------------------
app.get("/api/system/stats", systemOnly, async (req, res) => {
  try {
    const [results, diplomas, protocols, archive, notifications, competitions] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS c FROM results"),
      pool.query("SELECT COUNT(*)::int AS c FROM diplomas"),
      pool.query("SELECT COUNT(*)::int AS c FROM protocols"),
      pool.query("SELECT COUNT(*)::int AS c FROM archive_items"),
      pool.query("SELECT COUNT(*)::int AS c FROM notifications WHERE is_read = false"),
      pool.query("SELECT COUNT(*)::int AS c FROM competitions"),
    ]);
    res.json({
      stats: {
        results: results.rows[0].c,
        diplomas: diplomas.rows[0].c,
        protocols: protocols.rows[0].c,
        archive: archive.rows[0].c,
        unread: notifications.rows[0].c,
        competitions: competitions.rows[0].c,
      },
    });
  } catch (err) {
    console.log("[v0] Помилка статистики системи:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- Список конкурсів (для вибору в конвеєрі) --------------------------------
app.get("/api/system/competitions", systemOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT c.id, c.title, c.status, c.created_at,
            (SELECT COUNT(*)::int FROM applications a WHERE a.competition_id = c.id) AS applications,
            (SELECT COUNT(*)::int FROM results res
               JOIN applications a ON a.id = res.application_id
              WHERE a.competition_id = c.id) AS results,
            (SELECT COUNT(*)::int FROM diplomas d WHERE d.competition_id = c.id) AS diplomas,
            (SELECT COUNT(*)::int FROM protocols p WHERE p.competition_id = c.id) AS protocols
       FROM competitions c
      ORDER BY c.created_at DESC`
  );
  res.json({ competitions: r.rows });
});

// --- РЕЗУЛЬТАТИ: усі оцінки суддів -------------------------------------------
app.get("/api/system/results", systemOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT res.id, res.score, res.comment, res.created_at,
            c.title AS competition_title,
            a.title AS application_title,
            sp.full_name AS student_name,
            jp.full_name AS judge_name
       FROM results res
       JOIN applications a ON a.id = res.application_id
       JOIN competitions c ON c.id = a.competition_id
       LEFT JOIN user_profiles sp ON sp.user_id = a.student_id
       LEFT JOIN user_profiles jp ON jp.user_id = res.judge_id
      ORDER BY res.created_at DESC`
  );
  res.json({ results: r.rows });
});

// --- РЕЙТИНГ: середній бал по заявці, ранжування в межах конкурсу ------------
app.get("/api/system/rating", systemOnly, async (req, res) => {
  const competitionId = req.query.competition_id ? Number(req.query.competition_id) : null;
  const where = competitionId ? "WHERE a.competition_id = $1" : "";
  const params = competitionId ? [competitionId] : [];
  const r = await pool.query(
    `SELECT a.id AS application_id, a.title AS application_title,
            a.competition_id, c.title AS competition_title,
            sp.full_name AS student_name,
            ROUND(AVG(res.score), 2) AS avg_score,
            COUNT(res.id)::int AS judges,
            RANK() OVER (
              PARTITION BY a.competition_id ORDER BY AVG(res.score) DESC NULLS LAST
            ) AS place
       FROM applications a
       JOIN competitions c ON c.id = a.competition_id
       LEFT JOIN user_profiles sp ON sp.user_id = a.student_id
       JOIN results res ON res.application_id = a.id
       ${where}
      GROUP BY a.id, a.title, a.competition_id, c.title, sp.full_name
      ORDER BY a.competition_id, place`,
    params
  );
  res.json({ rating: r.rows });
});

// --- КОНВЕЄР: підрахунок рейтингу, дипломи, протокол, архів, сповіщення ------
app.post("/api/system/competitions/:id/process", systemOnly, async (req, res) => {
  const competitionId = Number(req.params.id);
  try {
    const comp = await pool.query("SELECT id, title FROM competitions WHERE id = $1", [competitionId]);
    if (comp.rowCount === 0) return res.status(404).json({ error: "Конкурс не знайдено" });
    const competitionTitle = comp.rows[0].title;

    // 1) Рейтинг — середній бал кожної заявки
    const ranking = await pool.query(
      `SELECT a.id AS application_id, a.student_id, a.title,
              sp.full_name AS student_name,
              ROUND(AVG(res.score), 2) AS avg_score
         FROM applications a
         LEFT JOIN user_profiles sp ON sp.user_id = a.student_id
         JOIN results res ON res.application_id = a.id
        WHERE a.competition_id = $1
        GROUP BY a.id, a.student_id, a.title, sp.full_name
        ORDER BY AVG(res.score) DESC NULLS LAST`,
      [competitionId]
    );

    if (ranking.rowCount === 0) {
      return res.status(400).json({ error: "Немає результатів для обробки цього конкурсу" });
    }

    const rows = ranking.rows;

    // Прибираємо попередні згенеровані дані конкурсу (повторний запуск)
    await pool.query("DELETE FROM diplomas WHERE competition_id = $1", [competitionId]);
    await pool.query("DELETE FROM protocols WHERE competition_id = $1", [competitionId]);
    await pool.query(
      "DELETE FROM archive_items WHERE type IN ('protocol','diploma') AND related_id = $1",
      [competitionId]
    );

    // 2) Дипломи — призерам (перші три місця)
    const winners = rows.slice(0, 3);
    for (let i = 0; i < winners.length; i++) {
      const w = winners[i];
      await pool.query(
        `INSERT INTO diplomas (competition_id, student_id, application_id, place, score)
         VALUES ($1, $2, $3, $4, $5)`,
        [competitionId, w.student_id, w.application_id, i + 1, w.avg_score]
      );
      if (w.student_id) {
        await pool.query(
          `INSERT INTO notifications (user_id, message)
           VALUES ($1, $2)`,
          [w.student_id, `Вітаємо! Ви посіли ${i + 1} місце у конкурсі «${competitionTitle}».`]
        );
      }
    }

    // 3) Протокол — підсумковий документ
    const protocolLines = rows
      .map((r, idx) => `${idx + 1}. ${r.student_name || "Учасник"} — «${r.title || "Заявка"}» — ${r.avg_score ?? "—"} б.`)
      .join("\n");
    const protocolContent = `Протокол конкурсу «${competitionTitle}»\nДата: ${new Date().toLocaleString("uk-UA")}\nУчасників: ${rows.length}\n\n${protocolLines}`;
    const protocol = await pool.query(
      `INSERT INTO protocols (competition_id, content) VALUES ($1, $2) RETURNING id`,
      [competitionId, protocolContent]
    );

    // 4) Архів — протокол та конкурс
    await pool.query(
      `INSERT INTO archive_items (type, related_id, title)
       VALUES ('protocol', $1, $2)`,
      [competitionId, `Протокол: ${competitionTitle}`]
    );
    await pool.query(
      `INSERT INTO archive_items (type, related_id, title)
       VALUES ('competition', $1, $2)
       ON CONFLICT DO NOTHING`,
      [competitionId, competitionTitle]
    );

    // 5) Статистика — агрегований запис
    const scores = rows.map((r) => Number(r.avg_score)).filter((n) => !Number.isNaN(n));
    const avgAll = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : 0;
    await pool.query(
      `INSERT INTO statistics (type, data_json) VALUES ('competition_result', $1)`,
      [
        JSON.stringify({
          competition_id: competitionId,
          competition_title: competitionTitle,
          participants: rows.length,
          diplomas: winners.length,
          average_score: avgAll,
          top_score: scores.length ? Math.max(...scores) : 0,
          processed_at: new Date().toISOString(),
        }),
      ]
    );

    // Конкурс переходить в архів
    await pool.query("UPDATE competitions SET status = 'archived' WHERE id = $1", [competitionId]);

    await logAction("system_process", req.user.id, `Конкурс #${competitionId} оброблено системою`);

    res.json({
      message: "Конкурс оброблено: рейтинг, дипломи, протокол та архів сформовано.",
      diplomas: winners.length,
      participants: rows.length,
      protocol_id: protocol.rows[0].id,
    });
  } catch (err) {
    console.log("[v0] Помилка обробки конкурсу:", err.message);
    res.status(500).json({ error: "Внутрішня помилка серверу" });
  }
});

// --- ДИПЛОМИ -----------------------------------------------------------------
app.get("/api/system/diplomas", systemOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT d.id, d.place, d.score, d.issued_at,
            c.title AS competition_title,
            sp.full_name AS student_name
       FROM diplomas d
       JOIN competitions c ON c.id = d.competition_id
       LEFT JOIN user_profiles sp ON sp.user_id = d.student_id
      ORDER BY d.issued_at DESC, d.place ASC`
  );
  res.json({ diplomas: r.rows });
});

// --- ПРОТОКОЛИ ---------------------------------------------------------------
app.get("/api/system/protocols", systemOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT p.id, p.content, p.file_url, p.created_at,
            c.title AS competition_title
       FROM protocols p
       JOIN competitions c ON c.id = p.competition_id
      ORDER BY p.created_at DESC`
  );
  res.json({ protocols: r.rows });
});

// --- АРХІВ -------------------------------------------------------------------
app.get("/api/system/archive", systemOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT id, type, related_id, title, file_url, created_at
       FROM archive_items
      ORDER BY created_at DESC`
  );
  res.json({ items: r.rows });
});

// --- СТАТИСТИКА --------------------------------------------------------------
app.get("/api/system/statistics", systemOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT id, type, data_json, created_at FROM statistics ORDER BY created_at DESC`
  );
  res.json({ statistics: r.rows });
});

// --- СПОВІЩЕННЯ ---------------------------------------------------------------
app.get("/api/system/notifications", systemOnly, async (req, res) => {
  const r = await pool.query(
    `SELECT n.id, n.message, n.is_read, n.created_at, u.email AS user_email
       FROM notifications n
       LEFT JOIN users u ON u.id = n.user_id
      ORDER BY n.created_at DESC
      LIMIT 200`
  );
  res.json({ notifications: r.rows });
});

app.patch("/api/system/notifications/:id/read", systemOnly, async (req, res) => {
  await pool.query("UPDATE notifications SET is_read = true WHERE id = $1", [Number(req.params.id)]);
  res.json({ message: "Позначено прочитаним" });
});

app.post("/api/system/notifications/read-all", systemOnly, async (req, res) => {
  await pool.query("UPDATE notifications SET is_read = true WHERE is_read = false");
  res.json({ message: "Усі сповіщення прочитано" });
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
