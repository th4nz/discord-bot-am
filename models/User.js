const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    discord_id: {
      type: String,
      required: true,
      unique: true
    },

    credits: {
      type: Number,
      default: 0
    },

    daily_credits: {
      type: Number,
      default: 2
    },

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
  mongoose.model("User", userSchema);
