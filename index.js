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
   DISCORD CLIENT
========================================================= */

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

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

async function apiVerify(email, magicLink) {
  const url = new URL(`${API_BASE}/api/am`);
  url.searchParams.set("action", "verif");
  url.searchParams.set("apikey", API_KEY);
  url.searchParams.set("email", email);
  url.searchParams.set("url", magicLink);
  const response = await fetch(url);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`API response bukan JSON.`); }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return data;
}

function getApiMessage(data) {
  return data?.error || data?.message || "Unknown error";
}

/* =========================================================
   USER PANEL (DENGAN REALTIME CREDIT DISPLAY)
========================================================= */

function createPublicPanel(user = null) {
  const creditDisplay = user 
    ? creditText(user) 
    : `Daily Credit: **${DAILY_CREDITS}/${DAILY_CREDITS}**\nBonus Credit: **0**`;

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
        creditDisplay,
        "",
        "*Credit akan terupdate otomatis.*"
      ].join("\n")
    )
    .setColor(0xa9cdea);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("am_send")
      .setLabel("Send Email")
      .setStyle(ButtonStyle.Primary)
  );

  return {
    embeds: [embed],
    components: [row]
  };
}

/* =========================================================
   ADMIN PANEL
========================================================= */

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

async function setupPublicPanel() {
  try {
    const channel = await client.channels.fetch(PUBLIC_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;
    const messages = await channel.messages.fetch({ limit: 50 });
    const existingPanel = messages.find(m => m.author.id === client.user.id && m.embeds?.[0]?.title === "Generate Acc AM Premium");
    if (existingPanel) return;
    await channel.send(createPublicPanel());
  } catch (error) {
    console.error("PUBLIC PANEL ERROR:", error);
  }
}

async function setupAdminPanel() {
  try {
    const channel = await client.channels.fetch(ADMIN_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;
    const messages = await channel.messages.fetch({ limit: 50 });
    const existingPanel = messages.find(m => m.author.id === client.user.id && m.embeds?.[0]?.title === "Admin AM Premium");
    if (existingPanel) return;
    await channel.send(createAdminPanel());
  } catch (error) {
    console.error("ADMIN PANEL ERROR:", error);
  }
}

client.once("ready", async () => {
  console.log(`Bot online: ${client.user.tag}`);
  await setupPublicPanel();
  await setupAdminPanel();
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
        if (!validEmail(email)) return interaction.reply({ content: "Email tidak valid.", ephemeral: true });

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

