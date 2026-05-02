/**
 * WhatsApp service — @whiskeysockets/baileys v6.7.x
 * No makeInMemoryStore (removed in 6.7+) — chats/messages managed manually.
 *
 * Fixes applied:
 *  1. Contact name resolution  — listen to contacts.upsert + contacts.update
 *     and messaging-history.set to build a contactMap per account.
 *     buildChatList resolves names: saved name → push name → verified → phone.
 *  2. Message history          — messaging-history.set populates msgMap on
 *     connect so getChatMessages returns real history, not an empty array.
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidGroup,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino     = require('pino');
const path     = require('path');
const fs       = require('fs');
const qrcode   = require('qrcode');

// ── State ──────────────────────────────────────────────
const clients    = {};   // accountId → socket
const statuses   = {};   // accountId → { status, phone, name, error, reason }
const chatMap    = {};   // accountId → Map<chatId, chatObj>
const msgMap     = {};   // accountId → Map<chatId, message[]>
const contactMap = {};   // accountId → Map<jid, { name?, notify?, verifiedName? }>

const MAX_ACCOUNTS = parseInt(process.env.WA_MAX_ACCOUNTS || '5');
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const logger = pino({ level: 'silent' });

let _waVersion = null;
async function getWAVersion() {
  if (!_waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    _waVersion = version;
    console.log('[WA] Version:', version.join('.'));
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

function extractBody(msg) {
  return msg?.message?.conversation
    || msg?.message?.extendedTextMessage?.text
    || msg?.message?.imageMessage?.caption
    || msg?.message?.videoMessage?.caption
    || '';
}

/** FIX 1: Resolve best display name for a JID from contactMap */
function resolveName(accountId, jid, fallbackPushName) {
  const contact = contactMap[accountId]?.get(jid);
  const resolved = contact?.name
    || contact?.notify
    || contact?.verifiedName
    || fallbackPushName;
  if (resolved) return resolved;
  // Fall back to a readable phone number (e.g. "+919876543210") instead of raw JID
  const phone = phoneFromJid(jid);
  return phone ? `+${phone}` : 'Unknown';
}

/** Merge contacts into contactMap */
function upsertContacts(accountId, contacts) {
  if (!contactMap[accountId]) contactMap[accountId] = new Map();
  for (const c of contacts) {
    if (!c.id) continue;
    const existing = contactMap[accountId].get(c.id) || {};
    contactMap[accountId].set(c.id, { ...existing, ...c });
  }
}

/** Store messages into msgMap, capped at 200 per chat */
function storeMessages(accountId, messages) {
  if (!msgMap[accountId]) msgMap[accountId] = new Map();
  for (const msg of messages) {
    const jid = msg.key?.remoteJid;
    if (!jid) continue;
    if (!msgMap[accountId].has(jid)) msgMap[accountId].set(jid, []);
    const arr = msgMap[accountId].get(jid);
    arr.push(msg);
    if (arr.length > 200) arr.splice(0, arr.length - 200);
  }
}

