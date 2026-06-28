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

  console.log("[v0] База даних готова: таблиці users, user_profiles, auth_tokens");
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

// --- Приклад роуту лише для адміністратора ------------------------------------
app.get("/api/admin/users", authRequired, roleRequired("admin", "system"), async (req, res) => {
  const r = await pool.query(
    `SELECT id, email, role, status, created_at FROM users ORDER BY created_at DESC`
  );
  res.json({ users: r.rows, roles: ROLES });
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
