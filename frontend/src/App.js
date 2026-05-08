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
  const [activeTab,     setActiveTab]     = useState('whatsapp');
  const [notifications, setNotifications] = useState([]);
  const [waStatuses,    setWaStatuses]    = useState({});
  const [waMessages,    setWaMessages]    = useState([]);
  const [waQRs,         setWaQRs]         = useState({});
  const [waChats,       setWaChats]       = useState({});
  const socketRef = useRef(null);

  const addNotification = useCallback((type, text) => {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, type, text }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 4000);
  }, []);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[socket] connected');
      // Always fetch current status on connect/reconnect — accounts may have
      // restored on the server while socket was disconnected
      waAPI.getStatus().then(data => {
        if (!data || !Object.keys(data).length) return;
        setWaStatuses(prev => {
          const next = { ...prev };
          for (const [id, s] of Object.entries(data)) {
            // Merge: keep existing phone/name if server hasn't updated yet
            next[id] = { ...(next[id] || {}), ...s };
          }
          return next;
        });
      }).catch(() => {});
    });

    socket.on('wa:status', ({ accountId, status, phone, name, error, reason }) => {
      setWaStatuses(prev => {
        const cur = prev[accountId] || {};
        // Skip update if nothing changed — prevents cascade re-renders
        if (cur.status === status && cur.phone === phone && cur.name === name) return prev;
        return { ...prev, [accountId]: { ...cur, status, phone, name, error, reason } };
      });
      if (status === 'ready') {
        setWaQRs(prev => { const n = { ...prev }; delete n[accountId]; return n; });
        addNotification('success', `WhatsApp ${name || accountId} connected ✓`);
      }
    });

    socket.on('wa:qr', ({ accountId, qr }) => {
      if (!qr) {
        setWaQRs(prev => { const n = { ...prev }; delete n[accountId]; return n; });
      } else {
        setWaQRs(prev => ({ ...prev, [accountId]: qr }));
      }
    });

    socket.on('wa:chats', ({ accountId, chats }) => {
      if (Array.isArray(chats) && chats.length > 0) {
        setWaChats(prev => {
          const existing = prev[accountId];
          // FIX: Only skip if count AND first+last IDs all match (true no-op)
          // Previous check was too strict — blocked updates with resolved names
          if (existing && existing.length === chats.length &&
              existing[0]?.id === chats[0]?.id &&
              existing[existing.length-1]?.id === chats[chats.length-1]?.id) return prev;
          return { ...prev, [accountId]: chats };
        });
      }
    });

    socket.on('wa:message', (msg) => {
      setWaMessages(prev => [msg, ...prev.slice(0, 499)]);
    });

    return () => socket.disconnect();
  }, []);

  const tabs = [
    { id: 'whatsapp', label: 'WhatsApp', icon: '💬' },
    { id: 'email',    label: 'Email',    icon: '📧' },
    { id: 'calendar', label: 'Calendar', icon: '📅' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];

  // Poll status every 10s — reliable fallback so all accounts always appear
  // even if socket events were missed during startup
  useEffect(() => {
    const poll = () => {
      waAPI.getStatus().then(data => {
        if (!data || !Object.keys(data).length) return;
        setWaStatuses(prev => {
          const next = { ...prev };
          let changed = false;
          for (const [id, s] of Object.entries(data)) {
            const cur = next[id] || {};
            // Add missing accounts; update status/phone/name if changed
            if (!next[id] || cur.status !== s.status || cur.phone !== s.phone || cur.name !== s.name) {
              next[id] = { ...cur, ...s };
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }).catch(() => {});
    };
    poll(); // immediate on mount
    const t = setInterval(poll, 10000);
    return () => clearInterval(t);
  }, []);

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
