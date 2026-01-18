// server.js
// Expo Push Server (Render) - CLEAN & DỨT ĐIỂM
// - POST /register { token, language, tz, app } -> store token (PERSISTED)
// - CRON: 07:00 / 12:00 / 20:00 (Asia/Bangkok) -> broadcast to all tokens
// - GET /ping, /stats -> quick debug
//
// ✅ DỨT ĐIỂM:
// - ❌ KHÔNG gửi welcome ngay khi register
// - ❌ KHÔNG có /test
// - ✅ Chỉ có 3 mốc 07/12/20
// - ✅ Có "FINGERPRINT" để kiểm tra Render đang chạy đúng bản này

const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// Node 18+ có fetch sẵn. Nếu môi trường không có, fallback:
if (typeof fetch === "undefined") {
  // eslint-disable-next-line global-require
  global.fetch = require("node-fetch");
}

const app = express();
app.use(cors());
app.use(express.json());

// ---------- FINGERPRINT (để biết Render đang chạy đúng code này) ----------
const FINGERPRINT = `clean-${new Date().toISOString()}`;
console.log("BOOT FINGERPRINT =", FINGERPRINT);

// Prefer Render persistent disk path if mounted (Render Disk at /var/data)
const DEFAULT_TOKENS_PATH = "/var/data/tokens.json";
const TOKENS_PATH =
  process.env.TOKENS_PATH ||
  (fs.existsSync("/var/data")
    ? DEFAULT_TOKENS_PATH
    : path.join(__dirname, "tokens.json"));

// token -> { language, tz, app, updatedAt }
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
    }, 400);
  } catch {}
}

// load on boot
loadTokensFromDisk();

// ---------- routes ----------
app.get("/", (_, res) => res.send("push server ok"));

app.get("/ping", (_, res) => {
  res.json({ ok: true, tokenCount: tokens.size, time: Date.now(), fingerprint: FINGERPRINT });
});

app.get("/stats", (_, res) => {
  res.json({
    ok: true,
    tokenCount: tokens.size,
    tokensPath: TOKENS_PATH,
    hasVarData: fs.existsSync("/var/data"),
    now: new Date().toISOString(),
    fingerprint: FINGERPRINT,
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

// chunk <=100
async function sendInBatches(allMessages, batchSize = 100) {
  for (let i = 0; i < allMessages.length; i += batchSize) {
    const batch = allMessages.slice(i, i + batchSize);
    console.log(`Sending batch ${i / batchSize + 1} size=${batch.length}`);
    await sendExpoPush(batch);
  }
}

function buildDailyMessage(token, meta, slot) {
  const lang = meta.language || "id";
  const title = "Destiny 2026 ✨";

  const viBodies = {
    "07:00":
      "Chào buổi sáng ✨ Năng lượng hôm nay đang mở. Xem dự đoán, màu may mắn và điều cần ưu tiên.",
    "12:00":
      "Giữa ngày rồi ✨ Kiểm tra lại hướng đi: công việc, cảm xúc và một gợi ý nhỏ để bẻ lái kịp lúc.",
    "20:00":
      "Buổi tối ✨ Hạ nhịp một chút. Xem tổng kết năng lượng và lời nhắc để ngủ yên, mai sáng nhẹ đầu.",
  };

  const idBodies = {
    "07:00":
      "Selamat pagi ✨ Energi hari ini sedang terbuka. Cek prediksi, warna hoki, dan fokus utamamu.",
    "12:00":
      "Siang ini ✨ Saatnya cek arah: kerja, emosi, dan satu petunjuk kecil biar langkahmu tetap pas.",
    "20:00":
      "Malam ini ✨ Turunkan ritme. Lihat ringkasan energi dan pesan penutup untuk tidur lebih tenang.",
  };

  const body =
    lang === "vi"
      ? viBodies[slot] || "Thông điệp hôm nay đã sẵn sàng. Mở app để xem ✨"
      : idBodies[slot] || "Pesan hari ini sudah siap. Buka aplikasi để melihat ✨";

  return {
    to: token,
    title,
    body,
    sound: "default",
    data: { target: "TodayHome", kind: "push_daily", slot },
    channelId: "daily",
  };
}

async function broadcastDaily(slot) {
  if (tokens.size === 0) {
    console.log("No tokens to send");
    return;
  }

  const all = [];
  for (const [token, meta] of tokens.entries()) {
    all.push(buildDailyMessage(token, meta, slot));
  }

  console.log(`[PUSH_DAILY] slot=${slot} count=${all.length}`);
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

// ✅ Register ONLY (no welcome, no test)
app.post("/register", async (req, res) => {
  try {
    const { token, language, tz, app: appName } = req.body || {};

    if (!isValidExpoToken(token)) {
      return res.status(400).send("invalid token");
    }

    const meta = {
      language: language === "vi" ? "vi" : "id",
      tz: tz || "Asia/Bangkok",
      app: appName || "destiny-2026",
      updatedAt: Date.now(),
    };

    tokens.set(token, meta);
    scheduleSaveTokensToDisk();

    console.log("[REGISTER]", token, meta);
    // ❌ intentionally NO welcome push here

    res.json({
      ok: true,
      tokenCount: tokens.size,
      tokensPath: TOKENS_PATH,
      fingerprint: FINGERPRINT,
    });
  } catch (e) {
    console.log("REGISTER error:", e);
    res.status(500).send("server error");
  }
});

// ✅ Block unknown GET routes (đỡ bị soi/ gọi nhầm)
app.get("*", (req, res) => res.status(404).send("not found"));
// ✅ Block unknown POST routes (đỡ bị gọi nhầm /test cũ)
app.post("*", (req, res) => res.status(404).send("not found"));

// ✅ Schedule at 07:00 / 12:00 / 20:00 (Asia/Bangkok)
const TZ = "Asia/Bangkok";
cron.schedule("0 7 * * *", () => broadcastDaily("07:00"), { timezone: TZ });
cron.schedule("0 12 * * *", () => broadcastDaily("12:00"), { timezone: TZ });
cron.schedule("0 20 * * *", () => broadcastDaily("20:00"), { timezone: TZ });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log("Push server listening on", PORT, "TOKENS_PATH=", TOKENS_PATH, "FINGERPRINT=", FINGERPRINT)
);
