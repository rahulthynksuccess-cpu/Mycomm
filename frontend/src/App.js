import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { waAPI } from './api';
import WhatsAppTab from './components/WhatsApp/WhatsAppTab';
import EmailTab    from './components/Email/EmailTab';
import CalendarTab from './components/Calendar/CalendarTab';
import SettingsTab from './components/Shared/SettingsTab';
import './App.css';

const SOCKET_URL = process.env.REACT_APP_API_URL ||
  (process.env.NODE_ENV === 'production' ? window.location.origin : 'http://localhost:4000');

export default function App() {
  const [activeTab,    setActiveTab]    = useState('whatsapp');
  const [notifications, setNotifications] = useState([]);
  const [waStatuses,   setWaStatuses]   = useState({});
  const [waMessages,   setWaMessages]   = useState([]);
  const [waQRs,        setWaQRs]        = useState({});
  const [waChats,      setWaChats]      = useState({});  // accountId → chat[]
  const socketRef = useRef(null);

  const addNotification = useCallback((type, text) => {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, type, text }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 4000);
  }, []);

  // Merge incoming status — NEVER replace the whole object.
  // This prevents HTTP snapshots from wiping real-time socket updates.
  const mergeStatus = useCallback((accountId, fields) => {
    setWaStatuses(prev => ({
      ...prev,
      [accountId]: { ...(prev[accountId] || {}), ...fields },
    }));
  }, []);

  useEffect(() => {
    // ── Socket setup ───────────────────────────────────
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[socket] connected');
      // On (re)connect, also do a fresh HTTP fetch as a belt-and-suspenders backup
      waAPI.getStatus().then(data => {
        if (!data || !Object.keys(data).length) return;
        // Only add accounts we don't already know about
        setWaStatuses(prev => {
          const merged = { ...data };
          // Existing real-time data wins over the HTTP snapshot
          Object.keys(prev).forEach(id => { merged[id] = prev[id]; });
          return merged;
        });
      }).catch(() => {});
    });

    socket.on('wa:status', ({ accountId, status, phone, name, error, reason }) => {
      mergeStatus(accountId, { status, phone, name, error, reason });
      if (status === 'ready') {
        setWaQRs(prev => { const n = { ...prev }; delete n[accountId]; return n; });
        addNotification('success', `WhatsApp ${name || accountId} connected ✓`);
      }
    });

    socket.on('wa:qr', ({ accountId, qr }) => {
      if (!qr) {
        // null qr = account connected, clear QR
        setWaQRs(prev => { const n = { ...prev }; delete n[accountId]; return n; });
      } else {
        setWaQRs(prev => ({ ...prev, [accountId]: qr }));
      }
    });

    // Backend pushes chats when an account becomes ready
    socket.on('wa:chats', ({ accountId, chats }) => {
      if (Array.isArray(chats) && chats.length > 0) {
        setWaChats(prev => ({ ...prev, [accountId]: chats }));
      }
    });

    socket.on('wa:message', (msg) => {
      setWaMessages(prev => [msg, ...prev.slice(0, 499)]);
    });

    // Cleanup
    return () => socket.disconnect();
  }, []);

  const tabs = [
    { id: 'whatsapp', label: 'WhatsApp', icon: '💬' },
    { id: 'email',    label: 'Email',    icon: '📧' },
    { id: 'calendar', label: 'Calendar', icon: '📅' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];

  const readyCount = Object.values(waStatuses).filter(s => s.status === 'ready').length;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-mark">MC</div>
          <div>
            <div className="logo-name">MyComms</div>
            <div className="logo-sub">Personal Hub</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`nav-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="nav-icon">{tab.icon}</span>
              <span className="nav-label">{tab.label}</span>
              {tab.id === 'whatsapp' && readyCount > 0 && (
                <span className="nav-badge">{readyCount}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="connection-dots">
            {Object.entries(waStatuses).map(([id, s]) => (
              <div
                key={id}
                className={`conn-dot ${s.status || ''}`}
                title={`${s.name || id}: ${s.status}${s.phone ? ` (+${s.phone})` : ''}`}
              />
            ))}
          </div>
        </div>
      </aside>

      <main className="main-content">
        {activeTab === 'whatsapp' && (
          <WhatsAppTab
            socket={socketRef.current}
            statuses={waStatuses}
            setWaStatuses={setWaStatuses}
            qrCodes={waQRs}
            realtimeMessages={waMessages}
            pushedChats={waChats}
            setPushedChats={setWaChats}
          />
        )}
        {activeTab === 'email'    && <EmailTab />}
        {activeTab === 'calendar' && <CalendarTab />}
        {activeTab === 'settings' && (
          <SettingsTab
            socket={socketRef.current}
            waStatuses={waStatuses}
            setWaStatuses={setWaStatuses}
          />
        )}
      </main>

      <div className="toast-container">
        {notifications.map(n => (
          <div key={n.id} className={`toast toast-${n.type}`}>{n.text}</div>
        ))}
      </div>
    </div>
  );
}
