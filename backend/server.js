require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ── Health check first — before anything else ──────────
// This must respond even if other services fail to load
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 4000;

// ── Socket.io ──────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
});
app.set('io', io);

// ── Middleware ─────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Routes (wrapped so one failure doesn't kill server) ─
try {
  const authRoutes = require('./routes/auth');
  app.use('/auth', authRoutes);
  console.log('✓ Auth routes loaded');
} catch (e) { console.error('✗ Auth routes failed:', e.message); }

try {
  const emailRoutes = require('./routes/email');
  app.use('/api/email', emailRoutes);
  console.log('✓ Email routes loaded');
} catch (e) { console.error('✗ Email routes failed:', e.message); }

try {
  const calendarRoutes = require('./routes/calendar');
  app.use('/api/calendar', calendarRoutes);
  console.log('✓ Calendar routes loaded');
} catch (e) { console.error('✗ Calendar routes failed:', e.message); }

try {
  const whatsappRoutes = require('./routes/whatsapp');
  app.use('/api/whatsapp', whatsappRoutes);
  console.log('✓ WhatsApp routes loaded');
} catch (e) { console.error('✗ WhatsApp routes failed:', e.message); }

// ── Socket.io events ───────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('wa:send', async ({ accountId, to, body }) => {
    try {
      const { sendWAMessage } = require('./services/whatsapp');
      await sendWAMessage(accountId, to, body);
      socket.emit('wa:sent', { success: true });
    } catch (err) {
      socket.emit('wa:error', { error: err.message });
    }
  });
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ── Start server ───────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n MyComms backend running on port', PORT);

  // Init WhatsApp after server is already up and healthy
  try {
    const { initWhatsApp } = require('./services/whatsapp');
    await initWhatsApp(io);
    console.log('WhatsApp service started');
  } catch (e) {
    console.error('WhatsApp init failed (server still running):', e.message);
  }
});

module.exports = { app, io };
