const express = require('express');
const router  = express.Router();
const { pool } = require('../services/db');
const {
  getAccounts,
  fetchEmails,
  fetchEmailBody,
  sendEmail,
  deleteEmail,
  moveEmail,
  flagEmail,
  searchEmails,
  getFolders,
} = require('../services/email');

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getAccountsFromDb() {
  if (!pool) return null;
  try {
    const r = await pool.query(
      "SELECT value FROM wa_sessions WHERE account_id = 'system' AND key = 'email_accounts'"
    );
    if (r.rows.length) return JSON.parse(r.rows[0].value);
  } catch (e) {
    console.error('[Email] DB read error:', e.message);
  }
  return null;
}

async function getAccountsAsync() {
  const dbAccounts = await getAccountsFromDb();
  if (dbAccounts && dbAccounts.length) return dbAccounts;
  return getAccounts(); // fallback to ENV
}

async function saveAccountsToDb(accounts) {
  if (!pool) throw new Error('No DB connection');
  await pool.query(
    `INSERT INTO wa_sessions (account_id, key, value)
     VALUES ('system', 'email_accounts', $1)
     ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(accounts)]
  );
}

// ─── Account management ─────────────────────────────────────────────────────

// GET /api/email/accounts
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await getAccountsAsync();
    const safe = accounts.map(({ password, ...rest }) => rest);
    res.json(safe);
  } catch (e) {
    console.error('[Email] getAccounts error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/accounts
router.post('/accounts', async (req, res) => {
  try {
    const accounts = await getAccountsAsync();
    const newAccount = { id: `email_${Date.now()}`, ...req.body };
    accounts.push(newAccount);
    await saveAccountsToDb(accounts);
    const { password, ...safe } = newAccount;
    res.json(safe);
  } catch (e) {
    console.error('[Email] addAccount error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/email/accounts/:accountId
router.delete('/accounts/:accountId', async (req, res) => {
  try {
    const accounts = await getAccountsAsync();
    const filtered = accounts.filter(a => a.id !== req.params.accountId);
    await saveAccountsToDb(filtered);
    res.json({ deleted: true });
  } catch (e) {
    console.error('[Email] deleteAccount error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/accounts/deduplicate
router.post('/accounts/deduplicate', async (req, res) => {
  try {
    const accounts = await getAccountsAsync();
    const seen = new Set();
    const deduped = accounts.filter(a => {
      if (seen.has(a.user)) return false;
      seen.add(a.user);
      return true;
    });
    await saveAccountsToDb(deduped);
    res.json({ before: accounts.length, after: deduped.length });
  } catch (e) {
    console.error('[Email] deduplicate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Per-account operations ──────────────────────────────────────────────────

// GET /api/email/:accountId/folders
router.get('/:accountId/folders', async (req, res) => {
  try {
    const folders = await getFolders(req.params.accountId);
    res.json(folders);
  } catch (e) {
    console.error('[Email] getFolders error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/:accountId/messages
router.get('/:accountId/messages', async (req, res) => {
  try {
    const { folder = 'INBOX', limit = 50, page = 1 } = req.query;
    const result = await fetchEmails(req.params.accountId, {
      folder,
      limit: parseInt(limit, 10),
      page:  parseInt(page,  10),
    });
    res.json(result);
  } catch (e) {
    console.error('[Email] fetchEmails error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/:accountId/messages/:uid
router.get('/:accountId/messages/:uid', async (req, res) => {
  try {
    const { folder = 'INBOX' } = req.query;
    const body = await fetchEmailBody(req.params.accountId, parseInt(req.params.uid, 10), folder);
    res.json(body);
  } catch (e) {
    console.error('[Email] fetchEmailBody error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/:accountId/send
router.post('/:accountId/send', async (req, res) => {
  res.setTimeout(55000, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Send timed out. Check SMTP credentials or try again.' });
    }
  });
  try {
    const result = await sendEmail(req.params.accountId, req.body);
    res.json({ ok: true, messageId: result.messageId });
  } catch (e) {
    console.error('[Email] sendEmail error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// DELETE /api/email/:accountId/messages/:uid
router.delete('/:accountId/messages/:uid', async (req, res) => {
  try {
    const { folder = 'INBOX' } = req.query;
    const result = await deleteEmail(req.params.accountId, parseInt(req.params.uid, 10), folder);
    res.json(result);
  } catch (e) {
    console.error('[Email] deleteEmail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/:accountId/messages/:uid/move
router.post('/:accountId/messages/:uid/move', async (req, res) => {
  try {
    const { fromFolder, toFolder } = req.body;
    const result = await moveEmail(req.params.accountId, parseInt(req.params.uid, 10), fromFolder, toFolder);
    res.json(result);
  } catch (e) {
    console.error('[Email] moveEmail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/email/:accountId/messages/:uid/flag
router.patch('/:accountId/messages/:uid/flag', async (req, res) => {
  try {
    const { flag, folder = 'INBOX' } = req.body;
    const result = await flagEmail(req.params.accountId, parseInt(req.params.uid, 10), flag, folder);
    res.json(result);
  } catch (e) {
    console.error('[Email] flagEmail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/:accountId/search
router.get('/:accountId/search', async (req, res) => {
  try {
    const { q, folder = 'INBOX' } = req.query;
    const results = await searchEmails(req.params.accountId, q, folder);
    res.json(results);
  } catch (e) {
    console.error('[Email] searchEmails error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
