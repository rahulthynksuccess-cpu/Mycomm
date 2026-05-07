const express = require('express');
const router  = express.Router();
const { pool } = require('../services/db');
const imapSvc = require('../services/email');
const zohoSvc = require('../services/zohoEmail');

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
  return imapSvc.getAccounts(); // fallback to ENV
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

// Returns the correct service module for an accountId
async function svcFor(accountId) {
  const accounts = await getAccountsAsync();
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) throw new Error(`Account ${accountId} not found`);
  return acc.type === 'zoho' ? zohoSvc : imapSvc;
}

// ─── Account management ─────────────────────────────────────────────────────

// GET /api/email/zoho-auth
router.get('/zoho-auth', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const accounts = await getAccountsAsync();
    const acc = accounts.find(a => a.id === accountId);
    const emailHint = acc?.user || null;
    const url = zohoSvc.getAuthUrl(accountId, emailHint);
    res.json({ url });
  } catch (e) {
    console.error('[Email] getZohoAuthUrl error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/accounts
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await getAccountsAsync();
    const enriched = await Promise.all(accounts.map(async (acc) => {
      const { password, ...safe } = acc;
      if (safe.type === 'zoho') {
        try {
          const token = await zohoSvc.loadToken(safe.id);
          safe.zohoConnected = !!(token && token.access_token && token.refresh_token);
        } catch (e) {
          safe.zohoConnected = false;
        }
      }
      return safe;
    }));
    res.json(enriched);
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

// ─── Per-account operations (routed to correct service) ──────────────────────

// GET /api/email/:accountId/folders
router.get('/:accountId/folders', async (req, res) => {
  try {
    const svc = await svcFor(req.params.accountId);
    const folders = await svc.getFolders(req.params.accountId);
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
    const svc = await svcFor(req.params.accountId);
    const result = await svc.fetchEmails(req.params.accountId, {
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
    const svc = await svcFor(req.params.accountId);
    // Pass uid as string — Zoho message IDs are large 64-bit integers that must not be parsed as JS numbers
    const body = await svc.fetchEmailBody(req.params.accountId, req.params.uid, folder);
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
    const svc = await svcFor(req.params.accountId);
    const result = await svc.sendEmail(req.params.accountId, req.body);
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
    const svc = await svcFor(req.params.accountId);
    const result = await svc.deleteEmail(req.params.accountId, req.params.uid, folder);
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
    const svc = await svcFor(req.params.accountId);
    const result = await svc.moveEmail(req.params.accountId, req.params.uid, fromFolder, toFolder);
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
    const svc = await svcFor(req.params.accountId);
    const result = await svc.flagEmail(req.params.accountId, req.params.uid, flag, folder);
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
    const svc = await svcFor(req.params.accountId);
    const results = await svc.searchEmails(req.params.accountId, q, folder);
    res.json(results);
  } catch (e) {
    console.error('[Email] searchEmails error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;


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

// GET /api/email/zoho-auth
// Returns the Zoho OAuth URL so the frontend can open the popup
router.get('/zoho-auth', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    // Find the account to get the email hint (so Zoho pre-fills the login email)
    const accounts = await getAccountsAsync();
    const acc = accounts.find(a => a.id === accountId);
    const emailHint = acc?.user || null;

    const url = getAuthUrl(accountId, emailHint);
    res.json({ url });
  } catch (e) {
    console.error('[Email] getZohoAuthUrl error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/accounts
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await getAccountsAsync();

    // For Zoho accounts, check if a valid token exists in DB
    const enriched = await Promise.all(accounts.map(async (acc) => {
      const { password, ...safe } = acc;
      if (safe.type === 'zoho') {
        try {
          const token = await loadToken(safe.id);
          safe.zohoConnected = !!(token && token.access_token && token.refresh_token);
        } catch (e) {
          safe.zohoConnected = false;
        }
      }
      return safe;
    }));

    res.json(enriched);
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
    const body = await fetchEmailBody(req.params.accountId, req.params.uid, folder);
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

module.exports = router;
