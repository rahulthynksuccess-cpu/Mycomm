import React, { useState, useEffect, useRef } from 'react';
import { waAPI } from '../../api';

export default function WhatsAppTab({ socket, statuses, qrCodes, realtimeMessages, setWaStatuses }) {
  const [chats, setChats] = useState({});
  const [activeAccount, setActiveAccount] = useState(null);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(false);
  const [addingSession, setAddingSession] = useState(false);
  const [newAccountId, setNewAccountId] = useState('');
  const [showQR, setShowQR] = useState(null);
  const [qrTimeout, setQrTimeout] = useState(false);
  const messagesEndRef = useRef(null);
  const qrTimerRef = useRef(null);

  const readyAccounts = Object.entries(statuses).filter(([, s]) => s.status === 'ready');

  useEffect(() => {
    if (!activeAccount) return;
    waAPI.getChats(activeAccount).then(c => {
      setChats(prev => ({ ...prev, [activeAccount]: c }));
    }).catch(console.error);
  }, [activeAccount]);

  useEffect(() => {
    if (!activeAccount && readyAccounts.length > 0) {
      setActiveAccount(readyAccounts[0][0]);
    }
  }, [statuses]);

  useEffect(() => {
    if (!realtimeMessages.length) return;
    const latest = realtimeMessages[0];
    if (latest.accountId === activeAccount && activeChat && latest.chatId === activeChat.id) {
      setMessages(prev => [...prev, {
        id: latest.id, body: latest.body, fromMe: false,
        timestamp: latest.timestamp, type: 'chat',
      }]);
    }
    if (latest.accountId === activeAccount) {
      waAPI.getChats(activeAccount).then(c => setChats(prev => ({ ...prev, [activeAccount]: c }))).catch(() => {});
    }
  }, [realtimeMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Called when user clicks "Initialize →" in the Add Account modal
  function handleInitialize() {
    const accountId = newAccountId.trim() || `wa${Date.now()}`;
    setAddingSession(false);
    setNewAccountId('');
    startSession(accountId);
  }

  // Called when user clicks "Retry" or "Restart session" in the QR modal
  function handleRetry() {
    if (!showQR) return;
    startSession(showQR);
  }

  // Core: disconnect any existing session for this ID, then create fresh one
  async function startSession(accountId) {
    setQrTimeout(false);
    clearTimeout(qrTimerRef.current);

    try {
      // Clean up any stuck session first
      if (statuses[accountId]) {
        await waAPI.removeSession(accountId).catch(() => {});
        setWaStatuses(prev => {
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
        // Small delay so backend fully cleans up
        await new Promise(r => setTimeout(r, 800));
      }

      await waAPI.addSession(accountId);
      setShowQR(accountId);

      // 90s timeout — if no QR by then, show error state
      qrTimerRef.current = setTimeout(() => setQrTimeout(true), 90000);
    } catch (e) {
      alert('Failed to start session: ' + e.message);
    }
  }

  async function openChat(chat) {
    setActiveChat(chat);
    setMessages([]);
    setLoading(true);
    try {
      const msgs = await waAPI.getMessages(activeAccount, chat.id);
      setMessages(msgs);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function sendMessage() {
    if (!reply.trim() || !activeChat || !activeAccount) return;
    const text = reply.trim();
    setReply('');
    try {
      await waAPI.send(activeAccount, activeChat.id, text);
      setMessages(prev => [...prev, {
        id: Date.now(), body: text, fromMe: true,
        timestamp: Math.floor(Date.now() / 1000), type: 'chat',
      }]);
    } catch (e) { alert('Failed to send: ' + e.message); }
  }

  function closeQR() {
    setShowQR(null);
    setQrTimeout(false);
    clearTimeout(qrTimerRef.current);
  }

  const currentChats = activeAccount ? (chats[activeAccount] || []) : [];
  const activeStatus = activeAccount ? statuses[activeAccount] : null;
  const showQRStatus = showQR ? statuses[showQR] : null;
  const hasError = showQRStatus?.status === 'error' || qrTimeout;

  return (
    <div className="tab-layout">
      <div className="tab-header">
        <span className="tab-title">💬 WhatsApp</span>
        <button className="btn btn-primary" onClick={() => setAddingSession(true)}>+ Add Account</button>
      </div>

      <div className="tab-body">
        {/* Left panel */}
        <div className="panel-left">
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
            <div className="section-label" style={{ padding: '0 0 6px' }}>
              Accounts ({Object.keys(statuses).length}/5)
            </div>
            {Object.keys(statuses).length === 0 && (
              <div style={{ color: 'var(--text3)', fontSize: 12, padding: '4px 0' }}>
                No accounts yet. Add one above.
              </div>
            )}
            {Object.entries(statuses).map(([id, s]) => (
              <button
                key={id}
                onClick={() => setActiveAccount(id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '6px 8px', borderRadius: 7, border: 'none', cursor: 'pointer',
                  background: activeAccount === id ? 'var(--accent-t)' : 'transparent',
                  color: activeAccount === id ? 'var(--accent)' : 'var(--text2)',
                  marginBottom: 2,
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
                  background: s.status === 'ready' ? 'var(--green)' : s.status === 'qr' ? 'var(--amber)' : 'var(--text3)',
                }} />
                <span style={{ fontSize: 13, flex: 1, textAlign: 'left' }}>
                  {s.name || id}
                  {s.phone && <span style={{ color: 'var(--text3)', fontSize: 11, marginLeft: 4 }}>+{s.phone}</span>}
                </span>
                {s.status === 'qr' && (
                  <span
                    onClick={e => { e.stopPropagation(); setShowQR(id); }}
                    style={{ fontSize: 11, background: 'var(--amber)', color: '#000', borderRadius: 4, padding: '1px 6px', cursor: 'pointer' }}
                  >QR</span>
                )}
              </button>
            ))}
          </div>

          <div className="section-label">Chats</div>
          {/* Bug 4 fix: not-ready state outside panel-scroll so it doesn't consume scroll space */}
          {activeStatus && activeStatus.status !== 'ready' && (
            <div className="empty-state" style={{ padding: 20, minHeight: 'unset' }}>
              <div className="empty-icon" style={{ fontSize: 32 }}>📱</div>
              <div className="empty-sub">
                {activeStatus.status === 'qr' ? 'Scan QR to connect.'
                  : activeStatus.status === 'initializing' ? 'Initializing…'
                  : activeStatus.status === 'error' ? '❌ ' + (activeStatus.error || 'Error')
                  : 'Disconnected.'}
              </div>
              {activeStatus.status === 'qr' && (
                <button className="btn btn-primary btn-sm" onClick={() => setShowQR(activeAccount)}>
                  Show QR Code
                </button>
              )}
            </div>
          )}
          <div className="panel-scroll">
            {currentChats.map(chat => (
              <div
                key={chat.id}
                className={`list-item ${activeChat?.id === chat.id ? 'active' : ''}`}
                style={{ position: 'relative' }}
                onClick={() => openChat(chat)}
              >
                <div className="avatar" style={{ background: strColor(chat.name), flexShrink: 0 }}>
                  {chat.isGroup ? '👥' : initials(chat.name)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontSize: 13.5, color: 'var(--text)', fontWeight: chat.unreadCount ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
                      {chat.name}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>{fmtTime(chat.lastMessageTime)}</span>
                  </div>
                  <div className="email-preview">{chat.lastMessage || '…'}</div>
                </div>
                {chat.unreadCount > 0 && (
                  <div style={{
                    position: 'absolute', top: 12, right: 12,
                    background: '#25d366', color: '#000', borderRadius: '50%',
                    width: 18, height: 18, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', fontSize: 10, fontWeight: 700,
                  }}>{chat.unreadCount}</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Right panel */}
        <div className="panel-right">
          {!activeChat ? (
            <div className="empty-state">
              <div className="empty-icon">💬</div>
              <div className="empty-title">Select a chat</div>
              <div className="empty-sub">Pick a conversation from the left to start messaging.</div>
            </div>
          ) : (
            <>
              <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                <div className="avatar" style={{ background: strColor(activeChat.name) }}>
                  {activeChat.isGroup ? '👥' : initials(activeChat.name)}
                </div>
                <div>
                  <div style={{ fontWeight: 600 }}>{activeChat.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>{activeChat.isGroup ? 'Group · ' : ''}{activeAccount}</div>
                </div>
              </div>

              <div className="panel-scroll" style={{ background: 'var(--bg)' }}>
                <div className="bubble-wrap">
                  {loading && (
                    <div style={{ color: 'var(--text3)', textAlign: 'center', fontSize: 13, padding: 20 }}>
                      Loading messages…
                    </div>
                  )}
                  {!loading && messages.length === 0 && (
                    <div style={{ color: 'var(--text3)', textAlign: 'center', fontSize: 13, padding: 40 }}>
                      No messages to show
                    </div>
                  )}
                  {messages.map((m, i) => (
                    <div key={m.id || i} className={`bubble-row ${m.fromMe ? 'me' : ''}`}>
                      {!m.fromMe && (
                        <div className="avatar avatar-sm" style={{ background: strColor(activeChat.name) }}>{initials(activeChat.name)}</div>
                      )}
                      <div>
                        <div className={`bubble ${m.fromMe ? 'me' : 'them'}`}>
                          {m.body || <em style={{ opacity: 0.5 }}>[{m.type}]</em>}
                        </div>
                        <div className="bubble-time">{fmtTime(m.timestamp)}</div>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              </div>

              <div className="compose-wrap">
                <div className="compose-box">
                  <textarea
                    placeholder={`Message ${activeChat.name}…`}
                    value={reply}
                    onChange={e => setReply(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                    rows={2}
                  />
                  <div className="compose-toolbar">
                    <button className="compose-action">😊</button>
                    <button className="compose-action">📎</button>
                    <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={sendMessage}>Send ➤</button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Add Account modal */}
      {addingSession && (
        <div className="modal-overlay" onClick={() => setAddingSession(false)}>
          <div className="modal" style={{ width: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              Add WhatsApp Account
              <button className="modal-close" onClick={() => setAddingSession(false)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.6 }}>
                A QR code will appear. Open WhatsApp → Linked Devices → Link a Device → scan the QR.
              </p>
              <div className="field">
                <label>Account label (optional)</label>
                <input
                  className="input"
                  placeholder="e.g. personal, work, business1"
                  value={newAccountId}
                  onChange={e => setNewAccountId(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setAddingSession(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleInitialize}>Initialize →</button>
            </div>
          </div>
        </div>
      )}

      {/* QR modal */}
      {showQR && (
        <div className="qr-overlay" onClick={closeQR}>
          <div className="qr-card" onClick={e => e.stopPropagation()}>
            <h3>Scan with WhatsApp</h3>
            <p>WhatsApp → Linked Devices → Link a Device</p>

            {qrCodes[showQR] ? (
              <img src={qrCodes[showQR]} alt="QR Code" />
            ) : hasError ? (
              <div style={{ width: 256, height: 256, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'var(--bg2)', borderRadius: 8, padding: 16 }}>
                <div style={{ fontSize: 32 }}>⚠️</div>
                <div style={{ fontSize: 12, color: '#e05c5c', textAlign: 'center', wordBreak: 'break-word' }}>
                  {showQRStatus?.error || 'QR timed out. The server browser may have failed to start.'}
                </div>
                <button className="btn btn-primary" style={{ marginTop: 8, width: '100%' }} onClick={handleRetry}>
                  🔄 Retry
                </button>
              </div>
            ) : (
              <div style={{ width: 256, height: 256, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'var(--bg2)', borderRadius: 8 }}>
                <div style={{ fontSize: 40 }}>⏳</div>
                <div style={{ fontSize: 13, color: 'var(--text3)', textAlign: 'center' }}>
                  {showQRStatus?.status === 'initializing' ? 'Starting browser…' : 'Generating QR code…'}<br />
                  <span style={{ fontSize: 11 }}>May take up to 60s on first launch</span>
                </div>
                <button className="btn" style={{ marginTop: 4, fontSize: 12 }} onClick={handleRetry}>
                  🔄 Restart
                </button>
              </div>
            )}

            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text3)' }}>
              Account: <strong>{showQR}</strong>
            </div>
            <button className="btn" style={{ marginTop: 14, width: '100%' }} onClick={closeQR}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

const initials = (n = '') => n.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
const strColor = (s = '') => {
  const colors = ['#5b4fcf', '#2d6a4f', '#7b2d8b', '#1a5276', '#784212', '#6d4c41', '#37474f', '#1b6ca8'];
  let h = 0;
  for (let c of s) h = c.charCodeAt(0) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
};
const fmtTime = ts => {
  if (!ts) return '';
  const d = new Date(ts * 1000), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
