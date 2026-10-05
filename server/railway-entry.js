require("dotenv").config();

const scheduler = require("./scheduler");
const schedulerEnabled = String(process.env.SCHEDULER_ENABLED || "true").toLowerCase() !== "false";

// Railway/Safari cache hardening: auth bootstrap must never resolve as 304.
// Patch the Express factory before the main app is created so the runtime app
// has ETags disabled and auth API responses are explicitly no-store.
const expressModulePath = require.resolve("express");
const expressOriginal = require(expressModulePath);
function expressNoCache(...args) {
  const app = expressOriginal(...args);
  app.disable("etag");
  app.use((req, res, next) => {
    if (String(req.path || req.url || "").startsWith("/api/auth/")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.removeHeader("ETag");
    }
    next();
  });
  return app;
}
Object.assign(expressNoCache, expressOriginal);
require.cache[expressModulePath].exports = expressNoCache;

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
