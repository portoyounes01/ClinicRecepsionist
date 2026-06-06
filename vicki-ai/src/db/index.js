// ============================================================
// VICKI AI — Postgres connection + thin query layer
//
// Powers the ADDITIVE lifecycle engine only. The existing inbound
// booking flow does NOT use this — so if DATABASE_URL is missing,
// we degrade to a disabled state (isEnabled() === false) and the
// rest of the app keeps working exactly as before.
//
// Env:
//   DATABASE_URL  — Postgres connection string (Railway add-on)
//   PGSSL=disable — opt out of SSL (local dev)
// ============================================================

const fs   = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
let _enabled = false;

function isEnabled() { return _enabled; }

/**
 * Lazily create the pool. Returns null if no DATABASE_URL — callers
 * must check isEnabled() first.
 */
function getPool() {
  if (pool) return pool;
  if (!DATABASE_URL) return null;
  // require lazily so the app still boots if 'pg' isn't installed yet
  const { Pool } = require('pg');
  const ssl = process.env.PGSSL === 'disable'
    ? false
    : { rejectUnauthorized: false }; // Railway/managed PG uses self-signed
  pool = new Pool({ connectionString: DATABASE_URL, ssl, max: 5 });
  pool.on('error', (err) => console.error('[DB] Pool error:', err.message));
  return pool;
}

/** Run a parameterized query. Throws if DB disabled. */
async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('[DB] DATABASE_URL not set — DB is disabled');
  return p.query(text, params);
}

/** Convenience: first row or null. */
async function one(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

/** Convenience: all rows. */
async function many(text, params) {
  const res = await query(text, params);
  return res.rows;
}

/**
 * Apply schema.sql. Idempotent (all CREATE ... IF NOT EXISTS).
 * Call once at boot. No-op + warning if DB disabled.
 */
async function migrate() {
  if (!DATABASE_URL) {
    console.warn('[DB] DATABASE_URL not set — lifecycle engine disabled (inbound flow unaffected)');
    _enabled = false;
    return false;
  }
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await query(sql);
    _enabled = true;
    console.log('[DB] Migration applied — lifecycle engine enabled');
    return true;
  } catch (e) {
    console.error('[DB] Migration failed — lifecycle engine disabled:', e.message);
    _enabled = false;
    return false;
  }
}

module.exports = { isEnabled, getPool, query, one, many, migrate };
