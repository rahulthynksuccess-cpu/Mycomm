/**
 * Zoho Mail API service — OAuth2, no IMAP needed (works on free plan)
 * Uses Zoho Mail API v1: https://www.zoho.com/mail/help/api/
 */

const axios = require('axios');
const { pool } = require('./db');

const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REDIRECT_URI  = process.env.ZOHO_REDIRECT_URI;
const ZOHO_ACCOUNTS_URL  = 'https://accounts.zoho.in';
const ZOHO_API_BASE      = 'https://mail.zoho.in/api/accounts';

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
  try {
    await pool.query(
      "DELETE FROM wa_sessions WHERE account_id = $1 AND key = 'zoho_token'",
      [accountId]
    );
  } catch (e) {}
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
  if (r.data.error) throw new Error(r.data.error);
  return r.data;
}

async function refreshAccessToken(token) {
  const r = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
    params: {
      grant_type:    'refresh_token',
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: token.refresh_token,
    },
  });
  if (r.data.error) throw new Error('Token refresh failed: ' + r.data.error);
  return { ...token, access_token: r.data.access_token, obtained_at: Date.now() };
}

async function getValidToken(accountId) {
  let token = await loadToken(accountId);
  if (!token) throw new Error('ZOHO_NOT_CONNECTED');
  if (!token.access_token) throw new Error('ZOHO_NOT_CONNECTED');
  // Refresh if within 5 min of expiry
  const expiresAt = (token.obtained_at || 0) + (token.expires_in || 3600) * 1000;
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    token = await refreshAccessToken(token);
    await saveToken(accountId, token);
  }
  return token;
}

// ── Zoho internal account ID ──────────────────────────
// Zoho API requires the internal numeric accountId, not the email address
const _zohoAccIdCache = {};

