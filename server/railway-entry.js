require("dotenv").config();

const scheduler = require("./scheduler");
const schedulerEnabled = String(process.env.SCHEDULER_ENABLED || "true").toLowerCase() !== "false";

if (!schedulerEnabled) {
  scheduler.startScheduler = () => {
    console.log("[Railway] Scheduler disabled by SCHEDULER_ENABLED=false");
  };
}

require("./index");
