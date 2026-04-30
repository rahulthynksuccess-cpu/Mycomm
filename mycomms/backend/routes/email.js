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

// GET /api/email/accounts — list all configured email accounts
router.get('/accounts', (req, res) => {
  const accounts = getAccounts().map(({ id, label, user, type, color }) => ({
    id, label, user, type, color,
  }));
  res.json(accounts);
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
