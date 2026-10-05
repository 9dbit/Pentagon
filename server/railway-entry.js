require("dotenv").config();

const scheduler = require("./scheduler");
const schedulerEnabled = String(process.env.SCHEDULER_ENABLED || "true").toLowerCase() !== "false";

// Railway/Safari cache hardening: bootstrap HTML and auth must never resolve
// from a stale shell or conditional cache entry.
const expressModulePath = require.resolve("express");
const expressOriginal = require(expressModulePath);
function expressNoCache(...args) {
  const app = expressOriginal(...args);
  app.disable("etag");
  app.use((req, res, next) => {
    const requestPath = String(req.path || req.url || "").split("?")[0];
    const isAuth = requestPath.startsWith("/api/auth/");
    const isHtmlShell = requestPath === "/" || requestPath === "/index.html" || requestPath.endsWith(".html");

    if (isAuth || isHtmlShell) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Surrogate-Control", "no-store");
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
