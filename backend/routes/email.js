const router = require('express').Router();
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

const { pool } = require('../services/db');

// GET /api/email/accounts — list all configured email accounts
router.get('/accounts', async (req, res) => {
  // Try DB first, fall back to env var
  if (pool) {
    try {
      const r = await pool.query("SELECT value FROM wa_sessions WHERE account_id = 'system' AND key = 'email_accounts'");
      if (r.rows.length) {
        const accounts = JSON.parse(r.rows[0].value);
        return res.json(accounts.map(({ id, label, user, type, color }) => ({ id, label, user, type, color })));
      }
    } catch (e) {}
  }
  const accounts = getAccounts().map(({ id, label, user, type, color }) => ({ id, label, user, type, color }));
  res.json(accounts);
});

// POST /api/email/accounts — add a new email account
router.post('/accounts', async (req, res) => {
  const { id, label, user, password, type, color } = req.body;
  if (!label || !user || !password || !type) return res.status(400).json({ error: 'Missing required fields' });
  if (!pool) return res.status(500).json({ error: 'Database not available' });
  try {
    // Load existing accounts
    let accounts = [];
    const r = await pool.query("SELECT value FROM wa_sessions WHERE account_id = 'system' AND key = 'email_accounts'");
    if (r.rows.length) accounts = JSON.parse(r.rows[0].value);
    // Prevent duplicate: check if same email+type already exists
    const existing = accounts.find(a => a.user.toLowerCase() === user.toLowerCase() && a.type === type);
    if (existing) return res.status(409).json({ error: `Account ${user} (${type}) is already connected.` });
    // Add new account
    const { zohoRegion } = req.body;
    const newAccount = { id: id || 'email_' + Date.now(), label, user, password, type, color: color || type, zohoRegion: zohoRegion || 'in' };
    accounts.push(newAccount);
    await pool.query(
      `INSERT INTO wa_sessions (account_id, key, value) VALUES ('system', 'email_accounts', $1)
       ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(accounts)]
    );
    res.json({ success: true, id: newAccount.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/email/accounts/:accountId — remove an email account
router.delete('/accounts/:accountId', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not available' });
  try {
    const r = await pool.query("SELECT value FROM wa_sessions WHERE account_id = 'system' AND key = 'email_accounts'");
    let accounts = r.rows.length ? JSON.parse(r.rows[0].value) : [];
    accounts = accounts.filter(a => a.id !== req.params.accountId);
    await pool.query(
      `INSERT INTO wa_sessions (account_id, key, value) VALUES ('system', 'email_accounts', $1)
       ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(accounts)]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/accounts/deduplicate — remove duplicate accounts from DB (one-time cleanup)
router.post('/accounts/deduplicate', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'Database not available' });
  try {
    const r = await pool.query("SELECT value FROM wa_sessions WHERE account_id = 'system' AND key = 'email_accounts'");
    if (!r.rows.length) return res.json({ removed: 0 });
    const accounts = JSON.parse(r.rows[0].value);
    const seen = new Set();
    const unique = accounts.filter(a => {
      const key = a.user.toLowerCase() + '|' + a.type;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await pool.query(
      `INSERT INTO wa_sessions (account_id, key, value) VALUES ('system', 'email_accounts', $1)
       ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(unique)]
    );
    res.json({ removed: accounts.length - unique.length, remaining: unique.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/:accountId/folders — get folder/label list
router.get('/:accountId/folders', async (req, res) => {
  try {
    const folders = await getFolders(req.params.accountId);
    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email/:accountId/messages — list emails
router.get('/:accountId/messages', async (req, res) => {
  try {
    const result = await fetchEmails(req.params.accountId, {
      folder: req.query.folder || 'INBOX',
      limit: parseInt(req.query.limit) || 50,
      page: parseInt(req.query.page) || 1,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email/:accountId/messages/:uid — get full email body
router.get('/:accountId/messages/:uid', async (req, res) => {
  try {
    const email = await fetchEmailBody(
      req.params.accountId,
      parseInt(req.params.uid),
      req.query.folder || 'INBOX'
    );
    res.json(email);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email/:accountId/send — send an email
router.post('/:accountId/send', async (req, res) => {
  try {
    const { to, cc, bcc, subject, text, html, replyTo, attachments } = req.body;
    if (!to || !subject) return res.status(400).json({ error: 'to and subject are required.' });
    const result = await sendEmail(req.params.accountId, { to, cc, bcc, subject, text, html, replyTo, attachments });
    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/email/:accountId/messages/:uid — delete email
router.delete('/:accountId/messages/:uid', async (req, res) => {
  try {
    const result = await deleteEmail(
      req.params.accountId,
      parseInt(req.params.uid),
      req.query.folder || 'INBOX'
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email/:accountId/messages/:uid/move — move to folder
router.post('/:accountId/messages/:uid/move', async (req, res) => {
  try {
    const { toFolder, fromFolder = 'INBOX' } = req.body;
    const result = await moveEmail(req.params.accountId, parseInt(req.params.uid), fromFolder, toFolder);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/email/:accountId/messages/:uid/flag — star/unstar, mark read/unread
router.patch('/:accountId/messages/:uid/flag', async (req, res) => {
  try {
    const { flag, folder } = req.body;
    // flag: { name: '\\Flagged', add: true/false } or { name: '\\Seen', add: true }
    const result = await flagEmail(req.params.accountId, parseInt(req.params.uid), flag, folder);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email/:accountId/search — search emails
router.get('/:accountId/search', async (req, res) => {
  try {
    const { q, folder } = req.query;
    if (!q) return res.status(400).json({ error: 'q param required.' });
    const results = await searchEmails(req.params.accountId, q, folder || 'INBOX');
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
