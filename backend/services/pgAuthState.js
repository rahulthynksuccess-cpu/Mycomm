/**
 * Postgres-backed Baileys auth state.
 * Replaces useMultiFileAuthState — stores creds + signal keys in DB.
 * 
 * Table: wa_sessions
 *   account_id  TEXT
 *   key         TEXT   (e.g. "creds", "app-state-sync-key-XXX", etc.)
 *   value       TEXT   (JSON)
 *   PRIMARY KEY (account_id, key)
 */

const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { pool } = require('./db');

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_sessions (
      account_id TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      PRIMARY KEY (account_id, key)
    )
  `);
  // Separate registry table — tracks accounts even if session data is wiped
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_accounts (
      account_id  TEXT PRIMARY KEY,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      last_seen   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// Call once at startup
let tableReady = null;
function getTableReady() {
  if (!tableReady) tableReady = ensureTable();
  return tableReady;
}

async function usePostgresAuthState(accountId) {
  await getTableReady();

  // Register this account so it survives session wipes
  await pool.query(
    `INSERT INTO wa_accounts (account_id, last_seen) VALUES ($1, NOW())
     ON CONFLICT (account_id) DO UPDATE SET last_seen = NOW()`,
    [accountId]
  ).catch(function() {});  // non-fatal

  // ── Read a key ───────────────────────────────────────
  async function readData(key) {
    const res = await pool.query(
      'SELECT value FROM wa_sessions WHERE account_id = $1 AND key = $2',
      [accountId, key]
    );
    if (!res.rows.length) return null;
    try {
      return JSON.parse(res.rows[0].value, BufferJSON.reviver);
    } catch {
      return null;
    }
  }

  // ── Write a key ──────────────────────────────────────
  async function writeData(key, value) {
    const json = JSON.stringify(value, BufferJSON.replacer);
    await pool.query(
      `INSERT INTO wa_sessions (account_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [accountId, key, json]
    );
  }

  // ── Delete a key ─────────────────────────────────────
  async function removeData(key) {
    await pool.query(
      'DELETE FROM wa_sessions WHERE account_id = $1 AND key = $2',
      [accountId, key]
    );
  }

  // ── Delete all keys for this account ─────────────────
  async function removeAll() {
    await pool.query(
      'DELETE FROM wa_sessions WHERE account_id = $1',
      [accountId]
    );
  }

  // ── Load creds ───────────────────────────────────────
  const creds = (await readData('creds')) || initAuthCreds();

  // ── Signal key store (same interface Baileys expects) ─
  const keys = {
    get: async (type, ids) => {
      const data = {};
      await Promise.all(ids.map(async id => {
        const dbKey = `${type}-${id}`;
        let val = await readData(dbKey);
        if (val) {
          // proto decode for pre-keys and sender-keys
          if (type === 'app-state-sync-key') {
            val = proto.Message.AppStateSyncKeyData.fromObject(val);
          }
          data[id] = val;
        }
      }));
      return data;
    },
    set: async (data) => {
      const tasks = [];
      for (const [type, typeData] of Object.entries(data)) {
        for (const [id, value] of Object.entries(typeData)) {
          const dbKey = `${type}-${id}`;
          if (value) {
            tasks.push(writeData(dbKey, value));
          } else {
            tasks.push(removeData(dbKey));
          }
        }
      }
      await Promise.all(tasks);
    },
  };

  const state = { creds, keys };

  return {
    state,
    saveCreds: () => writeData('creds', state.creds),
    removeAll,
  };
}

async function getAllAccountIds() {
  await getTableReady();
  const res = await pool.query('SELECT account_id FROM wa_accounts ORDER BY created_at');
  return res.rows.map(function(r) { return r.account_id; });
}

async function removeAccountRegistry(accountId) {
  await pool.query('DELETE FROM wa_accounts WHERE account_id = $1', [accountId]).catch(function() {});
}

module.exports = { usePostgresAuthState, getAllAccountIds, removeAccountRegistry };
