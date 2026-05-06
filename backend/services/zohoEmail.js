/**
 * Zoho Mail API service — uses OAuth2 (no IMAP needed, works on free plan)
 * 
 * Setup needed in Railway env vars:
 *   ZOHO_CLIENT_ID      — from api-console.zoho.in
 *   ZOHO_CLIENT_SECRET  — from api-console.zoho.in
 *   ZOHO_REDIRECT_URI   — e.g. https://yourapp.up.railway.app/auth/zoho/callback
 */

const axios = require('axios');
const { pool } = require('./db');

const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REDIRECT_URI  = process.env.ZOHO_REDIRECT_URI;

// Zoho India API base (handles .in domains and custom domains on Zoho India)
const ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.in';
const ZOHO_MAIL_API     = 'https://mail.zoho.in/api';

// ── Token storage ─────────────────────────────────────

async function saveToken(accountId, token) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO wa_sessions (account_id, key, value) VALUES ($1, 'zoho_token', $2)
     ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [accountId, JSON.stringify(token)]
  );
}

async function loadToken(accountId) {
  if (!pool) return null;
  try {
    const r = await pool.query(
      "SELECT value FROM wa_sessions WHERE account_id = $1 AND key = 'zoho_token'",
      [accountId]
    );
    return r.rows.length ? JSON.parse(r.rows[0].value) : null;
  } catch (e) { return null; }
}

async function deleteToken(accountId) {
  if (!pool) return;
  await pool.query(
    "DELETE FROM wa_sessions WHERE account_id = $1 AND key = 'zoho_token'",
    [accountId]
  );
}

// ── OAuth URL ─────────────────────────────────────────

function getAuthUrl(accountId) {
  if (!ZOHO_CLIENT_ID) throw new Error('ZOHO_CLIENT_ID not set in environment variables');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     ZOHO_CLIENT_ID,
    scope:         'ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.folders.READ,ZohoMail.accounts.READ',
    redirect_uri:  ZOHO_REDIRECT_URI,
    access_type:   'offline',
    state:         accountId,
    prompt:        'consent',
  });
  return `${ZOHO_ACCOUNTS_URL}/oauth/v2/auth?${params}`;
}

// ── Token exchange & refresh ──────────────────────────

async function exchangeCode(code) {
  const r = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
    params: {
      grant_type:    'authorization_code',
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      redirect_uri:  ZOHO_REDIRECT_URI,
      code,
    },
  });
  return r.data; // { access_token, refresh_token, expires_in, ... }
}

async function refreshToken(token) {
  const r = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
    params: {
      grant_type:    'refresh_token',
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: token.refresh_token,
    },
  });
  return { ...token, access_token: r.data.access_token, obtained_at: Date.now() };
}

async function getValidToken(accountId) {
  let token = await loadToken(accountId);
  if (!token) throw new Error('ZOHO_NOT_CONNECTED');
  // Refresh if within 5 min of expiry
  const expiresAt = (token.obtained_at || 0) + (token.expires_in || 3600) * 1000;
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    token = await refreshToken(token);
    await saveToken(accountId, { ...token, obtained_at: Date.now() });
  }
  return token;
}

// ── Zoho account ID lookup ────────────────────────────
// Zoho API needs the internal accountId (not email), cache it

const _zohoAccountIdCache = {};

