"use strict";

const session = require("express-session");

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function sessionExpiry(sess) {
  const cookie = sess && sess.cookie;
  if (cookie && cookie.expires) {
    const expiry = new Date(cookie.expires);
    if (Number.isFinite(expiry.getTime())) return expiry;
  }
  const maxAge = cookie && Number(cookie.originalMaxAge ?? cookie.maxAge);
  if (Number.isFinite(maxAge) && maxAge > 0) {
    return new Date(Date.now() + maxAge);
  }
  return new Date(Date.now() + DEFAULT_TTL_MS);
}

class PgSessionStore extends session.Store {
  constructor(pool) {
    super();
    if (!pool || typeof pool.query !== "function") {
      throw new TypeError("PgSessionStore requires a PostgreSQL pool");
    }
    this.pool = pool;
    this.cleanupTimer = setInterval(() => {
      this.pool.query("DELETE FROM public.pentagon_http_sessions WHERE expire <= NOW()")
        .catch((err) => console.warn("[session] expired session cleanup failed:", err.message));
    }, CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer.unref === "function") this.cleanupTimer.unref();
  }

  get(sid, callback) {
    this.pool.query(
      "SELECT sess FROM public.pentagon_http_sessions WHERE sid = $1 AND expire > NOW()",
      [sid]
    ).then(({ rows }) => callback(null, rows[0] ? rows[0].sess : null))
      .catch((err) => callback(err));
  }

  set(sid, sess, callback) {
    this.pool.query(
      `INSERT INTO public.pentagon_http_sessions (sid, sess, expire)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sid, JSON.stringify(sess), sessionExpiry(sess)]
    ).then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }

  touch(sid, sess, callback) {
    this.pool.query(
      "UPDATE public.pentagon_http_sessions SET expire = $2 WHERE sid = $1",
      [sid, sessionExpiry(sess)]
    ).then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }

  destroy(sid, callback) {
    this.pool.query(
      "DELETE FROM public.pentagon_http_sessions WHERE sid = $1",
      [sid]
    ).then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }
}

module.exports = PgSessionStore;
