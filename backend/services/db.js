const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[DB] FATAL: DATABASE_URL not set.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message);
});

// Test connection on startup
pool.query('SELECT 1').then(() => {
  console.log('[DB] Postgres connected OK');
}).catch(err => {
  console.error('[DB] Postgres connection FAILED:', err.message);
});

module.exports = { pool };
