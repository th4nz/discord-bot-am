require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;

const DAILY_CREDITS = 2;
const RESET_TIME = 24 * 60 * 60 * 1000;

const API_BASE = (process.env.API_BASE || "https://restapidhan.vercel.app").replace(/\/+$/, "");
const API_KEY = process.env.API_KEY;

if (!BOT_TOKEN || !MONGODB_URI || !API_KEY) {
  console.error("ERROR: BOT_TOKEN, MONGODB_URI, atau API_KEY belum lengkap di environment variables.");
  process.exit(1);
}

/* =========================================================
   MONGODB USER SCHEMA (Dibuat Dalam 1 File Agar Tidak Crash)
========================================================= */
const userSchema = new mongoose.Schema({
  discord_id: { type: String, required: true, unique: true },
  credits: { type: Number, default: 0 },
  daily_credits: { type: Number, default: DAILY_CREDITS },
  last_reset: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);

const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map(); // Menyimpan state step user (email & magic link)

/* =========================================================
   DATABASE UTILS & DAILY RESET
========================================================= */

async function getUser(telegramId) {
  let user = await User.findOne({ discord_id: String(telegramId) });
  if (!user) {
    user = await User.create({
      discord_id: String(telegramId),
      credits: 0,
      daily_credits: DAILY_CREDITS,
      last_reset: new Date()
    });
  }
  await resetDailyIfNeeded(user);
  return user;
}

async function resetDailyIfNeeded(user) {
  const now = Date.now();
  const lastReset = new Date(user.last_reset).getTime();
  if (now - lastReset >= RESET_TIME) {
    user.daily_credits = DAILY_CREDITS;
    user.last_reset = new Date();
    await user.save();
  }
}

function creditText(user) {
  return [
    `Daily Credit: <b>${user.daily_credits}/${DAILY_CREDITS}</b>`,
    `Bonus Credit: <b>${user.credits}</b>`
  ].join("\n");
}

async function consumeCredit(telegramId) {
  const user = await getUser(telegramId);
  if (user.daily_credits > 0) {
    user.daily_credits -= 1;
    await user.save();
    return { success: true, type: "daily" };
  }
  if (user.credits > 0) {
    user.credits -= 1;
    await user.save();
    return { success: true, type: "bonus" };
  }
  return { success: false };
}

async function refundCredit(telegramId, type) {
  const user = await getUser(telegramId);
  if (type === "daily") {
    user.daily_credits = Math.min(DAILY_CREDITS, user.daily_credits + 1);
  } else if (type === "bonus") {
    user.credits += 1;
  }
  await user.save();
}

async function apiSend(email) {
  const url = new URL(`${API_BASE}/api/am`);
  url.searchParams.set("action", "send");
  url.searchParams.set("apikey", API_KEY);
  url.searchParams.set("email", email);
  const response = await fetch(url);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("API response bukan JSON."); }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return data;
}

async function apiVerify(email, magicLink) {
  const url = new URL(`${API_BASE}/api/am`);
  url.searchParams.set("action", "verif");
  url.searchParams.set("apikey", API_KEY);
  url.searchParams.set("email", email);
  url.searchParams.set("url", magicLink);
  const response = await fetch(url);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("API response bukan JSON."); }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return data;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/* =========================================================
   TELEGRAM COMMANDS & UI PANELS
========================================================= */

const mainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("📧 Send Email", "btn_send"), Markup.button.callback("💳 Cek Credit", "btn_credit")]
]);

async function sendDashboard(ctx, userId) {
  const user = await getUser(userId);
  const caption = [
    "<b>Generate Acc AM Premium</b>",
    "",
    "Gunakan tombol di bawah untuk memproses akun.",
    "",
    "<b>Alur:</b>",
    "1. Send Email",
    "2. Cek email Inbox/Spam",
    "3. Masukkan Magic Link",
    "",
    "---",
    "<b>Status Credit Kamu:</b>",
    creditText(user),
    "",
    "<i>Credit akan terupdate otomatis.</i>"
  ].join("\n");

  await ctx.reply(caption, { parse_mode: "HTML", ...mainKeyboard });
}

bot.start(async (ctx) => {
  await sendDashboard(ctx, ctx.from.id);
});

