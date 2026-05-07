// File: backend/services/whatsapp.js

/**
 * WhatsApp service — @whiskeysockets/baileys
 * FINAL STABLE VERSION
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
const { pool } = require('./db');

const { Boom } = require('@hapi/boom');

const pino = require('pino');
const qrcode = require('qrcode');

const fs = require('fs');
const path = require('path');

const logger = pino({ level: 'silent' });

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const clients = {};
const statuses = {};
const chatMap = {};
const msgMap = {};
const contactMap = {};

let _waVersion = null;

async function getWAVersion() {
  if (!_waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    _waVersion = version;
  }

  return _waVersion;
}

function emitStatus(io, accountId, fields) {
  statuses[accountId] = {
    ...(statuses[accountId] || {}),
    ...fields,
  };

  io.emit('wa:status', {
    accountId,
    ...statuses[accountId],
  });
}

function phoneFromJid(jid = '') {
  return jid
    .split('@')[0]
    .split(':')[0]
    .replace(/[^0-9]/g, '');
}

function extractBody(msg) {
  const m = msg?.message;

  if (!m) return '';

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    (m.audioMessage && '🎵 Audio') ||
    (m.stickerMessage && '🎨 Sticker') ||
    (m.locationMessage && '📍 Location') ||
    (m.contactMessage?.displayName &&
      `👤 ${m.contactMessage.displayName}`) ||
    m.templateMessage?.hydratedTemplate?.hydratedContentText ||
    m.buttonsMessage?.contentText ||
    m.listMessage?.description ||
    (m.reactionMessage &&
      `${m.reactionMessage.text || '👍'} Reaction`) ||
    ''
  );
}

function resolveName(accountId, jid, fallback) {
  const c = contactMap[accountId]?.get(jid);

  const phone = phoneFromJid(jid);

  const safeFallback =
    fallback &&
    !fallback.includes('@') &&
    !fallback.includes(':')
      ? fallback.trim()
      : null;

  const name =
    c?.name ||
    c?.notify ||
    safeFallback;

  if (name && !/^\d+$/.test(name)) {
    return name;
  }

  return phone || jid;
}

function buildChatList(accountId, limit = 5000) {
  const map = chatMap[accountId];

  if (!map || map.size === 0) {
    return [];
  }

  return [...map.values()]
    .sort(
      (a, b) =>
        (Number(b.conversationTimestamp) || 0) -
        (Number(a.conversationTimestamp) || 0)
    )
    .slice(0, limit)
    .map(chat => ({
      id: chat.id,
      name: resolveName(accountId, chat.id, chat.name),
      lastMessage: chat.lastMessage || '',
      lastMessageTime:
        Number(chat.conversationTimestamp) || 0,
      unreadCount: chat.unreadCount || 0,
      isGroup: isJidGroup(chat.id),
    }));
}

async function createClient(accountId, io) {
  // Prevent duplicate sessions
  if (clients[accountId]) {
    console.log(
      `[WA] Client already exists for ${accountId}`
    );

    return clients[accountId];
  }

  chatMap[accountId] = new Map();
  msgMap[accountId] = new Map();
  contactMap[accountId] = new Map();

  emitStatus(io, accountId, {
    status: 'initializing',
    phone: undefined,
    name: undefined,
    error: undefined,
    reason: undefined,
  });

  let state;
  let saveCreds;
  let removeAll;

  try {
    await pool.query('SELECT 1');

    ({
      state,
      saveCreds,
      removeAll,
    } = await usePostgresAuthState(accountId));

    console.log(
      `[WA] Using Postgres auth for ${accountId}`
    );
  } catch (e) {
    console.log(
      `[WA] Using file auth for ${accountId}`
    );

    const dir = path.join(
      SESSIONS_DIR,
      `session-${accountId}`
    );

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    ({
      state,
      saveCreds,
    } = await useMultiFileAuthState(dir));

    removeAll = async () =>
      fs.rmSync(dir, {
        recursive: true,
        force: true,
      });
  }

  const version = await getWAVersion();

  const sock = makeWASocket({
    version,

    logger,

    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        logger
      ),
    },

    browser: ['MyComms', 'Chrome', '10.0'],

    printQRInTerminal: false,

    syncFullHistory: true,

    fireInitQueries: true,

    shouldSyncHistoryMessage: () => true,

    markOnlineOnConnect: true,

    connectTimeoutMs: 60000,

    keepAliveIntervalMs: 25000,
  });

  clients[accountId] = sock;

  function pushChats() {
    const list = buildChatList(accountId);

    io.emit('wa:chats', {
      accountId,
      chats: list,
    });

    if (pool && list.length > 0) {
      pool
        .query(
          `
          INSERT INTO wa_sessions
          (account_id, key, value)
          VALUES ($1, 'chats_cache', $2)

          ON CONFLICT (account_id, key)
          DO UPDATE SET value = EXCLUDED.value
          `,
          [accountId, JSON.stringify(list)]
        )
        .catch(() => {});
    }
  }

  sock.ev.on(
    'connection.update',
    async update => {
      const {
        connection,
        lastDisconnect,
        qr,
      } = update;

      if (qr) {
        emitStatus(io, accountId, {
          status: 'qr',
        });

        const qrDataUrl =
          await qrcode
            .toDataURL(qr)
            .catch(() => null);

        if (qrDataUrl) {
          io.emit('wa:qr', {
            accountId,
            qr: qrDataUrl,
          });
        }
      }

      if (connection === 'open') {
        const phone = phoneFromJid(
          sock.user?.id || ''
        );

        const name =
          sock.user?.name || accountId;

        console.log(
          `[WA] ${accountId} ready — ${phone}`
        );

        io.emit('wa:qr', {
          accountId,
          qr: null,
        });

        emitStatus(io, accountId, {
          status: 'ready',
          phone,
          name,
        });

        // Push repeatedly while sync completes
        [2000, 5000, 10000, 20000, 30000].forEach(
          delay => {
            setTimeout(() => {
              pushChats();
            }, delay);
          }
        );

        // Force chat sync
        setTimeout(async () => {
          try {
            const chats =
              await sock.fetchAllParticipating();

            console.log(
              `[WA] Full sync for ${accountId}:`,
              Object.keys(chats || {}).length
            );

            pushChats();
          } catch (e) {
            console.log(
              '[WA] Full sync failed:',
              e.message
            );
          }
        }, 7000);
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output
                ?.statusCode
            : null;

        const loggedOut =
          statusCode ===
          DisconnectReason.loggedOut;

        const badSession =
          statusCode ===
          DisconnectReason.badSession;

        delete clients[accountId];

        if (loggedOut || badSession) {
          await removeAll().catch(() => {});

          delete chatMap[accountId];
          delete msgMap[accountId];
          delete contactMap[accountId];

          emitStatus(io, accountId, {
            status: 'auth_failure',
            error: loggedOut
              ? 'Logged out from phone'
              : 'Bad session — re-scan QR',
          });
        } else {
          emitStatus(io, accountId, {
            status: 'disconnected',
            reason: String(statusCode),
          });

          // Auto reconnect
          setTimeout(() => {
            if (!clients[accountId]) {
              createClient(
                accountId,
                io
              ).catch(console.error);
            }
          }, 8000);
        }
      }
    }
  );

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on(
    'messages.upsert',
    async ({ messages }) => {
      for (const msg of messages || []) {
        const jid = msg.key.remoteJid;

        if (!jid) continue;

        const arr =
          msgMap[accountId].get(jid) || [];

        arr.push(msg);

        // Prevent memory leak
        if (arr.length > 300) {
          arr.splice(
            0,
            arr.length - 300
          );
        }

        msgMap[accountId].set(jid, arr);

        chatMap[accountId].set(jid, {
          ...(chatMap[accountId].get(jid) ||
            {}),

          id: jid,

          conversationTimestamp:
            msg.messageTimestamp ||
            Math.floor(Date.now() / 1000),

          lastMessage: extractBody(msg),
        });
      }

      pushChats();
    }
  );

  return sock;
}

function listStoredSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(SESSIONS_DIR)
    .filter(d => {
      if (!d.startsWith('session-')) {
        return false;
      }

      const accountId = d.replace(
        'session-',
        ''
      );

      // Ignore temp numeric folders
      if (/^\d+$/.test(accountId)) {
        return false;
      }

      // Ignore broken folders
      if (
        !accountId ||
        accountId === 'undefined' ||
        accountId === 'null' ||
        accountId.length < 5
      ) {
        return false;
      }

      return fs.existsSync(
        path.join(
          SESSIONS_DIR,
          d,
          'creds.json'
        )
      );
    })
    .map(d => d.replace('session-', ''));
}

module.exports = {
  createClient,
  clients,
  statuses,
  buildChatList,
  listStoredSessions,
};
