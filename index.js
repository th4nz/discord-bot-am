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
const User = require("./models/User");

/* =========================================================
   CONFIG
========================================================= */

const PUBLIC_CHANNEL_ID = "1544164307682721866";
const ADMIN_CHANNEL_ID = "1544164307682721864";
const ADMIN_USER_ID = "1403799018487808071";

const DAILY_CREDITS = 2;
const RESET_TIME = 24 * 60 * 60 * 1000;

const API_BASE = (
  process.env.API_BASE ||
  "https://restapidhan.vercel.app"
).replace(/\/+$/, "");

const API_KEY = process.env.API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;

/* =========================================================
   DISCORD CLIENT (DENGAN INTENTS LENGKAP)
========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

/* =========================================================
   VALIDATION & DB UTILS
========================================================= */

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function getUser(discordId) {
  let user = await User.findOne({ discord_id: discordId });
  if (!user) {
    user = await User.create({
      discord_id: discordId,
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

async function addBonusCredit(discordId, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Jumlah credit tidak valid.");
  const user = await getUser(discordId);
  user.credits += amount;
  await user.save();
  return user;
}

async function removeBonusCredit(discordId, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Jumlah credit tidak valid.");
  const user = await getUser(discordId);
  user.credits = Math.max(0, user.credits - amount);
  await user.save();
  return user;
}

async function apiSend(email) {
  const url = new URL(`${API_BASE}/api/am`);
  url.searchParams.set("action", "send");
  url.searchParams.set("apikey", API_KEY);
  url.searchParams.set("email", email);
  const response = await fetch(url);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`API response bukan JSON.`); }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return data;
}

async function apiCheckLimit() {
  const url = new URL(`${API_BASE}/api/key/status`);
  url.searchParams.set("apikey", API_KEY);
  try {
    const response = await fetch(url);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, error: "Response bukan JSON" }; }
    if (!response.ok) return { ok: false, error: data?.error || `HTTP ${response.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
      .setCustomId("api_limit")
      .setLabel("Cek Limit API")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [row]
  };
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

/* =========================================================
   AUTO SETUP PANELS (DENGAN ERROR HANDLER)
========================================================= */

async function setupPanels() {
  try {
    // Setup Public Panel
    const pubChannel = await client.channels.fetch(PUBLIC_CHANNEL_ID).catch(() => null);
    if (pubChannel && pubChannel.isTextBased()) {
      const messages = await pubChannel.messages.fetch({ limit: 20 }).catch(() => null);
      const existingPanel = messages?.find(m => m.author.id === client.user.id && m.embeds?.[0]?.title === "Generate Acc AM Premium");
      
      if (!existingPanel) {
        await pubChannel.send(createPublicPanel());
        console.log("✓ Public panel berhasil dikirim ke channel.");
      } else {
        console.log("✓ Public panel sudah ada di channel.");
      }
    } else {
      console.warn("⚠ Public channel tidak ditemukan atau bot tidak memiliki akses.");
    }

    // Setup Admin Panel
    const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID).catch(() => null);
    if (adminChannel && adminChannel.isTextBased()) {
      const messages = await adminChannel.messages.fetch({ limit: 20 }).catch(() => null);
      const existingAdminPanel = messages?.find(m => m.author.id === client.user.id && m.embeds?.[0]?.title === "Admin AM Premium");
      
      if (!existingAdminPanel) {
        await adminChannel.send(createAdminPanel());
        console.log("✓ Admin panel berhasil dikirim ke channel.");
      } else {
        console.log("✓ Admin panel sudah ada di channel.");
      }
    } else {
      console.warn("⚠ Admin channel tidak ditemukan atau bot tidak memiliki akses.");
    }
  } catch (error) {
    console.error("PANEL SETUP ERROR:", error);
  }
}

client.once("ready", async () => {
  console.log(`--------------------------------`);
  console.log(`Bot online: ${client.user.tag}`);
  console.log(`--------------------------------`);

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
        const hasCredit = user.daily_credits > 0 || user.credits > 0;

        if (!hasCredit) {
          return interaction.reply({
            content: "Credit kamu habis. Tunggu reset 24 jam atau hubungi admin.",
            ephemeral: true
          });
        }

        const modal = new ModalBuilder().setCustomId("modal_send").setTitle("Send Email");
        const emailInput = new TextInputBuilder().setCustomId("email").setLabel("Email").setPlaceholder("contoh@gmail.com").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(emailInput));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "api_limit") {
        await interaction.deferReply({ ephemeral: true });
        const res = await apiCheckLimit();
        
        if (!res.ok) {
          await interaction.editReply(`Gagal mengambil status API: ${res.error}`);
          setTimeout(async () => { try { await interaction.editReply({ content: "", components: [] }); } catch {} }, 3000);
          return;
        }

        const data = res.data || {};
        const dailyUsage = data.dailyUsage ?? data.usage ?? 0;
        const dailyLimit = data.dailyLimit ?? data.limit ?? "Unlimited";

        await interaction.editReply(
          [
            "📊 **Status / Limit API Key**",
            "",
            `Status: **${data.active !== false ? "Aktif" : "Tidak Aktif"}**`,
            `Penggunaan Hari Ini: \`${dailyUsage} / ${dailyLimit}\``
          ].join("\n")
        );

        setTimeout(async () => { try { await interaction.editReply({ content: "", components: [] }); } catch {} }, 3000);
        return;
      }

      const adminButtons = ["admin_add", "admin_remove", "admin_check"];
      if (adminButtons.includes(interaction.customId)) {
        if (interaction.user.id !== ADMIN_USER_ID) {
          return interaction.reply({ content: "Unauthorized.", ephemeral: true });
        }
        if (interaction.customId === "admin_add") {
          const modal = new ModalBuilder().setCustomId("modal_admin_add").setTitle("Tambah Bonus Credit");
          const userId = new TextInputBuilder().setCustomId("userid").setLabel("Discord User ID").setStyle(TextInputStyle.Short).setRequired(true);
          const amount = new TextInputBuilder().setCustomId("amount").setLabel("Jumlah Credit").setStyle(TextInputStyle.Short).setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(userId), new ActionRowBuilder().addComponents(amount));
          return interaction.showModal(modal);
        }
        if (interaction.customId === "admin_remove") {
          const modal = new ModalBuilder().setCustomId("modal_admin_remove").setTitle("Kurangi Bonus Credit");
          const userId = new TextInputBuilder().setCustomId("userid").setLabel("Discord User ID").setStyle(TextInputStyle.Short).setRequired(true);
          const amount = new TextInputBuilder().setCustomId("amount").setLabel("Jumlah Credit").setStyle(TextInputStyle.Short).setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(userId), new ActionRowBuilder().addComponents(amount));
          return interaction.showModal(modal);
        }
        if (interaction.customId === "admin_check") {
          const modal = new ModalBuilder().setCustomId("modal_admin_check").setTitle("Cek User");
          const userId = new TextInputBuilder().setCustomId("userid").setLabel("Discord User ID").setStyle(TextInputStyle.Short).setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(userId));
          return interaction.showModal(modal);
        }
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "modal_send") {
        const email = interaction.fields.getTextInputValue("email").trim();
        const consumed = await consumeCredit(interaction.user.id);
        if (!consumed.success) return interaction.reply({ content: "Credit kamu habis.", ephemeral: true });

        await interaction.deferReply({ ephemeral: true });
        try {
          const data = await apiSend(email);
          if (data?.status) {
            const user = await getUser(interaction.user.id);
            await interaction.editReply(
              [
                `✓ **Email terkirim ke** \`${email}\`.`,
                "",
                creditText(user)
              ].join("\n")
            );

            setTimeout(async () => { try { await interaction.editReply({ content: "", components: [] }); } catch {} }, 3000);
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

      if (interaction.customId === "modal_admin_add") {
        if (interaction.user.id !== ADMIN_USER_ID) return;
        const discordId = interaction.fields.getTextInputValue("userid").trim();
        const amount = Number(interaction.fields.getTextInputValue("amount").trim());
        const user = await addBonusCredit(discordId, amount);
        return interaction.reply({ content: `✓ Berhasil tambah ${amount} credit ke ${discordId}.`, ephemeral: true });
      }
      if (interaction.customId === "modal_admin_remove") {
        if (interaction.user.id !== ADMIN_USER_ID) return;
        const discordId = interaction.fields.getTextInputValue("userid").trim();
        const amount = Number(interaction.fields.getTextInputValue("amount").trim());
        const user = await removeBonusCredit(discordId, amount);
        return interaction.reply({ content: `✓ Berhasil kurangi credit user ${discordId}.`, ephemeral: true });
      }
      if (interaction.customId === "modal_admin_check") {
        if (interaction.user.id !== ADMIN_USER_ID) return;
        const discordId = interaction.fields.getTextInputValue("userid").trim();
        const user = await getUser(discordId);
        return interaction.reply({ content: `Info User ${discordId}:\n${creditText(user)}`, ephemeral: true });
      }
    }
  } catch (error) {
    console.error(error);
  }
});

async function start() {
  await mongoose.connect(MONGODB_URI);
  console.log("✓ MongoDB connected.");
  await client.login(DISCORD_TOKEN);
}

start();
