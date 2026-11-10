"use strict";

const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const PACKAGE_NAME = "com.pentagon.providernode";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_APK_BYTES = 32 * 1024 * 1024;
const APK_FALLBACK_URL = "https://pentagon.quest/api/provider-node/releases/cloud/apk";

class ReleaseError extends Error {
  constructor(status, code, upstreamStatus) {
    super(code); this.status = status; this.code = code; this.upstreamStatus = upstreamStatus;
  }
}

function releaseBase(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(raw); } catch (_) { throw new ReleaseError(503, "RELEASE_CHANNEL_NOT_CONFIGURED"); }
  // Only deployment configuration selects the origin. Query strings, request
  // headers and incoming paths never influence the upstream destination.
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || (url.pathname && url.pathname !== "/") || (url.port && url.port !== "443")) {
    throw new ReleaseError(503, "INVALID_RELEASE_CHANNEL");
  }
  return url.origin;
}

function noCache(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("X-Content-Type-Options", "nosniff");
}

function fail(res, error) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.removeHeader("Content-Length");
  res.removeHeader("Content-Disposition");
  res.set("Content-Type", "application/json; charset=utf-8");
  const known = error instanceof ReleaseError;
  const body = { error: known ? error.code : "RELEASE_SERVICE_UNAVAILABLE" };
  if (known && Number.isInteger(error.upstreamStatus)) body.upstream_status = error.upstreamStatus;
  res.status(known ? error.status : 502).json(body);
}

async function readBounded(body, maximum) {
  if (!body) throw new ReleaseError(502, "EMPTY_RELEASE_RESPONSE");
  const chunks = []; let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maximum) throw new ReleaseError(502, "RELEASE_RESPONSE_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function createCloudReleaseHandlers(options = {}) {
  const getBase = options.getBase || (() => process.env.PROVIDER_NODE_CLOUD_RELEASE_URL);
  const fetchUpstream = options.fetchImpl || globalThis.fetch;
  const manifestTimeoutMs = options.manifestTimeoutMs || 12000;
  const apkTimeoutMs = options.apkTimeoutMs || 60000;
  const maxApkBytes = options.maxApkBytes || MAX_APK_BYTES;
  let apkInFlight = 0;

  async function request(req, res, path, timeoutMs, consume) {
    const base = releaseBase(getBase());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once("close", disconnected);
    try {
      const response = await fetchUpstream(base + path, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Cache-Control": "no-cache", "Pragma": "no-cache", "Accept-Encoding": "identity",
          "User-Agent": "PentagonReleaseProxy/1.1"
        }
      });
      if (response.status !== 200) throw new ReleaseError(502, "RELEASE_SERVICE_UNAVAILABLE", response.status);
      await consume(response, base);
    } finally {
      clearTimeout(timer);
      res.removeListener("close", disconnected);
      controller.abort();
    }
  }

  async function latest(req, res) {
    noCache(res);
    try {
      await request(req, res, "/latest.json", manifestTimeoutMs, async (response, base) => {
        if (req.method === "HEAD") { res.status(200).end(); return; }
        let release;
        try { release = JSON.parse((await readBounded(response.body, MAX_MANIFEST_BYTES)).toString("utf8")); }
        catch (error) { if (error instanceof ReleaseError) throw error; throw new ReleaseError(502, "INVALID_RELEASE_METADATA"); }
        if (release?.packageName !== PACKAGE_NAME || !Number.isSafeInteger(release.versionCode) || release.versionCode < 1
            || typeof release.versionName !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(release.versionName)
            || !/^[a-fA-F0-9]{64}$/.test(release.sha256 || "") || !/^[a-fA-F0-9]{64}$/.test(release.signerSha256 || "")
            || !Number.isSafeInteger(release.sizeBytes) || release.sizeBytes < 1 || release.sizeBytes > maxApkBytes) {
          throw new ReleaseError(502, "INVALID_RELEASE_METADATA");
        }
        res.json({
          versionCode: release.versionCode, versionName: release.versionName,
          packageName: PACKAGE_NAME, sizeBytes: release.sizeBytes,
          sha256: release.sha256.toLowerCase(), signerSha256: release.signerSha256.toLowerCase(),
          releaseNotes: String(release.releaseNotes || "").slice(0, 4096),
          downloadUrl: base + "/latest.apk", fallbackDownloadUrl: APK_FALLBACK_URL
        });
      });
    } catch (error) { fail(res, error); }
  }

  async function apk(req, res) {
    noCache(res);
    if (apkInFlight >= 3) {
      res.set("Retry-After", "15");
      return res.status(503).json({ error: "RELEASE_DOWNLOAD_BUSY" });
    }
    apkInFlight++;
    try {
      await request(req, res, "/latest.apk", apkTimeoutMs, async response => {
        const rawLength = response.headers.get("content-length");
        const length = rawLength === null ? null : Number(rawLength);
        if (length !== null && (!Number.isSafeInteger(length) || length < 1 || length > maxApkBytes)) {
          throw new ReleaseError(502, "INVALID_APK_SIZE");
        }
        const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!["application/vnd.android.package-archive", "application/octet-stream"].includes(contentType)) {
          throw new ReleaseError(502, "INVALID_APK_CONTENT_TYPE");
        }
        res.set("Content-Type", "application/vnd.android.package-archive");
        res.set("Content-Disposition", 'attachment; filename="Pentagon-Provider-Node.apk"');
        if (length !== null) res.set("Content-Length", String(length));
        if (req.method === "HEAD") { res.status(200).end(); return; }
        if (!response.body) throw new ReleaseError(502, "EMPTY_RELEASE_RESPONSE");
        let received = 0;
        const bound = new Transform({
          transform(chunk, encoding, callback) {
            received += chunk.length;
            if (received > maxApkBytes) callback(new ReleaseError(502, "APK_TOO_LARGE"));
            else callback(null, chunk);
          },
          flush(callback) {
            if (length !== null && length !== received) callback(new ReleaseError(502, "INCOMPLETE_APK"));
            else callback();
          }
        });
        await pipeline(Readable.fromWeb(response.body), bound, res);
      });
    } catch (error) { fail(res, error); }
    finally { apkInFlight--; }
  }

  return { latest, apk };
}

module.exports = { createCloudReleaseHandlers, releaseBase, MAX_APK_BYTES };
