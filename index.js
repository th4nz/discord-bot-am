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
} = require("discord.js");

const { MongoClient } = require("mongodb");

/* =========================================================
   CONFIG
========================================================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const API_BASE = (
  process.env.API_BASE || "https://restapidhan.vercel.app"
).replace(/\/+$/, "");

const API_KEY = process.env.API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

const PUBLIC_CHANNEL_ID = "1544164307682721866";
const ADMIN_CHANNEL_ID = "1544164307682721864";
const ADMIN_USER_ID = "1403799018487808071";

const DAILY_CREDITS = 2;

/* =========================================================
   VALIDATE ENV
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
  intents: [GatewayIntentBits.Guilds],
});

/* =========================================================
   MONGODB
========================================================= */

const mongoClient = new MongoClient(MONGODB_URI);

let db;
let usersCollection;

async function connectDatabase() {
  await mongoClient.connect();

  db = mongoClient.db("discord_am_bot");

  usersCollection = db.collection("users");

  await usersCollection.createIndex(
    { discordId: 1 },
    { unique: true }
  );

  console.log("MongoDB connected.");
}

/* =========================================================
   USER DATABASE
========================================================= */

async function getUser(discordId) {
  let user = await usersCollection.findOne({
    discordId,
  });

  const now = new Date();

  if (!user) {
    user = {
      discordId,
      dailyCredits: DAILY_CREDITS,
      bonusCredits: 0,
      lastReset: now,
      createdAt: now,
      updatedAt: now,
    };

    await usersCollection.insertOne(user);

    return user;
  }

  const lastReset = new Date(user.lastReset);

  const elapsed = now.getTime() - lastReset.getTime();

  const twentyFourHours = 24 * 60 * 60 * 1000;

  if (elapsed >= twentyFourHours) {
    user.dailyCredits = DAILY_CREDITS;
    user.lastReset = now;
    user.updatedAt = now;

    await usersCollection.updateOne(
      { discordId },
      {
        $set: {
          dailyCredits: DAILY_CREDITS,
          lastReset: now,
          updatedAt: now,
        },
      }
    );
  }

  return user;
}

/* =========================================================
   CREDIT INFO
========================================================= */

async function getCreditInfo(discordId) {
  const user = await getUser(discordId);

  return {
    dailyCredits: user.dailyCredits || 0,
    bonusCredits: user.bonusCredits || 0,
    totalCredits:
      (user.dailyCredits || 0) +
      (user.bonusCredits || 0),
    lastReset: user.lastReset,
  };
}

/* =========================================================
   CONSUME CREDIT
========================================================= */

async function consumeCredit(discordId) {
  const user = await getUser(discordId);

  const daily = user.dailyCredits || 0;
  const bonus = user.bonusCredits || 0;

  if (daily > 0) {
    await usersCollection.updateOne(
      { discordId },
      {
        $inc: {
          dailyCredits: -1,
        },
        $set: {
          updatedAt: new Date(),
        },
      }
    );

    return {
      success: true,
      type: "daily",
    };
  }

  if (bonus > 0) {
    await usersCollection.updateOne(
      { discordId },
      {
        $inc: {
          bonusCredits: -1,
        },
        $set: {
          updatedAt: new Date(),
        },
      }
    );

    return {
      success: true,
      type: "bonus",
    };
  }

  return {
    success: false,
    type: null,
  };
}

/* =========================================================
   ADMIN ADD CREDIT
========================================================= */

async function addBonusCredits(discordId, amount) {
  await getUser(discordId);

  await usersCollection.updateOne(
    { discordId },
    {
      $inc: {
        bonusCredits: amount,
      },
      $set: {
        updatedAt: new Date(),
      },
    }
  );

  return getCreditInfo(discordId);
}

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
   SESSION
========================================================= */

const sessions = new Map();

/* =========================================================
   PUBLIC PANEL
========================================================= */

function createPublicPanel() {
  const embed = new EmbedBuilder()
    .setTitle("AM Premium Generator")
    .setDescription(
      [
        "Gunakan tombol di bawah untuk memulai.",
        "",
        "📩 **Send Email**",
        "Kirim email untuk mendapatkan Magic Link.",
        "",
        "🔐 **Aktivasi**",
        "Masukkan Magic Link dari email.",
        "",
        "💳 **Credit**",
        "Setiap user mendapatkan 2 pemakaian setiap 24 jam.",
        "Credit tambahan diberikan oleh admin.",
        "",
        "📊 **Cek Credit**",
        "Lihat sisa credit kamu."
      ].join("\n")
    )
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("am_send")
      .setLabel("Send Email")
      .setEmoji("📩")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("am_verify")
      .setLabel("Aktivasi")
      .setEmoji("🔐")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("am_credit")
      .setLabel("Credit")
      .setEmoji("💳")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("am_reset")
      .setLabel("Reset")
      .setEmoji("♻️")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [row],
  };
}

