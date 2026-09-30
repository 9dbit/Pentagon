require("dotenv").config();

const scheduler = require("./scheduler");
const schedulerEnabled = String(process.env.SCHEDULER_ENABLED || "true").toLowerCase() !== "false";

try {
  if (process.env.DATABASE_URL) {
    const dbUrl = new URL(process.env.DATABASE_URL);
    console.log(`[Railway] DB target host=${dbUrl.hostname} database=${dbUrl.pathname.replace(/^\//, "") || "postgres"}`);
  } else {
    console.log("[Railway] DB target missing DATABASE_URL");
  }
} catch (err) {
  console.log(`[Railway] DB target parse error: ${err.message}`);
}

if (!schedulerEnabled) {
  scheduler.startScheduler = () => {
    console.log("[Railway] Scheduler disabled by SCHEDULER_ENABLED=false");
  };
}

require("./index");
