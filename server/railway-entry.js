require("dotenv").config();

const scheduler = require("./scheduler");
const schedulerEnabled = String(process.env.SCHEDULER_ENABLED || "true").toLowerCase() !== "false";

function logDbTarget(name) {
  try {
    const value = process.env[name];
    if (!value) {
      console.log(`[Railway] ${name} target missing`);
      return;
    }
    const dbUrl = new URL(value);
    console.log(`[Railway] ${name} target host=${dbUrl.hostname} database=${dbUrl.pathname.replace(/^\//, "") || "postgres"}`);
  } catch (err) {
    console.log(`[Railway] ${name} target parse error: ${err.message}`);
  }
}

logDbTarget("DATABASE_URL");
logDbTarget("DATABASE_URL_DEVELOPMENT");

if (!schedulerEnabled) {
  scheduler.startScheduler = () => {
    console.log("[Railway] Scheduler disabled by SCHEDULER_ENABLED=false");
  };
}

require("./index");
