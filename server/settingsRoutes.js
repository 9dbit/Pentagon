const express = require("express");
const { getRuntimeSettings, saveSettings } = require("./settingsStore");

const router = express.Router();

router.get("/", (req, res) => {
  const settings = getRuntimeSettings();
  if (req.session && req.session.isDemo) {
    return res.json({
      ...settings,
      telegram_bot_token: "",
      telegram_chat_id: ""
    });
  }
  res.json(settings);
});

router.post("/", async (req, res, next) => {
  try {
    const saved = await saveSettings(req.body || {});
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
