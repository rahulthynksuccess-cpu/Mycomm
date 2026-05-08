/**
 * WhatsApp service — @whiskeysockets/baileys v6.7.x
 * Fixes:
 *  (1) Contact names — saved name > pushName > phone number
 *  (2) All chats showing — no artificial caps, DB cache + live sync
 *  (3) Latest messages — per-chat DB keys, always newest on open, scroll-up for older
 *  (4) Chat loading race — HTTP /chats endpoint reads from chatMap + DB fallback
 */

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  isJidGroup,
} = require('@whiskeysockets/baileys');

const { usePostgresAuthState, getAllAccountIds, removeAccountRegistry } = require('./pgAuthState');
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
const historySyncDone = {};

const MAX_ACCOUNTS     = parseInt(process.env.WA_MAX_ACCOUNTS || '5');
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
  const m = msg && msg.message;
  if (!m) return '';
  return m.conversation
    || (m.extendedTextMessage && m.extendedTextMessage.text)
    || (m.imageMessage && m.imageMessage.caption)
    || (m.videoMessage && m.videoMessage.caption)
    || (m.documentMessage && m.documentMessage.caption)
    || (m.audioMessage && '🎵 Audio')
    || (m.stickerMessage && '🎨 Sticker')
    || (m.locationMessage && '📍 Location')
    || (m.contactMessage && m.contactMessage.displayName && ('👤 ' + m.contactMessage.displayName))
    || (m.templateMessage && m.templateMessage.hydratedTemplate && m.templateMessage.hydratedTemplate.hydratedContentText)
    || (m.templateMessage && '📋 Template message')
    || (m.interactiveMessage && m.interactiveMessage.body && m.interactiveMessage.body.text)
    || (m.interactiveMessage && '📋 Interactive message')
    || (m.buttonsMessage && m.buttonsMessage.contentText)
    || (m.listMessage && m.listMessage.description)
    || (m.reactionMessage && ((m.reactionMessage.text || '👍') + ' Reaction'))
    || (m.pollCreationMessage && m.pollCreationMessage.name && ('📊 Poll: ' + m.pollCreationMessage.name))
    || (m.ephemeralMessage && extractBody({ message: m.ephemeralMessage.message }))
    || (m.viewOnceMessage && extractBody({ message: m.viewOnceMessage.message }))
    || '';
}

// Normalize JID — Baileys sometimes uses @c.us, API uses @s.whatsapp.net; treat as same
function normalizeJid(jid) {
  if (!jid) return jid;
  return jid.replace('@c.us', '@s.whatsapp.net').split(':')[0];
}

// FIX #1: Resolve display name — saved contact > pushName > phone number
// Tries both @s.whatsapp.net and @c.us variants so lookup always works
function resolveName(accountId, jid, fallback) {
  const map = contactMap[accountId];
  if (!map) return fallback || phoneFromJid(jid) || jid;

  // Try direct lookup, then normalized, then @c.us variant
  const variants = [
    jid,
    normalizeJid(jid),
    jid && jid.replace('@s.whatsapp.net', '@c.us'),
  ].filter(Boolean);

  let c = null;
  for (const v of variants) {
    c = map.get(v);
    if (c) break;
  }

  if (c && c.name && c.name.trim() && !/^\d+$/.test(c.name.trim()) && !c.name.includes('@')) {
    return c.name.trim();
  }
  if (c && c.notify && c.notify.trim() && !/^\d+$/.test(c.notify.trim()) && !c.notify.includes('@')) {
    return c.notify.trim();
  }
  if (fallback && typeof fallback === 'string' && fallback.trim()
      && !fallback.includes('@') && !fallback.includes(':')
      && !/^\d+$/.test(fallback.trim())) {
    return fallback.trim();
  }
  const phone = phoneFromJid(jid);
  return phone || jid;
}

