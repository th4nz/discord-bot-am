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
  EmbedBuilder,
  PermissionsBitField
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
   ENV CHECK
========================================================= */

if (!DISCORD_TOKEN) {
  console.error("ERROR: DISCORD_TOKEN belum diisi.");
  process.exit(1);
}

if (!API_KEY) {
  console.error("ERROR: API_KEY belum diisi.");
  process.exit(1);
}

if (!MONGODB_URI) {
  console.error("ERROR: MONGODB_URI belum diisi.");
  process.exit(1);
}

/* =========================================================
   DISCORD CLIENT
========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

/* =========================================================
   TEMP SESSION
========================================================= */

const sessions = new Map();

/*
  Format:

  Discord ID
  ↓
  {
    email,
    sentAt
  }
*/

/* =========================================================
   VALIDATION
========================================================= */

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

/* =========================================================
   USER DATABASE
========================================================= */

async function getUser(discordId) {
  let user = await User.findOne({
    discord_id: discordId
  });

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

/* =========================================================
   DAILY RESET
========================================================= */

async function resetDailyIfNeeded(user) {
  const now = Date.now();
  const lastReset = new Date(user.last_reset).getTime();

  if (now - lastReset >= RESET_TIME) {
    user.daily_credits = DAILY_CREDITS;
    user.last_reset = new Date();

    await user.save();
  }
}

/* =========================================================
   CREDIT DISPLAY
========================================================= */

function creditText(user) {
  return [
    `Daily Credit: **${user.daily_credits}/${DAILY_CREDITS}**`,
    `Bonus Credit: **${user.credits}**`
  ].join("\n");
}

/* =========================================================
   CREDIT CONSUME
========================================================= */

async function consumeCredit(discordId) {
  const user = await getUser(discordId);

  /*
    Prioritas:
    1. Daily credit
    2. Bonus credit
  */

  if (user.daily_credits > 0) {
    user.daily_credits -= 1;

    await user.save();

    return {
      success: true,
      type: "daily"
    };
  }

  if (user.credits > 0) {
    user.credits -= 1;

    await user.save();

    return {
      success: true,
      type: "bonus"
    };
  }

  return {
    success: false
  };
}

/* =========================================================
   CREDIT REFUND
========================================================= */

async function refundCredit(discordId, type) {
  const user = await getUser(discordId);

  if (type === "daily") {
    user.daily_credits = Math.min(
      DAILY_CREDITS,
      user.daily_credits + 1
    );
  } else if (type === "bonus") {
    user.credits += 1;
  }

  await user.save();
}

/* =========================================================
   ADD BONUS CREDIT
========================================================= */

async function addBonusCredit(discordId, amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Jumlah credit tidak valid.");
  }

  const user = await getUser(discordId);

  user.credits += amount;

  await user.save();

  return user;
}

/* =========================================================
   REMOVE BONUS CREDIT
========================================================= */

async function removeBonusCredit(discordId, amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Jumlah credit tidak valid.");
  }

  const user = await getUser(discordId);

  user.credits = Math.max(
    0,
    user.credits - amount
  );

  await user.save();

  return user;
}

/* =========================================================
   API SEND
========================================================= */

async function apiSend(email) {
  const url = new URL(`${API_BASE}/api/am`);

  url.searchParams.set("action", "send");
  url.searchParams.set("apikey", API_KEY);
  url.searchParams.set("email", email);

  const response = await fetch(url);

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `API response bukan JSON. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return data;
}

/* =========================================================
   API VERIFY
========================================================= */

async function apiVerify(email, magicLink) {
  const url = new URL(`${API_BASE}/api/am`);

  url.searchParams.set("action", "verif");
  url.searchParams.set("apikey", API_KEY);
  url.searchParams.set("email", email);
  url.searchParams.set("url", magicLink);

  const response = await fetch(url);

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `API response bukan JSON. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return data;
}

/* =========================================================
   API MESSAGE
========================================================= */

function getApiMessage(data) {
  return (
    data?.error ||
    data?.message ||
    "Unknown error"
  );
}

