#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isStaleMerchantDemoSession, customerGrantForEmail } = require("../server/customerViewerAuth");

const email = "merchant-fixture@example.test";
const tenant = "fixture_merchant";
const grants = JSON.stringify([{ email, tenant, role: "merchant_admin" }]);
const viewers = JSON.stringify([{ email, tenant, role: "customer_viewer" }]);
const oldDemo = { isAdmin: true, isDemo: true, adminEmail: email, tenant: "demo" };
const merchant = { isAdmin: false, isDemo: false, isCustomerViewer: true, adminEmail: email, tenant };
let passed = 0;
function test(name, fn) { fn(); ++passed; console.log("PASS " + name); }

test("mapped legacy demo is marked for safe logout, never silently promoted", () => {
  assert.equal(isStaleMerchantDemoSession(oldDemo, grants), true);
  assert.equal(isStaleMerchantDemoSession(oldDemo, viewers), true);
  assert.deepEqual(oldDemo, { isAdmin:true, isDemo:true, adminEmail:email, tenant:"demo" });
  assert.equal(customerGrantForEmail(email, grants).role, "merchant_admin");
});
test("sessions for other accounts remain untouched", () => {
  assert.equal(isStaleMerchantDemoSession(oldDemo, "[]"), false);
  assert.equal(isStaleMerchantDemoSession({ ...oldDemo, adminEmail: "someone@example.test" }, grants), false);
  assert.equal(isStaleMerchantDemoSession({ ...oldDemo, adminEmail: "" }, grants), false);
  assert.equal(isStaleMerchantDemoSession({ ...oldDemo, isAdmin: false }, grants), false);
  assert.equal(isStaleMerchantDemoSession(merchant, grants), false);
  assert.equal(isStaleMerchantDemoSession(null, grants), false);
});
test("merchant cannot be granted just by a stale cookie", () => {
  assert.equal(isStaleMerchantDemoSession({ ...oldDemo, isCustomerViewer: true }, grants), false);
  const auth = require("../server/customerViewerAuth");
  assert.equal(auth.currentMerchantTenant(oldDemo), null);
  assert.equal(auth.currentMerchantTenant(merchant), null); // No env grant on this isolated test
});
test("auth/bootstrap destroys legacy session and forces an unauthenticated response", () => {
  const src = fs.readFileSync(path.join(__dirname, "../server/index.js"), "utf8");
  const start = src.indexOf('app.get("/api/auth/me"');
  const end = src.indexOf('app.post("/api/auth/login"',start);
  const authRoute = src.slice(start,end);
  assert.ok(start > 0 && end > start);
  assert.match(authRoute,/isStaleMerchantDemoSession\(req.session\)/);
  assert.match(authRoute,/req.session.destroy/);
  assert.match(authRoute,/res.clearCookie\("domain_radar_sid"/);
  assert.match(authRoute,/authenticated: false/);
  assert.match(authRoute,/role: "reauth_required"/);
  assert.doesNotMatch(authRoute,/isAdmin\s*=\s*true/);
});
test("Login as admin actually revokes server session", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/App.jsx"), "utf8");
  const start = src.indexOf("  const logout=async()=>{");
  const end = src.indexOf("  if(!checked)",start);
  assert.ok(start > 0 && end > start);
  const text = src.slice(start,end);
  assert.match(text,/await api\("\/api\/auth\/logout", \{ method: "POST" \}\)/);
  assert.match(text,/setIsDemo\(false\)/);
});
console.log("PENTAGON_MERCHANT_LOGIN_SESSION_FIX_PASS=" + passed);