import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { waAPI } from './api';
import WhatsAppTab from './components/WhatsApp/WhatsAppTab';
import EmailTab from './components/Email/EmailTab';
import CalendarTab from './components/Calendar/CalendarTab';
import SettingsTab from './components/Shared/SettingsTab';
import './App.css';

// Same-origin in production; localhost in dev
const SOCKET_URL = process.env.REACT_APP_API_URL ||
  (process.env.NODE_ENV === 'production' ? window.location.origin : 'http://localhost:4000');

export default function App() {
  const [activeTab, setActiveTab] = useState('whatsapp');
  const [notifications, setNotifications] = useState([]);
  const [waStatuses, setWaStatuses] = useState({});
  const [waMessages, setWaMessages] = useState([]);   // incoming real-time WA messages
  const [waQRs, setWaQRs] = useState({});             // accountId → qr data URL
  const socketRef = useRef(null);

  useEffect(() => {
    // Bug 3 fix: load existing session statuses on mount (persists across refresh)
    waAPI.getStatus().then(data => {
      setWaStatuses(data);
    }).catch(() => {});

    const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => console.log('Socket connected'));

    // WhatsApp real-time events
    socket.on('wa:status', ({ accountId, status, phone, name, error }) => {
      setWaStatuses(prev => ({ ...prev, [accountId]: { status, phone, name, error } }));
      // Bug 1 fix: clear QR image when session becomes ready (backend emits wa:status not wa:ready)
      if (status === 'ready') {
        setWaQRs(prev => { const n = { ...prev }; delete n[accountId]; return n; });
        addNotification('success', `WhatsApp ${accountId} connected ✓`);
      }
    });

    socket.on('wa:qr', ({ accountId, qr }) => {
      setWaQRs(prev => ({ ...prev, [accountId]: qr }));
    });

    // wa:ready is never emitted by backend — handled above in wa:status instead

    socket.on('wa:message', (msg) => {
      setWaMessages(prev => [msg, ...prev.slice(0, 499)]);
      if (activeTab !== 'whatsapp') {
        addNotification('message', `💬 ${msg.from}: ${msg.body?.slice(0, 60)}`);
      }
    });

    socket.on('wa:chats', ({ accountId, chats }) => {
      // handled in WhatsAppTab via ref
    });

    return () => socket.disconnect();
  }, []);

  function addNotification(type, text) {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, type, text }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 4000);
  }

  const tabs = [
    { id: 'whatsapp', label: 'WhatsApp', icon: '💬' },
    { id: 'email',    label: 'Email',    icon: '📧' },
    { id: 'calendar', label: 'Calendar', icon: '📅' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];

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
              {tab.id === 'whatsapp' && Object.keys(waStatuses).length > 0 && (
                <span className="nav-badge">
                  {Object.values(waStatuses).filter(s => s.status === 'ready').length}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="connection-dots">
            {Object.entries(waStatuses).map(([id, s]) => (
              <div
                key={id}
                className={`conn-dot ${s.status}`}
                title={`${id}: ${s.status}${s.phone ? ` (+${s.phone})` : ''}`}
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
            qrCodes={waQRs}
            realtimeMessages={waMessages}
            setWaStatuses={setWaStatuses}
          />
        )}
        {activeTab === 'email' && <EmailTab />}
        {activeTab === 'calendar' && <CalendarTab />}
        {activeTab === 'settings' && <SettingsTab socket={socketRef.current} waStatuses={waStatuses} setWaStatuses={setWaStatuses} />}
      </main>

      {/* Notification toasts */}
      <div className="toast-container">
        {notifications.map(n => (
          <div key={n.id} className={`toast toast-${n.type}`}>{n.text}</div>
        ))}
      </div>
    </div>
  );
}
