require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { initWhatsApp } = require('./services/whatsapp');
const emailRoutes = require('./routes/email');
const calendarRoutes = require('./routes/calendar');
const whatsappRoutes = require('./routes/whatsapp');
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);

// ─── Socket.io (real-time events to frontend) ──────────
const io = new Server(server, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'http://localhost:3000',
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Make io accessible to routes
app.set('io', io);

// ─── Middleware ────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:3000',
  ],
  credentials: true,
}));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({ windowMs: 60 * 1000, max: 200 });
app.use('/api/', limiter);

// ─── Routes ────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/whatsapp', whatsappRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ─── Socket.io connection ──────────────────────────────
io.on('connection', (socket) => {
  console.log('Frontend connected:', socket.id);

  socket.on('wa:send', async ({ accountId, to, body }) => {
    try {
      const { sendWAMessage } = require('./services/whatsapp');
      await sendWAMessage(accountId, to, body);
      socket.emit('wa:sent', { success: true, accountId, to });
    } catch (err) {
      socket.emit('wa:error', { accountId, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Frontend disconnected:', socket.id);
  });
});

// ─── Boot ──────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, async () => {
  console.log(`\n🚀 MyComms backend running on port ${PORT}`);
  console.log(`   Frontend origin: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);

  // Start WhatsApp sessions
  console.log('\n📱 Initializing WhatsApp sessions...');
  await initWhatsApp(io);
});

module.exports = { app, io };