async function getZohoAccountId(accountId, accessToken) {
  if (_zohoAccountIdCache[accountId]) return _zohoAccountIdCache[accountId];
  const r = await axios.get(`${ZOHO_MAIL_API}/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const accounts = r.data?.data || [];
  const acc = accounts[0]; // primary account
  if (!acc) throw new Error('No Zoho mail account found');
  _zohoAccountIdCache[accountId] = acc.accountId;
  return acc.accountId;
}

// ── Mail API calls ────────────────────────────────────

async function fetchEmails(accountId, options = {}) {
  const { folder = 'INBOX', limit = 50, page = 1 } = options;
  const token = await getValidToken(accountId);
  const zohoAccId = await getZohoAccountId(accountId, token.access_token);

  const start = (page - 1) * limit;
  const r = await axios.get(`${ZOHO_MAIL_API}/accounts/${zohoAccId}/messages/view`, {
    headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
    params: { foldername: folder, limit, start },
  });

  const emails = (r.data?.data || []).map(m => ({
    uid:       m.messageId,
    seqno:     m.messageId,
    accountId,
    folder,
    from:      m.fromAddress || '',
    to:        m.toAddress   || '',
    subject:   m.subject     || '(No Subject)',
    date:      new Date(parseInt(m.receivedTime)),
    snippet:   m.summary    || '',
    isRead:    m.isRead === '1' || m.isRead === true,
    isStarred: m.isFlagged  === '1' || m.isFlagged === true,
    flags:     [],
  }));

  return { emails, total: r.data?.totalCount || emails.length, folder };
}

async function fetchEmailBody(accountId, messageId, folder = 'INBOX') {
  const token = await getValidToken(accountId);
  const zohoAccId = await getZohoAccountId(accountId, token.access_token);

  const r = await axios.get(`${ZOHO_MAIL_API}/accounts/${zohoAccId}/messages/${messageId}/content`, {
    headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
  });

  const d = r.data?.data || {};
  return {
    uid:      messageId,
    from:     d.fromAddress || '',
    to:       d.toAddress   || '',
    cc:       d.ccAddress   || '',
    subject:  d.subject     || '',
    date:     d.receivedTime ? new Date(parseInt(d.receivedTime)) : null,
    htmlBody: d.htmlBody    || d.content || '',
    textBody: d.textBody    || '',
    attachments: (d.attachments || []).map(a => ({
      filename:    a.attachmentName,
      contentType: a.type,
      size:        a.attachmentSize,
    })),
  };
}

async function sendEmail(accountId, { to, cc, bcc, subject, text, html }) {
  const token = await getValidToken(accountId);
  const zohoAccId = await getZohoAccountId(accountId, token.access_token);

  const r = await axios.post(`${ZOHO_MAIL_API}/accounts/${zohoAccId}/messages`,
    { toAddress: to, ccAddress: cc, bccAddress: bcc, subject, content: html || text, mailFormat: html ? 'html' : 'plaintext' },
    { headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` } }
  );
  return { success: true, messageId: r.data?.data?.messageId };
}

async function getFolders(accountId) {
  const token = await getValidToken(accountId);
  const zohoAccId = await getZohoAccountId(accountId, token.access_token);

  const r = await axios.get(`${ZOHO_MAIL_API}/accounts/${zohoAccId}/folders`, {
    headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
  });

  return (r.data?.data || []).map(f => ({
    name:  f.folderName,
    label: f.folderName,
    path:  f.path || f.folderName,
  }));
}

async function deleteEmail(accountId, messageId, folder = 'INBOX') {
  const token = await getValidToken(accountId);
  const zohoAccId = await getZohoAccountId(accountId, token.access_token);

  await axios.delete(`${ZOHO_MAIL_API}/accounts/${zohoAccId}/messages`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
      data: { messageId: [String(messageId)], folderId: folder },
    }
  );
  return { deleted: true, uid: messageId };
}

async function markRead(accountId, messageId, isRead = true) {
  const token = await getValidToken(accountId);
  const zohoAccId = await getZohoAccountId(accountId, token.access_token);

  await axios.put(`${ZOHO_MAIL_API}/accounts/${zohoAccId}/updatemessage`,
    { messageId: [String(messageId)], isRead: isRead ? '1' : '0' },
    { headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` } }
  );
  return { success: true };
}

async function searchEmails(accountId, query, folder = 'INBOX') {
  const token = await getValidToken(accountId);
  const zohoAccId = await getZohoAccountId(accountId, token.access_token);

  const r = await axios.get(`${ZOHO_MAIL_API}/accounts/${zohoAccId}/messages/search`, {
    headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
    params: { searchKey: query, foldername: folder, limit: 30 },
  });

  return (r.data?.data || []).map(m => ({
    uid:     m.messageId,
    from:    m.fromAddress || '',
    subject: m.subject || '',
    date:    m.receivedTime ? new Date(parseInt(m.receivedTime)) : null,
    accountId,
  }));
}

function getConnectedAccounts() {
  // Returns list of accountIds that have tokens — called synchronously so returns cached data
  return Object.keys(_zohoAccountIdCache);
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  saveToken,
  loadToken,
  deleteToken,
  fetchEmails,
  fetchEmailBody,
  sendEmail,
  getFolders,
  deleteEmail,
  markRead,
  searchEmails,
  getConnectedAccounts,
};
