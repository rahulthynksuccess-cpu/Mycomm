import React, { useState, useEffect, useCallback } from 'react';
import { emailAPI } from '../../api';

const FOLDERS = ['INBOX', 'Sent', 'Drafts', 'Spam', 'Trash'];
const FOLDER_ICONS = { INBOX: '📥', Sent: '📤', Drafts: '📝', Spam: '🚫', Trash: '🗑️' };

const parseName  = (s = '') => { const m = s.match(/^"?([^"<]+)"?\s*</); return m ? m[1].trim() : s.split('@')[0]; };
const parseEmail = (s = '') => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s; };
const initials   = (n = '') => n.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
const strColor   = (s = '') => {
  const palette = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'];
  let h = 0; for (const c of s) h = c.charCodeAt(0) + ((h << 5) - h);
  return palette[Math.abs(h) % palette.length];
};
const fmtDate = d => {
  if (!d) return '';
  const dt = new Date(d), now = new Date();
  return dt.toDateString() === now.toDateString()
    ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

// ── styles ───────────────────────────────────────────────────────────────────
const overlay  = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const modalBox = { background: 'var(--bg)', borderRadius: 16, width: 460, boxShadow: '0 24px 64px rgba(0,0,0,.25)', overflow: 'hidden' };
const fieldCol = { display: 'flex', flexDirection: 'column', gap: 5 };
const lbl      = { fontSize: 12, fontWeight: 600, color: 'var(--text2)', letterSpacing: '.03em' };
const inp      = { padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13.5, outline: 'none' };
const btnGhost   = { padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--text2)' };
const btnOutline = (color) => ({ padding: '8px 16px', borderRadius: 8, border: `1.5px solid ${color}`, background: 'none', cursor: 'pointer', fontSize: 13, color, fontWeight: 600 });
const btnFill    = (color) => ({ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, color: '#fff', fontWeight: 600, background: color });

// ── AddAccountModal ───────────────────────────────────────────────────────────
function AddAccountModal({ type, onClose, onSaved }) {
  const [form, setForm]         = useState({ label: '', user: '', password: '' });
  const [saving, setSaving]     = useState(false);
  const [testing, setTesting]   = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError]       = useState('');

  const isGmail    = type === 'gmail';
  const brandColor = isGmail ? '#EA4335' : '#E05D2E';
  const brandName  = isGmail ? 'Gmail' : 'Zoho Mail';
  const set        = k => e => { setForm(p => ({ ...p, [k]: e.target.value })); setTestResult(null); setError(''); };

  async function handleTest() {
    if (!form.label || !form.user || !form.password) { setError('Fill all fields before testing.'); return; }
    setTesting(true); setTestResult(null); setError('');
    try {
      await emailAPI.addAccount({ ...form, type, testOnly: true });
      setTestResult({ ok: true, msg: 'Connection successful! Credentials are valid.' });
    } catch (e) {
      setTestResult({ ok: false, msg: e.response?.data?.error || e.message || 'Connection failed.' });
    }
    setTesting(false);
  }

  async function handleSave() {
    if (!form.label || !form.user || !form.password) { setError('All fields are required.'); return; }
    setSaving(true); setError('');
    try {
      await emailAPI.addAccount({ ...form, type });
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
    setSaving(false);
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modalBox} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: brandColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>
            {isGmail ? '📧' : '📮'}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>Add {brandName} Account</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>Connect your {brandName} to Mycomm</div>
          </div>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: 'var(--text3)', lineHeight: 1, padding: '0 2px' }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {isGmail && (
            <div style={{ background: '#fff8f0', border: '1px solid #fed7aa', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, color: '#92400e', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>ℹ️</span>
              <span>Gmail requires an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" style={{ color: '#c2410c', fontWeight: 600 }}>App Password</a> — not your regular password. 2-Step Verification must be enabled on your Google account.</span>
            </div>
          )}
          <div style={fieldCol}>
            <label style={lbl}>Label</label>
            <input style={inp} placeholder="e.g. Work, Personal…" value={form.label} onChange={set('label')} />
          </div>
          <div style={fieldCol}>
            <label style={lbl}>Email address</label>
            <input style={inp} type="email" placeholder={isGmail ? 'you@gmail.com' : 'you@zohomail.com'} value={form.user} onChange={set('user')} />
          </div>
          <div style={fieldCol}>
            <label style={lbl}>{isGmail ? 'App Password' : 'Password'}</label>
            <input style={inp} type="password" placeholder="••••••••••••••••" value={form.password} onChange={set('password')} />
          </div>

          {testResult && (
            <div style={{
              padding: '10px 14px', borderRadius: 10, fontSize: 13, display: 'flex', gap: 10, alignItems: 'center',
              background: testResult.ok ? '#f0fdf4' : '#fef2f2',
              border: `1px solid ${testResult.ok ? '#bbf7d0' : '#fecaca'}`,
              color: testResult.ok ? '#166534' : '#991b1b',
            }}>
              <span style={{ fontSize: 20, flexShrink: 0 }}>{testResult.ok ? '✅' : '❌'}</span>
              <span>{testResult.msg}</span>
            </div>
          )}

          {error && (
            <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', fontSize: 13, color: '#991b1b' }}>
              ⚠️ {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={handleTest} disabled={testing} style={btnOutline(brandColor)}>
            {testing ? '⏳ Testing…' : '🔗 Test Connection'}
          </button>
          <button onClick={handleSave} disabled={saving} style={btnFill(brandColor)}>
            {saving ? 'Saving…' : `Add ${brandName}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── AccountSection ────────────────────────────────────────────────────────────
function AccountSection({ label, icon, color, accounts, activeAccount, onSelect, onDelete, onAdd, noBorderRight }) {
  return (
    <div style={{ borderRight: noBorderRight ? 'none' : '1px solid var(--border)', minWidth: 230, flexShrink: 0 }}>
      <div style={{ padding: '7px 14px 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', letterSpacing: '.07em', textTransform: 'uppercase' }}>{label}</span>
        <span style={{ fontSize: 15, marginLeft: 'auto' }}>{icon}</span>
      </div>
      <div style={{ display: 'flex', padding: '0 10px 10px', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {accounts.length === 0 && (
          <span style={{ fontSize: 12, color: 'var(--text3)', padding: '4px 2px' }}>No accounts added</span>
        )}
        {accounts.map(acc => (
          <div
            key={acc.id}
            onClick={() => onSelect(acc.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px 5px 7px',
              borderRadius: 20, cursor: 'pointer',
              border: activeAccount === acc.id ? `1.5px solid ${color}` : '1px solid var(--border)',
              background: activeAccount === acc.id ? `${color}18` : 'var(--bg2)',
              transition: 'all .15s',
            }}
          >
            <div style={{ width: 22, height: 22, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', fontWeight: 700, flexShrink: 0 }}>
              {acc.label[0].toUpperCase()}
            </div>
            <div style={{ textAlign: 'left', minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap', color: activeAccount === acc.id ? color : 'var(--text)' }}>{acc.label}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}>{acc.user}</div>
            </div>
            <button
              onClick={e => { e.stopPropagation(); onDelete(acc.id); }}
              style={{ marginLeft: 2, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 15, lineHeight: 1, padding: '0 1px' }}
              title="Remove account"
            >×</button>
          </div>
        ))}
        <button
          onClick={onAdd}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px',
            borderRadius: 20, border: `1.5px dashed ${color}66`,
            background: 'none', cursor: 'pointer', fontSize: 12, color, fontWeight: 600,
            transition: 'all .15s',
          }}
        >
          + Add
        </button>
      </div>
    </div>
  );
}

// ── Main EmailTab ─────────────────────────────────────────────────────────────
export default function EmailTab() {
  const [accounts, setAccounts]           = useState([]);
  const [activeAccount, setActiveAccount] = useState(null);
  const [activeFolder, setActiveFolder]   = useState('INBOX');
  const [emails, setEmails]               = useState([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(1);
  const [activeEmail, setActiveEmail]     = useState(null);
  const [emailBody, setEmailBody]         = useState(null);
  const [loadingList, setLoadingList]     = useState(false);
  const [loadingBody, setLoadingBody]     = useState(false);
  const [searchQ, setSearchQ]             = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [composing, setComposing]         = useState(false);
  const [compose, setCompose]             = useState({ to: '', cc: '', subject: '', body: '' });
  const [sending, setSending]             = useState(false);
  const [folders, setFolders]             = useState([]);
  const [selectedEmails, setSelectedEmails] = useState(new Set());
  const [addModal, setAddModal]           = useState(null); // null | 'gmail' | 'zoho'

  const loadAccounts = useCallback(() => {
    emailAPI.getAccounts().then(accs => {
      setAccounts(accs);
      if (accs.length) setActiveAccount(prev => prev || accs[0].id);
    }).catch(console.error);
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  async function handleDeleteAccount(id) {
    if (!window.confirm('Remove this email account?')) return;
    await emailAPI.deleteAccount(id).catch(() => {});
    if (activeAccount === id) setActiveAccount(null);
    loadAccounts();
  }

  useEffect(() => {
    if (!activeAccount) return;
    emailAPI.getFolders(activeAccount).then(setFolders).catch(() => {});
  }, [activeAccount]);

  const loadEmails = useCallback(async () => {
    if (!activeAccount) return;
    setLoadingList(true); setActiveEmail(null); setEmailBody(null); setSearchResults(null);
    try {
      const r = await emailAPI.getMessages(activeAccount, { folder: activeFolder, page, limit: 50 });
      setEmails(r.emails || []); setTotal(r.total || 0);
    } catch (e) { console.error(e); }
    setLoadingList(false);
  }, [activeAccount, activeFolder, page]);

  useEffect(() => { loadEmails(); }, [loadEmails]);

  async function openEmail(email) {
    setActiveEmail(email); setEmailBody(null); setLoadingBody(true);
    try {
      const body = await emailAPI.getBody(activeAccount, email.uid, activeFolder);
      setEmailBody(body);
    } catch (e) { console.error(e); }
    setLoadingBody(false);
  }

  async function deleteEmail(uid, folder) {
    if (!window.confirm('Delete this email?')) return;
    try {
      await emailAPI.delete(activeAccount, uid, folder);
      setEmails(prev => prev.filter(e => e.uid !== uid));
      if (activeEmail?.uid === uid) { setActiveEmail(null); setEmailBody(null); }
    } catch (e) { alert('Delete failed: ' + e.message); }
  }

  async function deleteSelected() {
    if (!selectedEmails.size || !window.confirm(`Delete ${selectedEmails.size} email(s)?`)) return;
    for (const uid of selectedEmails) await emailAPI.delete(activeAccount, uid, activeFolder).catch(() => {});
    setEmails(prev => prev.filter(e => !selectedEmails.has(e.uid)));
    setSelectedEmails(new Set());
  }

  async function flagEmail(uid, flagName, add) {
    try {
      await emailAPI.flag(activeAccount, uid, { name: flagName, add }, activeFolder);
      setEmails(prev => prev.map(e => e.uid === uid
        ? { ...e, flags: add ? [...e.flags, flagName] : e.flags.filter(f => f !== flagName) } : e));
    } catch (e) { console.error(e); }
  }

  async function doSearch(q) {
    if (!q.trim()) { setSearchResults(null); return; }
    setLoadingList(true);
    try { setSearchResults(await emailAPI.search(activeAccount, q, activeFolder)); } catch (e) { console.error(e); }
    setLoadingList(false);
  }

  async function sendEmail() {
    if (!compose.to || !compose.subject) { alert('To and Subject are required.'); return; }
    setSending(true);
    try {
      await emailAPI.send(activeAccount, {
        to: compose.to, cc: compose.cc, subject: compose.subject,
        text: compose.body, html: compose.body.replace(/\n/g, '<br>'),
      });
      setComposing(false); setCompose({ to: '', cc: '', subject: '', body: '' });
      alert('Email sent!');
    } catch (e) { alert('Failed to send: ' + e.message); }
    setSending(false);
  }

  function replyTo(email) {
    setCompose({
      to: email.from, cc: '',
      subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      body: `\n\n--- Original message ---\nFrom: ${email.from}\n${emailBody?.textBody || ''}`,
    });
    setComposing(true);
  }

  function toggleSelect(uid) {
    setSelectedEmails(prev => { const n = new Set(prev); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });
  }

  const displayList = searchResults ?? emails;
  const gmailAccs   = accounts.filter(a => a.type === 'gmail');
  const zohoAccs    = accounts.filter(a => a.type === 'zoho');

  return (
    <div className="tab-layout">

      {/* ── Header ── */}
      <div className="tab-header">
        <span className="tab-title">📧 Email</span>
        <div className="search-bar">
          <span style={{ color: 'var(--text3)' }}>🔍</span>
          <input
            value={searchQ}
            onChange={e => { setSearchQ(e.target.value); if (!e.target.value) setSearchResults(null); }}
            onKeyDown={e => e.key === 'Enter' && doSearch(searchQ)}
            placeholder="Search emails…"
          />
          {searchQ && <button className="compose-action" onClick={() => { setSearchQ(''); setSearchResults(null); }}>×</button>}
        </div>
        <button className="btn btn-primary" onClick={() => setComposing(true)}>✏️ Compose</button>
      </div>

      {/* ── Accounts bar ── */}
      <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0 }}>
        <div style={{ display: 'flex', overflowX: 'auto' }}>
          <AccountSection
            label="Gmail" icon="📧" color="#EA4335"
            accounts={gmailAccs} activeAccount={activeAccount}
            onSelect={id => { setActiveAccount(id); setPage(1); setActiveFolder('INBOX'); }}
            onDelete={handleDeleteAccount}
            onAdd={() => setAddModal('gmail')}
          />
          <AccountSection
            label="Zoho Mail" icon="📮" color="#E05D2E"
            accounts={zohoAccs} activeAccount={activeAccount}
            onSelect={id => { setActiveAccount(id); setPage(1); setActiveFolder('INBOX'); }}
            onDelete={handleDeleteAccount}
            onAdd={() => setAddModal('zoho')}
            noBorderRight
          />
        </div>
      </div>

      {/* ── Body ── */}
      <div className="tab-body">

        {/* Sidebar */}
        <div className="panel-left" style={{ width: 180 }}>
          <div style={{ overflowY: 'auto', flex: 1, paddingTop: 6 }}>
            <div className="section-label">Folders</div>
            {FOLDERS.map(f => (
              <button
                key={f}
                onClick={() => { setActiveFolder(f); setPage(1); setSearchResults(null); setSearchQ(''); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '8px 14px', border: 'none', cursor: 'pointer', borderRadius: 6,
                  background: activeFolder === f ? 'var(--accent-t)' : 'transparent',
                  color: activeFolder === f ? 'var(--accent)' : 'var(--text2)',
                  fontSize: 13.5,
                }}
              >
                {FOLDER_ICONS[f] || '📁'} {f}
              </button>
            ))}
            {folders.filter(f => !FOLDERS.includes(f.name)).slice(0, 20).map(f => (
              <button
                key={f.name}
                onClick={() => { setActiveFolder(f.name); setPage(1); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '7px 14px', border: 'none', cursor: 'pointer',
                  background: activeFolder === f.name ? 'var(--accent-t)' : 'transparent',
                  color: 'var(--text3)', fontSize: 12.5,
                }}
              >
                📁 {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Email list */}
        <div style={{ width: 340, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg2)', flexShrink: 0 }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              onChange={e => setSelectedEmails(e.target.checked ? new Set(displayList.map(m => m.uid)) : new Set())}
              checked={selectedEmails.size === displayList.length && displayList.length > 0}
              style={{ cursor: 'pointer' }}
            />
            {selectedEmails.size > 0 ? (
              <>
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>{selectedEmails.size} selected</span>
                <button className="btn btn-danger btn-sm" onClick={deleteSelected}>🗑 Delete</button>
              </>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                {searchResults ? `${searchResults.length} results` : `${displayList.length} of ${total}`}
              </span>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>‹</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setPage(p => p + 1)} disabled={emails.length < 50}>›</button>
              <button className="btn btn-ghost btn-sm" onClick={loadEmails}>↻</button>
            </div>
          </div>

          <div className="panel-scroll">
            {loadingList && <div style={{ padding: 20, color: 'var(--text3)', textAlign: 'center', fontSize: 13 }}>Loading…</div>}
            {!loadingList && displayList.length === 0 && (
              <div className="empty-state" style={{ minHeight: 'unset', padding: 30 }}>
                <div className="empty-icon" style={{ fontSize: 32 }}>📭</div>
                <div className="empty-sub">No emails here.</div>
              </div>
            )}
            {displayList.map(email => (
              <div
                key={email.uid}
                className={`list-item ${activeEmail?.uid === email.uid ? 'active' : ''} ${!email.isRead ? 'unread' : ''}`}
                onClick={() => openEmail(email)}
              >
                <input
                  type="checkbox" checked={selectedEmails.has(email.uid)}
                  onChange={e => { e.stopPropagation(); toggleSelect(email.uid); }}
                  onClick={e => e.stopPropagation()}
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <button
                  className="compose-action"
                  style={{ flexShrink: 0, fontSize: 16, color: email.isStarred ? '#fbbf24' : 'var(--text3)' }}
                  onClick={e => { e.stopPropagation(); flagEmail(email.uid, '\\Flagged', !email.isStarred); }}
                >★</button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: !email.isRead ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
                      {parseName(email.from)}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>{fmtDate(email.date)}</span>
                  </div>
                  <div className="email-subject">{email.subject}</div>
                  <div className="email-preview">{email.snippet}</div>
                </div>
                {!email.isRead && <div className="unread-dot" />}
              </div>
            ))}
          </div>
        </div>

        {/* Email detail */}
        <div className="panel-right">
          {!activeEmail ? (
            <div className="empty-state">
              <div className="empty-icon">📧</div>
              <div className="empty-title">Select an email</div>
              <div className="empty-sub">Choose an email from the list to read it here.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
              <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', flexShrink: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>{activeEmail.subject}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div className="avatar" style={{ background: strColor(activeEmail.from), flexShrink: 0 }}>
                    {initials(parseName(activeEmail.from))}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{parseName(activeEmail.from)}</div>
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>{parseEmail(activeEmail.from)} → {activeEmail.to}</div>
                    {activeEmail.date && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{new Date(activeEmail.date).toLocaleString()}</div>}
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button className="btn btn-sm" onClick={() => replyTo(activeEmail)}>↩ Reply</button>
                    <button className="btn btn-sm" onClick={() => { setCompose({ ...compose, to: '', subject: `Fwd: ${activeEmail.subject}`, body: `\n\n--- Forwarded message ---\nFrom: ${activeEmail.from}\n${emailBody?.textBody || ''}` }); setComposing(true); }}>→ Forward</button>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteEmail(activeEmail.uid, activeFolder)}>🗑</button>
                  </div>
                </div>
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                {loadingBody && <div style={{ padding: 24, color: 'var(--text3)', textAlign: 'center' }}>Loading…</div>}
                {emailBody && (
                  emailBody.htmlBody
                    ? <iframe srcDoc={emailBody.htmlBody} title="email" style={{ width: '100%', height: '100%', minHeight: 400, border: 'none', background: '#fff' }} sandbox="allow-same-origin" />
                    : <div style={{ padding: 22, color: 'var(--text)', lineHeight: 1.7, fontSize: 14, whiteSpace: 'pre-wrap' }}>{emailBody.textBody}</div>
                )}
                {emailBody?.attachments?.length > 0 && (
                  <div style={{ padding: '12px 22px', borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>Attachments ({emailBody.attachments.length})</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {emailBody.attachments.map((a, i) => (
                        <div key={i} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          📎 {a.filename || 'attachment'} <span style={{ color: 'var(--text3)', fontSize: 11 }}>({Math.round(a.size / 1024)}KB)</span>
                          <a href={`data:${a.contentType};base64,${a.content}`} download={a.filename} style={{ color: 'var(--accent)', fontSize: 12 }}>↓</a>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Compose modal ── */}
      {composing && (
        <div className="modal-overlay" onClick={() => setComposing(false)}>
          <div className="modal" style={{ width: 600 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              {compose.subject?.startsWith('Re:') ? '↩ Reply' : compose.subject?.startsWith('Fwd:') ? '→ Forward' : '✏️ New Email'}
              <button className="modal-close" onClick={() => setComposing(false)}>×</button>
            </div>
            <div className="modal-body" style={{ gap: 10 }}>
              <div className="field">
                <label>From</label>
                <select className="input" value={activeAccount} onChange={e => setActiveAccount(e.target.value)}>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.label} &lt;{a.user}&gt;</option>)}
                </select>
              </div>
              <div className="field"><label>To *</label><input className="input" placeholder="recipient@email.com" value={compose.to} onChange={e => setCompose({ ...compose, to: e.target.value })} /></div>
              <div className="field"><label>CC</label><input className="input" placeholder="cc@email.com" value={compose.cc} onChange={e => setCompose({ ...compose, cc: e.target.value })} /></div>
              <div className="field"><label>Subject *</label><input className="input" placeholder="Subject" value={compose.subject} onChange={e => setCompose({ ...compose, subject: e.target.value })} /></div>
              <div className="field"><label>Message</label><textarea className="input" rows={10} placeholder="Write your email…" value={compose.body} onChange={e => setCompose({ ...compose, body: e.target.value })} /></div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setComposing(false)}>Discard</button>
              <button className="btn btn-primary" onClick={sendEmail} disabled={sending}>{sending ? 'Sending…' : 'Send Email ➤'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Account Modal ── */}
      {addModal && (
        <AddAccountModal
          type={addModal}
          onClose={() => setAddModal(null)}
          onSaved={() => { setAddModal(null); loadAccounts(); }}
        />
      )}
    </div>
  );
}
