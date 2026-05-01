const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

// ── State ──────────────────────────────────────────────
const clients  = {};  // accountId → Client
const statuses = {};  // accountId → { status, phone, name, error, reason }

const MAX_ACCOUNTS = parseInt(process.env.WA_MAX_ACCOUNTS || '5');
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function findChromium() {
  // Priority: env var > well-known system paths
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      require('fs').accessSync(p, require('fs').constants.X_OK);
      console.log('[WA] Using browser:', p);
      return p;
    } catch (_) {}
  }
  // Fall back to letting puppeteer decide (will use its downloaded Chrome)
  console.warn('[WA] No system Chromium found — puppeteer will use its own (may fail without deps)');
  return undefined;
}

function getPuppeteerOpts() {
  const executablePath = findChromium();
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas',
    '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu',
    '--disable-extensions', '--disable-default-apps',
  ];
  const opts = { args };
  if (executablePath) opts.executablePath = executablePath;
  return opts;
}

// Central emit — always keeps statuses{} in sync with what we send
function emitStatus(io, accountId, fields) {
  statuses[accountId] = { ...(statuses[accountId] || {}), ...fields };
  io.emit('wa:status', { accountId, ...statuses[accountId] });
}

async function createClient(accountId, io) {
  if (clients[accountId]) return;

  emitStatus(io, accountId, { status: 'initializing', phone: undefined, name: undefined, error: undefined });

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId, dataPath: SESSIONS_DIR }),
    puppeteer: getPuppeteerOpts(),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
  });

  clients[accountId] = client;  // register immediately to block duplicate calls

  client.on('qr', async (qr) => {
    console.log('[WA] QR for', accountId);
    emitStatus(io, accountId, { status: 'qr' });
    const qrDataUrl = await qrcode.toDataURL(qr).catch(() => null);
    if (qrDataUrl) io.emit('wa:qr', { accountId, qr: qrDataUrl });
  });

  client.on('authenticated', () => {
    emitStatus(io, accountId, { status: 'authenticated' });
  });

  client.on('auth_failure', (msg) => {
    console.error('[WA] Auth failure', accountId, msg);
    delete clients[accountId];
    emitStatus(io, accountId, { status: 'auth_failure', error: String(msg) });
  });

  client.on('ready', async () => {
    console.log('[WA] Ready:', accountId);
    const info = client.info;
    emitStatus(io, accountId, {
      status: 'ready',
      phone: info?.wid?.user || '',
      name:  info?.pushname  || accountId,
    });
    try {
      const chats = await getRecentChats(accountId);
      io.emit('wa:chats', { accountId, chats });
    } catch (e) {
      console.error('[WA] getChats failed for', accountId, e.message);
    }
  });

  client.on('message', async (msg) => {
    try {
      const contact = await msg.getContact().catch(() => null);
      const chat    = await msg.getChat().catch(() => null);
      io.emit('wa:message', {
        accountId, id: msg.id._serialized, chatId: msg.from,
        from: contact?.pushname || contact?.name || msg.from.replace(/@\w+\.us/, ''),
        fromNumber: msg.from, body: msg.body, type: msg.type,
        timestamp: msg.timestamp, isGroup: msg.from.includes('@g.us'),
        chatName: chat?.name || null, hasMedia: msg.hasMedia,
      });
    } catch (_) {}
  });

  client.on('disconnected', (reason) => {
    console.log('[WA] Disconnected:', accountId, reason);
    delete clients[accountId];
    emitStatus(io, accountId, { status: 'disconnected', reason: String(reason) });
    // Auto-reconnect if session folder still exists (unexpected drop, not manual disconnect)
    const sessionDir = path.join(SESSIONS_DIR, `session-${accountId}`);
    if (fs.existsSync(sessionDir)) {
      console.log('[WA] Auto-reconnect in 8s for', accountId);
      setTimeout(() => {
        if (!clients[accountId]) createClient(accountId, io).catch(console.error);
      }, 8000);
    }
  });

  await client.initialize().catch((err) => {
    console.error('[WA] Init failed for', accountId, err.message);
    delete clients[accountId];
    emitStatus(io, accountId, { status: 'error', error: err.message });
  });
}

async function initWhatsApp(io) {
  const saved = getSavedSessionIds();
  console.log('[WA] Restoring sessions:', saved);
  for (const id of saved) {
    await createClient(id, io).catch(e =>
      console.error('[WA] Restore failed for', id, e.message)
    );
  }
}

async function addNewSession(accountId, io) {
  if (Object.keys(clients).length >= MAX_ACCOUNTS)
    throw new Error(`Max ${MAX_ACCOUNTS} accounts reached.`);
  await createClient(accountId, io);
}

async function disconnectSession(accountId) {
  if (clients[accountId]) {
    try { await clients[accountId].destroy(); } catch (_) {}
    delete clients[accountId];
  }
  delete statuses[accountId];
  const sessionDir = path.join(SESSIONS_DIR, `session-${accountId}`);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log('[WA] Session folder deleted for', accountId);
  }
}

async function sendWAMessage(accountId, to, body) {
  const client = clients[accountId];
  if (!client || statuses[accountId]?.status !== 'ready')
    throw new Error('Account not ready. Please wait for it to connect.');
  const chatId = to.includes('@') ? to : (to.replace(/\D/g, '') + '@c.us');
  return client.sendMessage(chatId, body);
}

async function getRecentChats(accountId, limit = 50) {
  const client = clients[accountId];
  if (!client || statuses[accountId]?.status !== 'ready') return [];
  const all = await client.getChats();
  return Promise.all(all.slice(0, limit).map(async chat => ({
    id:              chat.id._serialized,
    name:            chat.name || chat.id.user || 'Unknown',
    lastMessage:     chat.lastMessage?.body || '',
    lastMessageTime: chat.lastMessage?.timestamp || 0,
    unreadCount:     chat.unreadCount || 0,
    isGroup:         chat.isGroup,
  })));
}

async function getChatMessages(accountId, chatId, limit = 50) {
  const client = clients[accountId];
  if (!client) throw new Error('Account not connected.');
  const chat = await client.getChatById(chatId);
  const msgs = await chat.fetchMessages({ limit });
  return msgs.map(m => ({
    id: m.id._serialized, body: m.body || '',
    fromMe: m.fromMe, type: m.type,
    timestamp: m.timestamp, author: m.author || null,
  }));
}

function getStatuses() { return statuses; }

function getSavedSessionIds() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(d => d.startsWith('session-') &&
      fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory())
    .map(d => d.replace('session-', ''));
}

module.exports = {
  initWhatsApp, addNewSession, sendWAMessage,
  getRecentChats, getChatMessages, disconnectSession, getStatuses,
};
