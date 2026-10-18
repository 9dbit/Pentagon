"use strict";
// Marketing RC1 is an independent static preview. NEVER loads the Pentagon app,
// production database, Railway app secrets, or scheduling workers.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "../public");
const assets = Object.freeze({
  "/learn/": ["learn/index.html", "text/html; charset=utf-8"],
  "/sitemap.xml": ["sitemap.xml", "application/xml; charset=utf-8"],
  "/pentagon-icon.svg": ["pentagon-icon.svg", "image/svg+xml"],
  "/og-image.png": ["og-image.png", "image/png"]
});
const constants = Object.fromEntries(Object.entries(assets).map(([url, [p, mime]]) => {
  const file = path.join(ROOT, p);
  const data = fs.readFileSync(file);
  return [url, {data, mime}];
}));
const ROBOTS = Buffer.from("User-agent: *\nDisallow: /\n", "utf8");
const headers = Object.freeze({
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cache-Control": "no-store, max-age=0"
});
function createServer() {
  return http.createServer((req, res) => {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, {"Allow": "GET, HEAD"});
      return res.end(req.method === "HEAD" ? undefined : "Method not allowed\n");
    }
    let url;
    try { url = new URL(req.url, "http://preview.invalid").pathname; }
    catch { res.writeHead(400); return res.end(); }
    if (url === "/" || url === "/learn") {
      res.writeHead(302, {"Location": "/learn/"});
      return res.end();
    }
    if (url === "/health") {
      const data = Buffer.from('{"ok":true,"service":"pentagon-marketing-rc1","database":"not-connected","scheduler":"disabled"}\n');
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", String(data.length));
      res.writeHead(200);
      return res.end(req.method === "HEAD" ? undefined : data);
    }
    if (url === "/robots.txt") {
      res.setHeader("Content-Length", String(ROBOTS.length));
      res.writeHead(200);
      return res.end(req.method === "HEAD" ? undefined : ROBOTS);
    }
    const asset = constants[url];
    if (!asset) {
      res.writeHead(404);
      return res.end(req.method === "HEAD" ? undefined : "Preview path not found\n");
    }
    res.setHeader("Content-Type", asset.mime);
    res.setHeader("Content-Length", String(asset.data.length));
    res.writeHead(200);
    res.end(req.method === "HEAD" ? undefined : asset.data);
  });
}
if (require.main === module) {
  const port = Number(process.env.PORT || "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error("INVALID_PORT");
  createServer().listen(port, "0.0.0.0", () => console.log("PENTAGON_STATIC_PREVIEW_READY"));
}
module.exports = { createServer };
