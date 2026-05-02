const { Pool } = require('pg');

let pool = null;
let dbAvailable = false;

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!url) {
  console.error('[DB] No DATABASE_URL found — session persistence disabled, using file fallback');
} else {
  console.log('[DB] Connecting to:', url.replace(/:([^:@]+)@/, ':***@'));
  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('[DB] Pool error:', err.message);
    dbAvailable = false;
  });

  pool.query('SELECT 1').then(() => {
    console.log('[DB] Postgres connected OK');
    dbAvailable = true;
  }).catch(err => {
    console.error('[DB] Postgres connection FAILED:', err.message);
    dbAvailable = false;
  });
}

module.exports = { 
  get pool() { return pool; },
  get dbAvailable() { return dbAvailable; }
};
