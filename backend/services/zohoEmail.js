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
const _zohoAccIdCache    = {}; // cache: our accountId → Zoho internal accountId
const _zohoFolderCache   = {}; // cache: `${accountId}:${folderName}` → Zoho folderId

// ── Token storage ─────────────────────────────────────

async function saveToken(accountId, token) {
  delete _zohoAccIdCache[accountId]; // always clear cache when token changes
  if (!pool) return;
  await pool.query(
    `INSERT INTO wa_sessions (account_id, key, value) VALUES ($1, 'zoho_token', $2)
     ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [accountId, JSON.stringify(token)]
  );
  // Clear cached Zoho account ID so it's re-fetched with the new token
  delete _zohoAccIdCache[accountId];
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
  delete _zohoAccIdCache[accountId];
  // Clear all cached folder IDs for this account
  Object.keys(_zohoFolderCache).forEach(k => {
    if (k.startsWith(`${accountId}:`)) delete _zohoFolderCache[k];
  });
}

// ── OAuth URL ─────────────────────────────────────────

function getAuthUrl(accountId, emailHint) {
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
  // login_hint forces Zoho to show the correct email — prevents signing in with wrong account
  if (emailHint) params.set('login_hint', emailHint);
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

async function getZohoAccId(accountId, accessToken) {
  // Return from cache if available
  if (_zohoAccIdCache[accountId]) return _zohoAccIdCache[accountId];
  
  // Best case: zohoAccountId was stored at OAuth callback time — use it directly
  const token = await loadToken(accountId);
  if (token?.zohoAccountId) {
    console.log(`[Zoho] Using stored zohoAccountId for ${accountId}: ${token.zohoAccountId}`);
    _zohoAccIdCache[accountId] = token.zohoAccountId;
    return token.zohoAccountId;
  }

  // No stored zohoAccountId — token is from before this fix
  // Force reconnect so we can capture the correct accountId
  throw new Error('ZOHO_NEEDS_RECONNECT');
}

// ── Zoho folder ID resolution ─────────────────────────
// Zoho content API requires folderId; resolve folder name → folderId with caching

async function getZohoFolderId(accountId, zohoAccId, accessToken, folderName = 'INBOX') {
  const cacheKey = `${accountId}:${folderName.toUpperCase()}`;
  if (_zohoFolderCache[cacheKey]) return _zohoFolderCache[cacheKey];

  try {
    const data = await zohoGet(`${ZOHO_API_BASE}/${zohoAccId}/folders`, accessToken);
    const folders = data?.data || [];
    for (const f of folders) {
      const name = (f.folderName || '').toUpperCase();
      const path = (f.path       || '').toUpperCase();
      const key1 = `${accountId}:${name}`;
      const key2 = `${accountId}:${path}`;
      if (f.folderId) {
        _zohoFolderCache[key1] = f.folderId;
        if (path) _zohoFolderCache[key2] = f.folderId;
      }
    }
  } catch (e) {
    console.warn('[Zoho] Could not fetch folders for folderId resolution:', e.message);
  }

  // Return resolved id or fall back to INBOX id or undefined
  return _zohoFolderCache[cacheKey] || _zohoFolderCache[`${accountId}:INBOX`];
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
  // Pass folderId so the correct mailbox folder is queried
  const start    = (page - 1) * limit;
  const folderId = await getZohoFolderId(accountId, zohoAccId, token.access_token, folder);
  const params   = { limit, start, sortorder: 'false' }; // sortorder false = newest first
  if (folderId) {
    params.folderId = folderId;
  } else if (folder && folder.toUpperCase() !== 'INBOX') {
    params.folderpath = folder;
  }

  const data = await zohoGet(
    `${ZOHO_API_BASE}/${zohoAccId}/messages/view`,
    token.access_token,
    params
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

  // Resolve folderId — Zoho content API requires it, otherwise returns URL_RULE_NOT_CONFIGURED
  const folderId = await getZohoFolderId(accountId, zohoAccId, token.access_token, folder);
  const params   = {};
  if (folderId) params.folderId = folderId;

  // messageId MUST remain a string — large Zoho IDs lose precision if parsed as JS number
  const data = await zohoGet(
    `${ZOHO_API_BASE}/${zohoAccId}/messages/${String(messageId)}/content`,
    token.access_token,
    params
  );

  // Log raw response once to diagnose content structure
  console.log('[Zoho] message content raw keys:', Object.keys(data?.data || data || {}));
  
  // Zoho can return data as object directly or nested under data.data
  const d = data?.data || data || {};
  
  // Zoho content field names vary: content, htmlBody, body, mailBody
  const rawContent = d.content || d.htmlBody || d.body || d.mailBody || d.textBody || '';
  const format = (d.mailFormat || d.format || '').toLowerCase();
  
  // Detect HTML: check format field OR sniff content
  const isHtml = format.includes('html') || 
                 rawContent.trimStart().startsWith('<') ||
                 rawContent.includes('<html') ||
                 rawContent.includes('<div') ||
                 rawContent.includes('<p>');
  
  const htmlBody = isHtml ? rawContent : (d.htmlBody || '');
  const textBody = !isHtml ? rawContent : (d.textBody || '');

  console.log('[Zoho] content parsed — format:', format, 'isHtml:', isHtml, 'length:', rawContent.length);

  return {
    uid:         messageId,
    from:        d.fromAddress || d.from    || d.sender || '',
    to:          d.toAddress   || d.to      || '',
    cc:          d.ccAddress   || d.cc      || '',
    subject:     d.subject     || '',
    date:        d.receivedTime ? new Date(parseInt(d.receivedTime)) : null,
    htmlBody,
    textBody,
    attachments: (d.attachments || []).map(a => ({
      filename:    a.attachmentName || a.fileName    || a.name || 'attachment',
      contentType: a.type          || a.contentType || 'application/octet-stream',
      size:        a.attachmentSize || a.size        || 0,
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

  return (data?.data || []).map(f => {
    // Populate folder cache as a side-effect
    if (f.folderId) {
      const name = (f.folderName || '').toUpperCase();
      const path = (f.path       || '').toUpperCase();
      _zohoFolderCache[`${accountId}:${name}`] = f.folderId;
      if (path) _zohoFolderCache[`${accountId}:${path}`] = f.folderId;
    }
    return {
      name:     f.folderName,
      label:    f.folderName,
      path:     f.path || f.folderName,
      folderId: f.folderId,
    };
  });
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