/* =========================================================
   USER PANEL
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
        "3. Salin Magic Link",
        "4. Tekan Aktivasi",
        "",
        "Setiap user memiliki **2 Daily Credit / 24 jam**.",
        "Bonus credit diberikan oleh admin."
      ].join("\n")
    )
    .setColor(0xa9cdea);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("am_send")
      .setLabel("Send Email")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("am_verify")
      .setLabel("Aktivasi")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("am_credit")
      .setLabel("Cek Credit")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("am_reset")
      .setLabel("Reset Session")
      .setStyle(ButtonStyle.Secondary)
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
    .setDescription(
      [
        "Panel administrasi credit.",
        "",
        "**Tambah Credit**",
        "Memberikan bonus credit kepada user.",
        "",
        "**Kurangi Credit**",
        "Mengurangi bonus credit user.",
        "",
        "**Cek User**",
        "Melihat status credit user."
      ].join("\n")
    )
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("admin_add")
      .setLabel("Tambah Credit")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("admin_remove")
      .setLabel("Kurangi Credit")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("admin_check")
      .setLabel("Cek User")
      .setStyle(ButtonStyle.Primary)
  );

  return {
    embeds: [embed],
    components: [row]
  };
}

/* =========================================================
   AUTO PUBLIC PANEL
========================================================= */

async function setupPublicPanel() {
  try {
    const channel = await client.channels.fetch(
      PUBLIC_CHANNEL_ID
    );

    if (!channel || !channel.isTextBased()) {
      console.error(
        "Public channel tidak ditemukan."
      );
      return;
    }

    const messages = await channel.messages.fetch({
      limit: 50
    });

    const existingPanel = messages.find(
      message =>
        message.author.id === client.user.id &&
        message.embeds?.[0]?.title ===
          "Generate Acc AM Premium"
    );

    if (existingPanel) {
      console.log(
        "Public panel sudah ada."
      );
      return;
    }

    await channel.send(
      createPublicPanel()
    );

    console.log(
      "✓ Public panel berhasil dibuat."
    );
  } catch (error) {
    console.error(
      "PUBLIC PANEL ERROR:",
      error
    );
  }
}

/* =========================================================
   AUTO ADMIN PANEL
========================================================= */

async function setupAdminPanel() {
  try {
    const channel = await client.channels.fetch(
      ADMIN_CHANNEL_ID
    );

    if (!channel || !channel.isTextBased()) {
      console.error(
        "Admin channel tidak ditemukan."
      );
      return;
    }

    const messages = await channel.messages.fetch({
      limit: 50
    });

    const existingPanel = messages.find(
      message =>
        message.author.id === client.user.id &&
        message.embeds?.[0]?.title ===
          "Admin AM Premium"
    );

    if (existingPanel) {
      console.log(
        "Admin panel sudah ada."
      );
      return;
    }

    await channel.send(
      createAdminPanel()
    );

    console.log(
      "✓ Admin panel berhasil dibuat."
    );
  } catch (error) {
    console.error(
      "ADMIN PANEL ERROR:",
      error
    );
  }
}

/* =========================================================
   READY
========================================================= */

client.once("ready", async () => {
  console.log("--------------------------------");
  console.log(
    `Bot online: ${client.user.tag}`
  );
  console.log(
    `API: ${API_BASE}`
  );
  console.log(
    `MongoDB: connected`
  );
  console.log("--------------------------------");

  await setupPublicPanel();
  await setupAdminPanel();
});

/* =========================================================
   INTERACTIONS
========================================================= */