async function getZohoAccId(accountId, accessToken) {
  if (_zohoAccIdCache[accountId]) return _zohoAccIdCache[accountId];
  try {
    const r = await axios.get('https://mail.zoho.in/api/accounts', {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    const data = r.data?.data;
    if (!data || !data.length) throw new Error('No Zoho account data returned');
    // data is array of accounts — take first (primary)
    const zohoAccId = data[0].accountId;
    if (!zohoAccId) throw new Error('accountId missing from Zoho response: ' + JSON.stringify(data[0]));
    _zohoAccIdCache[accountId] = zohoAccId;
    return zohoAccId;
  } catch (e) {
    // Log full error for debugging
    if (e.response) {
      throw new Error(`Zoho accounts API error ${e.response.status}: ${JSON.stringify(e.response.data)}`);
    }
    throw e;
  }
}

// ── Helper: axios with better error messages ──────────
async function zohoGet(url, accessToken, params = {}) {
  try {
    const r = await axios.get(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      params,
    });
    return r.data;
  } catch (e) {
    const status = e.response?.status;
    const body   = JSON.stringify(e.response?.data || {});
    throw new Error(`Zoho API ${status} at ${url}: ${body}`);
  }
}

// ── Mail API ──────────────────────────────────────────

async function fetchEmails(accountId, options = {}) {
  const { folder = 'INBOX', limit = 50, page = 1 } = options;
  const token     = await getValidToken(accountId);
  const zohoAccId = await getZohoAccId(accountId, token.access_token);

  // Zoho Mail API: GET /accounts/{accountId}/messages/view
  // Required params: limit, start (0-based offset)
  // Optional: folderId or folderpath
  const start = (page - 1) * limit;
  const data = await zohoGet(
    `${ZOHO_API_BASE}/${zohoAccId}/messages/view`,
    token.access_token,
    { limit, start, sortorder: 'false' } // sortorder false = newest first
  );

  const emails = (data?.data || []).map(m => ({
    uid:       m.messageId,
    seqno:     m.messageId,
    accountId,
    folder,
    from:      m.fromAddress || '',
    to:        m.toAddress   || '',
    subject:   m.subject     || '(No Subject)',
    date:      m.receivedTime ? new Date(parseInt(m.receivedTime)) : new Date(),
    snippet:   m.summary     || '',
    isRead:    m.isRead === '1' || m.isRead === true,
    isStarred: m.isFlagged   === '1' || m.isFlagged === true,
    flags:     [],
  }));

  return { emails, total: data?.totalCount || emails.length, folder };
}

async function fetchEmailBody(accountId, messageId, folder = 'INBOX') {
  const token     = await getValidToken(accountId);
  const zohoAccId = await getZohoAccId(accountId, token.access_token);

  const data = await zohoGet(
    `${ZOHO_API_BASE}/${zohoAccId}/messages/${messageId}/content`,
    token.access_token
  );

  const d = data?.data || {};
  return {
    uid:         messageId,
    from:        d.fromAddress || '',
    to:          d.toAddress   || '',
    cc:          d.ccAddress   || '',
    subject:     d.subject     || '',
    date:        d.receivedTime ? new Date(parseInt(d.receivedTime)) : null,
    htmlBody:    d.htmlBody    || d.content || '',
    textBody:    d.textBody    || '',
    attachments: (d.attachments || []).map(a => ({
      filename:    a.attachmentName,
      contentType: a.type || 'application/octet-stream',
      size:        a.attachmentSize,
    })),
  };
}

async function sendEmail(accountId, { to, cc, bcc, subject, text, html }) {
  const token     = await getValidToken(accountId);
  const zohoAccId = await getZohoAccId(accountId, token.access_token);

  try {
    const r = await axios.post(
      `${ZOHO_API_BASE}/${zohoAccId}/messages`,
      {
        toAddress:   to,
        ccAddress:   cc  || '',
        bccAddress:  bcc || '',
        subject:     subject,
        content:     html || text,
        mailFormat:  html ? 'html' : 'plaintext',
      },
      { headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` } }
    );
    return { success: true, messageId: r.data?.data?.messageId };
  } catch (e) {
    throw new Error(`Send failed ${e.response?.status}: ${JSON.stringify(e.response?.data)}`);
  }
}

async function getFolders(accountId) {
  const token     = await getValidToken(accountId);
  const zohoAccId = await getZohoAccId(accountId, token.access_token);

  const data = await zohoGet(
    `${ZOHO_API_BASE}/${zohoAccId}/folders`,
    token.access_token
  );

  return (data?.data || []).map(f => ({
    name:  f.folderName,
    label: f.folderName,
    path:  f.path || f.folderName,
  }));
}

async function deleteEmail(accountId, messageId, folder = 'INBOX') {
  const token     = await getValidToken(accountId);
  const zohoAccId = await getZohoAccId(accountId, token.access_token);

  try {
    await axios.delete(
      `${ZOHO_API_BASE}/${zohoAccId}/messages`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
        data: { messageId: [String(messageId)] },
      }
    );
  } catch (e) {
    throw new Error(`Delete failed ${e.response?.status}: ${JSON.stringify(e.response?.data)}`);
  }
  return { deleted: true, uid: messageId };
}

async function markRead(accountId, messageId, isRead = true) {
  const token     = await getValidToken(accountId);
  const zohoAccId = await getZohoAccId(accountId, token.access_token);

  try {
    await axios.put(
      `${ZOHO_API_BASE}/${zohoAccId}/updatemessage`,
      { messageId: [String(messageId)], isRead: isRead ? '1' : '0' },
      { headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` } }
    );
  } catch (e) {}
  return { success: true };
}

async function searchEmails(accountId, query, folder = 'INBOX') {
  const token     = await getValidToken(accountId);
  const zohoAccId = await getZohoAccId(accountId, token.access_token);

  const data = await zohoGet(
    `${ZOHO_API_BASE}/${zohoAccId}/messages/search`,
    token.access_token,
    { searchKey: query, limit: 30, start: 0 }
  );

  return (data?.data || []).map(m => ({
    uid:     m.messageId,
    from:    m.fromAddress || '',
    subject: m.subject     || '',
    date:    m.receivedTime ? new Date(parseInt(m.receivedTime)) : null,
    snippet: m.summary     || '',
    accountId,
  }));
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
};
