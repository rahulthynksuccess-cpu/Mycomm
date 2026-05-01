/**
 * WhatsApp service — @whiskeysockets/baileys
 * Fixes:
 *  - Emit wa:qr with qr=null on connection open so frontend clears the modal
 *  - Fetch WA version once at startup, not per-account (avoids race + slowness)
 *  - Count only active (non-failed) sessions toward MAX_ACCOUNTS
 *  - Stagger multi-account init to avoid hitting WA rate limits
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  isJidGroup,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino     = require('pino');
const path     = require('path');
const fs       = require('fs');
const qrcode   = require('qrcode');

// ── State ──────────────────────────────────────────────
const clients  = {};   // accountId → socket
const stores   = {};   // accountId → in-memory store
const statuses = {};   // accountId → { status, phone, name, error, reason }

const MAX_ACCOUNTS = parseInt(process.env.WA_MAX_ACCOUNTS || '5');
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const logger = pino({ level: 'silent' });

// Cache WA version — fetched once at first use, reused for all accounts
let _waVersion = null;
async function getWAVersion() {
  if (!_waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    _waVersion = version;
    console.log('[WA] Using version:', version.join('.'));
  }
  return _waVersion;
}

// ── Helpers ────────────────────────────────────────────
function sessionDir(accountId) {
  const d = path.join(SESSIONS_DIR, `session-${accountId}`);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function emitStatus(io, accountId, fields) {
  statuses[accountId] = { ...(statuses[accountId] || {}), ...fields };
  io.emit('wa:status', { accountId, ...statuses[accountId] });
}

function phoneFromJid(jid = '') {
  return jid.split('@')[0].replace(/[^0-9]/g, '');
}

// Active accounts = those not in a terminal-failed state
function activeAccountCount() {
  return Object.keys(clients).length;
}

// ── Core: create a Baileys socket for one account ──────
async function createClient(accountId, io) {
  // Tear down any existing socket
  if (clients[accountId]) {
    try { clients[accountId].end(undefined); } catch (_) {}
    delete clients[accountId];
  }

  emitStatus(io, accountId, {
    status: 'initializing', phone: undefined, name: undefined,
    error: undefined, reason: undefined,
  });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir(accountId));
  const version              = await getWAVersion();

  const store = makeInMemoryStore({ logger });
  stores[accountId] = store;

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    browser: ['MyComms', 'Chrome', '10.0'],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    retryRequestDelayMs: 250,
  });

  clients[accountId] = sock;
  store.bind(sock.ev);

  // ── Connection updates ─────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // New QR available — send to frontend
    if (qr) {
      emitStatus(io, accountId, { status: 'qr' });
      const qrDataUrl = await qrcode.toDataURL(qr).catch(() => null);
      if (qrDataUrl) io.emit('wa:qr', { accountId, qr: qrDataUrl });
    }

    if (connection === 'open') {
      const phone = phoneFromJid(sock.user?.id || '');
      const name  = sock.user?.name || accountId;
      console.log(`[WA] ${accountId} ready — ${phone} (${name})`);

      // 1. Clear QR modal on frontend FIRST — send null qr signal
      io.emit('wa:qr', { accountId, qr: null });

      // 2. Then emit ready status
      emitStatus(io, accountId, { status: 'ready', phone, name });

      // 3. Push initial chat list
      try {
        const chats = await getRecentChats(accountId);
        io.emit('wa:chats', { accountId, chats });
      } catch (_) {}
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode : null;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;
      const badSession = statusCode === DisconnectReason.badSession;

      console.log(`[WA] ${accountId} closed — code ${statusCode}`);
      delete clients[accountId];

      if (loggedOut || badSession) {
        fs.rmSync(sessionDir(accountId), { recursive: true, force: true });
        delete stores[accountId];
        emitStatus(io, accountId, {
          status: 'auth_failure',
          error: loggedOut ? 'Logged out from phone' : 'Bad session — please re-scan QR',
        });
      } else {
        emitStatus(io, accountId, { status: 'disconnected', reason: String(statusCode) });
        const delay = statusCode === DisconnectReason.restartRequired ? 2000 : 8000;
        console.log(`[WA] Auto-reconnect ${accountId} in ${delay}ms`);
        setTimeout(() => {
          if (!clients[accountId]) createClient(accountId, io).catch(console.error);
        }, delay);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Incoming messages ──────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const msg of msgs) {
      if (msg.key.fromMe) continue;
      const jid      = msg.key.remoteJid || '';
      const body     = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';
      const contact  = store.contacts?.[jid];
      const fromName = contact?.notify || contact?.name || phoneFromJid(jid);
      io.emit('wa:message', {
        accountId,
        id:          msg.key.id,
        chatId:      jid,
        from:        fromName,
        fromNumber:  jid,
        body,
        type:        Object.keys(msg.message || {})[0] || 'unknown',
        timestamp:   Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
        isGroup:     isJidGroup(jid),
        chatName:    store.chats.get(jid)?.name || fromName,
        hasMedia:    !!(msg.message?.imageMessage || msg.message?.videoMessage
                      || msg.message?.audioMessage || msg.message?.documentMessage),
      });
    }
  });
}

// ── Public API ─────────────────────────────────────────

async function initWhatsApp(io) {
  // Pre-fetch WA version once before restoring sessions
  await getWAVersion().catch(e => console.error('[WA] Version fetch failed:', e.message));

  const saved = getSavedSessionIds();
  console.log('[WA] Restoring sessions:', saved);

  // Stagger restores by 3s each to avoid rate limiting
  for (let i = 0; i < saved.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 3000));
    await createClient(saved[i], io).catch(e =>
      console.error('[WA] Restore failed for', saved[i], e.message)
    );
  }
}

async function addNewSession(accountId, io) {
  if (activeAccountCount() >= MAX_ACCOUNTS)
    throw new Error(`Max ${MAX_ACCOUNTS} accounts reached.`);
  await createClient(accountId, io);
}

async function disconnectSession(accountId) {
  if (clients[accountId]) {
    try { clients[accountId].end(undefined); } catch (_) {}
    delete clients[accountId];
  }
  delete stores[accountId];
  delete statuses[accountId];
  const dir = path.join(SESSIONS_DIR, `session-${accountId}`);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function sendWAMessage(accountId, to, body) {
  const sock = clients[accountId];
  if (!sock || statuses[accountId]?.status !== 'ready')
    throw new Error('Account not ready. Please wait for it to connect.');
  const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: body });
}

async function getRecentChats(accountId, limit = 50) {
  const store = stores[accountId];
  if (!store) return [];

  // Baileys store exposes chats differently depending on version —
  // handle all known shapes safely
  let all = [];
  try {
    if (typeof store.chats.all === 'function') {
      all = [...store.chats.all()];
    } else if (store.chats.toJSON) {
      all = Object.values(store.chats.toJSON());
    } else if (store.chats.get) {
      // Iterate underlying Map if exposed
      all = [...(store.chats._map?.values() || [])];
    }
  } catch (e) {
    console.error('[WA] getRecentChats store read error:', e.message);
  }

  // Sort by most recent message first
  all.sort((a, b) => (Number(b.conversationTimestamp) || 0) - (Number(a.conversationTimestamp) || 0));

  return all.slice(0, limit).map(chat => {
    const lastMsgArray = chat.messages?.array;
    const lastMsg = lastMsgArray?.[lastMsgArray.length - 1];
    const lastBody = lastMsg?.message?.conversation
      || lastMsg?.message?.extendedTextMessage?.text
      || '';
    return {
      id:              chat.id,
      name:            chat.name || phoneFromJid(chat.id) || 'Unknown',
      lastMessage:     lastBody,
      lastMessageTime: Number(chat.conversationTimestamp) || 0,
      unreadCount:     chat.unreadCount || 0,
      isGroup:         isJidGroup(chat.id),
    };
  });
}

async function getChatMessages(accountId, chatId, limit = 50) {
  const store = stores[accountId];
  if (!store) throw new Error('Account not connected.');
  const msgs = store.messages[chatId];
  if (!msgs) return [];
  return [...msgs.array].slice(-limit).map(m => ({
    id:        m.key.id,
    body:      m.message?.conversation
               || m.message?.extendedTextMessage?.text
               || m.message?.imageMessage?.caption
               || '',
    fromMe:    m.key.fromMe || false,
    type:      Object.keys(m.message || {})[0] || 'unknown',
    timestamp: Number(m.messageTimestamp) || 0,
    author:    m.key.participant || null,
  }));
}

function getStatuses() { return statuses; }

function getSavedSessionIds() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(d => d.startsWith('session-')
      && fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory())
    .map(d => d.replace('session-', ''));
}

module.exports = {
  initWhatsApp, addNewSession, sendWAMessage,
  getRecentChats, getChatMessages, disconnectSession, getStatuses,
};
