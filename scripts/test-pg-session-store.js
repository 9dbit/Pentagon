"use strict";
const assert = require("node:assert/strict");
const PgSessionStore = require("../server/pgSessionStore");

const rows = new Map();
const pool = {
  async query(sql, args = []) {
    if (sql.startsWith("INSERT INTO")) {
      rows.set(args[0], { sess: JSON.parse(args[1]), expire: args[2] });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT sess")) {
      const value = rows.get(args[0]);
      return { rows: value && value.expire > new Date() ? [{ sess: value.sess }] : [] };
    }
    if (sql.startsWith("UPDATE public.pentagon_http_sessions")) {
      if (rows.has(args[0])) rows.get(args[0]).expire = args[1];
      return { rows: [] };
    }
    if (sql.startsWith("DELETE FROM")) {
      if (args.length) rows.delete(args[0]);
      return { rows: [] };
    }
    throw new Error("Unexpected query in test: " + sql);
  }
};
const store = new PgSessionStore(pool);
function invoke(method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (err, value) => err ? reject(err) : resolve(value));
  });
}

(async () => {
  const value = { isAdmin: true, adminEmail: "test@example.invalid", cookie: { originalMaxAge: 90000 } };
  await invoke("set", "sid1", value);
  assert.equal((await invoke("get", "sid1")).isAdmin, true);
  assert.equal(rows.get("sid1").sess.adminEmail, "test@example.invalid");
  assert(rows.get("sid1").expire > new Date());
  const before = rows.get("sid1").expire;
  await invoke("touch", "sid1", { cookie: { originalMaxAge: 180000 } });
  assert(rows.get("sid1").expire >= before);
  await invoke("destroy", "sid1");
  assert.equal(await invoke("get", "sid1"), null);
  await invoke("set", "old", { cookie: { expires: new Date(Date.now() - 5000).toISOString() } });
  assert.equal(await invoke("get", "old"), null);
  store.cleanupTimer && clearInterval(store.cleanupTimer);
  console.log("PASS PostgreSQL session get/set/touch/destroy/expiry");
})().catch((e) => {
  store.cleanupTimer && clearInterval(store.cleanupTimer);
  console.error(e);
  process.exitCode = 1;
});