function buildChatList(accountId, limit) {
  limit = limit || 1000;
  const map = chatMap[accountId];
  if (!map || map.size === 0) return [];
  return Array.from(map.values())
    .sort(function(a, b) { return (Number(b.conversationTimestamp) || 0) - (Number(a.conversationTimestamp) || 0); })
    .slice(0, limit)
    .map(function(chat) {
      return {
        id:              chat.id,
        name:            resolveName(accountId, chat.id, chat.name),
        lastMessage:     chat.lastMessage || '',
        lastMessageTime: Number(chat.conversationTimestamp) || 0,
        unreadCount:     chat.unreadCount || 0,
        isGroup:         isJidGroup(chat.id),
      };
    });
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
    console.log('[WA] Using Postgres auth for ' + accountId);
  } catch (e) {
    console.log('[WA] Using file auth for ' + accountId + ' (DB unavailable: ' + e.message + ')');
    const dir = path.join(SESSIONS_DIR, 'session-' + accountId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    ({ state, saveCreds } = await useMultiFileAuthState(dir));
    removeAll = async function() { fs.rmSync(dir, { recursive: true, force: true }); };
  }

  const version = await getWAVersion();

  const sock = makeWASocket({
    version: version,
    logger: logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    browser: ['MyComms', 'Chrome', '10.0'],
    syncFullHistory: true,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    getMessage: async function(key) {
      const msgs = (msgMap[accountId] && msgMap[accountId].get(key.remoteJid)) || [];
      const found = msgs.find(function(m) { return m.key && m.key.id === key.id; });
      return found ? found.message : undefined;
    },
  });

  clients[accountId] = sock;

  // ── Contact helpers ───────────────────────────────────────────────────────

  function storeContacts(list) {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!c.id) continue;
      const existing = contactMap[accountId].get(normalizeJid(c.id)) || {};
      const name   = ((c.name || c.verifiedName || existing.name || '')).trim();
      const notify = ((c.notify || c.pushName || existing.notify || '')).trim();
      if (name || notify) {
        const entry = { name: name, notify: notify };
        // Store under normalized JID (@s.whatsapp.net) so lookup always works
        contactMap[accountId].set(normalizeJid(c.id), entry);
        // Also store under @c.us variant for backwards compat
        if (c.id.includes('@s.whatsapp.net')) {
          contactMap[accountId].set(c.id.replace('@s.whatsapp.net', '@c.us'), entry);
        } else if (c.id.includes('@c.us')) {
          contactMap[accountId].set(c.id.replace('@c.us', '@s.whatsapp.net'), entry);
        }
      }
    }
  }

  function saveContactsToDb() {
    if (!pool) return;
    const obj = {};
    contactMap[accountId].forEach(function(c, jid) {
      // Only save @s.whatsapp.net keys to avoid duplicates in DB
      if (!jid.includes('@c.us')) obj[jid] = c;
    });
    pool.query(
      'INSERT INTO wa_sessions (account_id, key, value) VALUES ($1, \'contacts_cache\', $2)' +
      ' ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value',
      [accountId, JSON.stringify(obj)]
    ).catch(function() {});
  }

  // ── Chat helpers ──────────────────────────────────────────────────────────

  function storeChats(list) {
    if (!Array.isArray(list)) return;
    for (const chat of list) {
      if (!chat.id) continue;
      chatMap[accountId].set(chat.id, Object.assign({}, chatMap[accountId].get(chat.id) || {}, chat));
    }
  }

  function pushChats() {
    const list = buildChatList(accountId, 1000);
    if (list.length === 0) return;
    io.emit('wa:chats', { accountId: accountId, chats: list });
    if (pool) {
      pool.query(
        'INSERT INTO wa_sessions (account_id, key, value) VALUES ($1, \'chats_cache\', $2)' +
        ' ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value',
        [accountId, JSON.stringify(list)]
      ).catch(function() {});
    }
  }

  // FIX #3: Write per-chat message keys so getChatMessages can find them reliably
  function savePerChatMsgKeys() {
    if (!pool) return;
    msgMap[accountId].forEach(function(msgs, jid) {
      const sorted = msgs.slice().sort(function(a, b) {
        return Number(a.messageTimestamp) - Number(b.messageTimestamp);
      });
      const trimmed = sorted.slice(-MSG_MEMORY_LIMIT);
      pool.query(
        'INSERT INTO wa_sessions (account_id, key, value) VALUES ($1, $2, $3)' +
        ' ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value',
        [accountId, 'msgs_' + jid, JSON.stringify(trimmed)]
      ).catch(function() {});
    });
  }

  // ── Load cached data from DB at startup ───────────────────────────────────
  // FIX #4: Load contacts + chats + per-chat message keys; rebuild chatMap so
  //         the HTTP /chats endpoint works immediately (before socket reconnects)
  if (pool) {
    pool.query(
      'SELECT key, value FROM wa_sessions WHERE account_id = $1 AND (key IN (\'contacts_cache\',\'chats_cache\') OR key LIKE \'msgs_%\')',
      [accountId]
    ).then(function(res) {
      // Pass 1: contacts
      for (const row of res.rows) {
        if (row.key === 'contacts_cache') {
          try {
            const cached = JSON.parse(row.value);
            Object.entries(cached).forEach(function(entry) {
              const jid = entry[0];
              const c   = entry[1];
              const norm = normalizeJid(jid);
              contactMap[accountId].set(norm, c);
              // Also store @c.us variant so both formats resolve
              contactMap[accountId].set(norm.replace('@s.whatsapp.net', '@c.us'), c);
            });
            console.log('[WA] Loaded ' + Object.keys(cached).length + ' contacts from cache for ' + accountId);
          } catch (_) {}
        }
      }
      // Pass 2: chats — rebuild chatMap
      for (const row of res.rows) {
        if (row.key === 'chats_cache') {
          try {
            const cached = JSON.parse(row.value);
            if (cached && cached.length) {
              for (const c of cached) {
                chatMap[accountId].set(c.id, {
                  id: c.id,
                  name: c.name,
                  conversationTimestamp: c.lastMessageTime,
                  lastMessage: c.lastMessage || '',
                  unreadCount: c.unreadCount || 0,
                });
              }
              // Emit with freshly resolved names
              const resolved = buildChatList(accountId, 1000);
              if (resolved.length > 0) {
                io.emit('wa:chats', { accountId: accountId, chats: resolved });
              }
              console.log('[WA] Loaded ' + cached.length + ' chats from DB cache for ' + accountId);
            }
          } catch (_) {}
        }
        // Pass 3: per-chat message keys
        if (row.key.indexOf('msgs_') === 0) {
          try {
            const jid = row.key.slice(5);
            const msgs = JSON.parse(row.value);
            if (Array.isArray(msgs) && msgs.length) {
              msgMap[accountId].set(jid, msgs);
            }
          } catch (_) {}
        }
      }
    }).catch(function(e) {
      console.error('[WA] Cache load error for ' + accountId + ':', e.message);
    });
  }

  // ── Socket events ──────────────────────────────────────────────────────────

  sock.ev.on('connection.update', async function(update) {
    const connection     = update.connection;
    const lastDisconnect = update.lastDisconnect;
    const qr             = update.qr;

    if (qr) {
      emitStatus(io, accountId, { status: 'qr' });
      const qrDataUrl = await qrcode.toDataURL(qr).catch(function() { return null; });
      if (qrDataUrl) io.emit('wa:qr', { accountId: accountId, qr: qrDataUrl });
    }

    if (connection === 'open') {
      const phone = phoneFromJid((sock.user && sock.user.id) || '');
      const name  = (sock.user && sock.user.name) || accountId;
      console.log('[WA] ' + accountId + ' ready — ' + phone);
      io.emit('wa:qr', { accountId: accountId, qr: null });
      emitStatus(io, accountId, { status: 'ready', phone: phone, name: name });

      // Push chats at staggered intervals — history sync arrives over several seconds
      [1000, 3000, 8000, 15000, 30000, 60000].forEach(function(delay) {
        setTimeout(pushChats, delay);
      });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect && lastDisconnect.error instanceof Boom)
        ? lastDisconnect.error.output && lastDisconnect.error.output.statusCode
        : null;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;  // 401 — user logged out from phone

      // IMPORTANT: Never treat badSession as permanent — it can fire on network issues.
      // Only wipe creds on confirmed 401 logout. Everything else: reconnect.
      const badSession = statusCode === DisconnectReason.badSession;

      delete clients[accountId];

      if (loggedOut) {
        // Confirmed logout from phone — safe to wipe creds
        await removeAll().catch(function() {});
        delete chatMap[accountId];
        delete msgMap[accountId];
        delete contactMap[accountId];
        emitStatus(io, accountId, { status: 'auth_failure', error: 'Logged out from phone — re-scan QR' });
      } else if (badSession) {
        // Bad session can be a transient error — DON'T wipe creds, just reconnect
        console.log('[WA] Bad session for ' + accountId + ', reconnecting (NOT wiping creds)...');
        emitStatus(io, accountId, { status: 'disconnected', reason: 'bad_session' });
        setTimeout(function() {
          if (!clients[accountId]) createClient(accountId, io).catch(console.error);
        }, 5000);
      } else {
        emitStatus(io, accountId, { status: 'disconnected', reason: String(statusCode) });
        const delay = statusCode === DisconnectReason.restartRequired ? 2000 : 8000;
        setTimeout(function() {
          if (!clients[accountId]) createClient(accountId, io).catch(console.error);
        }, delay);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('contacts.upsert', function(cs) { storeContacts(cs); saveContactsToDb(); pushChats(); });
  sock.ev.on('contacts.update', function(cs) { storeContacts(cs); saveContactsToDb(); pushChats(); });
  // contacts.set fires once with ALL contacts — most important for name resolution
  sock.ev.on('contacts.set',   function(payload) {
    const list = payload.contacts || payload;
    storeContacts(Array.isArray(list) ? list : []);
    saveContactsToDb();
    // Re-push chats now that all names are resolved
    setTimeout(pushChats, 200);
    setTimeout(pushChats, 2000);
  });

  sock.ev.on('chats.upsert', function(cs) { storeChats(cs); pushChats(); });
  sock.ev.on('chats.update', function(cs) { storeChats(cs); pushChats(); });
  sock.ev.on('chats.set',    function(cs) { storeChats(cs.chats || []); pushChats(); });

  // ── History sync ──────────────────────────────────────────────────────────
  // messaging-history.set delivers chat metadata + STUB messages (msg.message=undefined).
  // Stubs tell us the chat exists and its last-message timestamp — store chats but not stubs.
  // Real message content arrives via messages.upsert with type='append'/'notify'.
  sock.ev.on('messaging-history.set', function(payload) {
    const hc       = payload.chats;
    const hct      = payload.contacts;
    const hm       = payload.messages;
    const isLatest = payload.isLatest;

    if (hct && hct.length) { storeContacts(hct); saveContactsToDb(); }
    if (hc  && hc.length)  { storeChats(hc); }

    // Only store messages that have actual content (not stubs)
    if (hm && hm.length) {
      let stored = 0;
      for (const msg of hm) {
        const jid = msg.key && msg.key.remoteJid;
        if (!jid) continue;
        // Accept messages with real content OR with a body we can extract
        const body = extractBody(msg);
        if (!body && !msg.message) continue;  // pure stub — skip
        if (!msgMap[accountId].has(jid)) msgMap[accountId].set(jid, []);
        const arr = msgMap[accountId].get(jid);
        if (!arr.find(function(m) { return m.key && m.key.id === msg.key.id; })) {
          arr.push(msg);
          stored++;
        }
      }
      if (stored > 0) {
        msgMap[accountId].forEach(function(msgs) {
          msgs.sort(function(a, b) { return Number(a.messageTimestamp) - Number(b.messageTimestamp); });
          if (msgs.length > MSG_MEMORY_LIMIT) msgs.splice(0, msgs.length - MSG_MEMORY_LIMIT);
        });
        savePerChatMsgKeys();
        console.log('[WA] History: stored ' + stored + ' messages for ' + accountId);
      }
    }

    if (isLatest) {
      historySyncDone[accountId] = true;
      console.log('[WA] Full history sync complete for ' + accountId);
    }

    setTimeout(pushChats, 500);
  });

  // ── Incoming & historical messages via messages.upsert ────────────────────
  // type='notify'  → new real-time message
  // type='append'  → historical messages delivered after history sync
  // type='history' → also historical (some Baileys versions)
  // We store ALL types; only emit wa:message for new inbound (notify, not fromMe)
  const SKIP_TYPES = new Set([
    'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo',
    'appStateSyncKeyShare', 'reaction', 'pollUpdateMessage',
  ]);

  // Debounce DB writes for history batches — avoid flooding Postgres
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function() { savePerChatMsgKeys(); }, 1500);
  }

  sock.ev.on('messages.upsert', function(payload) {
    const msgs = payload.messages;
    const type = payload.type;  // 'notify' | 'append' | 'history'
    let changed = false;

    for (const msg of msgs) {
      const jid = (msg.key && msg.key.remoteJid) || '';
      if (!jid) continue;

      // Status broadcast JIDs — ignore
      if (jid === 'status@broadcast') continue;

      const msgType = Object.keys(msg.message || {})[0];

      // Skip protocol noise — but only if it has no extractable body
      if (msg.message && SKIP_TYPES.has(msgType)) continue;

      // Must have some content
      const body = extractBody(msg);
      if (!body && !msg.message) continue;

      if (!msgMap[accountId].has(jid)) msgMap[accountId].set(jid, []);
      const arr = msgMap[accountId].get(jid);
      if (!arr.find(function(m) { return m.key && m.key.id === msg.key.id; })) {
        arr.push(msg);
        if (arr.length > MSG_MEMORY_LIMIT) arr.splice(0, arr.length - MSG_MEMORY_LIMIT);
        changed = true;
      }

      // Update chat metadata with latest message info
      const existing = chatMap[accountId].get(jid) || { id: jid };
      const existingTs = Number(existing.conversationTimestamp) || 0;
      const msgTs = Number(msg.messageTimestamp) || 0;
      if (msgTs >= existingTs || !existing.lastMessage) {
        chatMap[accountId].set(jid, Object.assign({}, existing, {
          conversationTimestamp: msg.messageTimestamp,
          lastMessage: body || existing.lastMessage || '',
        }));
      }

      // Capture pushName
      if (msg.pushName && msg.pushName.trim()) {
        const ec = contactMap[accountId].get(jid) || {};
        if (!ec.name) {
          contactMap[accountId].set(jid, Object.assign({}, ec, { notify: msg.pushName.trim() }));
        }
      }

      // Emit new inbound message notification
      if (type === 'notify' && !(msg.key && msg.key.fromMe)) {
        io.emit('wa:message', {
          accountId:   accountId,
          id:          msg.key.id,
          chatId:      jid,
          from:        resolveName(accountId, jid, msg.pushName),
          fromNumber:  jid,
          body:        body,
          type:        msgType || 'unknown',
          timestamp:   msgTs || Math.floor(Date.now() / 1000),
          isGroup:     isJidGroup(jid),
          chatName:    resolveName(accountId, jid, msg.pushName),
          hasMedia:    !!(msg.message && (
                         msg.message.imageMessage || msg.message.videoMessage ||
                         msg.message.audioMessage || msg.message.documentMessage)),
        });
      }
    }

    if (changed) {
      if (type === 'notify') {
        // Immediate save + push for real-time messages
        for (const jid of new Set(msgs.map(function(m) { return m.key && m.key.remoteJid; }).filter(Boolean))) {
          if (pool) {
            const chatMsgs = (msgMap[accountId].get(jid) || []).slice(-MSG_MEMORY_LIMIT);
            pool.query(
              'INSERT INTO wa_sessions (account_id, key, value) VALUES ($1, $2, $3)' +
              ' ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value',
              [accountId, 'msgs_' + jid, JSON.stringify(chatMsgs)]
            ).catch(function() {});
          }
        }
        pushChats();
      } else {
        // Debounced save for historical batches
        scheduleSave();
        setTimeout(pushChats, 1000);
      }
    }
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

async function initWhatsApp(io) {
  await getWAVersion().catch(function() {});
  const saved = await getSavedSessionIds();
  console.log('[WA] Restoring sessions:', saved);

  // Immediately set initializing status for ALL accounts so frontend shows them
  for (const id of saved) {
    statuses[id] = { status: 'initializing' };
  }

  for (let i = 0; i < saved.length; i++) {
    if (i > 0) await new Promise(function(r) { setTimeout(r, 3000); });
    await createClient(saved[i], io).catch(function(e) {
      console.error('[WA] Restore failed for', saved[i], e.message);
      statuses[saved[i]] = { status: 'error', error: e.message };
    });
  }
  console.log('[WA] Sessions restored');
}

async function addNewSession(accountId, io) {
  if (Object.keys(clients).length >= MAX_ACCOUNTS)
    throw new Error('Max ' + MAX_ACCOUNTS + ' accounts reached.');
  await createClient(accountId, io);
}

async function disconnectSession(accountId) {
  if (clients[accountId]) {
    try { clients[accountId].end(undefined); } catch (_) {}
    delete clients[accountId];
  }
  if (pool) {
    // Remove from registry — intentional user removal
    await removeAccountRegistry(accountId).catch(function() {});
    await pool.query('DELETE FROM wa_sessions WHERE account_id = $1', [accountId]).catch(function() {});
  }
  const dir = path.join(SESSIONS_DIR, 'session-' + accountId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  delete chatMap[accountId];
  delete msgMap[accountId];
  delete contactMap[accountId];
  delete statuses[accountId];
  delete historySyncDone[accountId];
}

async function sendWAMessage(accountId, to, body) {
  const sock = clients[accountId];
  if (!sock || (statuses[accountId] && statuses[accountId].status !== 'ready'))
    throw new Error('Account not ready.');
  const jid = to.includes('@') ? to : (to.replace(/\D/g, '') + '@s.whatsapp.net');
  await sock.sendMessage(jid, { text: body });
}

// FIX #4: Always try DB fallback if chatMap is empty (startup race condition)
async function getRecentChats(accountId, limit) {
  limit = limit || 1000;
  const live = buildChatList(accountId, limit);
  if (live.length > 0) return live;

  if (!pool) return [];
  try {
    // Load contacts first for correct name resolution
    if (!contactMap[accountId] || contactMap[accountId].size === 0) {
      const cr = await pool.query(
        'SELECT value FROM wa_sessions WHERE account_id = $1 AND key = \'contacts_cache\'',
        [accountId]
      );
      if (cr.rows.length) {
        if (!contactMap[accountId]) contactMap[accountId] = new Map();
        const cached = JSON.parse(cr.rows[0].value);
        Object.entries(cached).forEach(function(entry) {
          contactMap[accountId].set(entry[0], entry[1]);
        });
      }
    }
    const res = await pool.query(
      'SELECT value FROM wa_sessions WHERE account_id = $1 AND key = \'chats_cache\'',
      [accountId]
    );
    if (!res.rows.length) return [];
    const cached = JSON.parse(res.rows[0].value);
    if (!cached || !cached.length) return [];
    // Rebuild chatMap from cache so future in-memory calls also work
    if (!chatMap[accountId]) chatMap[accountId] = new Map();
    for (const c of cached) {
      if (!chatMap[accountId].has(c.id)) {
        chatMap[accountId].set(c.id, {
          id: c.id,
          name: c.name,
          conversationTimestamp: c.lastMessageTime,
          lastMessage: c.lastMessage || '',
          unreadCount: c.unreadCount || 0,
        });
      }
    }
    return buildChatList(accountId, limit);
  } catch (e) {
    console.error('[WA] getRecentChats DB fallback error:', e.message);
    return [];
  }
}

async function getChatMessages(accountId, chatId, limit) {
  limit = limit || 500;
  let msgs = (msgMap[accountId] && msgMap[accountId].get(chatId))
    ? msgMap[accountId].get(chatId).slice()
    : [];

  console.log('[WA] getChatMessages', accountId, chatId, '— in-memory:', msgs.length);

  if (msgs.length === 0 && pool) {
    try {
      // Try per-chat key first (most up-to-date)
      const perChatRes = await pool.query(
        'SELECT value FROM wa_sessions WHERE account_id = $1 AND key = $2',
        [accountId, 'msgs_' + chatId]
      );
      if (perChatRes.rows.length) {
        msgs = JSON.parse(perChatRes.rows[0].value) || [];
        console.log('[WA] getChatMessages loaded', msgs.length, 'from per-chat key for', chatId);
      }

      // Fallback: bulk msgs_cache
      if (msgs.length === 0) {
        const bulkRes = await pool.query(
          'SELECT value FROM wa_sessions WHERE account_id = $1 AND key = $2',
          [accountId, 'msgs_cache']
        );
        if (bulkRes.rows.length) {
          const allMsgs = JSON.parse(bulkRes.rows[0].value);
          msgs = (allMsgs && allMsgs[chatId]) || [];
          console.log('[WA] getChatMessages loaded', msgs.length, 'from bulk cache for', chatId);
        }
      }

      if (msgs.length && msgMap[accountId]) {
        msgs.sort(function(a, b) { return Number(a.messageTimestamp) - Number(b.messageTimestamp); });
        msgMap[accountId].set(chatId, msgs);
      }
    } catch (e) {
      console.error('[WA] getChatMessages DB error:', e.message);
    }
  }

  console.log('[WA] getChatMessages returning', Math.min(msgs.length, limit), 'of', msgs.length, 'msgs for', chatId);

  msgs.sort(function(a, b) { return Number(a.messageTimestamp) - Number(b.messageTimestamp); });

  return msgs.slice(-limit).map(function(m) {
    return {
      id:        m.key.id,
      body:      extractBody(m),
      fromMe:    (m.key && m.key.fromMe) || false,
      type:      Object.keys(m.message || {})[0] || 'unknown',
      timestamp: Number(m.messageTimestamp) || 0,
      author:    (m.key && m.key.participant) || null,
    };
  });
}

function getStatuses() {
  // Include all registered accounts, even ones still initializing
  const result = Object.assign({}, statuses);
  return result;
}

// Called at startup to ensure all registered accounts appear in status
async function ensureAllAccountsInStatus(io) {
  if (!pool) return;
  try {
    const ids = await getAllAccountIds();
    for (const id of ids) {
      if (!statuses[id]) {
        statuses[id] = { status: 'initializing' };
        io.emit('wa:status', { accountId: id, status: 'initializing' });
      }
    }
  } catch (_) {}
}

async function getSavedSessionIds() {
  if (pool) {
    for (let i = 0; i < 10; i++) {
      try {
        // PRIMARY: use wa_accounts registry — survives session data wipes
        let ids = await getAllAccountIds();
        if (ids.length > 0) {
          console.log('[WA] Loaded session IDs from wa_accounts registry:', ids);
          return ids;
        }
        // FALLBACK: old method — scan wa_sessions for creds keys
        const res = await pool.query(
          "SELECT DISTINCT account_id FROM wa_sessions WHERE key = 'creds'"
        );
        ids = res.rows.map(function(r) { return r.account_id; });
        if (ids.length > 0) {
          console.log('[WA] Loaded session IDs from wa_sessions (legacy):', ids);
          // Migrate them into wa_accounts so future restarts use the registry
          for (const id of ids) {
            await pool.query(
              'INSERT INTO wa_accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING',
              [id]
            ).catch(function() {});
          }
          return ids;
        }
        return [];
      } catch (e) {
        console.log('[WA] DB not ready yet, retrying (' + (i+1) + '/10)...');
        await new Promise(function(r) { setTimeout(r, 3000); });
      }
    }
  }
  // File fallback
  console.log('[WA] Loading session IDs from files');
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(function(d) {
      if (!d.startsWith('session-')) return false;
      return fs.existsSync(path.join(SESSIONS_DIR, d, 'creds.json'));
    })
    .map(function(d) { return d.replace('session-', ''); });
}

module.exports = {
  initWhatsApp, addNewSession, sendWAMessage,
  getRecentChats, getChatMessages, disconnectSession, getStatuses,
};
