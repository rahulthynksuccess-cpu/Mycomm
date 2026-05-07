import React, { useState, useEffect, useRef, useCallback } from 'react';
import { waAPI } from '../../api';

export default function WhatsAppTab({ socket, statuses, setWaStatuses, qrCodes, realtimeMessages, pushedChats = {}, setPushedChats }) {
  const [chats,         setChats]         = useState({});  // accountId → chat[]
  const [activeAccount, setActiveAccount] = useState(null);
  const [activeChat,    setActiveChat]    = useState(null);
  const [messages,      setMessages]      = useState([]);
  const [reply,         setReply]         = useState('');
  const [loading,       setLoading]       = useState(false);
  const [addingSession, setAddingSession] = useState(false);
  const [newAccountId,  setNewAccountId]  = useState('');
  const [showQR,        setShowQR]        = useState(null);
  const [qrTimeout,     setQrTimeout]     = useState(false);

  const messagesEndRef     = useRef(null);
  const scrollContainerRef = useRef(null);
  const [msgLimit,      setMsgLimit]      = useState(200);
  const [showNewChat,   setShowNewChat]   = useState(false);
  const [newChatNumber, setNewChatNumber] = useState('');
  const [newChatMsg,    setNewChatMsg]    = useState('');
  const [newChatSending,setNewChatSending]= useState(false);
  const [newChatError,  setNewChatError]  = useState('');
  const qrTimerRef     = useRef(null);

  // ── Merge server-pushed chats into local state ──────
  useEffect(() => {
    if (!pushedChats || !Object.keys(pushedChats).length) return;
    setChats(prev => {
      const next = { ...prev };
      for (const [id, chatList] of Object.entries(pushedChats)) {
        if (Array.isArray(chatList) && chatList.length > 0) {
          next[id] = chatList;
        }
      }
      return next;
    });
  }, [pushedChats]);

  // ── Derived ──────────────────────────────────────────
  const readyAccounts  = Object.entries(statuses).filter(([, s]) => s.status === 'ready');
  const currentChats   = activeAccount ? (chats[activeAccount] || []) : [];
  const activeStatus   = activeAccount ? statuses[activeAccount] : null;
  const showQRStatus   = showQR ? statuses[showQR] : null;
  const hasError       = showQRStatus?.status === 'error' || qrTimeout;

  // ── Load chats for an account ────────────────────────
  const loadChats = useCallback(async (accountId) => {
    if (!accountId) return;
    // Try immediately, then retry after 4s if empty (backend needs time to sync)
    const attempt = async () => {
      try {
        const c = await waAPI.getChats(accountId, 500);
        if (Array.isArray(c) && c.length > 0) {
          setChats(prev => ({ ...prev, [accountId]: c }));
          return true;
        }
        return false;
      } catch (e) {
        console.error('[WA] loadChats failed', accountId, e);
        return false;
      }
    };
    const got = await attempt();
    if (!got) setTimeout(() => attempt(), 4000);  // retry once after 4s
  }, []);

  // ── Auto-select first ready account (only when none selected) ──
  const readyAccountIds = readyAccounts.map(([id]) => id).join(',');
  useEffect(() => {
    if (activeAccount) return;
    if (readyAccounts.length === 0) return;
    setActiveAccount(readyAccounts[0][0]);
  }, [readyAccountIds]); // stable string dep — only fires when account list actually changes

  // ── Load chats whenever active account changes ───────
  // Depends only on activeAccount so switching always triggers a fresh load.
  // Also re-fires when status flips to 'ready' for the first time.
  useEffect(() => {
    if (!activeAccount) return;
    // Load immediately if already ready, else wait for ready status below
    if (statuses[activeAccount]?.status === 'ready') {
      loadChats(activeAccount);
    }
  }, [activeAccount]); // intentionally only activeAccount — avoids stale-value trap

  // Separate effect: fires when an account first becomes ready (e.g. after QR scan)
  const activeStatus2 = statuses[activeAccount]?.status;
  useEffect(() => {
    if (!activeAccount) return;
    if (activeStatus2 === 'ready') {
      loadChats(activeAccount);
    }
  }, [activeStatus2, activeAccount]); // only re-fires when status string changes

  // ── Close QR modal only when account is actually ready ──
  useEffect(() => {
    if (!showQR) return;
    const isReady = statuses[showQR]?.status === 'ready'
                 || statuses[showQR]?.status === 'authenticated';
    if (isReady) {
      clearTimeout(qrTimerRef.current);
      setShowQR(null);
      setQrTimeout(false);
    }
  }, [statuses, showQR]);

  // ── Handle incoming real-time messages ───────────────
  useEffect(() => {
    if (!realtimeMessages.length) return;
    const msg = realtimeMessages[0];
    // Append to open chat if it matches
    if (msg.accountId === activeAccount && activeChat && msg.chatId === activeChat.id) {
      setMessages(prev => [...prev, {
        id: msg.id, body: msg.body, fromMe: false,
        timestamp: msg.timestamp, type: 'chat',
      }]);
    }
    // Refresh chat list for the account that received the message
    if (msg.accountId === activeAccount) {
      waAPI.getChats(msg.accountId).then(c =>
        setChats(prev => ({ ...prev, [msg.accountId]: c }))
      ).catch(() => {});
    }
  }, [realtimeMessages]);

  // ── Load more messages when scrolling to top ────────
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (container.scrollTop < 50 && activeChat && activeAccount) {
      const newLimit = msgLimit + 100;
      setMsgLimit(newLimit);
      waAPI.getMessages(activeAccount, activeChat.id, newLimit)
        .then(msgs => { if (msgs?.length) setMessages(msgs); })
        .catch(() => {});
    }
  }, [activeChat, activeAccount, msgLimit]);

  // ── Scroll to bottom only if user is already near bottom ──
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    // Only auto-scroll if within 150px of bottom
    if (distFromBottom < 150) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // ── Scroll to bottom when opening a new chat ──────────
  // Fire when messages actually load (not just when chat is selected)
  const prevChatId = useRef(null);
  useEffect(() => {
    if (!messages.length) return;
    if (activeChat?.id !== prevChatId.current) {
      prevChatId.current = activeChat?.id;
      // Use setTimeout to ensure DOM has rendered
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
      }, 50);
    }
  }, [messages, activeChat?.id]);

  // ── Session management ───────────────────────────────
  async function startSession(accountId) {
    setQrTimeout(false);
    clearTimeout(qrTimerRef.current);

    try {
      // Only clean up if the session is stuck or failed — never wipe a healthy account
      const existingStatus = statuses[accountId]?.status;
      const isStuck = existingStatus && !['ready', 'initializing', 'authenticated'].includes(existingStatus);
      if (isStuck) {
        await waAPI.removeSession(accountId).catch(() => {});
        setWaStatuses(prev => { const n = { ...prev }; delete n[accountId]; return n; });
        await new Promise(r => setTimeout(r, 1000));
      }
      setShowQR(accountId);  // open modal first so user sees status
      await waAPI.addSession(accountId);
      // If no QR arrives within 90s, show timeout error
      qrTimerRef.current = setTimeout(() => setQrTimeout(true), 90000);
    } catch (e) {
      const msg = e.response?.data?.error || e.message || 'Unknown error';
      console.error('[WA] startSession failed:', msg);
      // Keep modal open and show error via status
      setWaStatuses(prev => ({
        ...prev,
        [accountId]: { ...(prev[accountId] || {}), status: 'error', error: msg },
      }));
      setQrTimeout(true);
    }
  }

  function handleInitialize() {
    const accountId = newAccountId.trim() || `wa${Date.now()}`;
    setAddingSession(false);
    setNewAccountId('');
    startSession(accountId);
  }

  function closeQR() {
    setShowQR(null);
    setQrTimeout(false);
    clearTimeout(qrTimerRef.current);
  }

  // ── Chat & messaging ─────────────────────────────────
  async function openChat(chat) {
    setActiveChat(chat);
    setMessages([]);
    setMsgLimit(200);
    setLoading(true);
    // Clear unread badge immediately on open
    setChats(prev => ({
      ...prev,
      [activeAccount]: (prev[activeAccount] || []).map(c =>
        c.id === chat.id ? { ...c, unreadCount: 0 } : c
      ),
    }));
    try {
      const msgs = await waAPI.getMessages(activeAccount, chat.id);
      setMessages(msgs);
    } catch (e) {
      console.error('[WA] loadMessages failed', e);
    }
    setLoading(false);
  }

  async function sendNewChat() {
    const num = newChatNumber.replace(/\D/g, '');
    if (!num || num.length < 7) { setNewChatError('Enter a valid number with country code'); return; }
    if (!newChatMsg.trim()) { setNewChatError('Enter a message'); return; }
    if (!activeAccount) { setNewChatError('Select an account first'); return; }
    setNewChatSending(true); setNewChatError('');
    try {
      const jid = num + '@s.whatsapp.net';
      await waAPI.send(activeAccount, jid, newChatMsg.trim());
      // Open this chat in the panel
      const fakeChat = {
        id: jid,
        name: newChatNumber,
        isGroup: false,
        unreadCount: 0,
        lastMessage: newChatMsg.trim(),
        lastMessageTime: Math.floor(Date.now() / 1000),
      };
      openChat(fakeChat);
      setShowNewChat(false);
      setNewChatNumber('');
      setNewChatMsg('');
    } catch (e) {
      setNewChatError(e.response?.data?.error || e.message);
    }
    setNewChatSending(false);
  }

  async function sendMessage() {
    if (!reply.trim() || !activeChat || !activeAccount) return;
    const text = reply.trim();
    setReply('');
    try {
      await waAPI.send(activeAccount, activeChat.id, text);
      setMessages(prev => [...prev, {
        id: `local-${Date.now()}`, body: text, fromMe: true,
        timestamp: Math.floor(Date.now() / 1000), type: 'chat',
      }]);
    } catch (e) {
      alert('Failed to send: ' + (e.response?.data?.error || e.message));
      setReply(text); // restore
    }
  }

  // ── Render ───────────────────────────────────────────
  return (
    <div className="tab-layout">
      <div className="tab-header">
        <span className="tab-title">💬 WhatsApp</span>
        <button className="btn btn-primary" onClick={() => setAddingSession(true)}>+ Add Account</button>
      </div>

      <div className="tab-body">
        {/* ── Left panel ── */}
        <div className="panel-left">

          {/* Accounts list */}
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div className="section-label" style={{ padding: '0 0 6px' }}>
              Accounts ({Object.keys(statuses).length}/5)
            </div>
            {Object.keys(statuses).length === 0 && (
              <div style={{ color: 'var(--text3)', fontSize: 12, padding: '4px 0' }}>
                No accounts yet. Click "+ Add Account".
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
                  background: s.status === 'ready' ? 'var(--green)'
                    : s.status === 'qr'            ? 'var(--amber)'
                    : s.status === 'initializing'  ? 'var(--blue)'
                    : 'var(--red)',
                }} />
                <span style={{ fontSize: 13, flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.name || id}
                  {s.phone && <span style={{ color: 'var(--text3)', fontSize: 11, marginLeft: 4 }}>+{s.phone}</span>}
                </span>
                {s.status === 'qr' && (
                  <span
                    onClick={e => { e.stopPropagation(); setShowQR(id); }}
                    style={{ fontSize: 11, background: 'var(--amber)', color: '#fff', borderRadius: 4, padding: '1px 6px', cursor: 'pointer', flexShrink: 0 }}
                  >QR</span>
                )}
                {(s.status === 'disconnected' || s.status === 'error' || s.status === 'auth_failure') && (
                  <span
                    onClick={e => { e.stopPropagation(); startSession(id); }}
                    style={{ fontSize: 11, background: 'var(--red)', color: '#fff', borderRadius: 4, padding: '1px 6px', cursor: 'pointer', flexShrink: 0 }}
                  >↺</span>
                )}
              </button>
            ))}
          </div>

          <div className="section-label">Chats</div>

          {/* Non-ready status message (outside scroll so it doesn't eat scroll height) */}
          {activeStatus && activeStatus.status !== 'ready' && (
            <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📱</div>
              {activeStatus.status === 'initializing' && 'Starting up… may take 30–60s'}
              {activeStatus.status === 'qr'           && 'Scan the QR code to connect'}
              {activeStatus.status === 'authenticated' && 'Authenticated, loading…'}
              {activeStatus.status === 'disconnected' && 'Disconnected'}
              {activeStatus.status === 'auth_failure' && '❌ Auth failed'}
              {activeStatus.status === 'error'        && ('❌ ' + (activeStatus.error || 'Error'))}

              {activeStatus.status === 'qr' && (
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => setShowQR(activeAccount)}>
                    Show QR Code
                  </button>
                </div>
              )}
              {(activeStatus.status === 'disconnected' || activeStatus.status === 'error' || activeStatus.status === 'auth_failure') && (
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => startSession(activeAccount)}>
                    🔄 Reconnect
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="panel-scroll">
            {activeStatus?.status === 'ready' && currentChats.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                No chats loaded yet
              </div>
            )}
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
                    <span style={{
                      fontSize: 13.5, color: 'var(--text)',
                      fontWeight: chat.unreadCount ? 600 : 400,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160,
                    }}>
                      {chat.name?.includes('@') ? chat.name.split('@')[0].split(':')[0].replace(/[^0-9]/g,'') : chat.name}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>
                      {fmtTime(chat.lastMessageTime)}
                    </span>
                  </div>
                  <div className="email-preview">{chat.lastMessage || '…'}</div>
                </div>
                {chat.unreadCount > 0 && (
                  <div style={{
                    position: 'absolute', top: 12, right: 12,
                    background: '#25d366', color: '#fff', borderRadius: '50%',
                    width: 18, height: 18, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', fontSize: 10, fontWeight: 700,
                  }}>{chat.unreadCount}</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── Right panel ── */}
        <div className="panel-right">
          {!activeChat ? (
            <div className="empty-state">
              <div className="empty-icon">💬</div>
              <div className="empty-title">Select a chat</div>
              <div className="empty-sub">Pick a conversation from the left to start messaging.</div>
            </div>
          ) : (
            <>
              {/* Chat header */}
              <div style={{
                padding: '12px 18px', borderBottom: '1px solid var(--border)',
                background: 'var(--bg2)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
              }}>
                <div className="avatar" style={{ background: strColor(activeChat.name) }}>
                  {activeChat.isGroup ? '👥' : initials(activeChat.name)}
                </div>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {activeChat.name?.includes('@') 
                      ? activeChat.name.split('@')[0].split(':')[0].replace(/[^0-9]/g,'')
                      : activeChat.name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                    {activeChat.isGroup ? 'Group · ' : ''}{activeAccount}
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="panel-scroll" ref={scrollContainerRef} onScroll={handleScroll} style={{ background: 'var(--bg)' }}>
                <div className="bubble-wrap">
                  {loading && (
                    <div style={{ color: 'var(--text3)', textAlign: 'center', fontSize: 13, padding: 20 }}>
                      Loading messages…
                    </div>
                  )}
                  {!loading && messages.length === 0 && (
                    <div style={{ color: 'var(--text3)', textAlign: 'center', fontSize: 13, padding: 40 }}>
                      No messages
                    </div>
                  )}
                  {messages.filter(m => m.type !== 'protocolMessage' && m.type !== 'senderKeyDistributionMessage' && (m.body || m.type === 'chat')).map((m, i) => (
                    <div key={m.id || i} className={`bubble-row ${m.fromMe ? 'me' : ''}`}>
                      {!m.fromMe && (
                        <div className="avatar avatar-sm" style={{ background: strColor(activeChat.name) }}>
                          {initials(activeChat.name)}
                        </div>
                      )}
                      <div>
                        <div className={`bubble ${m.fromMe ? 'me' : 'them'}`}>
                          {m.body || <em style={{ opacity: 0.5 }}>[{m.type}]</em>}
                        </div>
                        <div className="bubble-time">{fmtTime(m.timestamp, true)}</div>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              </div>

              {/* Compose */}
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
                    <label title="Attach file" style={{ cursor: 'pointer', padding: '6px 8px', color: 'var(--text3)', fontSize: 18, lineHeight: 1 }}>
                      📎
                      <input type="file" style={{ display: 'none' }} onChange={e => {
                        const file = e.target.files[0];
                        if (file) alert('File sending coming soon: ' + file.name);
                        e.target.value = '';
                      }} />
                    </label>
                    <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={sendMessage}>
                      Send ➤
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Add Account modal ── */}
      {addingSession && (
        <div className="modal-overlay" onClick={() => setAddingSession(false)}>
          <div className="modal" style={{ width: 420 }} onClick={e => e.stopPropagation()}>
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
                  placeholder="e.g. personal, work, business"
                  value={newAccountId}
                  onChange={e => setNewAccountId(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleInitialize()}
                  autoFocus
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

      {/* ── QR modal ── */}
      {showQR && (
        <div className="qr-overlay" onClick={closeQR}>
          <div className="qr-card" onClick={e => e.stopPropagation()}>
            <h3>Scan with WhatsApp</h3>
            <p>WhatsApp → Linked Devices → Link a Device</p>

            {qrCodes[showQR] ? (
              <img src={qrCodes[showQR]} alt="QR Code" style={{ width: 240, height: 240, borderRadius: 8, background: '#fff', padding: 8 }} />
            ) : hasError ? (
              <div style={{ width: 240, height: 240, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'var(--bg3)', borderRadius: 8, padding: 16 }}>
                <div style={{ fontSize: 32 }}>⚠️</div>
                <div style={{ fontSize: 12, color: 'var(--red)', textAlign: 'center' }}>
                  {showQRStatus?.error || 'QR timed out. The browser may have failed to start.'}
                </div>
                <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => startSession(showQR)}>
                  🔄 Retry
                </button>
              </div>
            ) : (
              <div style={{ width: 240, height: 240, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'var(--bg3)', borderRadius: 8 }}>
                <div style={{ fontSize: 36 }}>⏳</div>
                <div style={{ fontSize: 13, color: 'var(--text3)', textAlign: 'center', lineHeight: 1.6 }}>
                  {showQRStatus?.status === 'initializing' ? 'Starting browser…' : 'Generating QR…'}<br />
                  <span style={{ fontSize: 11 }}>May take up to 60s on first launch</span>
                </div>
              </div>
            )}

            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text3)' }}>
              Account: <strong>{showQR}</strong>
            </div>
            <button className="btn" style={{ marginTop: 14, width: '100%' }} onClick={closeQR}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────
const initials = (n = '') =>
  n.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

const strColor = (s = '') => {
  const colors = ['#5b4fcf', '#2d6a4f', '#7b2d8b', '#1a5276', '#784212', '#6d4c41', '#37474f', '#1b6ca8'];
  let h = 0;
  for (const c of s) h = c.charCodeAt(0) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
};

const IST = 'Asia/Kolkata';
const fmtTime = (ts, full = false) => {
  if (!ts) return '';
  const d = new Date(ts * 1000), now = new Date();
  const todayIST = now.toLocaleDateString('en-IN', { timeZone: IST });
  const dateIST  = d.toLocaleDateString('en-IN', { timeZone: IST });
  const timeStr  = d.toLocaleTimeString('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true });
  if (full) {
    // Full date+time for message bubbles
    return todayIST === dateIST
      ? timeStr
      : d.toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: '2-digit' }) + ', ' + timeStr;
  }
  // Short for chat list
  return todayIST === dateIST
    ? timeStr
    : d.toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short' });
};
