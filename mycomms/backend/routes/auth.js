const router = require('express').Router();
const { handleCallback } = require('../services/calendar');

// GET /auth/google/callback — Google OAuth2 redirect
router.get('/google/callback', async (req, res) => {
  const { code, state: accountId, error } = req.query;

  if (error) {
    return res.send(`
      <script>
        window.opener?.postMessage({ type: 'GOOGLE_AUTH_ERROR', error: '${error}' }, '*');
        window.close();
      </script>
    `);
  }

  try {
    await handleCallback(code, accountId);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:#f0f0fa">
        <h2>✅ Calendar connected!</h2>
        <p>You can close this window.</p>
        <script>
          window.opener?.postMessage({ type: 'GOOGLE_AUTH_SUCCESS', accountId: '${accountId}' }, '*');
          setTimeout(() => window.close(), 2000);
        </script>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0f;color:#f87171">
        <h2>❌ Auth failed</h2><p>${err.message}</p>
        <script>
          window.opener?.postMessage({ type: 'GOOGLE_AUTH_ERROR', error: '${err.message}' }, '*');
        </script>
      </body></html>
    `);
  }
});

module.exports = router;
