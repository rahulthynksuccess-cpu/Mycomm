const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const clients = {};
const statuses = {};

const MAX_ACCOUNTS = parseInt(process.env.WA_MAX_ACCOUNTS || '5');
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Detect system Chromium — searches all known paths including nix store
function getChromiumPath() {
  // 1. Explicit env override
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    console.log('Using CHROMIUM_PATH env:', process.env.CHROMIUM_PATH);
    return process.env.CHROMIUM_PATH;
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    console.log('Using PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Standard paths
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
    '/run/current-system/sw/bin/chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { console.log('Found Chromium at:', p); return p; }
  }

  // 3. Search nix store (Railway nixpacks installs here)
  try {
    const nixStore = '/nix/store';
    if (fs.existsSync(nixStore)) {
      const dirs = fs.readdirSync(nixStore).filter(d => d.includes('chromium'));
      for (const dir of dirs) {
        const p = `${nixStore}/${dir}/bin/chromium`;
        if (fs.existsSync(p)) { console.log('Found Chromium in nix store:', p); return p; }
      }
    }
  } catch (e) { console.warn('Nix store search failed:', e.message); }

  // 4. Try `which chromium` / `which chromium-browser`
  for (const cmd of ['chromium', 'chromium-browser', 'google-chrome']) {
    try {
      const p = execSync(`which ${cmd} 2>/dev/null`).toString().trim();
      if (p && fs.existsSync(p)) { console.log(`Found via which ${cmd}:`, p); return p; }
    } catch (e) { /* not found */ }
  }

  console.error('❌ No Chromium found anywhere! Set CHROMIUM_PATH env var on Railway.');
  return undefined;
}

async function initWhatsApp(io) {
  const savedSessions = getSavedSessionIds();
  console.log('Found', savedSessions.length, 'saved WA sessions:', savedSessions);
  for (const accountId of savedSessions) {
    await createClient(accountId, io);
  }
}

async function createClient(accountId, io) {
  if (clients[accountId]) {
    console.log('Session', accountId, 'already exists.');
    return;
  }

  statuses[accountId] = 'initializing';
  io.emit('wa:status', { accountId, status: 'initializing' });

  const chromiumPath = getChromiumPath();

  if (!chromiumPath) {
    const errMsg = 'Chromium not found on server. Set CHROMIUM_PATH env var in Railway dashboard.';
    console.error(errMsg);
    statuses[accountId] = 'error';
    io.emit('wa:status', { accountId, status: 'error', error: errMsg });
    return;
  }

  const puppeteerConfig = {
    headless: true,
    executablePath: chromiumPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-software-rasterizer',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
    ],
  };

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: accountId,
      dataPath: SESSIONS_DIR,
    }),
    puppeteer: puppeteerConfig,
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
  });

  client.on('qr', async (qr) => {
    console.log('QR generated for', accountId);
    statuses[accountId] = 'qr';
    const qrDataUrl = await qrcode.toDataURL(qr);
    io.emit('wa:qr', { accountId, qr: qrDataUrl });
    io.emit('wa:status', { accountId, status: 'qr' });
  });

  client.on('authenticated', () => {
    console.log(accountId, 'authenticated');
    statuses[accountId] = 'authenticated';
    io.emit('wa:status', { accountId, status: 'authenticated' });
  });

  client.on('auth_failure', (msg) => {
    console.error(accountId, 'auth failed:', msg);
    statuses[accountId] = 'auth_failure';
    io.emit('wa:status', { accountId, status: 'auth_failure', error: msg });
  });

  client.on('ready', async () => {
    console.log(accountId, 'is ready!');
    statuses[accountId] = 'ready';
    const info = client.info;
    io.emit('wa:status', {
      accountId,
      status: 'ready',
      phone: info.wid.user,
      name: info.pushname,
    });
    const chats = await getRecentChats(accountId);
    io.emit('wa:chats', { accountId, chats });
  });

  client.on('message', async (msg) => {
    const contact = await msg.getContact().catch(() => null);
    const chat = await msg.getChat().catch(() => null);
    const payload = {
      accountId,
      id: msg.id._serialized,
      chatId: msg.from,
      from: contact?.pushname || contact?.name || msg.from.replace('@c.us', '').replace('@g.us', ''),
      fromNumber: msg.from,
      body: msg.body,
      type: msg.type,
      timestamp: msg.timestamp,
      isGroup: msg.from.includes('@g.us'),
      chatName: chat?.name || null,
      hasMedia: msg.hasMedia,
    };
    if (msg.hasMedia && ['image', 'video', 'audio', 'document'].includes(msg.type)) {
      try {
        const media = await msg.downloadMedia();
        payload.media = { data: media.data, mimetype: media.mimetype, filename: media.filename };
      } catch (e) { /* skip */ }
    }
    io.emit('wa:message', payload);
  });

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

  client.on('disconnected', (reason) => {
    console.log(accountId, 'disconnected:', reason);
    statuses[accountId] = 'disconnected';
    io.emit('wa:status', { accountId, status: 'disconnected', reason });
    delete clients[accountId];
  });

  clients[accountId] = client;

  await client.initialize().catch(err => {
    console.error('Failed to init', accountId, ':', err.message);
    statuses[accountId] = 'error';
    io.emit('wa:status', { accountId, status: 'error', error: err.message });
    delete clients[accountId];
  });
}

async function addNewSession(accountId, io) {
  const totalSessions = Object.keys(clients).length;
  if (totalSessions >= MAX_ACCOUNTS) {
    throw new Error('Maximum of ' + MAX_ACCOUNTS + ' WhatsApp accounts reached.');
  }
  await createClient(accountId, io);
}

async function sendWAMessage(accountId, to, body) {
  const client = clients[accountId];
  if (!client) throw new Error('Account ' + accountId + ' not found or not ready.');
  const chatId = to.includes('@') ? to : (to.replace(/\D/g, '') + '@c.us');
  return client.sendMessage(chatId, body);
}

async function sendWAMedia(accountId, to, filePath, caption) {
  const client = clients[accountId];
  if (!client) throw new Error('Account ' + accountId + ' not found.');
  const media = MessageMedia.fromFilePath(filePath);
  const chatId = to.includes('@') ? to : (to.replace(/\D/g, '') + '@c.us');
  return client.sendMessage(chatId, media, { caption });
}

async function getRecentChats(accountId, limit) {
  limit = limit || 30;
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

async function getChatMessages(accountId, chatId, limit) {
  limit = limit || 50;
  const client = clients[accountId];
  if (!client) throw new Error('Account ' + accountId + ' not ready.');
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
    await client.destroy().catch(() => {});
    delete clients[accountId];
    delete statuses[accountId];
  }
}

function getStatuses() { return statuses; }

function getSavedSessionIds() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(d => d.startsWith('session-'))
    .map(d => d.replace('session-', ''));
}

// Debug helper — call GET /api/whatsapp/debug to see what's happening on the server
function getDebugInfo() {
  const chromiumPath = getChromiumPath();
  return {
    chromiumFound: !!chromiumPath,
    chromiumPath,
    activeSessions: Object.keys(clients),
    statuses,
    env: {
      CHROMIUM_PATH: process.env.CHROMIUM_PATH || null,
      PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      NODE_ENV: process.env.NODE_ENV,
    },
  };
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
  getDebugInfo,
};
