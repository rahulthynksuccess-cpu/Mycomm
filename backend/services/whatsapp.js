const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const clients = {};
const statuses = {};

const MAX_ACCOUNTS = parseInt(process.env.WA_MAX_ACCOUNTS || '5');
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function getPuppeteerArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
  ];
}

async function createClient(accountId, io) {
  if (clients[accountId]) return;

  statuses[accountId] = 'initializing';
  io.emit('wa:status', { accountId, status: 'initializing' });

  // PUPPETEER_EXECUTABLE_PATH set by Dockerfile to /usr/bin/chromium (apt-installed)
  const puppeteerOpts = { args: getPuppeteerArgs() };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log('Using Chromium at:', process.env.PUPPETEER_EXECUTABLE_PATH);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId, dataPath: SESSIONS_DIR }),
    puppeteer: puppeteerOpts,
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
    statuses[accountId] = 'authenticated';
    io.emit('wa:status', { accountId, status: 'authenticated' });
  });

  client.on('auth_failure', (msg) => {
    statuses[accountId] = 'auth_failure';
    io.emit('wa:status', { accountId, status: 'auth_failure', error: msg });
  });

  client.on('ready', async () => {
    console.log(accountId, 'ready!');
    statuses[accountId] = 'ready';
    const info = client.info;
    io.emit('wa:status', { accountId, status: 'ready', phone: info.wid.user, name: info.pushname });
    const chats = await getRecentChats(accountId);
    io.emit('wa:chats', { accountId, chats });
  });

  client.on('message', async (msg) => {
    const contact = await msg.getContact().catch(() => null);
    const chat = await msg.getChat().catch(() => null);
    const payload = {
      accountId, id: msg.id._serialized, chatId: msg.from,
      from: contact?.pushname || contact?.name || msg.from.replace(/@\w+\.us/, ''),
      fromNumber: msg.from, body: msg.body, type: msg.type,
      timestamp: msg.timestamp, isGroup: msg.from.includes('@g.us'),
      chatName: chat?.name || null, hasMedia: msg.hasMedia,
    };
    io.emit('wa:message', payload);
  });

  client.on('disconnected', (reason) => {
    statuses[accountId] = 'disconnected';
    io.emit('wa:status', { accountId, status: 'disconnected', reason });
    delete clients[accountId];
  });

  clients[accountId] = client;

  await client.initialize().catch(err => {
    console.error('Init failed for', accountId, ':', err.message);
    statuses[accountId] = 'error';
    io.emit('wa:status', { accountId, status: 'error', error: err.message });
    delete clients[accountId];
  });
}

async function initWhatsApp(io) {
  const saved = getSavedSessionIds();
  for (const id of saved) await createClient(id, io);
}

async function addNewSession(accountId, io) {
  if (Object.keys(clients).length >= MAX_ACCOUNTS)
    throw new Error('Maximum accounts reached.');
  await createClient(accountId, io);
}

async function sendWAMessage(accountId, to, body) {
  const client = clients[accountId];
  if (!client) throw new Error('Account not found or not ready.');
  // If already a full WA ID (has @), use as-is. Otherwise assume individual number.
  const chatId = to.includes('@') ? to : (to.replace(/\D/g, '') + '@c.us');
  console.log('Sending to chatId:', chatId);
  return client.sendMessage(chatId, body);
}

async function getRecentChats(accountId, limit = 30) {
  const client = clients[accountId];
  if (!client) return [];
  const chats = await client.getChats();
  return Promise.all(chats.slice(0, limit).map(async chat => ({
    id: chat.id._serialized, name: chat.name,
    lastMessage: chat.lastMessage?.body || '',
    lastMessageTime: chat.lastMessage?.timestamp || 0,
    unreadCount: chat.unreadCount, isGroup: chat.isGroup,
  })));
}

async function getChatMessages(accountId, chatId, limit = 50) {
  const client = clients[accountId];
  if (!client) throw new Error('Account not ready.');
  console.log('Fetching messages for chat:', chatId);
  const chat = await client.getChatById(chatId);
  const messages = await chat.fetchMessages({ limit });
  return messages.map(m => ({
    id: m.id._serialized,
    body: m.body || '',
    fromMe: m.fromMe,
    type: m.type,
    timestamp: m.timestamp,
    author: m.author || null,
  }));
}

async function disconnectSession(accountId) {
  if (clients[accountId]) {
    await clients[accountId].destroy().catch(() => {});
    delete clients[accountId];
    delete statuses[accountId];
  }
  // Remove persisted session folder so it doesn't re-initialize on server restart
  const sessionFolder = path.join(SESSIONS_DIR, `session-${accountId}`);
  if (fs.existsSync(sessionFolder)) {
    fs.rmSync(sessionFolder, { recursive: true, force: true });
    console.log('Deleted session folder for', accountId);
  }
}

function getStatuses() { return statuses; }

function getSavedSessionIds() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(d => d.startsWith('session-'))
    .map(d => d.replace('session-', ''));
}

module.exports = {
  initWhatsApp, addNewSession, sendWAMessage,
  getRecentChats, getChatMessages, disconnectSession, getStatuses,
};
