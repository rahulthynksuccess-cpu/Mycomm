/**
 * WhatsApp service — @whiskeysockets/baileys v6.7.x
 * Fixed: (1) contact names, (2) all chats showing, (3) latest messages
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

// Track whether full history sync is complete per account
const historySyncDone = {};

const MAX_ACCOUNTS = parseInt(process.env.WA_MAX_ACCOUNTS || '5');
// Keep up to 500 messages per chat in memory/DB
const MSG_MEMORY_LIMIT = 500;

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

/**
 * FIX #1: Improved name resolution
 * Priority: saved contact name > pushName/notify > phone number
 * Never shows raw JID strings.
 */
function resolveName(accountId, jid, fallback) {
  const c = contactMap[accountId]?.get(jid);

  // Best: saved contact name (from phone book sync)
  if (c && c.name && c.name.trim() && !/^\d+$/.test(c.name.trim()) && !c.name.includes('@')) {
    return c.name.trim();
  }
  // Second: notify/pushName (WhatsApp display name they set)
  if (c && c.notify && c.notify.trim() && !/^\d+$/.test(c.notify.trim()) && !c.notify.includes('@')) {
    return c.notify.trim();
  }
  // Third: fallback from chat/message (pushName at message time)
  if (fallback && typeof fallback === 'string' && fallback.trim()
      && !fallback.includes('@') && !fallback.includes(':')
      && !/^\d+$/.test(fallback.trim())) {
    return fallback.trim();
  }
  // Last resort: formatted phone number
  const phone = phoneFromJid(jid);
  return phone || jid;
}

/**
 * FIX #2: Build chat list with higher default limit, no artificial 500 cap.
 */
