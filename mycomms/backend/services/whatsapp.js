const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const clients = {};      // accountId → Client instance
const statuses = {};     // accountId → 'initializing' | 'qr' | 'ready' | 'disconnected'

const MAX_ACCOUNTS = parseInt(process.env.WA_MAX_ACCOUNTS || '5');
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ─── Init all persisted sessions on boot ──────────────
async function initWhatsApp(io) {
  // Load any previously saved session IDs
  const savedSessions = getSavedSessionIds();
  console.log(`   Found ${savedSessions.length} saved WhatsApp session(s):`, savedSessions);

  for (const accountId of savedSessions) {
    await createClient(accountId, io);
  }
}

// ─── Create a single WA client ─────────────────────────
async function createClient(accountId, io) {
  if (clients[accountId]) {
    console.log(`Session ${accountId} already exists.`);
    return;
  }

  statuses[accountId] = 'initializing';
  io.emit('wa:status', { accountId, status: 'initializing' });

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: accountId,
      dataPath: SESSIONS_DIR,
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
  });

  // ── QR Code ──
  client.on('qr', async (qr) => {
    console.log(`QR generated for ${accountId}`);
    statuses[accountId] = 'qr';
    const qrDataUrl = await qrcode.toDataURL(qr);
    io.emit('wa:qr', { accountId, qr: qrDataUrl });
    io.emit('wa:status', { accountId, status: 'qr' });
  });

  // ── Auth ──
  client.on('authenticated', () => {
    console.log(`${accountId} authenticated`);
    statuses[accountId] = 'authenticated';
    io.emit('wa:status', { accountId, status: 'authenticated' });
  });

  client.on('auth_failure', (msg) => {
    console.error(`${accountId} auth failed:`, msg);
    statuses[accountId] = 'auth_failure';
    io.emit('wa:status', { accountId, status: 'auth_failure', error: msg });
  });

  // ── Ready ──
  client.on('ready', async () => {
    console.log(`✅ ${accountId} is ready!`);
    statuses[accountId] = 'ready';
    const info = client.info;
    io.emit('wa:status', {
      accountId,
      status: 'ready',
      phone: info.wid.user,
      name: info.pushname,
    });

    // Send initial chats to frontend
    const chats = await getRecentChats(accountId);
    io.emit('wa:chats', { accountId, chats });
  });

  // ── Incoming message ──
  client.on('message', async (msg) => {
    const contact = await msg.getContact().catch(() => null);
    const chat = await msg.getChat().catch(() => null);
    
    const payload = {
      accountId,
      id: msg.id._serialized,
      chatId: msg.from,
      from: contact?.pushname || contact?.name || msg.from.replace('@c.us','').replace('@g.us',''),
      fromNumber: msg.from,
      body: msg.body,
      type: msg.type,
      timestamp: msg.timestamp,
      isGroup: msg.from.includes('@g.us'),
      chatName: chat?.name || null,
      hasMedia: msg.hasMedia,
    };

    // Handle media
    if (msg.hasMedia && ['image','video','audio','document'].includes(msg.type)) {
      try {
        const media = await msg.downloadMedia();
        payload.media = { data: media.data, mimetype: media.mimetype, filename: media.filename };
      } catch (e) { /* skip media download on error */ }
    }

    io.emit('wa:message', payload);
  });

  // ── Message sent by you (from phone) ──
  client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    io.emit('wa:message_sent', {
      accountId,
      id: msg.id._serialized,
      chatId: msg.to,
      body: msg.body,
      timestamp: msg.timestamp,
    });
  });

  // ── Disconnected ──
  client.on('disconnected', (reason) => {
    console.log(`${accountId} disconnected:`, reason);
    statuses[accountId] = 'disconnected';
    io.emit('wa:status', { accountId, status: 'disconnected', reason });
    delete clients[accountId];
  });

  await client.initialize().catch(err => {
    console.error(`Failed to init ${accountId}:`, err.message);
    statuses[accountId] = 'error';
    io.emit('wa:status', { accountId, status: 'error', error: err.message });
  });

  clients[accountId] = client;
}

// ─── Public API ────────────────────────────────────────

async function addNewSession(accountId, io) {
  const totalSessions = Object.keys(clients).length;
  if (totalSessions >= MAX_ACCOUNTS) {
    throw new Error(`Maximum of ${MAX_ACCOUNTS} WhatsApp accounts reached.`);
  }
  await createClient(accountId, io);
}

async function sendWAMessage(accountId, to, body) {
  const client = clients[accountId];
  if (!client) throw new Error(`Account ${accountId} not found or not ready.`);
  // Normalize number: strip non-digits, append @c.us if needed
  const chatId = to.includes('@') ? to : `${to.replace(/\D/g,'')}@c.us`;
  return client.sendMessage(chatId, body);
}

async function sendWAMedia(accountId, to, filePath, caption) {
  const client = clients[accountId];
  if (!client) throw new Error(`Account ${accountId} not found.`);
  const media = MessageMedia.fromFilePath(filePath);
  const chatId = to.includes('@') ? to : `${to.replace(/\D/g,'')}@c.us`;
  return client.sendMessage(chatId, media, { caption });
}

async function getRecentChats(accountId, limit = 30) {
  const client = clients[accountId];
  if (!client) return [];
  const chats = await client.getChats();
  return Promise.all(
    chats.slice(0, limit).map(async (chat) => ({
      id: chat.id._serialized,
      name: chat.name,
      lastMessage: chat.lastMessage?.body || '',
      lastMessageTime: chat.lastMessage?.timestamp || 0,
      unreadCount: chat.unreadCount,
      isGroup: chat.isGroup,
    }))
  );
}

async function getChatMessages(accountId, chatId, limit = 50) {
  const client = clients[accountId];
  if (!client) throw new Error(`Account ${accountId} not ready.`);
  const chat = await client.getChatById(chatId);
  const messages = await chat.fetchMessages({ limit });
  return messages.map(m => ({
    id: m.id._serialized,
    body: m.body,
    fromMe: m.fromMe,
    type: m.type,
    timestamp: m.timestamp,
    author: m.author || null,
  }));
}

async function disconnectSession(accountId) {
  const client = clients[accountId];
  if (client) {
    await client.destroy();
    delete clients[accountId];
    delete statuses[accountId];
  }
}

function getStatuses() {
  return statuses;
}

function getSavedSessionIds() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(d => d.startsWith('session-'))
    .map(d => d.replace('session-', ''));
}

module.exports = {
  initWhatsApp,
  addNewSession,
  sendWAMessage,
  sendWAMedia,
  getRecentChats,
  getChatMessages,
  disconnectSession,
  getStatuses,
};
