const router = require('express').Router();
const {
  getAccounts,
  fetchEmails:     imapFetchEmails,
  fetchEmailBody:  imapFetchEmailBody,
  sendEmail:       imapSendEmail,
  deleteEmail:     imapDeleteEmail,
  moveEmail,
  flagEmail,
  searchEmails:    imapSearchEmails,
  getFolders:      imapGetFolders,
} = require('../services/email');

const zoho = require('../services/zohoEmail');
const { pool } = require('../services/db');

// ── Helper: is this a Zoho account? ──────────────────────
async function getAccount(accountId) {
  if (pool) {
    try {
      const r = await pool.query("SELECT value FROM wa_sessions WHERE account_id = 'system' AND key = 'email_accounts'");
      if (r.rows.length) {
        const accounts = JSON.parse(r.rows[0].value);
        return accounts.find(a => a.id === accountId) || null;
      }
    } catch (e) {}
  }
  return getAccounts().find(a => a.id === accountId) || null;
}

// ── GET /api/email/accounts ───────────────────────────────
router.get('/accounts', async (req, res) => {
  if (pool) {
    try {
      const r = await pool.query("SELECT value FROM wa_sessions WHERE account_id = 'system' AND key = 'email_accounts'");
      if (r.rows.length) {
        const accounts = JSON.parse(r.rows[0].value);
        // For Zoho accounts, check if OAuth token exists
        const result = await Promise.all(accounts.map(async ({ id, label, user, type, color, zohoRegion }) => {
          const isZoho = type === 'zoho';
          const zohoConnected = isZoho ? !!(await zoho.loadToken(id)) : null;
          return { id, label, user, type, color, zohoRegion, ...(isZoho ? { zohoConnected } : {}) };
        }));
        return res.json(result);
      }
    } catch (e) {}
  }
  res.json(getAccounts().map(({ id, label, user, type, color }) => ({ id, label, user, type, color })));
});

// ── GET /api/email/zoho-debug?accountId= — returns raw Zoho API response ────
router.get('/zoho-debug', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });
  try {
    const token = await zoho.loadToken(accountId);
    if (!token) return res.json({ error: 'No token saved for this account' });
    const axios = require('axios');
    const r = await axios.get('https://mail.zoho.in/api/accounts', {
      headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
    });
    res.json({ raw: r.data, accountId });
  } catch (e) {
    res.status(500).json({ error: e.message, response: e.response?.data });
  }
});