function buildChatList(accountId, limit = 1000) {
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
  historySyncDone[accountId] = false;

  emitStatus(io, accountId, {
    status: 'initializing', phone: undefined, name: undefined,
    error: undefined, reason: undefined,
  });

  let state, saveCreds, removeAll;
  try {
    if (!pool) throw new Error('No pool');
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
  const version = await getWAVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    browser: ['MyComms', 'Chrome', '10.0'],
    // FIX #3: Request full history sync
    syncFullHistory: true,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    getMessage: async (key) => {
      const msgs = msgMap[accountId]?.get(key.remoteJid) || [];
      const found = msgs.find(m => m.key && m.key.id === key.id);
      return found ? found.message : undefined;
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
      [2000, 5000, 10000, 20000, 40000].forEach(delay => {
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

  // ── FIX #1: Contacts — priority merging ───────────────────────
  function storeContacts(list) {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!c.id) continue;
      const existing = contactMap[accountId].get(c.id) || {};
      const name   = (c.name   || c.verifiedName || existing.name   || '').trim();
      const notify = (c.notify || c.pushName     || existing.notify || '').trim();
      // Always write — even partial is better than nothing
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
  function storeChats(list) {
    if (!Array.isArray(list)) return;
    for (const chat of list) {
      if (!chat.id) continue;
      chatMap[accountId].set(chat.id, {
        ...chatMap[accountId].get(chat.id),
        ...chat,
      });
    }
  }

  function pushChats() {
    const list = buildChatList(accountId, 1000);
    if (list.length > 0) {
      io.emit('wa:chats', { accountId, chats: list });
      if (pool) {
        pool.query(
          `INSERT INTO wa_sessions (account_id, key, value)
           VALUES ($1, 'chats_cache', $2)
           ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [accountId, JSON.stringify(list)]
        ).catch(() => {});
      }
    }
  }

  // Load cached data from DB immediately on start
  // FIX #1: Load contacts FIRST, then chats, so names resolve immediately
  if (pool) {
    pool.query(
      "SELECT key, value FROM wa_sessions WHERE account_id = $1 AND key IN ('chats_cache','msgs_cache','contacts_cache')",
      [accountId]
    ).then(res => {
      // Pass 1: contacts
      for (const row of res.rows) {
        if (row.key === 'contacts_cache') {
          const cached = JSON.parse(row.value);
          for (const [jid, c] of Object.entries(cached)) {
            contactMap[accountId].set(jid, c);
          }
          console.log(`[WA] Loaded ${Object.keys(cached).length} contacts from cache for ${accountId}`);
        }
      }
      // Pass 2: chats (now with contacts loaded, names resolve correctly)
      for (const row of res.rows) {
        if (row.key === 'chats_cache') {
          const cached = JSON.parse(row.value);
          if (cached && cached.length) {
            const resolved = cached.map(c => ({
              ...c,
              name: resolveName(accountId, c.id, c.name),
            }));
            io.emit('wa:chats', { accountId, chats: resolved });
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
      }
    }).catch(() => {});
  }

  sock.ev.on('chats.upsert', (cs) => { storeChats(cs); pushChats(); });
  sock.ev.on('chats.update', (cs) => { storeChats(cs); pushChats(); });
  sock.ev.on('chats.set',    (cs) => { storeChats(cs.chats || []); pushChats(); });

  // ── FIX #3: History sync — process contacts first, store ALL messages ────────
  sock.ev.on('messaging-history.set', ({ chats: hc, contacts: hct, messages: hm, isLatest }) => {
    // Contacts first so chat names work
    if (hct && hct.length) {
      storeContacts(hct);
      saveContactsToDb();
    }
    if (hc && hc.length) storeChats(hc);

    if (hm && hm.length) {
      for (const msg of hm) {
        const jid = msg.key && msg.key.remoteJid;
        if (!jid || !msg.message) continue;
        if (!msgMap[accountId].has(jid)) msgMap[accountId].set(jid, []);
        const arr = msgMap[accountId].get(jid);
        // No duplicates
        if (!arr.find(m => m.key && m.key.id === msg.key.id)) {
          arr.push(msg);
        }
      }
      // Sort each chat oldest→newest, trim to limit
      for (const [, msgs] of msgMap[accountId]) {
        msgs.sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
        if (msgs.length > MSG_MEMORY_LIMIT) msgs.splice(0, msgs.length - MSG_MEMORY_LIMIT);
      }
      // Persist to DB
      if (pool) {
        const allMsgs = {};
        for (const [jid, msgs] of msgMap[accountId]) {
          allMsgs[jid] = msgs.slice(-MSG_MEMORY_LIMIT);
        }
        pool.query(
          `INSERT INTO wa_sessions (account_id, key, value) VALUES ($1, 'msgs_cache', $2)
           ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [accountId, JSON.stringify(allMsgs)]
        ).catch(() => {});
      }
    }

    if (isLatest) {
      historySyncDone[accountId] = true;
      console.log(`[WA] Full history sync complete for ${accountId}`);
    }

    setTimeout(() => pushChats(), 1000);
  });

  // ── Incoming messages ──────────────────────────────
  const SKIP_TYPES = new Set([
    'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo',
    'appStateSyncKeyShare', 'reaction', 'pollUpdateMessage',
  ]);

  sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      const jid = msg.key.remoteJid || '';
      if (!jid) continue;
      const msgType = Object.keys(msg.message || {})[0];
      if (!msg.message || SKIP_TYPES.has(msgType)) continue;

      if (!msgMap[accountId].has(jid)) msgMap[accountId].set(jid, []);
      const arr = msgMap[accountId].get(jid);
      // No duplicates
      if (!arr.find(m => m.key && m.key.id === msg.key.id)) {
        arr.push(msg);
        if (arr.length > MSG_MEMORY_LIMIT) arr.splice(0, arr.length - MSG_MEMORY_LIMIT);
      }

      const existing = chatMap[accountId].get(jid) || { id: jid };
      chatMap[accountId].set(jid, {
        ...existing,
        conversationTimestamp: msg.messageTimestamp,
        lastMessage: extractBody(msg),
      });

      // FIX #1: Save pushName immediately in contactMap
      if (msg.pushName && msg.pushName.trim()) {
        const ec = contactMap[accountId].get(jid) || {};
        if (!ec.name) {
          contactMap[accountId].set(jid, { ...ec, notify: msg.pushName.trim() });
        }
      }

      if (pool) {
        const chatMsgs = (msgMap[accountId].get(jid) || []).slice(-MSG_MEMORY_LIMIT);
        pool.query(
          `INSERT INTO wa_sessions (account_id, key, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [accountId, `msgs_${jid}`, JSON.stringify(chatMsgs)]
        ).catch(() => {});
      }

      if (type === 'notify' && !msg.key.fromMe) {
        io.emit('wa:message', {
          accountId,
          id:          msg.key.id,
          chatId:      jid,
          from:        resolveName(accountId, jid, msg.pushName),
          fromNumber:  jid,
          body:        extractBody(msg),
          type:        msgType || 'unknown',
          timestamp:   Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
          isGroup:     isJidGroup(jid),
          chatName:    resolveName(accountId, jid, msg.pushName),
          hasMedia:    !!(msg.message && (msg.message.imageMessage || msg.message.videoMessage
                        || msg.message.audioMessage || msg.message.documentMessage)),
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
  if (dbAvailable && pool) {
    await pool.query('DELETE FROM wa_sessions WHERE account_id = $1', [accountId]).catch(() => {});
  }
  const dir = path.join(SESSIONS_DIR, `session-${accountId}`);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  delete chatMap[accountId];
  delete msgMap[accountId];
  delete contactMap[accountId];
  delete statuses[accountId];
  delete historySyncDone[accountId];
}

async function sendWAMessage(accountId, to, body) {
  const sock = clients[accountId];
  if (!sock || statuses[accountId]?.status !== 'ready')
    throw new Error('Account not ready.');
  const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: body });
}

async function getRecentChats(accountId, limit = 1000) {
  return buildChatList(accountId, limit);
}

/**
 * FIX #3: Return latest messages sorted oldest→newest.
 * Mirrors WhatsApp Web: open chat → see most recent messages, scroll up for older.
 */
async function getChatMessages(accountId, chatId, limit = 500) {
  let msgs = msgMap[accountId] && msgMap[accountId].get(chatId)
    ? msgMap[accountId].get(chatId).slice()
    : [];

  // Load from DB if not in memory
  if (msgs.length === 0 && pool) {
    try {
      let res = await pool.query(
        "SELECT value FROM wa_sessions WHERE account_id = $1 AND key = $2",
        [accountId, `msgs_${chatId}`]
      );
      if (res.rows.length) {
        msgs = JSON.parse(res.rows[0].value) || [];
        if (msgs.length && msgMap[accountId]) {
          msgs.sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
          msgMap[accountId].set(chatId, msgs);
        }
      }
      if (!msgs.length) {
        res = await pool.query(
          "SELECT value FROM wa_sessions WHERE account_id = $1 AND key = 'msgs_cache'",
          [accountId]
        );
        if (res.rows.length) {
          const allMsgs = JSON.parse(res.rows[0].value);
          msgs = (allMsgs && allMsgs[chatId]) || [];
          if (msgs.length && msgMap[accountId]) {
            msgs.sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
            msgMap[accountId].set(chatId, msgs);
          }
        }
      }
    } catch (e) {}
  }

  // Ensure sorted oldest→newest
  msgs.sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));

  // Return the LATEST `limit` messages (tail of sorted array)
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