bot.action("btn_credit", async (ctx) => {
  const user = await getUser(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.reply(`💳 <b>Informasi Credit Anda</b>\n\n${creditText(user)}`, { parse_mode: "HTML" });
});

bot.action("btn_send", async (ctx) => {
  const user = await getUser(ctx.from.id);
  if (user.daily_credits <= 0 && user.credits <= 0) {
    return ctx.answerCbQuery("Credit kamu habis! Hubungi admin.", { show_alert: true });
  }

  sessions.set(ctx.from.id, { step: "awaiting_email" });
  await ctx.answerCbQuery();
  await ctx.reply("✉️ Silakan masukkan alamat email tujuan untuk dikirimkan link verifikasi:", Markup.inlineKeyboard([
    [Markup.button.callback("❌ Batal", "btn_cancel")]
  ]));
});

bot.action("btn_cancel", async (ctx) => {
  sessions.delete(ctx.from.id);
  await ctx.answerCbQuery("Dibatalkan.");
  await ctx.editMessageText("Sesi dibatalkan.");
});

// Multi-step text input listener (Email & Magic Link)
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const session = sessions.get(userId);
  if (!session) return;

  // STEP 1: PROSES EMAIL
  if (session.step === "awaiting_email") {
    const email = ctx.message.text.trim();
    if (!validEmail(email)) {
      return ctx.reply("Format email tidak valid. Masukkan email yang benar (contoh: user@gmail.com):");
    }

    const processingMsg = await ctx.reply("⏳ Memproses pengiriman email...");

    const consumed = await consumeCredit(userId);
    if (!consumed.success) {
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
      sessions.delete(userId);
      return ctx.reply("Credit kamu habis.");
    }

    try {
      const data = await apiSend(email);
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});

      if (data?.status) {
        sessions.set(userId, { step: "awaiting_verify", email, consumedType: consumed.type });
        
        await ctx.reply(
          [
            `✓ <b>Email berhasil dikirim ke</b> <code>${email}</code>.`,
            "",
            "Silakan periksa Inbox/Spam email Anda. Setelah mendapatkan <b>Magic Link</b>, kirimkan link tersebut ke sini:",
          ].join("\n"),
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Batal", "btn_cancel")]]) }
        );
      } else {
        await refundCredit(userId, consumed.type);
        sessions.delete(userId);
        await ctx.reply(`Gagal: ${data?.error || data?.message || "Unknown error"}. Credit dikembalikan.`);
      }
    } catch (e) {
      await refundCredit(userId, consumed.type);
      sessions.delete(userId);
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
      await ctx.reply(`Error API: ${e.message}. Credit dikembalikan.`);
    }
    return;
  }

  // STEP 2: PROSES MAGIC LINK VERIFICATION
  if (session.step === "awaiting_verify") {
    const magicLink = ctx.message.text.trim();
    if (!validHttpUrl(magicLink)) {
      return ctx.reply("Magic Link harus berupa URL HTTP/HTTPS yang valid. Silakan kirimkan ulang link yang benar:");
    }

    const email = session.email;
    const consumedType = session.consumedType;
    sessions.delete(userId);

    const processingMsg = await ctx.reply("⏳ Memproses verifikasi akun...");

    try {
      const data = await apiVerify(email, magicLink);
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});

      if (data?.status) {
        const user = await getUser(userId);
        const codeOrder = data.codeorder ? `\nCode Order: <code>${data.codeorder}</code>` : "";

        await ctx.reply(
          [
            "✓ <b>Aktivasi Berhasil!</b>",
            codeOrder,
            "",
            creditText(user)
          ].join("\n"),
          { parse_mode: "HTML", ...mainKeyboard }
        );
      } else {
        await refundCredit(userId, consumedType);
        await ctx.reply(`Gagal verifikasi: ${data?.error || data?.message || "Unknown error"}.\n\nCredit kamu dikembalikan.`);
      }
    } catch (e) {
      await refundCredit(userId, consumedType);
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
      await ctx.reply(`Error API verifikasi: ${e.message}.\n\nCredit kamu dikembalikan.`);
    }
    return;
  }
});

/* =========================================================
   START MONGODB & BOT
========================================================= */

async function startBot() {
  await mongoose.connect(MONGODB_URI);
  console.log("✓ MongoDB connected successfully.");

  await bot.launch();
  console.log("✓ Telegram Bot running via Long Polling...");
}

startBot().catch((err) => {
  console.error("Failed to start bot:", err);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
