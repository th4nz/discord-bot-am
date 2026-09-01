const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    discord_id: {
      type: String,
      required: true,
      unique: true,
      index: true
    },

    // Bonus credit dari admin
    credits: {
      type: Number,
      default: 0,
      min: 0
    },

    // Jatah gratis 2x / 24 jam
    daily_credits: {
      type: Number,
      default: 2,
      min: 0,
      max: 2
    },

    // Waktu terakhir reset daily credit
    last_reset: {
      type: Date,
      default: Date.now
    },

    created_at: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

module.exports =
  mongoose.models.User ||
  mongoose.model("User", UserSchema);