// ── Core ───────────────────────────────────────────────
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

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir(accountId));
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
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
  });

  clients[accountId] = sock;

  // ── Connection updates ─────────────────────────────
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

  // ── FIX 1 + 2: History sync (fires shortly after connection.open) ──────
  // Baileys bundles chats + contacts + messages in this one event.
  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
    console.log(
      `[WA] ${accountId} history — chats:${chats.length} contacts:${contacts.length}` +
      ` messages:${messages.length} isLatest:${isLatest}`
    );

    // Contacts first — so name resolution works when processing messages
    if (contacts.length > 0) upsertContacts(accountId, contacts);

    // Chats
    for (const chat of chats) {
      chatMap[accountId].set(chat.id, {
        ...chatMap[accountId].get(chat.id),
        ...chat,
      });
    }

    // Messages — store and also mine pushName for individual contacts
    if (messages.length > 0) {
      storeMessages(accountId, messages);

      for (const msg of messages) {
        const jid = msg.key?.remoteJid;
        if (jid && msg.pushName && !isJidGroup(jid)) {
          const existing = contactMap[accountId].get(jid) || {};
          if (!existing.name && !existing.notify) {
            contactMap[accountId].set(jid, { ...existing, id: jid, notify: msg.pushName });
          }
        }
      }

      // Backfill lastMessage on chats from the newest stored message
      for (const [jid, msgs] of msgMap[accountId]) {
        if (!msgs.length) continue;
        const latest = msgs[msgs.length - 1];
        const chat   = chatMap[accountId].get(jid) || { id: jid };
        const ts     = Number(latest.messageTimestamp);
        if (!chat.conversationTimestamp || ts > Number(chat.conversationTimestamp)) {
          chatMap[accountId].set(jid, {
            ...chat,
            conversationTimestamp: latest.messageTimestamp,
            lastMessage: extractBody(latest),
          });
        }
      }
    }

    const list = buildChatList(accountId);
    if (list.length > 0) io.emit('wa:chats', { accountId, chats: list });
  });

  // ── FIX 1: Live contact events ─────────────────────
  sock.ev.on('contacts.upsert', (contacts) => {
    upsertContacts(accountId, contacts);
    const list = buildChatList(accountId);
    if (list.length > 0) io.emit('wa:chats', { accountId, chats: list });
  });

  sock.ev.on('contacts.update', (updates) => {
    upsertContacts(accountId, updates);
    const list = buildChatList(accountId);
    if (list.length > 0) io.emit('wa:chats', { accountId, chats: list });
  });

  // ── Chats upsert / update ──────────────────────────
  sock.ev.on('chats.upsert', (newChats) => {
    for (const chat of newChats) {
      chatMap[accountId].set(chat.id, {
        ...chatMap[accountId].get(chat.id),
        ...chat,
      });
    }
    // Only broadcast if contactMap is already populated (i.e. after history sync).
    // If we broadcast before contacts arrive, names show as raw JIDs.
    if (contactMap[accountId]?.size > 0) {
      const list = buildChatList(accountId);
      if (list.length > 0) io.emit('wa:chats', { accountId, chats: list });
    }
  });

  sock.ev.on('chats.update', (updates) => {
    for (const update of updates) {
      const existing = chatMap[accountId].get(update.id) || {};
      chatMap[accountId].set(update.id, { ...existing, ...update });
    }
    const list = buildChatList(accountId);
    if (list.length > 0) io.emit('wa:chats', { accountId, chats: list });
  });

  // ── Messages (live) ────────────────────────────────
  sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      const jid = msg.key.remoteJid || '';
      if (!jid) continue;

      // FIX 1: Capture pushName from live messages
      if (msg.pushName && !isJidGroup(jid)) {
        const existing = contactMap[accountId].get(jid) || {};
        contactMap[accountId].set(jid, {
          ...existing,
          id: jid,
          notify: existing.notify || msg.pushName,
        });
      }

      // Store
      if (!msgMap[accountId].has(jid)) msgMap[accountId].set(jid, []);
      const arr = msgMap[accountId].get(jid);
      arr.push(msg);
      if (arr.length > 200) arr.splice(0, arr.length - 200);

      // Update chat
      const chat = chatMap[accountId].get(jid) || { id: jid };
      chatMap[accountId].set(jid, {
        ...chat,
        conversationTimestamp: msg.messageTimestamp,
        lastMessage: extractBody(msg),
      });

      if (type === 'notify' && !msg.key.fromMe) {
        const body     = extractBody(msg);
        const fromName = resolveName(accountId, jid, msg.pushName);
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
          chatName:    fromName,
          hasMedia:    !!(msg.message?.imageMessage || msg.message?.videoMessage
                        || msg.message?.audioMessage || msg.message?.documentMessage),
        });

        const list = buildChatList(accountId);
        if (list.length > 0) io.emit('wa:chats', { accountId, chats: list });
      }
    }
  });
}

// FIX 1: buildChatList uses resolveName instead of raw chat.name
function buildChatList(accountId, limit = 50) {
  const map = chatMap[accountId];
  if (!map) return [];
  return [...map.values()]
    .sort((a, b) => (Number(b.conversationTimestamp) || 0) - (Number(a.conversationTimestamp) || 0))
    .slice(0, limit)
    .map(chat => {
      const name = isJidGroup(chat.id)
        ? (chat.name || chat.subject || chat.id)
        : resolveName(accountId, chat.id, chat.name);
      return {
        id:              chat.id,
        name,
        lastMessage:     chat.lastMessage || '',
        lastMessageTime: Number(chat.conversationTimestamp) || 0,
        unreadCount:     chat.unreadCount || 0,
        isGroup:         isJidGroup(chat.id),
      };
    });
}

// ── Public API ─────────────────────────────────────────

async function initWhatsApp(io) {
  await getWAVersion().catch(e => console.error('[WA] Version fetch failed:', e.message));
  const saved = getSavedSessionIds();
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
  delete chatMap[accountId];
  delete msgMap[accountId];
  delete contactMap[accountId];
  delete statuses[accountId];
  const dir = path.join(SESSIONS_DIR, `session-${accountId}`);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
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

// FIX 2: msgMap is now populated by messaging-history.set, returns real history
async function getChatMessages(accountId, chatId, limit = 50) {
  const msgs = msgMap[accountId]?.get(chatId) || [];
  return msgs.slice(-limit).map(m => ({
    id:        m.key.id,
    body:      extractBody(m),
    fromMe:    m.key.fromMe || false,
    type:      Object.keys(m.message || {})[0] || 'unknown',
    timestamp: Number(m.messageTimestamp) || 0,
    author:    isJidGroup(chatId)
      ? (m.pushName || resolveName(accountId, m.key.participant || '', m.pushName))
      : null,
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
