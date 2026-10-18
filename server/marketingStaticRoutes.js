"use strict";
// Routes for static, public product-preview assets.
// Installed before express.static and the SPA wildcard. Never intercepts '/'.
const fs = require("node:fs");
const path = require("node:path");

function registerMarketingStaticRoutes(app, distPath) {
  if (!app || typeof app.get !== "function") throw new TypeError("EXPRESS_APP_REQUIRED");
  if (!path.isAbsolute(distPath)) throw new Error("ABSOLUTE_DIST_PATH_REQUIRED");

  function sendPinnedAsset(relativePath, contentType) {
    // Only fixed, reviewed paths. No dynamic path or client input.
    const fullPath = path.join(distPath, relativePath);
    return (req, res) => {
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(503).type("text/plain").send("Public resource is not available yet.");
      }
      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.type(contentType).sendFile(fullPath);
    };
  }

  app.get("/learn", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.redirect(308, "/learn/");
  });

  app.get("/learn/", sendPinnedAsset("learn/index.html", "text/html; charset=utf-8"));
  app.get("/robots.txt", sendPinnedAsset("robots.txt", "text/plain; charset=utf-8"));
  app.get("/sitemap.xml", sendPinnedAsset("sitemap.xml", "application/xml; charset=utf-8"));
}

module.exports = { registerMarketingStaticRoutes };
