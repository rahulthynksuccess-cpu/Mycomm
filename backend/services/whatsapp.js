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
  // Ignore any fallback that looks like a JID
  const safeFallback = (fallback && !fallback.includes('@') && !fallback.includes(':')) ? fallback.trim() : null;
  const name = c?.name || c?.notify || safeFallback;
  // Return name if it looks like a real name (not just digits)
  if (name && !/^\d+$/.test(name)) return name;
  // Fall back to phone number
  return phone || jid;
}

function buildChatList(accountId, limit = 500) {
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
    // Required for history sync — Baileys calls this to decrypt older messages
    getMessage: async (key) => {
      const jid = key.remoteJid;
      const msgs = msgMap[accountId]?.get(jid) || [];
      const found = msgs.find(m => m.key.id === key.id);
      return found?.message || { conversation: '' };
    },
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

      // Push chats at intervals — history sync can take time
      [1000, 3000, 6000, 12000, 25000, 45000].forEach(delay => {
        setTimeout(() => pushChats(), delay);
      });
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

  function saveContactsToDb() {
    if (!pool) return;
    const obj = {};
    for (const [jid, c] of contactMap[accountId]) obj[jid] = c;
    pool.query(
      `INSERT INTO wa_sessions (account_id, key, value) VALUES ($1, 'contacts_cache', $2)
       ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [accountId, JSON.stringify(obj)]
    ).catch(() => {});
  }

  sock.ev.on('contacts.upsert', (cs) => { storeContacts(cs); saveContactsToDb(); pushChats(); });
  sock.ev.on('contacts.update', (cs) => { storeContacts(cs); saveContactsToDb(); pushChats(); });

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
    if (list.length > 0) {
      io.emit('wa:chats', { accountId, chats: list });
      // Save to DB cache — only when list has meaningful size (>5 chats)
      // This prevents a single new message from overwriting the full cache with 1 chat
      if (pool && list.length > 0) {
        pool.query(
          `INSERT INTO wa_sessions (account_id, key, value)
           VALUES ($1, 'chats_cache', $2)
           ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [accountId, JSON.stringify(list)]
        ).catch(() => {});
      }
    }
  }

  // Load chats and messages from DB cache immediately on start
  if (pool) {
    pool.query(
      "SELECT key, value FROM wa_sessions WHERE account_id = $1 AND key IN ('chats_cache','msgs_cache','contacts_cache')",
      [accountId]
    ).then(res => {
      for (const row of res.rows) {
        if (row.key === 'chats_cache') {
          const cached = JSON.parse(row.value);
          if (cached?.length) {
            io.emit('wa:chats', { accountId, chats: cached });
            console.log(`[WA] Loaded ${cached.length} chats from DB cache for ${accountId}`);
          }
        }
        if (row.key === 'msgs_cache') {
          const cached = JSON.parse(row.value);
          for (const [jid, msgs] of Object.entries(cached)) {
            msgMap[accountId].set(jid, msgs);
          }
          console.log(`[WA] Loaded messages cache for ${accountId}`);
        }
        if (row.key === 'contacts_cache') {
          const cached = JSON.parse(row.value);
          for (const [jid, c] of Object.entries(cached)) {
            contactMap[accountId].set(jid, c);
          }
          console.log(`[WA] Loaded contacts cache for ${accountId}`);
        }
      }
    }).catch(() => {});
  }

  sock.ev.on('chats.upsert', (cs) => { storeChats(cs); pushChats(); });
  sock.ev.on('chats.update', (cs) => { storeChats(cs); pushChats(); });
  sock.ev.on('chats.set',    (cs) => { storeChats(cs.chats || []); pushChats(); });

  // ── History sync: contacts FIRST then chats ────────
  sock.ev.on('messaging-history.set', ({ chats: hc, contacts: hct, messages: hm }) => {
    if (hct?.length) storeContacts(hct);
    if (hc?.length)  storeChats(hc);
    if (hm?.length) {
      const byChat = {};
      for (const msg of hm) {
        const jid = msg.key?.remoteJid;
        if (!jid || !msg.message) continue;
        if (!msgMap[accountId].has(jid)) msgMap[accountId].set(jid, []);
        msgMap[accountId].get(jid).push(msg);
        byChat[jid] = true;
      }
      // Sort each chat's messages by timestamp
      for (const [jid] of Object.entries(byChat)) {
        const msgs = msgMap[accountId].get(jid) || [];
        msgs.sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
      }
      // Save messages to DB cache
      if (pool) {
        const allMsgs = {};
        for (const [jid, msgs] of msgMap[accountId]) {
          allMsgs[jid] = msgs.slice(-200);
        }
        pool.query(
          `INSERT INTO wa_sessions (account_id, key, value) VALUES ($1, 'msgs_cache', $2)
           ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [accountId, JSON.stringify(allMsgs)]
        ).catch(() => {});
      }
    }
    setTimeout(() => pushChats(), 2000);
  });

  // ── Incoming messages ──────────────────────────────
  // Message types that are internal WhatsApp protocol — never show to user
  const SKIP_TYPES = new Set([
    'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo',
    'appStateSyncKeyShare', 'reaction', 'pollUpdateMessage',
  ]);

  sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      const jid = msg.key.remoteJid || '';
      if (!jid) continue;
      // Skip protocol/system messages
      const msgType = Object.keys(msg.message || {})[0];
      if (!msg.message || SKIP_TYPES.has(msgType)) continue;

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

      // Save updated messages for this chat to DB
      if (pool) {
        const chatMsgs = (msgMap[accountId].get(jid) || []).slice(-200);
        pool.query(
          `INSERT INTO wa_sessions (account_id, key, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [accountId, `msgs_${jid}`, JSON.stringify(chatMsgs)]
        ).catch(() => {});
      }

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

  // If no cached messages, try loading from DB (per-chat first, then full blob)
  if (msgs.length === 0 && pool) {
    try {
      // Try per-chat key first (most recent save)
      let res = await pool.query(
        "SELECT value FROM wa_sessions WHERE account_id = $1 AND key = $2",
        [accountId, `msgs_${chatId}`]
      );
      if (res.rows.length) {
        msgs = JSON.parse(res.rows[0].value);
        if (msgs.length) msgMap[accountId].set(chatId, msgs);
      }
      // Fall back to full msgs_cache blob
      if (!msgs.length) {
        res = await pool.query(
          "SELECT value FROM wa_sessions WHERE account_id = $1 AND key = 'msgs_cache'",
          [accountId]
        );
        if (res.rows.length) {
          const allMsgs = JSON.parse(res.rows[0].value);
          msgs = allMsgs[chatId] || [];
          if (msgs.length) msgMap[accountId].set(chatId, msgs);
        }
      }
    } catch (e) {}
  }



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