// ── GET /api/email/zoho-auth?accountId= ──────────────────
router.get('/zoho-auth', (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });
  if (!process.env.ZOHO_CLIENT_ID) {
    return res.status(500).json({ error: 'ZOHO_CLIENT_ID is not set in Railway environment variables.' });
  }
  try {
    const url = zoho.getAuthUrl(accountId);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/email/accounts ──────────────────────────────
router.post('/accounts', async (req, res) => {
  const { id, label, user, password, type, color, zohoRegion } = req.body;
  // Zoho accounts via API don't need a password at add time
  if (!label || !user || !type) return res.status(400).json({ error: 'Missing required fields' });
  if (type !== 'zoho' && !password) return res.status(400).json({ error: 'Password required for non-Zoho accounts' });
  if (!pool) return res.status(500).json({ error: 'Database not available' });
  try {
    let accounts = [];
    const r = await pool.query("SELECT value FROM wa_sessions WHERE account_id = 'system' AND key = 'email_accounts'");
    if (r.rows.length) accounts = JSON.parse(r.rows[0].value);
    const existing = accounts.find(a => a.user.toLowerCase() === user.toLowerCase() && a.type === type);
    if (existing) return res.status(409).json({ error: `Account ${user} (${type}) is already connected.` });
    const newAccount = {
      id: id || 'email_' + Date.now(),
      label, user, type,
      color: color || type,
      zohoRegion: zohoRegion || 'in',
      ...(password ? { password } : {}),
    };
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

// ── DELETE /api/email/accounts/:accountId ─────────────────
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
    // Also delete Zoho token if present
    await zoho.deleteToken(req.params.accountId).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/email/accounts/deduplicate ──────────────────
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

// ── GET /api/email/:accountId/folders ─────────────────────
router.get('/:accountId/folders', async (req, res) => {
  try {
    const account = await getAccount(req.params.accountId);
    if (account?.type === 'zoho') {
      const token = await zoho.loadToken(req.params.accountId);
      if (!token) return res.json([{ name: 'INBOX', label: 'Inbox' }]);
      return res.json(await zoho.getFolders(req.params.accountId));
    }
    res.json(await imapGetFolders(req.params.accountId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/email/:accountId/messages ────────────────────
router.get('/:accountId/messages', async (req, res) => {
  try {
    const account = await getAccount(req.params.accountId);
    if (account?.type === 'zoho') {
      const token = await zoho.loadToken(req.params.accountId);
      if (!token) return res.status(401).json({ error: 'ZOHO_NOT_CONNECTED', needsAuth: true });
      const result = await zoho.fetchEmails(req.params.accountId, {
        folder: req.query.folder || 'INBOX',
        limit:  parseInt(req.query.limit) || 50,
        page:   parseInt(req.query.page)  || 1,
      });
      return res.json(result);
    }
    const result = await imapFetchEmails(req.params.accountId, {
      folder: req.query.folder || 'INBOX',
      limit:  parseInt(req.query.limit) || 50,
      page:   parseInt(req.query.page)  || 1,
    });
    res.json(result);
  } catch (err) {
    console.error('[Email] fetchEmails error:', err.message);
    if (err.message === 'ZOHO_NOT_CONNECTED' || err.message === 'ZOHO_NEEDS_RECONNECT') {
      return res.status(401).json({ error: err.message, needsAuth: true });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/email/:accountId/messages/:uid ───────────────
router.get('/:accountId/messages/:uid', async (req, res) => {
  try {
    const account = await getAccount(req.params.accountId);
    if (account?.type === 'zoho') {
      return res.json(await zoho.fetchEmailBody(req.params.accountId, req.params.uid, req.query.folder || 'INBOX'));
    }
    res.json(await imapFetchEmailBody(req.params.accountId, parseInt(req.params.uid), req.query.folder || 'INBOX'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/email/:accountId/send ──────────────────────
router.post('/:accountId/send', async (req, res) => {
  try {
    const { to, cc, bcc, subject, text, html, replyTo, attachments } = req.body;
    if (!to || !subject) return res.status(400).json({ error: 'to and subject are required.' });
    const account = await getAccount(req.params.accountId);
    if (account?.type === 'zoho') {
      return res.json(await zoho.sendEmail(req.params.accountId, { to, cc, bcc, subject, text, html }));
    }
    const result = await imapSendEmail(req.params.accountId, { to, cc, bcc, subject, text, html, replyTo, attachments });
    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/email/:accountId/messages/:uid ────────────
router.delete('/:accountId/messages/:uid', async (req, res) => {
  try {
    const account = await getAccount(req.params.accountId);
    if (account?.type === 'zoho') {
      return res.json(await zoho.deleteEmail(req.params.accountId, req.params.uid, req.query.folder || 'INBOX'));
    }
    res.json(await imapDeleteEmail(req.params.accountId, parseInt(req.params.uid), req.query.folder || 'INBOX'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/email/:accountId/messages/:uid/move ─────────
router.post('/:accountId/messages/:uid/move', async (req, res) => {
  try {
    const { toFolder, fromFolder = 'INBOX' } = req.body;
    res.json(await moveEmail(req.params.accountId, parseInt(req.params.uid), fromFolder, toFolder));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/email/:accountId/messages/:uid/flag ────────
router.patch('/:accountId/messages/:uid/flag', async (req, res) => {
  try {
    const { flag, folder } = req.body;
    const account = await getAccount(req.params.accountId);
    if (account?.type === 'zoho') {
      // Map flag to Zoho markRead
      if (flag.name === '\\Seen') {
        return res.json(await zoho.markRead(req.params.accountId, req.params.uid, flag.add));
      }
      return res.json({ success: true }); // other flags not supported via API
    }
    res.json(await flagEmail(req.params.accountId, parseInt(req.params.uid), flag, folder));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/email/:accountId/search ─────────────────────
router.get('/:accountId/search', async (req, res) => {
  try {
    const { q, folder } = req.query;
    if (!q) return res.status(400).json({ error: 'q param required.' });
    const account = await getAccount(req.params.accountId);
    if (account?.type === 'zoho') {
      return res.json(await zoho.searchEmails(req.params.accountId, q, folder || 'INBOX'));
    }
    res.json(await imapSearchEmails(req.params.accountId, q, folder || 'INBOX'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