/* =========================================================
   ADMIN PANEL
========================================================= */

function createAdminPanel() {
  const embed = new EmbedBuilder()
    .setTitle("🛠️ ADMIN PANEL")
    .setDescription(
      [
        "Panel khusus administrator.",
        "",
        "➕ **Tambah Credit**",
        "Memberikan bonus credit kepada user.",
        "",
        "🔎 **Cek User**",
        "Melihat credit user berdasarkan Discord ID.",
        "",
        "📋 **Statistik**",
        "Melihat jumlah user yang tersimpan.",
      ].join("\n")
    )
    .setColor(0xed4245);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("admin_add_credit")
      .setLabel("Tambah Credit")
      .setEmoji("➕")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("admin_check_user")
      .setLabel("Cek User")
      .setEmoji("🔎")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("admin_stats")
      .setLabel("Statistik")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [row],
  };
}

/* =========================================================
   SEND API
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
      `API mengembalikan response bukan JSON (HTTP ${response.status})`
    );
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return data;
}

/* =========================================================
   VERIFY API
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
      `API mengembalikan response bukan JSON (HTTP ${response.status})`
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
      limit: 20,
    });

    const existing = messages.find(
      (message) =>
        message.author.id === client.user.id &&
        message.components?.some((row) =>
          row.components?.some(
            (component) =>
              component.customId === "am_send"
          )
        )
    );

    if (existing) {
      await existing.edit(createPublicPanel());

      console.log(
        "Public panel berhasil diperbarui."
      );

      return;
    }

    await channel.send(createPublicPanel());

    console.log(
      "Public panel berhasil dibuat."
    );
  } catch (error) {
    console.error(
      "PUBLIC PANEL ERROR:",
      error.message
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
      limit: 20,
    });

    const existing = messages.find(
      (message) =>
        message.author.id === client.user.id &&
        message.components?.some((row) =>
          row.components?.some(
            (component) =>
              component.customId ===
              "admin_add_credit"
          )
        )
    );

    if (existing) {
      await existing.edit(createAdminPanel());

      console.log(
        "Admin panel berhasil diperbarui."
      );

      return;
    }

    await channel.send(createAdminPanel());

    console.log(
      "Admin panel berhasil dibuat."
    );
  } catch (error) {
    console.error(
      "ADMIN PANEL ERROR:",
      error.message
    );
  }
}

/* =========================================================
   READY
========================================================= */

client.once("ready", async () => {
  console.log("--------------------------------");
  console.log(`Bot online: ${client.user.tag}`);
  console.log(`API: ${API_BASE}`);
  console.log("--------------------------------");

  await setupPublicPanel();
  await setupAdminPanel();
});

/* =========================================================
   INTERACTIONS
========================================================= */

