const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const {
  addNewSession,
  getRecentChats,
  getChatMessages,
  disconnectSession,
  getStatuses,
  sendWAMessage,
} = require('../services/whatsapp');

// GET /api/whatsapp/status — all session statuses
router.get('/status', (req, res) => {
  res.json(getStatuses());
});

// POST /api/whatsapp/sessions — add a new WhatsApp session
router.post('/sessions', async (req, res) => {
  try {
    const { accountId } = req.body;
    const id = accountId || `wa_${uuidv4().slice(0, 8)}`;
    const io = req.app.get('io');
    addNewSession(id, io); // fire and forget — QR comes via socket
    res.json({ success: true, accountId: id, message: 'Session initializing — watch for QR code event.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/whatsapp/sessions/:accountId — disconnect session
router.delete('/sessions/:accountId', async (req, res) => {
  try {
    await disconnectSession(req.params.accountId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/whatsapp/:accountId/chats — get recent chats
router.get('/:accountId/chats', async (req, res) => {
  try {
    const chats = await getRecentChats(req.params.accountId, parseInt(req.query.limit) || 30);
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/whatsapp/:accountId/chats/:chatId/messages — get messages in a chat
router.get('/:accountId/chats/:chatId/messages', async (req, res) => {
  try {
    const msgs = await getChatMessages(
      req.params.accountId,
      decodeURIComponent(req.params.chatId),
      parseInt(req.query.limit) || 50
    );
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/whatsapp/:accountId/send — send a message
router.post('/:accountId/send', async (req, res) => {
  try {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to and body are required.' });
    await sendWAMessage(req.params.accountId, to, body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
