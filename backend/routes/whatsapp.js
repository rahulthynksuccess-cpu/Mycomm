const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const {
  addNewSession, getRecentChats, getChatMessages,
  disconnectSession, getStatuses, sendWAMessage,
} = require('../services/whatsapp');

router.get('/status', (req, res) => res.json(getStatuses()));

router.post('/sessions', async (req, res) => {
  try {
    const { accountId } = req.body;
    const id = accountId || `wa_${uuidv4().slice(0, 8)}`;
    const io = req.app.get('io');
    res.json({ success: true, accountId: id });
    addNewSession(id, io).catch(err => {
      console.error('addNewSession error:', err.message);
      io.emit('wa:status', { accountId: id, status: 'error', error: err.message });
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/sessions/:accountId', async (req, res) => {
  try {
    await disconnectSession(req.params.accountId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:accountId/chats', async (req, res) => {
  try {
    const chats = await getRecentChats(req.params.accountId, parseInt(req.query.limit) || 30);
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

router.post('/:accountId/send', async (req, res) => {
  try {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to and body required.' });
    console.log('Send request — accountId:', req.params.accountId, 'to:', to);
    await sendWAMessage(req.params.accountId, to, body);
    res.json({ success: true });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
