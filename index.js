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

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const API_BASE = (
  process.env.API_BASE || "https://restapidhan.vercel.app"
).replace(/\/+$/, "");

const API_KEY = process.env.API_KEY;

// CHANNEL ID KAMU
const PANEL_CHANNEL_ID = "1544164307682721866";

if (!process.env.DISCORD_TOKEN) {
  console.error("ERROR: DISCORD_TOKEN belum diisi.");
  process.exit(1);
}

if (!API_KEY) {
  console.error("ERROR: API_KEY belum diisi.");
  process.exit(1);
}

/*
 * User ID Discord -> session email
 */
const sessions = new Map();

/* =========================
   VALIDATION
========================= */

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

/* =========================
   PANEL
========================= */

function createPanel() {
  const embed = new EmbedBuilder()
    .setTitle("Generate Acc AM Premium")
    .setDescription(
      [
        "Gunakan tombol di bawah untuk memproses akun AM Premium.",
        "",
        "📧 **Send Email**",
        "Masukkan email yang ingin digunakan.",
        "",
        "⚡ **Aktivasi**",
        "Masukkan Magic Link yang diterima melalui email.",
        "",
        "🔄 **Reset**",
        "Reset session email kamu.",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "Pastikan email yang dimasukkan benar.",
      ].join("\n")
    )
    .setColor(0xa9cdea);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("am_send")
      .setLabel("Send Email")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("am_verify")
      .setLabel("Aktivasi")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("am_reset")
      .setLabel("Reset")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [buttons],
  };
}

/* =========================
   API SEND
========================= */

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

/* =========================
   API VERIFY
========================= */

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

/* =========================
   API MESSAGE
========================= */

function getApiMessage(data) {
  return (
    data?.error ||
    data?.message ||
    "Unknown error"
  );
}

/* =========================
   SEND / UPDATE PANEL
========================= */

async function setupPanel() {
  try {
    const channel = await client.channels.fetch(
      PANEL_CHANNEL_ID
    );

    if (!channel) {
      console.error(
        "ERROR: Channel tidak ditemukan."
      );
      return;
    }

    if (!channel.isTextBased()) {
      console.error(
        "ERROR: Channel bukan text channel."
      );
      return;
    }

    console.log(
      `Channel ditemukan: ${channel.name || PANEL_CHANNEL_ID}`
    );

    /*
     * Cari panel bot sebelumnya supaya
     * restart Railway tidak membuat spam panel.
     */
    try {
      const messages = await channel.messages.fetch({
        limit: 50,
      });

      const oldPanel = messages.find(
        (message) =>
          message.author.id === client.user.id &&
          message.embeds.length > 0 &&
          message.embeds[0].title ===
            "Generate Acc AM Premium"
      );

      if (oldPanel) {
        await oldPanel.edit(createPanel());

        console.log(
          `Panel lama berhasil diperbarui: ${oldPanel.id}`
        );

        return;
      }
    } catch (error) {
      console.log(
        "Tidak bisa mencari panel lama, membuat panel baru..."
      );
    }

    /*
     * Kalau belum ada panel,
     * kirim panel baru.
     */
    const sent = await channel.send(createPanel());

    console.log(
      `Panel berhasil dikirim: ${sent.id}`
    );

  } catch (error) {
    console.error(
      "Gagal setup panel:",
      error
    );

    console.error(
      "Pastikan bot punya permission:",
      "View Channel, Send Messages, Embed Links, Read Message History"
    );
  }
}

/* =========================
   BOT READY
========================= */

client.once("ready", async () => {
  console.log("--------------------------------");
  console.log(`Bot online: ${client.user.tag}`);
  console.log(`API: ${API_BASE}`);
  console.log(`Panel Channel: ${PANEL_CHANNEL_ID}`);
  console.log("--------------------------------");

  await setupPanel();
});

/* =========================
   INTERACTIONS
========================= */

client.on(
  "interactionCreate",
  async (interaction) => {
    try {

      /* =====================
         BUTTON
      ===================== */

      if (interaction.isButton()) {

        /* SEND EMAIL */

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

          const row =
            new ActionRowBuilder()
              .addComponents(
                emailInput
              );

          modal.addComponents(row);

          return interaction.showModal(
            modal
          );
        }

        /* AKTIVASI */

        if (
          interaction.customId ===
          "am_verify"
        ) {
          const session =
            sessions.get(
              interaction.user.id
            );

          if (!session?.email) {
            return interaction.reply({
              content:
                "❌ Kirim email terlebih dahulu melalui tombol **Send Email**.",
              ephemeral: true,
            });
          }

          const modal =
            new ModalBuilder()
              .setCustomId(
                "modal_verify"
              )
              .setTitle(
                "Aktivasi AM Premium"
              );

          const magicInput =
            new TextInputBuilder()
              .setCustomId("magic")
              .setLabel(
                "Magic Link"
              )
              .setPlaceholder(
                "https://..."
              )
              .setStyle(
                TextInputStyle.Paragraph
              )
              .setRequired(true);

          const row =
            new ActionRowBuilder()
              .addComponents(
                magicInput
              );

          modal.addComponents(row);

          return interaction.showModal(
            modal
          );
        }

        /* RESET */

        if (
          interaction.customId ===
          "am_reset"
        ) {
          sessions.delete(
            interaction.user.id
          );

          return interaction.reply({
            content:
              "✅ Session email kamu berhasil di-reset.",
            ephemeral: true,
          });
        }
      }

      /* =====================
         MODAL
      ===================== */

      if (
        interaction.isModalSubmit()
      ) {

        /* =====================
           SEND MODAL
        ===================== */

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
                "❌ Format email tidak valid.",
              ephemeral: true,
            });
          }

          await interaction.deferReply({
            ephemeral: true,
          });

          try {
            const data =
              await apiSend(email);

            if (data?.status) {

              sessions.set(
                interaction.user.id,
                {
                  email,
                  sentAt: Date.now(),
                }
              );

              return interaction.editReply(
                [
                  "✅ **Email berhasil dikirim.**",
                  "",
                  `📧 Email: \`${email}\``,
                  "",
                  "Cek Inbox atau Spam.",
                  "",
                  "Setelah mendapatkan Magic Link, tekan tombol **Aktivasi**.",
                ].join("\n")
              );
            }

            return interaction.editReply(
              `❌ Gagal kirim: ${getApiMessage(data)}`
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

        /* =====================
           VERIFY MODAL
        ===================== */

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
                "❌ Session email tidak ditemukan. Gunakan **Send Email** terlebih dahulu.",
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
                "❌ Magic Link harus berupa URL HTTP/HTTPS yang valid.",
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
                  ? `\n\nCode Order: \`${data.codeorder}\``
                  : "";

              sessions.delete(
                interaction.user.id
              );

              return interaction.editReply(
                [
                  "✅ **Aktivasi berhasil!**",
                  "",
                  `Email: \`${session.email}\``,
                  code,
                ].join("")
              );
            }

            return interaction.editReply(
              `❌ Gagal aktivasi: ${getApiMessage(data)}`
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

/* =========================
   LOGIN
========================= */

client.login(
  process.env.DISCORD_TOKEN
);
