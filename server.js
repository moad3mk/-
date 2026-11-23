const express = require("express");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const yauzl = require("yauzl");
const { pipeline } = require("stream/promises");
const { spawn } = require("child_process");
const { Transform } = require("stream");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST_PASSWORD = process.env.HOST_PASSWORD;
const ROOT = __dirname;
const BOTS_DIR = process.env.NEXO_BOTS_DIR ? path.resolve(process.env.NEXO_BOTS_DIR) : path.join(ROOT, "bots");
const CLOUD_DIR = path.join(ROOT, "cloud");
const processes = new Map();
const installs = new Map();
const logs = new Map();
const cloudSessions = new Map();
const loginAttempts = new Map();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });
const SESSION_TTL = 12 * 60 * 60 * 1000;
const MAX_RUNNING_BOTS = Math.max(1, Math.min(20, Number.parseInt(process.env.NEXO_MAX_RUNNING_BOTS || "5", 10) || 5));
const MAX_INSTALLED_BOTS = Math.max(1, Math.min(100, Number.parseInt(process.env.NEXO_MAX_BOTS || "20", 10) || 20));
const apiRateBuckets = new Map();
const uploadRateBuckets = new Map();

// Periodically discard expired sessions and old login-attempt records.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of cloudSessions) {
    if (session.expiresAt <= now) cloudSessions.delete(token);
  }
  for (const [ip, attempts] of loginAttempts) {
    const recent = attempts.filter((time) => now - time < 15 * 60 * 1000);
    if (recent.length) loginAttempts.set(ip, recent);
    else loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);
cleanupTimer.unref();

if (!HOST_PASSWORD || HOST_PASSWORD.length < 16) {
  console.error("HOST_PASSWORD is missing or shorter than 16 characters. Set a unique password of at least 16 characters before starting NEXO.");
  process.exit(1);
}

fs.mkdirSync(BOTS_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(BOTS_DIR, 0o700); } catch (_) {}
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["\'self\'"], scriptSrc: ["\'self\'", "\'unsafe-inline\'"], styleSrc: ["\'self\'", "\'unsafe-inline\'"], imgSrc: ["\'self\'", "data:"], connectSrc: ["\'self\'"], baseUri: ["\'self\'"], formAction: ["\'self\'"], frameAncestors: ["\'none\'"] } } }));
app.use(express.json({ limit: "32kb" }));
app.use("/cloud", express.static(CLOUD_DIR));
app.use(express.static(path.join(ROOT, "public")));

function rateLimit(store, windowMs, max, message) {
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let bucket = store.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { startedAt: now, count: 0 };
      store.set(key, bucket);
    }
    bucket.count += 1;
    if (store.size > 10000) {
      for (const [storedKey, value] of store) {
        if (now - value.startedAt >= windowMs) store.delete(storedKey);
        if (store.size <= 9000) break;
      }
    }
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((windowMs - (now - bucket.startedAt)) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

function sameOriginWrites(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "تم رفض الطلب لأنه صادر من مصدر غير موثوق" });
    } catch (_) { return res.status(403).json({ error: "رأس Origin غير صالح" }); }
  }
  next();
}

app.use("/cloud/api", rateLimit(apiRateBuckets, 60 * 1000, 120, "طلبات كثيرة. انتظر دقيقة ثم حاول مجدداً."), sameOriginWrites);
app.use("/cloud/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
const uploadLimiter = rateLimit(uploadRateBuckets, 10 * 60 * 1000, 5, "تجاوزت حد رفع الملفات. حاول بعد 10 دقائق.");

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
    if (index > -1 && item.slice(0, index) === name) { try { return decodeURIComponent(item.slice(index + 1)); } catch (_) { return ""; } }
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
  if (!supplied || !safeEqual(supplied, HOST_PASSWORD)) return res.status(401).json({ error: "كلمة مرور اللوحة غير صحيحة" });
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
    if (loginAttempts.size > 10000) loginAttempts.delete(loginAttempts.keys().next().value);
    loginAttempts.set(ip, attempts);
    return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  for (const [existingToken, session] of cloudSessions) { if (session.expiresAt <= now) cloudSessions.delete(existingToken); }
  if (cloudSessions.size >= 1000) cloudSessions.delete(cloudSessions.keys().next().value);
  cloudSessions.set(token, { expiresAt: now + SESSION_TTL });
  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  res.setHeader("Set-Cookie", "nexo_cloud_session=" + token + "; HttpOnly; SameSite=Strict; Path=/cloud; Max-Age=" + Math.floor(SESSION_TTL / 1000) + (secure ? "; Secure" : ""));
  res.json({ ok: true });
});