client.on(
  "interactionCreate",
  async (interaction) => {
    try {
      /* =====================================================
         BUTTON
      ===================================================== */

      if (interaction.isButton()) {
        const channelId = interaction.channelId;

        /* ================================================
           PUBLIC PANEL
        ================================================ */

        if (
          [
            "am_send",
            "am_verify",
            "am_credit",
            "am_reset",
          ].includes(interaction.customId)
        ) {
          if (
            channelId !== PUBLIC_CHANNEL_ID
          ) {
            return interaction.reply({
              content:
                "Panel ini hanya bisa digunakan di channel public.",
              ephemeral: true,
            });
          }
        }

        /* ================================================
           SEND
        ================================================ */

        if (interaction.customId === "am_send") {
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

          const row =
            new ActionRowBuilder().addComponents(
              emailInput
            );

          modal.addComponents(row);

          return interaction.showModal(
            modal
          );
        }

        /* ================================================
           VERIFY
        ================================================ */

        if (
          interaction.customId === "am_verify"
        ) {
          const session = sessions.get(
            interaction.user.id
          );

          if (!session?.email) {
            return interaction.reply({
              content:
                "Kirim email terlebih dahulu melalui tombol **Send Email**.",
              ephemeral: true,
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

          const row =
            new ActionRowBuilder().addComponents(
              magicInput
            );

          modal.addComponents(row);

          return interaction.showModal(
            modal
          );
        }

        /* ================================================
           CREDIT
        ================================================ */

        if (
          interaction.customId ===
          "am_credit"
        ) {
          const info =
            await getCreditInfo(
              interaction.user.id
            );

          return interaction.reply({
            content: [
              "💳 **Credit Kamu**",
              "",
              `Daily Credit: **${info.dailyCredits}**`,
              `Bonus Credit: **${info.bonusCredits}**`,
              `Total: **${info.totalCredits}**`,
              "",
              `Reset daily: <t:${Math.floor(
                new Date(info.lastReset).getTime() /
                  1000 +
                  86400
              )}:R>`,
            ].join("\n"),
            ephemeral: true,
          });
        }

        /* ================================================
           RESET SESSION
        ================================================ */

        if (
          interaction.customId ===
          "am_reset"
        ) {
          sessions.delete(
            interaction.user.id
          );

          return interaction.reply({
            content:
              "♻️ Session email kamu berhasil di-reset.",
            ephemeral: true,
          });
        }

        /* ================================================
           ADMIN CHECK
        ================================================ */

        if (
          interaction.customId.startsWith(
            "admin_"
          )
        ) {
          if (
            interaction.user.id !==
            ADMIN_USER_ID
          ) {
            return interaction.reply({
              content:
                "❌ Kamu bukan administrator.",
              ephemeral: true,
            });
          }

          if (
            channelId !== ADMIN_CHANNEL_ID
          ) {
            return interaction.reply({
              content:
                "❌ Panel admin hanya bisa digunakan di channel admin.",
              ephemeral: true,
            });
          }
        }

        /* ================================================
           ADMIN ADD CREDIT
        ================================================ */

        if (
          interaction.customId ===
          "admin_add_credit"
        ) {
          const modal = new ModalBuilder()
            .setCustomId(
              "modal_admin_add_credit"
            )
            .setTitle(
              "Tambah Credit User"
            );

          const userIdInput =
            new TextInputBuilder()
              .setCustomId(
                "user_id"
              )
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

          const amountInput =
            new TextInputBuilder()
              .setCustomId(
                "amount"
              )
              .setLabel(
                "Jumlah Credit"
              )
              .setPlaceholder(
                "5"
              )
              .setStyle(
                TextInputStyle.Short
              )
              .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              userIdInput
            ),
            new ActionRowBuilder().addComponents(
              amountInput
            )
          );

          return interaction.showModal(
            modal
          );
        }

        /* ================================================
           ADMIN CHECK USER
        ================================================ */

        if (
          interaction.customId ===
          "admin_check_user"
        ) {
          const modal = new ModalBuilder()
            .setCustomId(
              "modal_admin_check_user"
            )
            .setTitle(
              "Cek Credit User"
            );

          const userIdInput =
            new TextInputBuilder()
              .setCustomId(
                "user_id"
              )
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
              userIdInput
            )
          );

          return interaction.showModal(
            modal
          );
        }

        /* ================================================
           ADMIN STATS
        ================================================ */

        if (
          interaction.customId ===
          "admin_stats"
        ) {
          const total =
            await usersCollection.countDocuments();

          return interaction.reply({
            content: [
              "📊 **Bot Statistics**",
              "",
              `Total user tersimpan: **${total}**`,
              `Daily credit/user: **${DAILY_CREDITS}**`,
            ].join("\n"),
            ephemeral: true,
          });
        }
      }

      /* ===================================================
         MODAL
      =================================================== */

      if (interaction.isModalSubmit()) {
        /* ================================================
           SEND EMAIL
        ================================================ */

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
              ephemeral: true,
            });
          }

          await interaction.deferReply({
            ephemeral: true,
          });

          /* CHECK CREDIT */

          const info =
            await getCreditInfo(
              interaction.user.id
            );

          if (
            info.totalCredits <= 0
          ) {
            return interaction.editReply(
              [
                "❌ **Credit habis.**",
                "",
                "Kamu sudah tidak memiliki credit.",
                "Tunggu reset harian atau hubungi admin untuk bonus credit.",
              ].join("\n")
            );
          }

          try {
            /* CALL API */

            const data =
              await apiSend(email);

            if (data?.status) {
              /* CONSUME ONLY AFTER SUCCESS */

              const consumed =
                await consumeCredit(
                  interaction.user.id
                );

              if (!consumed.success) {
                return interaction.editReply(
                  "Credit tidak cukup."
                );
              }

              sessions.set(
                interaction.user.id,
                {
                  email,
                  sentAt: Date.now(),
                }
              );

              const after =
                await getCreditInfo(
                  interaction.user.id
                );

              return interaction.editReply(
                [
                  "✅ **Email berhasil dikirim.**",
                  "",
                  `Email: \`${email}\``,
                  "",
                  "Cek Inbox atau Spam.",
                  "Setelah mendapatkan Magic Link, tekan tombol **Aktivasi**.",
                  "",
                  `Credit tersisa: **${after.totalCredits}**`,
                ].join("\n")
              );
            }

            return interaction.editReply(
              `❌ Gagal kirim: ${getApiMessage(
                data
              )}`
            );
          } catch (error) {
            console.error(
              "SEND ERROR:",
              error
            );

            return interaction.editReply(
              `❌ Error API: ${error.message}`
            );
          }
        }

        /* ================================================
           VERIFY
        ================================================ */

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
                "Session email tidak ditemukan. Gunakan **Send Email** terlebih dahulu.",
              ephemeral: true,
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
              ephemeral: true,
            });
          }

          await interaction.deferReply({
            ephemeral: true,
          });

          try {
            const data =
              await apiVerify(
                session.email,
                magicLink
              );

            if (data?.status) {
              const code =
                data.codeorder
                  ? `\nCode Order: \`${data.codeorder}\``
                  : "";

              sessions.delete(
                interaction.user.id
              );

              const info =
                await getCreditInfo(
                  interaction.user.id
                );

              return interaction.editReply(
                [
                  "✅ **Aktivasi berhasil**",
                  code,
                  "",
                  `Credit tersisa: **${info.totalCredits}**`,
                ].join("")
              );
            }

            return interaction.editReply(
              `❌ Gagal aktivasi: ${getApiMessage(
                data
              )}`
            );
          } catch (error) {
            console.error(
              "VERIFY ERROR:",
              error
            );

            return interaction.editReply(
              `❌ Error API: ${error.message}`
            );
          }
        }

        /* ================================================
           ADMIN ADD CREDIT
        ================================================ */

        if (
          interaction.customId ===
          "modal_admin_add_credit"
        ) {
          if (
            interaction.user.id !==
            ADMIN_USER_ID
          ) {
            return interaction.reply({
              content:
                "❌ Unauthorized.",
              ephemeral: true,
            });
          }

          const userId =
            interaction.fields
              .getTextInputValue(
                "user_id"
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
            !/^\d{15,20}$/.test(
              userId
            )
          ) {
            return interaction.reply({
              content:
                "❌ Discord User ID tidak valid.",
              ephemeral: true,
            });
          }

          if (
            !Number.isInteger(amount) ||
            amount <= 0 ||
            amount > 10000
          ) {
            return interaction.reply({
              content:
                "❌ Jumlah credit harus angka bulat antara 1 sampai 10000.",
              ephemeral: true,
            });
          }

          const info =
            await addBonusCredits(
              userId,
              amount
            );

          return interaction.reply({
            content: [
              "✅ **Credit berhasil ditambahkan.**",
              "",
              `User: <@${userId}>`,
              `Ditambahkan: **+${amount}**`,
              "",
              `Daily Credit: **${info.dailyCredits}**`,
              `Bonus Credit: **${info.bonusCredits}**`,
              `Total: **${info.totalCredits}**`,
            ].join("\n"),
            ephemeral: true,
          });
        }

        /* ================================================
           ADMIN CHECK USER
        ================================================ */

        if (
          interaction.customId ===
          "modal_admin_check_user"
        ) {
          if (
            interaction.user.id !==
            ADMIN_USER_ID
          ) {
            return interaction.reply({
              content:
                "❌ Unauthorized.",
              ephemeral: true,
            });
          }

          const userId =
            interaction.fields
              .getTextInputValue(
                "user_id"
              )
              .trim();

          if (
            !/^\d{15,20}$/.test(
              userId
            )
          ) {
            return interaction.reply({
              content:
                "❌ Discord User ID tidak valid.",
              ephemeral: true,
            });
          }

          const info =
            await getCreditInfo(
              userId
            );

          return interaction.reply({
            content: [
              "🔎 **User Credit**",
              "",
              `User: <@${userId}>`,
              "",
              `Daily Credit: **${info.dailyCredits}**`,
              `Bonus Credit: **${info.bonusCredits}**`,
              `Total: **${info.totalCredits}**`,
              "",
              `Last Reset: <t:${Math.floor(
                new Date(
                  info.lastReset
                ).getTime() /
                  1000
              )}:R>`,
            ].join("\n"),
            ephemeral: true,
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
            "❌ Terjadi error internal pada bot."
          );
        } else {
          await interaction.reply({
            content:
              "❌ Terjadi error internal pada bot.",
            ephemeral: true,
          });
        }
      } catch {}
    }
  }
);

/* =========================================================
   START
========================================================= */

async function start() {
  try {
    await connectDatabase();

    await client.login(
      DISCORD_TOKEN
    );
  } catch (error) {
    console.error(
      "START ERROR:",
      error
    );

    process.exit(1);
  }
}

start();
