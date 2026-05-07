import React, { useState, useEffect } from 'react';
import { waAPI, emailAPI } from '../../api';

export default function SettingsTab({ socket, waStatuses, setWaStatuses }) {
  const [emailAccounts, setEmailAccounts] = useState([]);
  const [activeSection, setActiveSection] = useState('whatsapp');
  const [zohoConnecting, setZohoConnecting] = useState({});

  const loadEmailAccounts = () => emailAPI.getAccounts().then(setEmailAccounts).catch(() => {});

  useEffect(() => { loadEmailAccounts(); }, []);

  // Listen for Zoho OAuth popup result
  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === 'ZOHO_AUTH_SUCCESS') {
        setZohoConnecting(prev => ({ ...prev, [e.data.accountId]: false }));
        loadEmailAccounts();
      }
      if (e.data?.type === 'ZOHO_AUTH_ERROR') {
        setZohoConnecting({});
        alert('Zoho connection failed: ' + e.data.error);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  async function reconnectZoho(accountId) {
    setZohoConnecting(prev => ({ ...prev, [accountId]: true }));
    try {
      const { url } = await emailAPI.getZohoAuthUrl(accountId);
      window.open(url, '_blank', 'width=520,height=640');
    } catch (e) {
      setZohoConnecting(prev => ({ ...prev, [accountId]: false }));
      alert('Could not get Zoho auth URL: ' + (e.response?.data?.error || e.message));
    }
  }

  async function disconnectZoho(accountId) {
    if (!window.confirm('Disconnect this Zoho account? You will need to reconnect it to read emails.')) return;
    // Delete the OAuth token by calling the delete endpoint
    try {
      await emailAPI.deleteAccount(accountId);
      // Re-add without password to keep account listed but disconnected
      loadEmailAccounts();
    } catch (e) {}
    loadEmailAccounts();
  }

  async function disconnectWA(id) {
    if (!window.confirm(`Disconnect WhatsApp account "${id}"?`)) return;
    await waAPI.removeSession(id).catch(e => alert(e.message));
    setWaStatuses(prev => { const n = { ...prev }; delete n[id]; return n; });
  }

  const sections = [
    { id: 'whatsapp', label: '💬 WhatsApp', icon: '💬' },
    { id: 'email',    label: '📧 Email',    icon: '📧' },
    { id: 'calendar', label: '📅 Calendar', icon: '📅' },
    { id: 'about',    label: 'ℹ️ About',    icon: 'ℹ️' },
  ];

  return (
    <div className="tab-layout">
      <div className="tab-header">
        <span className="tab-title">⚙️ Settings</span>
      </div>
      <div className="tab-body">
        {/* Settings nav */}
        <div className="panel-left" style={{ width: 200 }}>
          {sections.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '10px 14px', border: 'none', cursor: 'pointer', fontSize: 14,
                background: activeSection === s.id ? 'var(--accent-t)' : 'transparent',
                color: activeSection === s.id ? 'var(--accent)' : 'var(--text2)',
              }}
            >
              {s.icon} {s.label.replace(/^..\s/, '')}
            </button>
          ))}
        </div>

        {/* Settings content */}
        <div style={{ flex: 1, padding: 28, overflowY: 'auto' }}>

          {activeSection === 'whatsapp' && (
            <Section title="WhatsApp Accounts" subtitle="Manage your connected WhatsApp sessions (max 5)">
              {Object.entries(waStatuses).length === 0 && (
                <div style={{ color: 'var(--text3)', fontSize: 13 }}>No WhatsApp accounts connected yet. Go to the WhatsApp tab and click "+ Add Account".</div>
              )}
              {Object.entries(waStatuses).map(([id, s]) => (
                <div key={id} style={{
                  padding: '14px 16px', borderRadius: 10, border: '1px solid var(--border)',
                  background: 'var(--bg2)', display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10,
                }}>
                  <div style={{
                    width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                    background: s.status === 'ready' ? 'var(--green)' : s.status === 'qr' ? 'var(--amber)' : 'var(--text3)',
                  }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{id}</div>
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                      {s.status === 'ready' ? `Connected · +${s.phone} · ${s.name}` : s.status}
                    </div>
                  </div>
                  <StatusBadge status={s.status} />
                  <button className="btn btn-danger btn-sm" onClick={() => disconnectWA(id)}>Disconnect</button>
                </div>
              ))}
              <div style={{ marginTop: 8, padding: 14, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--text2)', lineHeight: 1.7 }}>
                <strong>How sessions work:</strong> Each WhatsApp session is saved to <code style={{ background: 'var(--bg4)', padding: '1px 5px', borderRadius: 4 }}>./sessions/</code> on the server. Sessions persist across restarts — you only need to scan the QR code once per account. If a session disconnects, go to the WhatsApp tab and re-scan.
              </div>
            </Section>
          )}

          {activeSection === 'email' && (
            <Section title="Email Accounts" subtitle="Manage connected email accounts">
              {emailAccounts.length === 0 && (
                <div style={{ color: 'var(--text3)', fontSize: 13 }}>No email accounts added yet. Go to the Email tab and click + Add.</div>
              )}
              {emailAccounts.map(acc => {
                const isZoho = acc.type === 'zoho';
                const connected = !isZoho || acc.zohoConnected;
                const connecting = zohoConnecting[acc.id];
                return (
                  <div key={acc.id} style={{
                    padding: '14px 16px', borderRadius: 10,
                    border: `1px solid ${!connected ? '#fed7aa' : 'var(--border)'}`,
                    background: !connected ? '#fff8f0' : 'var(--bg2)',
                    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10,
                  }}>
                    <div style={{
                      width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                      background: !connected ? '#f97316' : (acc.type === 'gmail' ? '#EA4335' : '#E05D2E'),
                    }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{acc.label}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                        {acc.user} · {acc.type}
                        {isZoho && (
                          <span style={{
                            marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 10,
                            background: connected ? '#dcfce7' : '#fef9c3',
                            color: connected ? '#166534' : '#854d0e',
                            fontWeight: 600,
                          }}>
                            {connected ? 'OAuth Connected' : 'Not Connected'}
                          </span>
                        )}
                      </div>
                    </div>
                    {isZoho && (
                      <button
                        onClick={() => reconnectZoho(acc.id)}
                        disabled={connecting}
                        style={{
                          padding: '5px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                          border: '1.5px solid #E05D2E', background: 'none',
                          color: '#E05D2E', cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                      >
                        {connecting ? '⏳ Connecting…' : connected ? '🔄 Reconnect' : '🔗 Connect Zoho'}
                      </button>
                    )}
                  </div>
                );
              })}
            </Section>
          )}

          {activeSection === 'calendar' && (
            <Section title="Google Calendar" subtitle="Connect Google Calendar accounts via OAuth">
              <div style={{ padding: 16, borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--text2)', lineHeight: 1.8, marginBottom: 16 }}>
                <strong style={{ color: 'var(--text)' }}>Setup steps:</strong>
                <ol style={{ paddingLeft: 18, marginTop: 8 }}>
                  <li>Go to <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>console.cloud.google.com</a></li>
                  <li>Create a new project → Enable "Google Calendar API"</li>
                  <li>Create OAuth 2.0 credentials (Web Application type)</li>
                  <li>Add your backend callback URL to Authorized Redirect URIs:<br />
                    <code style={{ background: 'var(--bg4)', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>
                      https://YOUR_BACKEND_URL/auth/google/callback
                    </code>
                  </li>
                  <li>Copy Client ID + Secret into your backend <code style={{ background: 'var(--bg4)', padding: '2px 5px', borderRadius: 4 }}>.env</code></li>
                  <li>Go to Calendar tab → click "+ Connect Google"</li>
                </ol>
              </div>
            </Section>
          )}

          {activeSection === 'about' && (
            <Section title="About MyComms" subtitle="Your personal unified communications hub">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                {[
                  { icon: '💬', label: 'WhatsApp', desc: 'Up to 5 accounts via whatsapp-web.js' },
                  { icon: '📧', label: 'Email', desc: 'Gmail, Google Workspace, Zoho via IMAP/SMTP' },
                  { icon: '📅', label: 'Calendar', desc: 'Google Calendar via official API' },
                  { icon: '🔄', label: 'Real-time', desc: 'Live messages via Socket.io' },
                ].map(f => (
                  <div key={f.label} style={{ padding: 16, borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 24, marginBottom: 8 }}>{f.icon}</div>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{f.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.5 }}>{f.desc}</div>
                  </div>
                ))}
              </div>
              <div style={{ padding: 16, borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--text2)', lineHeight: 1.8 }}>
                <strong style={{ color: 'var(--text)' }}>Deployment</strong><br />
                Frontend → GitHub Pages &nbsp;|&nbsp; Backend → Railway / Render / VPS<br />
                <a href="https://github.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>View on GitHub →</a>
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 4 }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = { ready: ['var(--green)', 'Connected'], qr: ['var(--amber)', 'Awaiting QR'], initializing: ['var(--blue)', 'Initializing'], disconnected: ['var(--red)', 'Disconnected'], error: ['var(--red)', 'Error'] };
  const [color, label] = map[status] || ['var(--text3)', status];
  return <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: `${color}22`, color }}>{label}</span>;
}

function EnvInstructions() {
  return (
    <div style={{ marginTop: 16, padding: 16, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--text2)', lineHeight: 1.8 }}>
      <strong style={{ color: 'var(--text)' }}>To add email accounts:</strong>
      <ol style={{ paddingLeft: 18, marginTop: 8 }}>
        <li>Copy <code style={{ background: 'var(--bg4)', padding: '1px 5px', borderRadius: 4 }}>.env.example</code> to <code style={{ background: 'var(--bg4)', padding: '1px 5px', borderRadius: 4 }}>.env</code> in your backend folder</li>
        <li>For Gmail/Workspace: Go to Google Account → Security → App Passwords → generate one for "Mail"</li>
        <li>For Zoho: accounts.zoho.in → Security → App Passwords → Generate</li>
        <li>Edit the <code style={{ background: 'var(--bg4)', padding: '1px 5px', borderRadius: 4 }}>EMAIL_ACCOUNTS</code> JSON in your .env file</li>
        <li>Restart the backend server</li>
      </ol>
    </div>
  );
}
