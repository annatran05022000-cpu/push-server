// server.js
// Expo Push Server
// - POST /register { token, language, tz }
//   -> stores token and sends a ONE-TIME welcome push immediately
// - EVERY 60 MINUTES: broadcasts to all tokens (debug schedule 1h)
// - POST /test -> send immediately (debug)

const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

// token -> { language, tz, app, updatedAt, welcomed }
const tokens = new Map();

app.get("/", (_, res) => res.send("push server ok"));

// Expo push endpoint
async function sendExpoPush(messages) {
  const url = "https://exp.host/--/api/v2/push/send";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messages),
  });
  const data = await res.json().catch(() => ({}));
  console.log("Expo response:", JSON.stringify(data));
  return data;
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
      ? "Đã bật thông báo. Tạm thời: 1 giờ nhận 1 lần để test."
      : "Notifikasi aktif. Sementara: tiap 1 jam untuk tes.";

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

  const batch = [];
  for (const [token, meta] of tokens.entries()) {
    batch.push(build1hMessage(token, meta));
  }

  console.log(`Broadcast 1h count=${batch.length}`);
  await sendExpoPush(batch);
}

// ✅ Register + welcome (one-time)
app.post("/register", async (req, res) => {
  const { token, language, tz, app: appName } = req.body || {};

  if (
    !token ||
    typeof token !== "string" ||
    !token.startsWith("ExponentPushToken")
  ) {
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
  console.log("REGISTER:", token, meta);

  // Send welcome only once per token
  if (!meta.welcomed) {
    try {
      console.log("WELCOME -> sending now...");
      await sendExpoPush([buildWelcomeMessage(token, meta)]);
      meta.welcomed = true;
      tokens.set(token, meta);
      console.log("WELCOME -> sent");
    } catch (e) {
      console.log("WELCOME send error:", e);
    }
  }

  res.json({ ok: true, welcomed: meta.welcomed });
});

// Manual test: send immediately to all
app.post("/test", async (req, res) => {
  if (tokens.size === 0) return res.json({ ok: true, count: 0 });

  const batch = [];
  for (const [token, meta] of tokens.entries()) {
    batch.push(build1hMessage(token, meta));
  }
  await sendExpoPush(batch);
  res.json({ ok: true, count: tokens.size });
});

// ✅ Every 60 minutes (at minute 0)
const TZ = "Asia/Bangkok";
cron.schedule("0 * * * *", () => broadcast1h(), { timezone: TZ });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log("Push server listening on", PORT));
