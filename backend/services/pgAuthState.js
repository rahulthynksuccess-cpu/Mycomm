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
}

// Call once at startup
let tableReady = null;
function getTableReady() {
  if (!tableReady) tableReady = ensureTable();
  return tableReady;
}

async function usePostgresAuthState(accountId) {
  await getTableReady();

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

  return {
    state:     { creds, keys },
    saveCreds: () => writeData('creds', creds),
    removeAll,
  };
}

module.exports = { usePostgresAuthState };
