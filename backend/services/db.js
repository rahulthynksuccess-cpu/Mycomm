/**
 * Postgres connection pool.
 * Uses DATABASE_URL env var — set this in Railway from your Postgres addon.
 */
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[DB] WARNING: DATABASE_URL not set. Session persistence disabled.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message);
});

module.exports = { pool };