app.post("/cloud/api/logout", cloudAuth, (req, res) => {
  const token = readCookie(req, "nexo_cloud_session");
  if (token) cloudSessions.delete(token);
  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  res.setHeader("Set-Cookie", "nexo_cloud_session=; HttpOnly; SameSite=Strict; Path=/cloud; Max-Age=0" + (secure ? "; Secure" : ""));
  res.json({ ok: true });
});

app.get("/cloud/api/me", cloudAuth, (_req, res) => res.json({ ok: true }));

function validId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(id);
}

function addLog(id, line) {
  const current = logs.get(id) || [];
  let safeLine = String(line).slice(0, 2000);
  for (const secret of Object.values(readBotEnv(id))) {
    if (typeof secret === "string" && secret.length >= 8) safeLine = safeLine.split(secret).join("[REDACTED]");
  }
  current.push({ time: new Date().toISOString(), line: safeLine });
  logs.set(id, current.slice(-150));
}

function getBots() {
  return fs.readdirSync(BOTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && validId(entry.name))
    .map((entry) => {
      const id = entry.name;
      return { id, running: processes.has(id), entry: fs.existsSync(path.join(BOTS_DIR, id, "index.js")), hasPackage: fs.existsSync(path.join(BOTS_DIR, id, "package.json")) };
    });
}

app.get("/cloud/api/bots", cloudAuth, (_req, res) => res.json({ bots: getBots() }));

app.post("/cloud/api/bots/:id/start", cloudAuth, (req, res) => {
  const id = req.params.id;
  if (!validId(id)) return res.status(400).json({ error: "معرّف غير صالح" });
  const folder = path.join(BOTS_DIR, id);
  if (installs.has(id)) return res.status(409).json({ error: "انتظر حتى يكتمل تثبيت المكتبات" });
  if (!fs.existsSync(path.join(folder, "index.js"))) return res.status(404).json({ error: "ملف index.js غير موجود" });
  if (processes.has(id)) return res.status(409).json({ error: "البوت شغال بالفعل" });
  if (processes.size >= MAX_RUNNING_BOTS) return res.status(429).json({ error: "وصلت للحد الأقصى للبوتات الشغالة (" + MAX_RUNNING_BOTS + ")" });
  try {
    fs.writeFileSync(path.join(folder, ".nexo-enabled"), "1", { mode: 0o600 });
    if (!startBot(id)) return res.status(500).json({ error: "تعذر تشغيل البوت" });
    res.json({ ok: true, message: "تم إرسال أمر التشغيل" });
  } catch (error) { res.status(500).json({ error: "فشل التشغيل: " + error.message }); }
});

app.post("/cloud/api/bots/:id/stop", cloudAuth, (req, res) => {
  const id = req.params.id;
  if (!validId(id)) return res.status(400).json({ error: "معرّف غير صالح" });
  const child = processes.get(id);
  if (!child) return res.status(404).json({ error: "البوت متوقف بالفعل" });
  try { fs.rmSync(path.join(BOTS_DIR, id, ".nexo-enabled"), { force: true }); } catch (_) {}
  child.kill("SIGTERM");
  res.json({ ok: true, message: "تم إرسال أمر الإيقاف" });
});

