require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder
} = require("discord.js");

const mongoose = require("mongoose");

/* =========================================================
   CONFIG
========================================================= */

const PUBLIC_CHANNEL_ID = process.env.PUBLIC_CHANNEL_ID || "1544164307682721866";
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID || "1544164307682721864";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "1403799018487808071";

const DAILY_CREDITS = 2;
const RESET_TIME = 24 * 60 * 60 * 1000;

const API_BASE = (
  process.env.API_BASE ||
  "https://restapidhan.vercel.app"
).replace(/\/+$/, "");

const API_KEY = process.env.API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;

if (!DISCORD_TOKEN || !API_KEY || !MONGODB_URI) {
  console.error("ERROR: Variabel lingkungan belum lengkap.");
  process.exit(1);
}

/* =========================================================
   MONGODB USER SCHEMA
========================================================= */

const userSchema = new mongoose.Schema({
  discord_id: { type: String, required: true, unique: true },
  credits: { type: Number, default: 0 },
  daily_credits: { type: Number, default: DAILY_CREDITS },
  last_reset: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);

/* =========================================================
   DISCORD CLIENT & SESSIONS
========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

const userSessions = new Map();

/* =========================================================
   VALIDATION & DB UTILS
========================================================= */

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

async function getUser(discordId) {
  let user = await User.findOne({ discord_id: String(discordId) });
  if (!user) {
    user = await User.create({
      discord_id: String(discordId),
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
    `Daily Credit: **${user.daily_credits}/${DAILY_CREDITS}**`,
    `Bonus Credit: **${user.credits}**`
  ].join("\n");
}

async function consumeCredit(discordId) {
  const user = await getUser(discordId);
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

async function refundCredit(discordId, type) {
  const user = await getUser(discordId);
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

function getApiMessage(data) {
  return data?.error || data?.message || "Unknown error";
}

/* =========================================================
   PANEL BUILDERS
========================================================= */

function createPublicPanel() {
  const embed = new EmbedBuilder()
    .setTitle("Generate Acc AM Premium")
    .setDescription(
      [
        "Gunakan tombol di bawah untuk memproses akun.",
        "",
        "**Alur:**",
        "1. Send Email",
        "2. Cek email Inbox/Spam",
        "3. Masukkan Magic Link",
        "",
        "---",
        "**Status Credit Kamu:**",
        `Daily Credit: **${DAILY_CREDITS}/${DAILY_CREDITS}**`,
        `Bonus Credit: **0**`,
        "",
        "*Credit akan terupdate otomatis.*"
      ].join("\n")
    )
    .setColor(0xa9cdea);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("am_send")
      .setLabel("Send Email")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("am_credit")
      .setLabel("Cek Credit")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

function createAdminPanel() {
  const embed = new EmbedBuilder()
    .setTitle("Admin AM Premium")
    .setDescription("Panel administrasi credit.")
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_add").setLabel("Tambah Credit").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("admin_remove").setLabel("Kurangi Credit").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("admin_check").setLabel("Cek User").setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

async function setupPanels() {
  try {
    const pubChannel = await client.channels.fetch(PUBLIC_CHANNEL_ID).catch(() => null);
    if (pubChannel && pubChannel.isTextBased()) {
      const messages = await pubChannel.messages.fetch({ limit: 20 }).catch(() => null);
      const existingPanel = messages?.find(m => m.author.id === client.user.id && m.embeds?.[0]?.title === "Generate Acc AM Premium");
      if (!existingPanel) await pubChannel.send(createPublicPanel());
    }

    const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID).catch(() => null);
    if (adminChannel && adminChannel.isTextBased()) {
      const messages = await adminChannel.messages.fetch({ limit: 20 }).catch(() => null);
      const existingAdminPanel = messages?.find(m => m.author.id === client.user.id && m.embeds?.[0]?.title === "Admin AM Premium");
      if (!existingAdminPanel) await adminChannel.send(createAdminPanel());
    }
  } catch (error) {
    console.error("PANEL SETUP ERROR:", error);
  }
}

client.once("ready", async () => {
  console.log(`Bot Discord online: ${client.user.tag}`);
  await setupPanels();
});

/* =========================================================
   INTERACTIONS
========================================================= */

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === "am_send") {
        const user = await getUser(interaction.user.id);
        if (user.daily_credits <= 0 && user.credits <= 0) {
          return interaction.reply({ content: "Credit kamu habis.", ephemeral: true });
        }

        const modal = new ModalBuilder().setCustomId("modal_send").setTitle("Send Email");
        const emailInput = new TextInputBuilder().setCustomId("email").setLabel("Email").setPlaceholder("contoh@gmail.com").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(emailInput));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "am_credit") {
        const user = await getUser(interaction.user.id);
        await interaction.reply({ content: `💳 **Informasi Credit Anda**\n\n${creditText(user)}`, ephemeral: true });

        setTimeout(async () => {
          try { await interaction.editReply({ content: "", components: [] }); } catch {}
        }, 3000);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "modal_send") {
        const email = interaction.fields.getTextInputValue("email").trim();
        if (!validEmail(email)) return interaction.reply({ content: "Format email tidak valid.", ephemeral: true });

        const consumed = await consumeCredit(interaction.user.id);
        if (!consumed.success) return interaction.reply({ content: "Credit kamu habis.", ephemeral: true });

        await interaction.deferReply({ ephemeral: true });
        try {
          const data = await apiSend(email);
          if (data?.status) {
            userSessions.set(interaction.user.id, { email, consumedType: consumed.type });

            await interaction.editReply(`✓ **Email berhasil dikirim ke** \`$email\`.\n\nKlik tombol di bawah untuk memasukkan Magic Link:`);

            const verifyRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("open_verify_modal").setLabel("🔗 Masukkan Magic Link").setStyle(ButtonStyle.Success)
            );

            await interaction.followUp({
              content: "Silakan lanjutkan verifikasi:",
              components: [verifyRow],
              ephemeral: true
            });
            return;
          }

          await refundCredit(interaction.user.id, consumed.type);
          await interaction.editReply(`Gagal: ${getApiMessage(data)}. Credit dikembalikan.`);
          setTimeout(async () => { try { await interaction.editReply({ content: "", components: [] }); } catch {} }, 3000);
        } catch (e) {
          await refundCredit(interaction.user.id, consumed.type);
          await interaction.editReply(`Error: ${e.message}. Credit dikembalikan.`);
          setTimeout(async () => { try { await interaction.editReply({ content: "", components: [] }); } catch {} }, 3000);
        }
      }

      if (interaction.customId === "modal_verify") {
        const magicLink = interaction.fields.getTextInputValue("magic_link").trim();
        const session = userSessions.get(interaction.user.id);

        if (!session || !session.email) {
          return interaction.reply({ content: "Sesi kedaluwarsa. Silakan ulangi proses.", ephemeral: true });
        }

        if (!validHttpUrl(magicLink)) {
          return interaction.reply({ content: "Magic Link tidak valid.", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          const data = await apiVerify(session.email, magicLink);
          if (data?.status) {
            userSessions.delete(interaction.user.id);
            const user = await getUser(interaction.user.id);
            const codeOrder = data.codeorder ? `\nCode Order: \`${data.codeorder}\`` : "";

            await interaction.editReply(`✓ **Aktivasi Berhasil!**${codeOrder}\n\n${creditText(user)}`);

            // Pesan hasil verifikasi otomatis dibersihkan setelah 3 detik
            setTimeout(async () => {
              try { await interaction.editReply({ content: "", components: [] }); } catch {}
            }, 3000);
            return;
          }

          await refundCredit(interaction.user.id, session.consumedType);
          userSessions.delete(interaction.user.id);
          await interaction.editReply(`Gagal verifikasi: ${getApiMessage(data)}\n\nCredit dikembalikan.`);
          setTimeout(async () => {
            try { await interaction.editReply({ content: "", components: [] }); } catch {}
          }, 3000);
        } catch (e) {
          await refundCredit(interaction.user.id, session.consumedType);
          userSessions.delete(interaction.user.id);
          await interaction.editReply(`Error API: ${e.message}\n\nCredit dikembalikan.`);
          setTimeout(async () => {
            try { await interaction.editReply({ content: "", components: [] }); } catch {}
          }, 3000);
        }
      }
    }

    if (interaction.isButton() && interaction.customId === "open_verify_modal") {
      const session = userSessions.get(interaction.user.id);
      if (!session) {
        return interaction.reply({ content: "Sesi habis. Kirim email ulang.", ephemeral: true });
      }

      const modal = new ModalBuilder().setCustomId("modal_verify").setTitle("Verifikasi Magic Link");
      const linkInput = new TextInputBuilder().setCustomId("magic_link").setLabel("Tempel Magic Link Di Sini").setStyle(TextInputStyle.Paragraph).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(linkInput));
      return interaction.showModal(modal);
    }

  } catch (error) {
    console.error(error);
  }
});

async function start() {
  await mongoose.connect(MONGODB_URI);
  console.log("✓ MongoDB connected successfully.");
  await client.login(DISCORD_TOKEN);
}

start();
