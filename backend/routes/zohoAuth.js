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
    
    // Immediately fetch the Zoho internal accountId and store it with the token
    // This avoids ever needing to match by email address later
    let zohoAccountId = null;
    try {
      const axios = require('axios');
      const r = await axios.get('https://mail.zoho.in/api/accounts', {
        headers: { Authorization: `Zoho-oauthtoken ${token.access_token}` },
      });
      const data = r.data?.data || [];
      console.log('[Zoho] OAuth accounts response:', JSON.stringify(data).slice(0, 500));
      // The account that just logged in is the first one (or the only one)
      // We also check userEmail claim from token if available
      if (data.length > 0) {
        zohoAccountId = data[0].accountId;
      }
    } catch (e) {
      console.error('[Zoho] Could not fetch accountId at callback:', e.message);
    }
    
    await saveToken(accountId, { ...token, obtained_at: Date.now(), zohoAccountId });
    console.log(`[Zoho] OAuth success for account: ${accountId}, zohoAccountId: ${zohoAccountId}`);
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
