require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');
const path   = require('path');

const app    = express();
const server = http.createServer(app);

// Health check — must respond immediately, before any async work
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date() }));

const PORT = process.env.PORT || 4000;

// ── Socket.io ──────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE', 'PATCH'] },
});
app.set('io', io);

// ── Middleware ─────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Routes ─────────────────────────────────────────────
const safeLoad = (label, fn) => {
  try { fn(); console.log('✓', label); }
  catch (e) { console.error('✗', label, e.message); }
};

safeLoad('Auth routes',      () => app.use('/auth',          require('./routes/auth')));
safeLoad('Zoho auth routes', () => app.use('/auth/zoho',      require('./routes/zohoAuth')));
safeLoad('Email routes',     () => app.use('/api/email',     require('./routes/email')));
safeLoad('Calendar routes',  () => app.use('/api/calendar',  require('./routes/calendar')));
safeLoad('WhatsApp routes',  () => app.use('/api/whatsapp',  require('./routes/whatsapp')));

// ── Socket: replay current state on every new connection ──
io.on('connection', (socket) => {
  console.log('[socket] connected:', socket.id);

  // Immediately send all known WA statuses to this client.
  // This is the KEY fix: any page refresh instantly gets current state
  // without waiting for the next event.
  try {
    const { getStatuses } = require('./services/whatsapp');
    const statuses = getStatuses();
    Object.entries(statuses).forEach(([accountId, s]) => {
      socket.emit('wa:status', { accountId, ...s });
    });
  } catch (_) {}

  socket.on('disconnect', () => console.log('[socket] disconnected:', socket.id));
});

// ── Serve React build (same-origin deploy) ─────────────
const frontendBuild = path.join(__dirname, '../frontend/build');
app.use(express.static(frontendBuild));
app.get('*', (_req, res) => res.sendFile(path.join(frontendBuild, 'index.html')));

// ── Start ──────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n MyComms running on port ${PORT}\n`);
  try {
    const { initWhatsApp } = require('./services/whatsapp');
    await initWhatsApp(io);
    console.log('[WA] Sessions restored');
  } catch (e) {
    console.error('[WA] Init error (server still up):', e.message);
  }
});

module.exports = { app, io };