app.post("/cloud/api/bots/:id/restart", cloudAuth, async (req, res) => {
  const id = req.params.id;
  if (!validId(id)) return res.status(400).json({ error: "معرّف غير صالح" });
  const folder = path.join(BOTS_DIR, id);
  if (installs.has(id)) return res.status(409).json({ error: "انتظر حتى يكتمل تثبيت المكتبات" });
  if (!fs.existsSync(path.join(folder, "index.js"))) return res.status(404).json({ error: "ملف index.js غير موجود" });
  const child = processes.get(id);
  if (!child) {
    try {
      fs.writeFileSync(path.join(folder, ".nexo-enabled"), "1", { mode: 0o600 });
      if (!startBot(id)) return res.status(500).json({ error: "تعذر تشغيل البوت" });
      return res.json({ ok: true, message: "تم تشغيل البوت" });
    } catch (_) { return res.status(500).json({ error: "تعذر تشغيل البوت" }); }
  }
  try { fs.writeFileSync(path.join(folder, ".nexo-enabled"), "1", { mode: 0o600 }); } catch (_) {}
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
  if (!graceful && processes.get(id) === child) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
  }
  if (processes.has(id)) return res.status(500).json({ error: "تعذر إيقاف النسخة القديمة" });
  if (!startBot(id)) return res.status(500).json({ error: "تعذر تشغيل البوت بعد إعادة التشغيل" });
  res.json({ ok: true, message: "تمت إعادة تشغيل البوت" });
});

app.post("/cloud/api/bots/:id/install", cloudAuth, (req, res) => {
  const id = req.params.id;
  if (!validId(id)) return res.status(400).json({ error: "معرّف غير صالح" });
  const folder = path.join(BOTS_DIR, id);
  const packagePath = path.join(folder, "package.json");
  if (!fs.existsSync(packagePath)) return res.status(404).json({ error: "ملف package.json غير موجود لهذا البوت" });
  if (processes.has(id)) return res.status(409).json({ error: "أوقف البوت قبل تثبيت المكتبات" });
  if (installs.has(id)) return res.status(409).json({ error: "تثبيت المكتبات جارٍ بالفعل" });
  if (installs.size >= 2) return res.status(429).json({ error: "يوجد تثبيتان آخران قيد التنفيذ؛ انتظر حتى ينتهي أحدهما" });
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")); }
  catch (_) { return res.status(400).json({ error: "ملف package.json غير صالح" }); }
  const deps = manifest && manifest.dependencies;
  if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
    return res.status(400).json({ error: "لا توجد dependencies في package.json" });
  }
  const entries = Object.entries(deps);
  if (!entries.length || entries.length > 40) return res.status(400).json({ error: "عدد المكتبات يجب أن يكون بين 1 و40" });
  for (const [name, version] of entries) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
        typeof version !== "string" || version.length > 80 ||
        !/^[0-9v*^~<>=.|xX -]+$/.test(version)) {
      return res.status(400).json({ error: "اسم أو إصدار مكتبة غير مسموح: " + name });
    }
  }
  const child = spawn("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress", "--package-lock=false", "--registry=https://registry.npmjs.org"], {
    cwd: folder,
    env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", CI: "1", npm_config_update_notifier: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  installs.set(id, child);
  addLog(id, "بدأ تثبيت " + entries.length + " مكتبة (مع تعطيل install scripts)");
  let outputBytes = 0;
  const capture = (data) => {
    outputBytes += data.length;
    if (outputBytes <= 200000) addLog(id, data.toString());
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timeout = setTimeout(() => {
    addLog(id, "تجاوز التثبيت 3 دقائق؛ سيتم إيقافه");
    child.kill("SIGTERM");
    setTimeout(() => { if (installs.get(id) === child) child.kill("SIGKILL"); }, 4000).unref();
  }, 180000);
  timeout.unref();
  child.on("error", (error) => addLog(id, "فشل تشغيل npm: " + error.message));
  child.on("exit", (code) => {
    clearTimeout(timeout);
    if (installs.get(id) === child) installs.delete(id);
    addLog(id, code === 0 ? "اكتمل تثبيت مكتبات البوت" : "فشل تثبيت المكتبات (exit=" + code + ")");
  });
  res.json({ ok: true, message: "بدأ تثبيت مكتبات البوت. تابع السجلات لمعرفة النتيجة." });
});

app.get("/cloud/api/bots/:id/logs", cloudAuth, (req, res) => {
  const id = req.params.id;
  if (!validId(id)) return res.status(400).json({ error: "معرّف غير صالح" });
  res.json({ logs: logs.get(id) || [] });
});

