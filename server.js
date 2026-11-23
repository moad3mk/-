const express = require("express");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST_PASSWORD = process.env.HOST_PASSWORD;
const ROOT = __dirname;
const BOTS_DIR = path.join(ROOT, "bots");
const CLOUD_DIR = path.join(ROOT, "cloud");
const processes = new Map();
const logs = new Map();
const cloudSessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;

if (!HOST_PASSWORD) {
  console.error("Missing HOST_PASSWORD environment variable. Set it before starting NEXO.");
  process.exit(1);
}

fs.mkdirSync(BOTS_DIR, { recursive: true });
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use("/cloud", express.static(CLOUD_DIR));
app.use(express.static(path.join(ROOT, "public")));

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const item = part.trim();
    const index = item.indexOf("=");
    if (index > -1 && item.slice(0, index) === name) {
      return decodeURIComponent(item.slice(index + 1));
    }
  }
  return "";
}

function cloudAuth(req, res, next) {
  const token = readCookie(req, "nexo_cloud_session");
  const session = token && cloudSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) cloudSessions.delete(token);
    return res.status(401).json({ error: "يلزم تسجيل الدخول أولاً" });
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  next();
}

function auth(req, res, next) {
  const supplied = req.get("x-host-password");
  if (!supplied || !safeEqual(supplied, HOST_PASSWORD)) {
    return res.status(401).json({ error: "كلمة مرور اللوحة غير صحيحة" });
  }
  next();
}

app.post("/cloud/api/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (attempts.length >= 8) {
    loginAttempts.set(ip, attempts);
    return res.status(429).json({ error: "محاولات كثيرة. حاول بعد 15 دقيقة." });
  }

  const password = req.body && req.body.password;
  if (typeof password !== "string" || !safeEqual(password, HOST_PASSWORD)) {
    attempts.push(now);
    loginAttempts.set(ip, attempts);
    return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  cloudSessions.set(token, { expiresAt: now + SESSION_TTL });
  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  res.setHeader("Set-Cookie", "nexo_cloud_session=" + token + "; HttpOnly; SameSite=Strict; Path=/cloud; Max-Age=" + Math.floor(SESSION_TTL / 1000) + (secure ? "; Secure" : ""));
  res.json({ ok: true });
});

app.post("/cloud/api/logout", cloudAuth, (req, res) => {
  const token = readCookie(req, "nexo_cloud_session");
  if (token) cloudSessions.delete(token);
  res.setHeader("Set-Cookie", "nexo_cloud_session=; HttpOnly; SameSite=Strict; Path=/cloud; Max-Age=0; Secure");
  res.json({ ok: true });
});

app.get("/cloud/api/me", cloudAuth, (_req, res) => {
  res.json({ ok: true });
});

function validId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(id);
}

function addLog(id, line) {
  const current = logs.get(id) || [];
  current.push({ time: new Date().toISOString(), line: String(line).slice(0, 2000) });
  logs.set(id, current.slice(-150));
}

function getBots() {
  return fs.readdirSync(BOTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && validId(entry.name))
    .map((entry) => {
      const id = entry.name;
      const running = processes.has(id);
      return { id, running, entry: fs.existsSync(path.join(BOTS_DIR, id, "index.js")) };
    });
}

app.get("/cloud/api/bots", cloudAuth, (_req, res) => {
  res.json({ bots: getBots() });
});

app.get("/api/status", auth, (_req, res) => {
  res.json({ name: "NEXO PRIVATE HOST", bots: getBots() });
});

app.get("/api/logs/:id", auth, (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
  res.json({ logs: logs.get(req.params.id) || [] });
});

function startBot(id) {
  if (!validId(id) || processes.has(id)) return false;

  const folder = path.join(BOTS_DIR, id);
  const entry = path.join(folder, "index.js");
  if (!fs.existsSync(entry)) return false;

  const child = spawn(process.execPath, [entry], {
    cwd: folder,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  processes.set(id, child);
  addLog(id, "بدأ تشغيل البوت");
  child.stdout.on("data", (data) => addLog(id, data.toString()));
  child.stderr.on("data", (data) => addLog(id, data.toString()));
  child.on("error", (error) => addLog(id, "خطأ: " + error.message));
  child.on("exit", (code, signal) => {
    addLog(id, "توقف البوت (code=" + code + ", signal=" + signal + ")");
    if (processes.get(id) === child) processes.delete(id);
  });
  return true;
}

app.post("/api/start/:id", auth, (req, res) => {
  const id = req.params.id;
  if (!validId(id)) return res.status(400).json({ error: "معرّف غير صالح" });
  if (processes.has(id)) return res.status(409).json({ error: "البوت شغال بالفعل" });

  const entry = path.join(BOTS_DIR, id, "index.js");
  if (!fs.existsSync(entry)) return res.status(404).json({ error: "لم أجد bots/" + id + "/index.js" });

  startBot(id);
  res.json({ ok: true, message: "بدأ تشغيل " + id });
});

app.post("/api/stop/:id", auth, (req, res) => {
  const id = req.params.id;
  if (!validId(id)) return res.status(400).json({ error: "معرّف غير صالح" });
  const child = processes.get(id);
  if (!child) return res.status(404).json({ error: "البوت مش شغال" });
  child.kill("SIGTERM");
  res.json({ ok: true, message: "تم إرسال أمر الإيقاف" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("NEXO PRIVATE HOST listening on port " + PORT);

  for (const entry of fs.readdirSync(BOTS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && validId(entry.name)) {
      if (startBot(entry.name)) console.log("Auto-started bot: " + entry.name);
    }
  }
});
