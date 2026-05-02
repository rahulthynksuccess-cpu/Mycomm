/**
 * WhatsApp service — @whiskeysockets/baileys v6.7.x
 */

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  isJidGroup,
} = require('@whiskeysockets/baileys');

const { usePostgresAuthState } = require('./pgAuthState');
const { pool, dbAvailable }  = require('./db');
const { Boom }  = require('@hapi/boom');
const pino      = require('pino');
const qrcode    = require('qrcode');
const path      = require('path');
const fs        = require('fs');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const clients     = {};
const statuses    = {};
const chatMap     = {};
const msgMap      = {};
const contactMap  = {};

const MAX_ACCOUNTS = parseInt(process.env.WA_MAX_ACCOUNTS || '5');

const logger = pino({ level: 'silent' });

let _waVersion = null;
async function getWAVersion() {
  if (!_waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    _waVersion = version;
  }
  return _waVersion;
}

function emitStatus(io, accountId, fields) {
  statuses[accountId] = { ...(statuses[accountId] || {}), ...fields };
  io.emit('wa:status', { accountId, ...statuses[accountId] });
}

function phoneFromJid(jid = '') {
  // JID format can be: 919241400000@s.whatsapp.net
  // or multi-device:   919241400000:12@s.whatsapp.net
  // Strip @... first, then :deviceid, then non-digits
  return jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function extractBody(msg) {
  const m = msg?.message;
  if (!m) return '';
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || m.audioMessage && '🎵 Audio'
    || m.stickerMessage && '🎨 Sticker'
    || m.locationMessage && '📍 Location'
    || m.contactMessage?.displayName && `👤 ${m.contactMessage.displayName}`
    || m.templateMessage?.hydratedTemplate?.hydratedContentText
    || m.templateMessage?.hydratedTemplate?.hydratedTitleText
    || m.templateMessage && '📋 Template message'
    || m.interactiveMessage?.body?.text
    || m.interactiveMessage?.header?.text
    || m.interactiveMessage && '📋 Interactive message'
    || m.buttonsMessage?.contentText
    || m.listMessage?.description
    || m.reactionMessage && `${m.reactionMessage.text || '👍'} Reaction`
    || m.pollCreationMessage?.name && `📊 Poll: ${m.pollCreationMessage.name}`
    || m.ephemeralMessage && extractBody({ message: m.ephemeralMessage.message })
    || m.viewOnceMessage && extractBody({ message: m.viewOnceMessage.message })
    || '';
}

function resolveName(accountId, jid, fallback) {
  const c = contactMap[accountId]?.get(jid);
  const phone = phoneFromJid(jid);
  // If fallback looks like a JID, ignore it and use phone number instead
  const safeFallback = (fallback && !fallback.includes('@')) ? fallback : null;
  return (c?.name || c?.notify || safeFallback || phone || jid).trim() || jid;
}

function buildChatList(accountId, limit = 50) {
  const map = chatMap[accountId];
  if (!map || map.size === 0) return [];
  return [...map.values()]
    .sort((a, b) => (Number(b.conversationTimestamp) || 0) - (Number(a.conversationTimestamp) || 0))
    .slice(0, limit)
    .map(chat => ({
      id:              chat.id,
      name:            resolveName(accountId, chat.id, chat.name),
      lastMessage:     chat.lastMessage || '',
      lastMessageTime: Number(chat.conversationTimestamp) || 0,
      unreadCount:     chat.unreadCount || 0,
      isGroup:         isJidGroup(chat.id),
    }));
}

async function createClient(accountId, io) {
  if (clients[accountId]) {
    try { clients[accountId].end(undefined); } catch (_) {}
    delete clients[accountId];
  }

  chatMap[accountId]    = new Map();
  msgMap[accountId]     = new Map();
  contactMap[accountId] = new Map();

  emitStatus(io, accountId, {
    status: 'initializing', phone: undefined, name: undefined,
    error: undefined, reason: undefined,
  });

  // Try Postgres auth — fall back to files only if DB is completely unavailable
  let state, saveCreds, removeAll;
  try {
    if (!pool) throw new Error('No pool');
    // Test connection is alive
    await pool.query('SELECT 1');
    ({ state, saveCreds, removeAll } = await usePostgresAuthState(accountId));
    console.log(`[WA] Using Postgres auth for ${accountId}`);
  } catch (e) {
    console.log(`[WA] Using file auth for ${accountId} (DB unavailable: ${e.message})`);
    const dir = path.join(SESSIONS_DIR, `session-${accountId}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    ({ state, saveCreds } = await useMultiFileAuthState(dir));
    removeAll = async () => fs.rmSync(dir, { recursive: true, force: true });
  }
  const version              = await getWAVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    browser: ['MyComms', 'Chrome', '10.0'],
    syncFullHistory: true,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
  });

  clients[accountId] = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      emitStatus(io, accountId, { status: 'qr' });
      const qrDataUrl = await qrcode.toDataURL(qr).catch(() => null);
      if (qrDataUrl) io.emit('wa:qr', { accountId, qr: qrDataUrl });
    }

    if (connection === 'open') {
      const phone = phoneFromJid(sock.user?.id || '');
      const name  = sock.user?.name || accountId;
      console.log(`[WA] ${accountId} ready — ${phone}`);
      io.emit('wa:qr', { accountId, qr: null });
      emitStatus(io, accountId, { status: 'ready', phone, name });

      // Wait for history sync events to arrive (messaging-history.set, chats.set)
      // then push. Retry a few times to catch delayed events.
      let pushed = false;
      const tryPush = (delay) => setTimeout(() => {
        const list = buildChatList(accountId);
        if (list.length > 0) {
          pushed = true;
          pushChats();
        }
      }, delay);
      tryPush(2000);
      tryPush(5000);
      tryPush(10000);
      tryPush(20000);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode : null;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;
      const badSession = statusCode === DisconnectReason.badSession;

      delete clients[accountId];

      if (loggedOut || badSession) {
        await removeAll().catch(() => {});
        delete chatMap[accountId];
        delete msgMap[accountId];
        delete contactMap[accountId];
        emitStatus(io, accountId, {
          status: 'auth_failure',
          error: loggedOut ? 'Logged out from phone' : 'Bad session — re-scan QR',
        });
      } else {
        emitStatus(io, accountId, { status: 'disconnected', reason: String(statusCode) });
        const delay = statusCode === DisconnectReason.restartRequired ? 2000 : 8000;
        setTimeout(() => {
          if (!clients[accountId]) createClient(accountId, io).catch(console.error);
        }, delay);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Contacts: build name map ───────────────────────
  function storeContacts(list = []) {
    for (const c of list) {
      if (!c.id) continue;
      const existing = contactMap[accountId].get(c.id) || {};
      const name   = c.name   || c.verifiedName || existing.name   || '';
      const notify = c.notify || c.pushName     || existing.notify || '';
      if (name || notify) {
        contactMap[accountId].set(c.id, { name, notify });
      }
    }
  }

  sock.ev.on('contacts.upsert', (cs) => { storeContacts(cs); pushChats(); });
  sock.ev.on('contacts.update', (cs) => { storeContacts(cs); pushChats(); });

  // ── Chats ──────────────────────────────────────────
  function storeChats(list = []) {
    for (const chat of list) {
      chatMap[accountId].set(chat.id, {
        ...chatMap[accountId].get(chat.id),
        ...chat,
      });
    }
  }

  function pushChats() {
    const list = buildChatList(accountId);
    if (list.length > 0) io.emit('wa:chats', { accountId, chats: list });
  }

  sock.ev.on('chats.upsert', (cs) => { storeChats(cs); pushChats(); });
  sock.ev.on('chats.update', (cs) => { storeChats(cs); pushChats(); });
  sock.ev.on('chats.set',    (cs) => { storeChats(cs.chats || []); pushChats(); });

  // ── History sync: contacts FIRST then chats ────────
  sock.ev.on('messaging-history.set', ({ chats: hc, contacts: hct, messages: hm }) => {
    if (hct?.length) storeContacts(hct);
    if (hc?.length)  storeChats(hc);
    if (hm?.length) {
      for (const msg of hm) {
        const jid = msg.key?.remoteJid;
        if (!jid || !msg.message) continue;
        if (!msgMap[accountId].has(jid)) msgMap[accountId].set(jid, []);
        msgMap[accountId].get(jid).push(msg);
      }
      // Sort each chat's messages by timestamp
      for (const [jid, msgs] of msgMap[accountId]) {
        msgs.sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
      }
    }
    // Wait 2s for any trailing contacts.upsert events before pushing
    setTimeout(() => pushChats(), 2000);
  });

  // ── Incoming messages ──────────────────────────────
  sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      const jid = msg.key.remoteJid || '';
      if (!jid) continue;

      // store message
      if (!msgMap[accountId].has(jid)) msgMap[accountId].set(jid, []);
      const arr = msgMap[accountId].get(jid);
      arr.push(msg);
      if (arr.length > 1000) arr.splice(0, arr.length - 1000);

      // update chat preview
      const existing = chatMap[accountId].get(jid) || { id: jid };
      chatMap[accountId].set(jid, {
        ...existing,
        conversationTimestamp: msg.messageTimestamp,
        lastMessage: extractBody(msg),
      });

      // cache pushName if we have no better name
      if (msg.pushName) {
        const ec = contactMap[accountId].get(jid) || {};
        if (!ec.name && !ec.notify) {
          contactMap[accountId].set(jid, { ...ec, notify: msg.pushName });
        }
      }

      if (type === 'notify' && !msg.key.fromMe) {
        io.emit('wa:message', {
          accountId,
          id:          msg.key.id,
          chatId:      jid,
          from:        resolveName(accountId, jid, msg.pushName),
          fromNumber:  jid,
          body:        extractBody(msg),
          type:        Object.keys(msg.message || {})[0] || 'unknown',
          timestamp:   Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
          isGroup:     isJidGroup(jid),
          chatName:    resolveName(accountId, jid, msg.pushName),
          hasMedia:    !!(msg.message?.imageMessage || msg.message?.videoMessage
                        || msg.message?.audioMessage || msg.message?.documentMessage),
        });
        pushChats();
      }
    }
  });
}

// ── Public API ─────────────────────────────────────────

async function initWhatsApp(io) {
  await getWAVersion().catch(() => {});
  const saved = await getSavedSessionIds();
  console.log('[WA] Restoring sessions:', saved);
  for (let i = 0; i < saved.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 3000));
    await createClient(saved[i], io).catch(e =>
      console.error('[WA] Restore failed for', saved[i], e.message)
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
    try { clients[accountId].end(undefined); } catch (_) {}
    delete clients[accountId];
  }
  // Delete session from DB or files
  if (dbAvailable && pool) {
    await pool.query('DELETE FROM wa_sessions WHERE account_id = $1', [accountId]).catch(() => {});
  }
  const dir = path.join(SESSIONS_DIR, `session-${accountId}`);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  delete chatMap[accountId];
  delete msgMap[accountId];
  delete contactMap[accountId];
  delete statuses[accountId];
}

async function sendWAMessage(accountId, to, body) {
  const sock = clients[accountId];
  if (!sock || statuses[accountId]?.status !== 'ready')
    throw new Error('Account not ready.');
  const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: body });
}

async function getRecentChats(accountId, limit = 50) {
  return buildChatList(accountId, limit);
}

async function getChatMessages(accountId, chatId, limit = 200) {
  let msgs = msgMap[accountId]?.get(chatId) || [];



  return msgs.slice(-limit).map(m => ({
    id:        m.key.id,
    body:      extractBody(m),
    fromMe:    m.key.fromMe || false,
    type:      Object.keys(m.message || {})[0] || 'unknown',
    timestamp: Number(m.messageTimestamp) || 0,
    author:    m.key.participant || null,
  }));
}

function getStatuses() { return statuses; }

async function getSavedSessionIds() {
  // Try Postgres directly — retry for up to 10s
  if (pool) {
    for (let i = 0; i < 10; i++) {
      try {
        const res = await pool.query(
          "SELECT DISTINCT account_id FROM wa_sessions WHERE key = 'creds'"
        );
        console.log('[WA] Loaded session IDs from Postgres:', res.rows.map(r => r.account_id));
        return res.rows.map(r => r.account_id);
      } catch (e) {
        console.log(`[WA] DB not ready yet, retrying (${i+1}/10)...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  // Fall back to file system
  console.log('[WA] Loading session IDs from files');
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(d => {
      if (!d.startsWith('session-')) return false;
      const accountId = d.replace('session-', '');
      if (/^\d+$/.test(accountId)) return false;
      return fs.existsSync(path.join(SESSIONS_DIR, d, 'creds.json'));
    })
    .map(d => d.replace('session-', ''));
}

module.exports = {
  initWhatsApp, addNewSession, sendWAMessage,
  getRecentChats, getChatMessages, disconnectSession, getStatuses,
};