client.on(
  "interactionCreate",
  async interaction => {

    try {

      /* =====================================================
         BUTTON
      ===================================================== */

      if (interaction.isButton()) {

        /* -----------------------------------------------
           USER SEND
        ------------------------------------------------ */

        if (
          interaction.customId === "am_send"
        ) {

          const modal = new ModalBuilder()
            .setCustomId("modal_send")
            .setTitle("Send Email");

          const emailInput =
            new TextInputBuilder()
              .setCustomId("email")
              .setLabel("Email")
              .setPlaceholder(
                "contoh@gmail.com"
              )
              .setStyle(
                TextInputStyle.Short
              )
              .setRequired(true)
              .setMaxLength(254);

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              emailInput
            )
          );

          return interaction.showModal(
            modal
          );
        }

        /* -----------------------------------------------
           USER VERIFY
        ------------------------------------------------ */

        if (
          interaction.customId === "am_verify"
        ) {

          const session =
            sessions.get(
              interaction.user.id
            );

          if (!session?.email) {
            return interaction.reply({
              content:
                "Kamu belum melakukan **Send Email**.",
              ephemeral: true
            });
          }

          const user =
            await getUser(
              interaction.user.id
            );

          const hasCredit =
            user.daily_credits > 0 ||
            user.credits > 0;

          if (!hasCredit) {
            return interaction.reply({
              content:
                "Credit kamu habis. Tunggu reset 24 jam atau hubungi admin untuk mendapatkan bonus credit.",
              ephemeral: true
            });
          }

          const modal = new ModalBuilder()
            .setCustomId("modal_verify")
            .setTitle(
              "Aktivasi AM Premium"
            );

          const magicInput =
            new TextInputBuilder()
              .setCustomId("magic")
              .setLabel("Magic Link")
              .setPlaceholder(
                "https://..."
              )
              .setStyle(
                TextInputStyle.Paragraph
              )
              .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              magicInput
            )
          );

          return interaction.showModal(
            modal
          );
        }

        /* -----------------------------------------------
           USER CREDIT
        ------------------------------------------------ */

        if (
          interaction.customId === "am_credit"
        ) {

          const user =
            await getUser(
              interaction.user.id
            );

          return interaction.reply({
            content: [
              "**Credit kamu**",
              "",
              creditText(user),
              "",
              "Daily credit reset setiap 24 jam."
            ].join("\n"),
            ephemeral: true
          });
        }

        /* -----------------------------------------------
           USER RESET
        ------------------------------------------------ */

        if (
          interaction.customId === "am_reset"
        ) {

          sessions.delete(
            interaction.user.id
          );

          return interaction.reply({
            content:
              "✓ Session email berhasil di-reset.",
            ephemeral: true
          });
        }

        /* =================================================
           ADMIN AUTH
        ================================================= */

        const adminButtons = [
          "admin_add",
          "admin_remove",
          "admin_check"
        ];

        if (
          adminButtons.includes(
            interaction.customId
          )
        ) {

          if (
            interaction.user.id !==
            ADMIN_USER_ID
          ) {
            return interaction.reply({
              content:
                "Kamu tidak memiliki akses admin.",
              ephemeral: true
            });
          }

          /* ---------------------------------------------
             ADD CREDIT
          --------------------------------------------- */

          if (
            interaction.customId ===
            "admin_add"
          ) {

            const modal = new ModalBuilder()
              .setCustomId(
                "modal_admin_add"
              )
              .setTitle(
                "Tambah Bonus Credit"
              );

            const userId =
              new TextInputBuilder()
                .setCustomId("userid")
                .setLabel(
                  "Discord User ID"
                )
                .setPlaceholder(
                  "123456789012345678"
                )
                .setStyle(
                  TextInputStyle.Short
                )
                .setRequired(true);

            const amount =
              new TextInputBuilder()
                .setCustomId("amount")
                .setLabel(
                  "Jumlah Credit"
                )
                .setPlaceholder("5")
                .setStyle(
                  TextInputStyle.Short
                )
                .setRequired(true);

            modal.addComponents(
              new ActionRowBuilder().addComponents(
                userId
              ),
              new ActionRowBuilder().addComponents(
                amount
              )
            );

            return interaction.showModal(
              modal
            );
          }

          /* ---------------------------------------------
             REMOVE CREDIT
          --------------------------------------------- */

          if (
            interaction.customId ===
            "admin_remove"
          ) {

            const modal = new ModalBuilder()
              .setCustomId(
                "modal_admin_remove"
              )
              .setTitle(
                "Kurangi Bonus Credit"
              );

            const userId =
              new TextInputBuilder()
                .setCustomId("userid")
                .setLabel(
                  "Discord User ID"
                )
                .setPlaceholder(
                  "123456789012345678"
                )
                .setStyle(
                  TextInputStyle.Short
                )
                .setRequired(true);

            const amount =
              new TextInputBuilder()
                .setCustomId("amount")
                .setLabel(
                  "Jumlah Credit"
                )
                .setPlaceholder("1")
                .setStyle(
                  TextInputStyle.Short
                )
                .setRequired(true);

            modal.addComponents(
              new ActionRowBuilder().addComponents(
                userId
              ),
              new ActionRowBuilder().addComponents(
                amount
              )
            );

            return interaction.showModal(
              modal
            );
          }

          /* ---------------------------------------------
             CHECK USER
          --------------------------------------------- */

          if (
            interaction.customId ===
            "admin_check"
          ) {

            const modal = new ModalBuilder()
              .setCustomId(
                "modal_admin_check"
              )
              .setTitle(
                "Cek User"
              );

            const userId =
              new TextInputBuilder()
                .setCustomId("userid")
                .setLabel(
                  "Discord User ID"
                )
                .setPlaceholder(
                  "123456789012345678"
                )
                .setStyle(
                  TextInputStyle.Short
                )
                .setRequired(true);

            modal.addComponents(
              new ActionRowBuilder().addComponents(
                userId
              )
            );

            return interaction.showModal(
              modal
            );
          }
        }
      }

      /* =====================================================
         MODAL
      ===================================================== */

      if (
        interaction.isModalSubmit()
      ) {

        /* =================================================
           SEND EMAIL
        ================================================= */

        if (
          interaction.customId ===
          "modal_send"
        ) {

          const email =
            interaction.fields
              .getTextInputValue(
                "email"
              )
              .trim();

          if (!validEmail(email)) {
            return interaction.reply({
              content:
                "Format email tidak valid.",
              ephemeral: true
            });
          }

          await interaction.deferReply({
            ephemeral: true
          });

          try {

            const data =
              await apiSend(email);

            if (data?.status) {

              sessions.set(
                interaction.user.id,
                {
                  email,
                  sentAt: Date.now()
                }
              );

              return interaction.editReply(
                [
                  "✓ **Email berhasil dikirim.**",
                  "",
                  `Email: \`${email}\``,
                  "",
                  "Cek Inbox atau Spam.",
                  "",
                  "Setelah mendapatkan Magic Link, tekan tombol **Aktivasi**."
                ].join("\n")
              );
            }

            return interaction.editReply(
              `Gagal kirim: ${getApiMessage(data)}`
            );

          } catch (error) {

            console.error(
              "SEND ERROR:",
              error
            );

            return interaction.editReply(
              `Error API: ${error.message}`
            );
          }
        }

        /* =================================================
           VERIFY
        ================================================= */

        if (
          interaction.customId ===
          "modal_verify"
        ) {

          const session =
            sessions.get(
              interaction.user.id
            );

          if (!session?.email) {
            return interaction.reply({
              content:
                "Session email tidak ditemukan. Silakan Send Email lagi.",
              ephemeral: true
            });
          }

          const magicLink =
            interaction.fields
              .getTextInputValue(
                "magic"
              )
              .trim();

          if (
            !validHttpUrl(
              magicLink
            )
          ) {
            return interaction.reply({
              content:
                "Magic Link harus berupa URL HTTP/HTTPS yang valid.",
              ephemeral: true
            });
          }

          /*
            Reserve credit SEBELUM API verify.
            Ini mencegah dua request bersamaan
            menghabiskan credit yang sama.
          */

          const consumed =
            await consumeCredit(
              interaction.user.id
            );

          if (!consumed.success) {
            return interaction.reply({
              content:
                "Credit kamu habis.",
              ephemeral: true
            });
          }

          await interaction.deferReply({
            ephemeral: true
          });

          try {

            const data =
              await apiVerify(
                session.email,
                magicLink
              );

            if (data?.status) {

              sessions.delete(
                interaction.user.id
              );

              const user =
                await getUser(
                  interaction.user.id
                );

              const code =
                data.codeorder
                  ? `\nCode Order: \`${data.codeorder}\``
                  : "";

              return interaction.editReply(
                [
                  "✓ **Aktivasi berhasil.**",
                  code,
                  "",
                  creditText(user)
                ].join("\n")
              );
            }

            /*
              API gagal → credit dikembalikan.
            */

            await refundCredit(
              interaction.user.id,
              consumed.type
            );

            return interaction.editReply(
              `Gagal aktivasi: ${getApiMessage(data)}\n\nCredit dikembalikan.`
            );

          } catch (error) {

            console.error(
              "VERIFY ERROR:",
              error
            );

            await refundCredit(
              interaction.user.id,
              consumed.type
            );

            return interaction.editReply(
              `Error API: ${error.message}\n\nCredit dikembalikan.`
            );
          }
        }

        /* =================================================
           ADMIN ADD
        ================================================= */

        if (
          interaction.customId ===
          "modal_admin_add"
        ) {

          if (
            interaction.user.id !==
            ADMIN_USER_ID
          ) {
            return interaction.reply({
              content:
                "Unauthorized.",
              ephemeral: true
            });
          }

          const discordId =
            interaction.fields
              .getTextInputValue(
                "userid"
              )
              .trim();

          const amountText =
            interaction.fields
              .getTextInputValue(
                "amount"
              )
              .trim();

          const amount =
            Number(amountText);

          if (
            !/^\d+$/.test(discordId) ||
            !Number.isInteger(amount) ||
            amount <= 0
          ) {
            return interaction.reply({
              content:
                "Discord ID atau jumlah credit tidak valid.",
              ephemeral: true
            });
          }

          try {

            const user =
              await addBonusCredit(
                discordId,
                amount
              );

            return interaction.reply({
              content: [
                "✓ **Credit berhasil ditambahkan.**",
                "",
                `User: \`${discordId}\``,
                `Ditambahkan: **+${amount}**`,
                `Bonus Credit sekarang: **${user.credits}**`,
                `Daily Credit: **${user.daily_credits}/${DAILY_CREDITS}**`
              ].join("\n"),
              ephemeral: true
            });

          } catch (error) {

            return interaction.reply({
              content:
                `Gagal: ${error.message}`,
              ephemeral: true
            });
          }
        }

        /* =================================================
           ADMIN REMOVE
        ================================================= */

        if (
          interaction.customId ===
          "modal_admin_remove"
        ) {

          if (
            interaction.user.id !==
            ADMIN_USER_ID
          ) {
            return interaction.reply({
              content:
                "Unauthorized.",
              ephemeral: true
            });
          }

          const discordId =
            interaction.fields
              .getTextInputValue(
                "userid"
              )
              .trim();

          const amountText =
            interaction.fields
              .getTextInputValue(
                "amount"
              )
              .trim();

          const amount =
            Number(amountText);

          if (
            !/^\d+$/.test(discordId) ||
            !Number.isInteger(amount) ||
            amount <= 0
          ) {
            return interaction.reply({
              content:
                "Discord ID atau jumlah credit tidak valid.",
              ephemeral: true
            });
          }

          try {

            const user =
              await removeBonusCredit(
                discordId,
                amount
              );

            return interaction.reply({
              content: [
                "✓ **Credit berhasil dikurangi.**",
                "",
                `User: \`${discordId}\``,
                `Dikurangi: **-${amount}**`,
                `Bonus Credit sekarang: **${user.credits}**`,
                `Daily Credit: **${user.daily_credits}/${DAILY_CREDITS}**`
              ].join("\n"),
              ephemeral: true
            });

          } catch (error) {

            return interaction.reply({
              content:
                `Gagal: ${error.message}`,
              ephemeral: true
            });
          }
        }

        /* =================================================
           ADMIN CHECK
        ================================================= */

        if (
          interaction.customId ===
          "modal_admin_check"
        ) {

          if (
            interaction.user.id !==
            ADMIN_USER_ID
          ) {
            return interaction.reply({
              content:
                "Unauthorized.",
              ephemeral: true
            });
          }

          const discordId =
            interaction.fields
              .getTextInputValue(
                "userid"
              )
              .trim();

          if (
            !/^\d+$/.test(discordId)
          ) {
            return interaction.reply({
              content:
                "Discord User ID tidak valid.",
              ephemeral: true
            });
          }

          const user =
            await getUser(
              discordId
            );

          return interaction.reply({
            content: [
              "**Informasi User**",
              "",
              `Discord ID: \`${discordId}\``,
              "",
              `Daily Credit: **${user.daily_credits}/${DAILY_CREDITS}**`,
              `Bonus Credit: **${user.credits}**`,
              `Created: <t:${Math.floor(new Date(user.created_at).getTime() / 1000)}:F>`,
              `Last Reset: <t:${Math.floor(new Date(user.last_reset).getTime() / 1000)}:F>`
            ].join("\n"),
            ephemeral: true
          });
        }
      }

    } catch (error) {

      console.error(
        "INTERACTION ERROR:",
        error
      );

      try {

        if (
          interaction.deferred ||
          interaction.replied
        ) {
          await interaction.editReply(
            "Terjadi error internal pada bot."
          );
        } else {
          await interaction.reply({
            content:
              "Terjadi error internal pada bot.",
            ephemeral: true
          });
        }

      } catch {}
    }
  }
);

/* =========================================================
   MONGODB
========================================================= */

async function connectMongo() {

  try {

    await mongoose.connect(
      MONGODB_URI
    );

    console.log(
      "✓ MongoDB connected."
    );

  } catch (error) {

    console.error(
      "MongoDB connection failed:",
      error
    );

    process.exit(1);
  }
}

/* =========================================================
   START
========================================================= */

async function start() {

  await connectMongo();

  await client.login(
    DISCORD_TOKEN
  );
}

start();
