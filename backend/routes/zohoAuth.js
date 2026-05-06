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
    await saveToken(accountId, { ...token, obtained_at: Date.now() });
    console.log(`[Zoho] OAuth success for account: ${accountId}`);
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
