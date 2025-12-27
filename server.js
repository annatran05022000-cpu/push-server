// server.js
// Expo Push Server (Render)
// - POST /register { token, language, tz, app }
//   -> stores token (PERSISTED) + sends ONE-TIME welcome immediately
// - CRON: every hour -> broadcast to all tokens
// - POST /test -> send immediately (debug)
// - GET /ping, /stats -> quick debug

const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// ✅ fetch fallback (Node version on Render may vary)
if (typeof fetch === "undefined") {
  // eslint-disable-next-line global-require
  global.fetch = require("node-fetch");
}

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Prefer Render persistent disk path if mounted
// If you add a Disk in Render at /var/data, tokens survive redeploy/restart.
const DEFAULT_TOKENS_PATH = "/var/data/tokens.json";
const TOKENS_PATH =
  process.env.TOKENS_PATH ||
  (fs.existsSync("/var/data") ? DEFAULT_TOKENS_PATH : path.join(__dirname, "tokens.json"));

// token -> { language, tz, app, updatedAt, welcomed }
const tokens = new Map();

// ---------- persistence helpers ----------
function safeMkdirForFile(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function loadTokensFromDisk() {
  try {
    if (!fs.existsSync(TOKENS_PATH)) {
      console.log("TOKENS file not found yet:", TOKENS_PATH);
      return;
    }
    const raw = fs.readFileSync(TOKENS_PATH, "utf8");
    const obj = raw ? JSON.parse(raw) : {};
    let count = 0;
    for (const [token, meta] of Object.entries(obj || {})) {
      if (token && meta) {
        tokens.set(token, meta);
        count++;
      }
    }
    console.log(`TOKENS loaded: ${count} token(s) from ${TOKENS_PATH}`);
  } catch (e) {
    console.log("TOKENS load error:", e);
  }
}

let _saveTimer = null;
function scheduleSaveTokensToDisk() {
  try {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      try {
        safeMkdirForFile(TOKENS_PATH);
        const obj = {};
        for (const [token, meta] of tokens.entries()) obj[token] = meta;
        fs.writeFileSync(TOKENS_PATH, JSON.stringify(obj, null, 2), "utf8");
        console.log(`TOKENS saved: ${tokens.size} token(s) -> ${TOKENS_PATH}`);
      } catch (e) {
        console.log("TOKENS save error:", e);
      }
    }, 400); // debounce
  } catch {}
}

// load on boot
loadTokensFromDisk();

// ---------- routes ----------
app.get("/", (_, res) => res.send("push server ok"));

app.get("/ping", (_, res) => {
  res.json({ ok: true, tokenCount: tokens.size, time: Date.now() });
});

app.get("/stats", (_, res) => {
  res.json({
    ok: true,
    tokenCount: tokens.size,
    tokensPath: TOKENS_PATH,
    hasVarData: fs.existsSync("/var/data"),
    now: new Date().toISOString(),
  });
});

// ---------- Expo push ----------
async function sendExpoPush(messages) {
  const url = "https://exp.host/--/api/v2/push/send";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messages),
  });
  const text = await res.text().catch(() => "");
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  console.log("Expo response:", JSON.stringify(data));
  return data;
}

// chunk to <=100 (Expo recommended)
async function sendInBatches(allMessages, batchSize = 100) {
  for (let i = 0; i < allMessages.length; i += batchSize) {
    const batch = allMessages.slice(i, i + batchSize);
    console.log(`Sending batch ${i / batchSize + 1} size=${batch.length}`);
    await sendExpoPush(batch);
  }
}

function build1hMessage(token, meta) {
  const lang = meta.language || "id";
  const title = "Destiny 2026 ✨";

  const body =
    lang === "vi"
      ? "Test server: 1 giờ bắn 1 lần. Mở app để xem thông điệp ✨"
      : "Tes server: tiap 1 jam. Buka aplikasi untuk melihat pesan ✨";

  return {
    to: token,
    title,
    body,
    sound: "default",
    data: { target: "TodayHome", kind: "push_1h" },
    channelId: "daily",
  };
}

function buildWelcomeMessage(token, meta) {
  const lang = meta.language || "id";
  const title = "Destiny 2026 ✨";

  const body =
    lang === "vi"
      ? "Đã bật thông báo. Server sẽ gửi 1 giờ/lần để test."
      : "Notifikasi aktif. Server kirim tiap 1 jam untuk tes.";

  return {
    to: token,
    title,
    body,
    sound: "default",
    data: { target: "TodayHome", kind: "push_welcome" },
    channelId: "daily",
  };
}

async function broadcast1h() {
  if (tokens.size === 0) {
    console.log("No tokens to send");
    return;
  }

  const all = [];
  for (const [token, meta] of tokens.entries()) {
    all.push(build1hMessage(token, meta));
  }

  console.log(`Broadcast 1h count=${all.length}`);
  await sendInBatches(all, 100);
}

function isValidExpoToken(token) {
  if (!token || typeof token !== "string") return false;
  return (
    token.startsWith("ExponentPushToken[") ||
    token.startsWith("ExpoPushToken[") ||
    token.startsWith("ExponentPushToken") ||
    token.startsWith("ExpoPushToken")
  );
}

// ✅ Register + welcome (one-time)
app.post("/register", async (req, res) => {
  try {
    const { token, language, tz, app: appName } = req.body || {};

    if (!isValidExpoToken(token)) {
      return res.status(400).send("invalid token");
    }

    const prev = tokens.get(token);

    const meta = {
      language: language === "vi" ? "vi" : "id",
      tz: tz || "Asia/Bangkok",
      app: appName || "destiny-2026",
      updatedAt: Date.now(),
      welcomed: prev?.welcomed === true,
    };

    tokens.set(token, meta);
    scheduleSaveTokensToDisk();
    console.log("REGISTER:", token, meta);

    // Send welcome only once per token
    if (!meta.welcomed) {
      try {
        console.log("WELCOME -> sending now...");
        await sendExpoPush([buildWelcomeMessage(token, meta)]);
        meta.welcomed = true;
        tokens.set(token, meta);
        scheduleSaveTokensToDisk();
        console.log("WELCOME -> sent");
      } catch (e) {
        console.log("WELCOME send error:", e);
      }
    }

    res.json({
      ok: true,
      welcomed: meta.welcomed,
      tokenCount: tokens.size,
      tokensPath: TOKENS_PATH,
    });
  } catch (e) {
    console.log("REGISTER error:", e);
    res.status(500).send("server error");
  }
});

// Manual test: send immediately to all
app.post("/test", async (req, res) => {
  if (tokens.size === 0) return res.json({ ok: true, count: 0 });

  const all = [];
  for (const [token, meta] of tokens.entries()) {
    all.push(build1hMessage(token, meta));
  }
  await sendInBatches(all, 100);
  res.json({ ok: true, count: tokens.size });
});

// ✅ Every hour at minute 0
const TZ = "Asia/Bangkok";
cron.schedule("0 * * * *", () => broadcast1h(), { timezone: TZ });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log("Push server listening on", PORT, "TOKENS_PATH=", TOKENS_PATH)
);