function botEnvPath(id) { return path.join(BOTS_DIR, id, ".nexo-env.json"); }
function readBotEnv(id) {
  try {
    const value = JSON.parse(fs.readFileSync(botEnvPath(id), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}
app.get("/cloud/api/bots/:id/env", cloudAuth, (req, res) => {
  const id = req.params.id;
  if (!validId(id) || !fs.existsSync(path.join(BOTS_DIR, id))) return res.status(404).json({ error: "البوت غير موجود" });
  res.json({ variables: readBotEnv(id) });
});
app.put("/cloud/api/bots/:id/env", cloudAuth, (req, res) => {
  const id = req.params.id;
  if (!validId(id) || !fs.existsSync(path.join(BOTS_DIR, id))) return res.status(404).json({ error: "البوت غير موجود" });
  const variables = req.body && req.body.variables;
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) return res.status(400).json({ error: "صيغة المتغيرات غير صحيحة" });
  const entries = Object.entries(variables);
  if (entries.length > 100) return res.status(400).json({ error: "الحد الأقصى 100 متغير" });
  const clean = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || /^(PATH|HOME|NODE_OPTIONS|HOST_PASSWORD|PORT|PWD|SHELL|LD_PRELOAD)$/i.test(key)) {
      return res.status(400).json({ error: "اسم متغير غير مسموح: " + key });
    }
    if (typeof value !== "string" || value.length > 8000) return res.status(400).json({ error: "قيمة متغير غير صالحة: " + key });
    clean[key] = value;
  }
  try {
    fs.writeFileSync(botEnvPath(id), JSON.stringify(clean, null, 2), { mode: 0o600 });
    fs.chmodSync(botEnvPath(id), 0o600);
    addLog(id, "تم تحديث متغيرات البيئة الخاصة بالبوت");
    res.json({ ok: true, count: entries.length });
  } catch (error) { res.status(500).json({ error: "تعذر حفظ المتغيرات" }); }
});
app.get("/api/status", auth, (_req, res) => res.json({ name: "NEXO PRIVATE HOST", bots: getBots() }));

app.get("/api/logs/:id", auth, (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
  res.json({ logs: logs.get(req.params.id) || [] });
});

function extractZip(buffer, destination) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (openError, zip) => {
      if (openError) return reject(new Error("ملف ZIP غير صالح"));
      const entries = [];
      const names = new Set();
      let totalSize = 0;
      let actualTotalSize = 0;
      let hasRootEntry = false;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch (_) {}
        reject(error);
      };
      zip.on("error", () => fail(new Error("تعذر قراءة ملف ZIP")));
      zip.on("entry", (entry) => {
        if (entries.length >= 250) return fail(new Error("الأرشيف يحتوي على ملفات كثيرة جداً"));
        const raw = entry.fileName;
        const normalized = path.posix.normalize(raw);
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xFFFF;
        const fileType = unixMode & 0xF000;
        const segments = raw.split("/");
        if (!raw || raw.includes("\\") || raw.includes("\0") || raw.startsWith("/") ||
            segments.some((part) => part === "." || part === "..") ||
            normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
          return fail(new Error("الأرشيف يحتوي على مسار ملف غير آمن"));
        }
        if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
          return fail(new Error("الأرشيف يحتوي على نوع ملف غير مسموح"));
        }
        if (raw === "index.js") hasRootEntry = true;
        if (names.has(normalized)) return fail(new Error("الأرشيف يحتوي على أسماء ملفات مكررة"));
        names.add(normalized);
        totalSize += entry.uncompressedSize || 0;
        if (totalSize > 30 * 1024 * 1024) return fail(new Error("حجم الملفات بعد فك الضغط أكبر من الحد المسموح"));
        entries.push(entry);
        zip.readEntry();
      });
      zip.on("end", async () => {
        if (settled) return;
        try {
          if (!hasRootEntry) throw new Error("لازم يكون ملف index.js عادي في جذر ملف ZIP");
          fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
          for (const entry of entries) {
            if (entry.fileName.endsWith("/")) {
              const dir = path.join(destination, ...entry.fileName.split("/").filter(Boolean));
              fs.mkdirSync(dir, { recursive: true });
              continue;
            }
            const target = path.join(destination, ...entry.fileName.split("/"));
            const relative = path.relative(destination, target);
            if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("مسار ملف غير آمن");
            fs.mkdirSync(path.dirname(target), { recursive: true });
            await new Promise((resolveEntry, rejectEntry) => {
              zip.openReadStream(entry, (streamError, readStream) => {
                if (streamError) return rejectEntry(streamError);
                const writeStream = fs.createWriteStream(target, { flags: "wx", mode: 0o600 });
                const sizeGuard = new Transform({ transform(chunk, _encoding, callback) {
                  actualTotalSize += chunk.length;
                  if (actualTotalSize > 30 * 1024 * 1024) return callback(new Error("الحجم الفعلي بعد فك الضغط تجاوز 30MB"));
                  callback(null, chunk);
                }});
                pipeline(readStream, sizeGuard, writeStream).then(resolveEntry, rejectEntry);
              });
            });
          }
          settled = true;
          zip.close();
          resolve();
        } catch (error) {
          try { fs.rmSync(destination, { recursive: true, force: true }); } catch (_) {}
          fail(error);
        }
      });
      zip.readEntry();
    });
  });
}

