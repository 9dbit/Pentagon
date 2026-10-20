#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { scryptSync } = require("node:crypto");
const { readTestUsers, verifyTestUser } = require("../server/testAccountAuth");
const fs = require("node:fs");
const path = require("node:path");

const demoEmail = "fixture-user@example.test";
const demoPassword = "A-Synthetic-Only-Password-Not-For-Production!";
const salt = Buffer.alloc(16, 0x5a);
const hash = scryptSync(demoPassword, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const entry = { email: demoEmail, role: "demo", saltHex: salt.toString("hex"), hashHex: hash.toString("hex") };
const raw = JSON.stringify([entry]);
let count = 0;
function check(name, callback) {
  try { callback(); count++; }
  catch (e) { throw Error("PENTAGON_TEST_AUTH_" + name + ": " + e.message); }
}

check("valid config parsed", () => assert.equal(readTestUsers(raw).length, 1));
check("matching credential accepted", () => assert.deepEqual(
  verifyTestUser(demoEmail, demoPassword, raw), { email: demoEmail, tenant: "demo", isDemo: true }
));
check("email case normalized", () => assert.ok(verifyTestUser(" FIXTURE-USER@EXAMPLE.TEST ", demoPassword, raw)));
check("incorrect password denied", () => assert.equal(verifyTestUser(demoEmail, "wrong-value", raw), null));
check("unknown account denied", () => assert.equal(verifyTestUser("unknown@example.test", demoPassword, raw), null));
check("no config denies access", () => assert.equal(verifyTestUser(demoEmail, demoPassword, ""), null));
check("invalid JSON denies access", () => assert.equal(verifyTestUser(demoEmail, demoPassword, "invalid-json"), null));
check("plaintext passwords in config forbidden", () => assert.equal(readTestUsers(JSON.stringify([{ ...entry, password: demoPassword }])).length, 0));
check("privileged role forbidden", () => assert.equal(readTestUsers(JSON.stringify([{ ...entry, role: "admin" }])).length, 0));
check("duplicate emails forbidden", () => assert.equal(readTestUsers(JSON.stringify([entry, entry])).length, 0));
check("invalid hash length forbidden", () => assert.equal(readTestUsers(JSON.stringify([{ ...entry, hashHex: "1234" }])).length, 0));
check("oversized config forbidden", () => assert.equal(readTestUsers(" ".repeat(20000) + raw).length, 0));
check("overlong password denied", () => assert.equal(verifyTestUser(demoEmail, "A".repeat(257), raw), null));

const server = fs.readFileSync(path.join(__dirname, "../server/index.js"), "utf8");
const client = fs.readFileSync(path.join(__dirname, "../src/App.jsx"), "utf8");
check("test credential evaluated before admin password", () => {
  const testPosition = server.indexOf("const testAccount = verifyTestUser(email, password)");
  const adminPosition = server.indexOf("if (password !== adminPassword)");
  assert.ok(testPosition > 0 && adminPosition > testPosition);
});
check("test login is segregated and demo read-only", () => {
  assert.match(server, /if \(testAccount\) \{[\s\S]*?req\.session\.isDemo = true;[\s\S]*?req\.session\.tenant = "demo"/);
  assert.match(server, /function requireNotDemoWrite/);
  assert.match(server, /function requireNotDemo\(/);
});
check("legacy whitelist still enforced", () => {
  assert.match(server, /isEmailWhitelistEnabled\(\)/);
  assert.match(server, /if \(!isEmailAllowed\(email\)\)/);
});
check("customer password never committed in code", () => {
  assert.ok(!server.includes("fixture-user@example.test"));
  assert.ok(!server.includes("A-Synthetic-Only-Password"));
});
check("login error differentiates permission and password", () => {
  assert.match(client, /err\.status === 403/);
  assert.match(client, /err\.status === 401/);
});
console.log("PENTAGON_TEST_ACCOUNT_AUTH_TESTS_PASS=" + count);
