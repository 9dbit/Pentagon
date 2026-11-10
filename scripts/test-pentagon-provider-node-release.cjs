#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const { createCloudReleaseHandlers, releaseBase, MAX_APK_BYTES } = require("../server/providerNodeRelease");

const BASE = "https://provider-node-release-production.up.railway.app";
const APK = Buffer.from("PK\u0003\u0004pentagon-fixture-apk");
const release = () => ({
  versionCode: 178, versionName: "1.7.8", packageName: "com.pentagon.providernode",
  sizeBytes: APK.length, sha256: createHash("sha256").update(APK).digest("hex"),
  signerSha256: "a".repeat(64), releaseNotes: "fixture only",
  downloadUrl: "https://untrusted.example/redirect.apk"
});

function decorate(res) {
  res.set = (name, value) => { res.setHeader(name, value); return res; };
  res.status = status => { res.statusCode = status; return res; };
  res.json = value => {
    const data = Buffer.from(JSON.stringify(value));
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", data.length);
    res.end(data); return res;
  };
  return res;
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return "http://127.0.0.1:" + server.address().port;
}

async function harness(t, handler, options = {}) {
  const seen = [];
  const upstream = await listen(t, handler);
  const endpoints = createCloudReleaseHandlers({
    getBase: () => BASE,
    fetchImpl: (url, request) => {
      seen.push({ url, request });
      // Test transport maps the validated public origin to this local fixture.
      // Production uses global fetch and has no caller-supplied upstream URL.
      return fetch(upstream + new URL(url).pathname, request);
    },
    ...options
  });
  const api = await listen(t, (req, res) => {
    decorate(res);
    const path = new URL(req.url, "http://fixture.test").pathname;
    const route = path.endsWith("/apk") ? endpoints.apk : endpoints.latest;
    Promise.resolve(route(req, res)).catch(() => res.destroy());
  });
  return { seen, api };
}

test("release origin rejects credentials, cleartext, path, query, fragment and non-TLS ports", () => {
  assert.equal(releaseBase(BASE + "/"), BASE);
  for (const value of ["", "http://release.example", "https://user:secret@release.example", "https://release.example/path",
    "https://release.example?target=evil", "https://release.example#evil", "https://release.example:444"]) {
    assert.throws(() => releaseBase(value));
  }
});

test("manifest preserves release identity and pins download routes, ignoring all caller inputs", async t => {
  const h = await harness(t, (req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(release())); });
  const response = await fetch(h.api + "/latest?url=https://evil.example&token=do-not-forward", {
    headers: { Authorization: "fixture-private", Cookie: "fixture-cookie", "X-Forwarded-Host": "evil.example" }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sha256, release().sha256);
  assert.equal(body.signerSha256, release().signerSha256);
  assert.equal(body.packageName, "com.pentagon.providernode");
  assert.equal(body.downloadUrl, BASE + "/latest.apk");
  assert.equal(body.fallbackDownloadUrl, "https://pentagon.quest/api/provider-node/releases/cloud/apk");
  assert.equal(h.seen[0].url, BASE + "/latest.json");
  assert.equal(h.seen[0].request.headers.Authorization, undefined);
  assert.equal(h.seen[0].request.headers.Cookie, undefined);
  assert.equal(response.headers.get("cache-control").includes("no-store"), true);
});

test("upstream redirects are rejected without visiting their target or exposing error details", async t => {
  let redirected = 0;
  const destination = await listen(t, (req, res) => { redirected++; res.end("secret"); });
  const h = await harness(t, (req, res) => { res.writeHead(302, { Location: destination + "/private?secret=fixture" }); res.end(); });
  const response = await fetch(h.api + "/latest");
  assert.equal(response.status, 502);
  const body = JSON.stringify(await response.json());
  assert.equal(redirected, 0);
  assert.doesNotMatch(body, /fixture|private|127\.0\.0\.1|http:/);
  assert.equal(h.seen[0].request.redirect, "error");
});

test("invalid and oversized release manifests fail without advertising an update", async t => {
  let mode = "package";
  const h = await harness(t, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(mode === "oversized" ? " ".repeat(65537) : JSON.stringify({ ...release(), packageName: "other.app" }));
  });
  assert.equal((await fetch(h.api + "/latest")).status, 502);
  mode = "oversized";
  const response = await fetch(h.api + "/latest");
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "RELEASE_RESPONSE_TOO_LARGE");
});

test("APK proxy returns exact binary bytes from its fixed source and forwards no credentials", async t => {
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive", "Content-Length": APK.length });
    res.end(APK);
  });
  const response = await fetch(h.api + "/apk?downloadUrl=https://evil.example", { headers: { Authorization: "private-fixture" } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), APK);
  assert.equal(h.seen[0].url, BASE + "/latest.apk");
  assert.equal(h.seen[0].request.headers.Authorization, undefined);
  assert.equal(response.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Pentagon-Provider-Node.apk"');
});

test("APK proxy rejects oversized advertised length and HTML before sending a download", async t => {
  let mode = "size";
  const h = await harness(t, (req, res) => {
    res.writeHead(200, mode === "size"
      ? { "Content-Type": "application/vnd.android.package-archive", "Content-Length": MAX_APK_BYTES + 1 }
      : { "Content-Type": "text/html" });
    res.end("bad");
  });
  let response = await fetch(h.api + "/apk");
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "INVALID_APK_SIZE");
  mode = "html";
  response = await fetch(h.api + "/apk");
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "INVALID_APK_CONTENT_TYPE");
});

test("chunked APK streams cannot bypass the maximum byte count", async t => {
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive", "Transfer-Encoding": "chunked" });
    res.end(Buffer.alloc(128));
  }, { maxApkBytes: 64 });
  await assert.rejects(async () => {
    const response = await fetch(h.api + "/apk");
    await response.arrayBuffer();
  });
});

test("manifest deadline bounds a stalled response body", async t => {
  let timer;
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"versionCode":');
    timer = setTimeout(() => res.end("178}"), 1500);
  }, { manifestTimeoutMs: 80 });
  t.after(() => clearTimeout(timer));
  const started = Date.now();
  const response = await fetch(h.api + "/latest");
  assert.equal(response.status, 502);
  assert.ok(Date.now() - started < 1000);
});

test("unconfigured release source is a controlled503 without an upstream request", async t => {
  let attempts = 0;
  const h = await harness(t, (req, res) => { attempts++; res.end(); }, { getBase: () => "" });
  const response = await fetch(h.api + "/latest");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "RELEASE_CHANNEL_NOT_CONFIGURED");
  assert.equal(attempts, 0);
});

test("three concurrent streams cap public download resource usage", async t => {
  const held = [];
  let ready;
  const allStarted = new Promise(resolve => { ready = resolve; });
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive", "Content-Length": APK.length });
    res.flushHeaders(); held.push(res);
    if (held.length === 3) ready();
  });
  const downloads = Array.from({ length: 3 }, () => fetch(h.api + "/apk").then(r => r.arrayBuffer()));
  await allStarted;
  const fourth = await fetch(h.api + "/apk");
  assert.equal(fourth.status, 503);
  assert.equal(fourth.headers.get("retry-after"), "15");
  assert.equal(h.seen.length, 3);
  for (const response of held) response.end(APK);
  for (const bytes of await Promise.all(downloads)) assert.deepEqual(Buffer.from(bytes), APK);
});