app.post("/cloud/api/upload", cloudAuth, uploadLimiter, upload.single("archive"), async (req, res) => {
  const id = req.body && req.body.botId;
  if (!validId(id)) return res.status(400).json({ error: "اسم البوت لازم يكون إنجليزي ومن غير مسافات" });
  if (!req.file) return res.status(400).json({ error: "اختار ملف ZIP أولاً" });
  if (fs.existsSync(path.join(BOTS_DIR, id))) return res.status(409).json({ error: "يوجد بوت بنفس الاسم بالفعل" });
  if (getBots().length >= MAX_INSTALLED_BOTS) return res.status(429).json({ error: "وصلت للحد الأقصى لعدد البوتات على الخادم (" + MAX_INSTALLED_BOTS + ")" });
  const temp = path.join(BOTS_DIR, ".upload-" + crypto.randomBytes(8).toString("hex"));
  try {
    await extractZip(req.file.buffer, temp);
    fs.renameSync(temp, path.join(BOTS_DIR, id));
    addLog(id, "تم رفع ملفات البوت");
    res.json({ ok: true, message: "تم رفع ملفات البوت " + id, bot: id, needsInstall: fs.existsSync(path.join(BOTS_DIR, id, "package.json")) });
  } catch (error) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {}
    res.status(400).json({ error: error.message || "فشل رفع ملفات البوت" });
  }
});

function startBot(id) {
  if (!validId(id) || processes.has(id) || processes.size >= MAX_RUNNING_BOTS) return false;
  const folder = path.join(BOTS_DIR, id);
  const entry = path.join(folder, "index.js");
  if (!fs.existsSync(entry)) return false;
  const baseEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    if (process.env[key]) baseEnv[key] = process.env[key];
  }
  baseEnv.NODE_ENV = "production";
  const child = spawn(process.execPath, [entry], { cwd: folder, env: { ...baseEnv, ...readBotEnv(id) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
  if (processes.size >= MAX_RUNNING_BOTS) return res.status(429).json({ error: "وصلت للحد الأقصى للبوتات الشغالة (" + MAX_RUNNING_BOTS + ")" });
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
  try { fs.rmSync(path.join(BOTS_DIR, id, ".nexo-enabled"), { force: true }); } catch (_) {}
  child.kill("SIGTERM");
  res.json({ ok: true, message: "تم إرسال أمر الإيقاف" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("NEXO PRIVATE HOST listening on port " + PORT);
  for (const entry of fs.readdirSync(BOTS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && validId(entry.name) && !entry.name.startsWith(".")) {
      if (fs.existsSync(path.join(BOTS_DIR, entry.name, ".nexo-enabled")) && startBot(entry.name)) console.log("Auto-started bot: " + entry.name);
    }
  }
});
