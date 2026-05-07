/**
 * Zoho OAuth callback handler
 * GET /auth/zoho/callback?code=...&state=accountId
 */
const router = require('express').Router();
const { exchangeCode, saveToken } = require('../services/zohoEmail');

router.get('/callback', async (req, res) => {
  const { code, state: accountId, error } = req.query;

  if (error) {
    return res.send(`<html><body><script>
      window.opener?.postMessage({ type: 'ZOHO_AUTH_ERROR', error: '${error}' }, '*');
      window.close();
    </script><p>Error: ${error}. You can close this window.</p></body></html>`);
  }

  if (!code || !accountId) {
    return res.send(`<html><body><script>
      window.opener?.postMessage({ type: 'ZOHO_AUTH_ERROR', error: 'Missing code or state' }, '*');
      window.close();
    </script><p>Invalid callback. You can close this window.</p></body></html>`);
  }

  try {
    const token = await exchangeCode(code);
    
    // Fetch Zoho accounts to get the internal accountId AND verify correct user logged in
    let zohoAccountId = null;
    let connectedEmail = null;
    try {
      const axios = require('axios');

      // Get the expected email from our DB
      const { pool } = require('../services/db');
      let expectedEmail = null;
      if (pool) {
        try {
          const r2 = await pool.query("SELECT value FROM wa_sessions WHERE account_id = 'system' AND key = 'email_accounts'");
          if (r2.rows.length) {
            const accs = JSON.parse(r2.rows[0].value);
            const acc = accs.find(a => a.id === accountId);
            if (acc) expectedEmail = acc.user.toLowerCase().trim();
          }
        } catch (e) {}
      }

      const r = await axios.get('https://mail.zoho.in/api/accounts', {
        headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
      });
      const data = r.data?.data || [];
      console.log('[Zoho] OAuth callback accounts:', JSON.stringify(data.map(a => ({
        accountId: a.accountId,
        primaryEmailAddress: a.primaryEmailAddress,
        incomingUserName: a.incomingUserName,
        mailboxAddress: a.mailboxAddress,
      }))));

      if (data.length > 0) {
        // Find account matching expected email
        let matched = null;
        if (expectedEmail) {
          matched = data.find(a => {
            const allText = JSON.stringify(a).toLowerCase();
            return allText.includes(expectedEmail);
          });
        }
        if (!matched) matched = data[0];
        zohoAccountId = matched.accountId;
        connectedEmail = matched.primaryEmailAddress || matched.incomingUserName || matched.mailboxAddress;
        
        // Warn if wrong account connected
        if (expectedEmail && connectedEmail && 
            !connectedEmail.toLowerCase().includes(expectedEmail) &&
            !expectedEmail.includes(connectedEmail.toLowerCase())) {
          console.warn(`[Zoho] WARNING: Expected ${expectedEmail} but got ${connectedEmail}`);
        }
      }
    } catch (e) {
      console.error('[Zoho] Could not fetch accountId at callback:', e.message);
    }
    
    await saveToken(accountId, { ...token, obtained_at: Date.now(), zohoAccountId, connectedEmail });
    console.log(`[Zoho] OAuth success: accountId=${accountId}, zohoAccountId=${zohoAccountId}, email=${connectedEmail}`);
    res.send(`<html><body><script>
      window.opener?.postMessage({ type: 'ZOHO_AUTH_SUCCESS', accountId: '${accountId}' }, '*');
      window.close();
    </script><p>Connected! You can close this window.</p></body></html>`);
  } catch (err) {
    console.error('[Zoho] OAuth callback error:', err.message);
    res.send(`<html><body><script>
      window.opener?.postMessage({ type: 'ZOHO_AUTH_ERROR', error: '${err.message.replace(/'/g, "\\'")}' }, '*');
      window.close();
    </script><p>Error: ${err.message}. You can close this window.</p></body></html>`);
  }
});

module.exports = router;
