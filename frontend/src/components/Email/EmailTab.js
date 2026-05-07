import React, { useState, useEffect, useCallback } from 'react';
import { emailAPI } from '../../api';

const FOLDERS     = ['INBOX','Sent','Drafts','Spam','Trash'];
const FOLDER_ICONS = { INBOX:'📥', Sent:'📤', Drafts:'📝', Spam:'🚫', Trash:'🗑️' };

const parseName  = (s='') => { const m=s.match(/^"?([^"<]+)"?\s*</); return m?m[1].trim():s.split('@')[0]; };
const parseEmail = (s='') => { const m=s.match(/<([^>]+)>/); return m?m[1]:s; };
const initials   = (n='') => n.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase()||'?';
const strColor   = (s='') => {
  const p=['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'];
  let h=0; for(const c of s) h=c.charCodeAt(0)+((h<<5)-h);
  return p[Math.abs(h)%p.length];
};
const fmtDate = d => {
  if(!d) return '';
  const dt=new Date(d),now=new Date();
  return dt.toDateString()===now.toDateString()
    ? dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
    : dt.toLocaleDateString([],{month:'short',day:'numeric'});
};

// ── styles ────────────────────────────────────────────────
const inp = { padding:'9px 12px', borderRadius:8, border:'1.5px solid var(--border)', background:'var(--bg2)', color:'var(--text)', fontSize:13.5, outline:'none', width:'100%', boxSizing:'border-box' };
const lbl = { fontSize:12, fontWeight:600, color:'var(--text2)', letterSpacing:'.03em' };
const fieldCol = { display:'flex', flexDirection:'column', gap:5 };

// ── AddAccountModal ───────────────────────────────────────
function AddAccountModal({ type, onClose, onSaved }) {
  const [form,setForm]         = useState({ label:'', user:'', password:'' });
  const [saving,setSaving]     = useState(false);
  const [testing,setTesting]   = useState(false);
  const [testResult,setTestResult] = useState(null);
  const [error,setError]       = useState('');

  const isGmail=type==='gmail', isZoho=type==='zoho';
  const brandColor=isGmail?'#EA4335':'#E05D2E';
  const brandName =isGmail?'Gmail':'Zoho Mail';
  const set = k => e => { setForm(p=>({...p,[k]:e.target.value})); setTestResult(null); setError(''); };

  async function handleTest() {
    if(!form.label||!form.user||!form.password){ setError('Fill all fields.'); return; }
    setTesting(true); setTestResult(null); setError('');
    try { await emailAPI.addAccount({...form,type,testOnly:true}); setTestResult({ok:true,msg:'Connection successful!'}); }
    catch(e){ setTestResult({ok:false,msg:e.response?.data?.error||e.message}); }
    setTesting(false);
  }

  async function handleSave() {
    if(!form.label||!form.user){ setError('Label and email required.'); return; }
    if(!isZoho&&!form.password){ setError('Password required.'); return; }
    setSaving(true); setError('');
    try { await emailAPI.addAccount({...form,type}); onSaved(); }
    catch(e){ setError(e.response?.data?.error||e.message); }
    setSaving(false);
  }

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center'}} onClick={onClose}>
      <div style={{background:'var(--bg)',borderRadius:16,width:460,boxShadow:'0 24px 64px rgba(0,0,0,.25)',overflow:'hidden'}} onClick={e=>e.stopPropagation()}>
        <div style={{padding:'20px 24px 16px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',gap:12}}>
          <div style={{width:38,height:38,borderRadius:10,background:brandColor,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20}}>{isGmail?'📧':'📮'}</div>
          <div>
            <div style={{fontWeight:700,fontSize:15}}>Add {brandName}</div>
            <div style={{fontSize:12,color:'var(--text3)'}}>Connect to Mycomm</div>
          </div>
          <button onClick={onClose} style={{marginLeft:'auto',background:'none',border:'none',cursor:'pointer',fontSize:22,color:'var(--text3)'}}>×</button>
        </div>
        <div style={{padding:'20px 24px',display:'flex',flexDirection:'column',gap:14}}>
          {isGmail&&<div style={{background:'#fff8f0',border:'1px solid #fed7aa',borderRadius:10,padding:'10px 14px',fontSize:12.5,color:'#92400e'}}>ℹ️ Gmail requires an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" style={{color:'#c2410c',fontWeight:600}}>App Password</a>, not your regular password.</div>}
          <div style={fieldCol}><label style={lbl}>Label</label><input style={inp} placeholder="e.g. Work Gmail" value={form.label} onChange={set('label')}/></div>
          <div style={fieldCol}><label style={lbl}>Email address</label><input style={inp} type="email" placeholder={isGmail?'you@gmail.com':'you@yourdomain.in'} value={form.user} onChange={set('user')}/></div>
          {!isZoho&&<div style={fieldCol}><label style={lbl}>App Password</label><input style={inp} type="password" placeholder="••••••••••••••••" value={form.password} onChange={set('password')}/></div>}
          {isZoho&&<div style={{background:'#fff8f0',border:'1px solid #fed7aa',borderRadius:10,padding:'12px 14px',fontSize:12.5,color:'#92400e'}}>ℹ️ Zoho uses OAuth — no password needed. After saving, click <strong>Connect Zoho</strong> to authorise.</div>}
          {testResult&&<div style={{padding:'10px 14px',borderRadius:10,fontSize:13,background:testResult.ok?'#f0fdf4':'#fef2f2',border:`1px solid ${testResult.ok?'#bbf7d0':'#fecaca'}`,color:testResult.ok?'#166534':'#991b1b'}}>{testResult.ok?'✅':'❌'} {testResult.msg}</div>}
          {error&&<div style={{padding:'8px 12px',borderRadius:8,background:'#fef2f2',border:'1px solid #fecaca',fontSize:13,color:'#991b1b'}}>⚠️ {error}</div>}
        </div>
        <div style={{padding:'14px 24px 20px',borderTop:'1px solid var(--border)',display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button onClick={onClose} style={{padding:'8px 16px',borderRadius:8,border:'1px solid var(--border)',background:'none',cursor:'pointer',fontSize:13,color:'var(--text2)'}}>Cancel</button>
          {!isZoho&&<button onClick={handleTest} disabled={testing} style={{padding:'8px 16px',borderRadius:8,border:`1.5px solid ${brandColor}`,background:'none',cursor:'pointer',fontSize:13,color:brandColor,fontWeight:600}}>{testing?'Testing…':'Test Connection'}</button>}
          <button onClick={handleSave} disabled={saving} style={{padding:'8px 18px',borderRadius:8,border:'none',cursor:'pointer',fontSize:13,color:'#fff',fontWeight:600,background:brandColor}}>{saving?'Saving…':`Add ${brandName}`}</button>
        </div>
      </div>
    </div>
  );
}

// ── Main EmailTab ─────────────────────────────────────────
export default function EmailTab() {
  const [accounts,setAccounts]           = useState([]);
  const [activeAccount,setActiveAccount] = useState(null);
  const [activeFolder,setActiveFolder]   = useState('INBOX');
  const [emails,setEmails]               = useState([]);
  const [total,setTotal]                 = useState(0);
  const [page,setPage]                   = useState(1);
  const [activeEmail,setActiveEmail]     = useState(null);
  const [emailBody,setEmailBody]         = useState(null);
  const [loadingList,setLoadingList]     = useState(false);
  const [loadingBody,setLoadingBody]     = useState(false);
  const [fetchError,setFetchError]       = useState('');
  const [searchQ,setSearchQ]             = useState('');
  const [searchResults,setSearchResults] = useState(null);
  const [composing,setComposing]         = useState(false);
  const [compose,setCompose]             = useState({to:'',cc:'',subject:'',body:'',fromAccount:null});
  const [sending,setSending]             = useState(false);
  const [folders,setFolders]             = useState([]);
  const [selectedEmails,setSelectedEmails] = useState(new Set());
  const [addModal,setAddModal]           = useState(null);

  // ── Load accounts ─────────────────────────────────────
  const loadAccounts = useCallback(() => {
    emailAPI.getAccounts().then(accs => {
      const seen=new Set();
      const unique=accs.filter(a=>{ const k=a.user.toLowerCase()+'|'+a.type; if(seen.has(k)) return false; seen.add(k); return true; });
      setAccounts(unique);
      // Do NOT auto-select — user must click an account
    }).catch(console.error);
  }, []);

  useEffect(() => { emailAPI.deduplicateAccounts().catch(()=>{}).finally(()=>loadAccounts()); }, [loadAccounts]);

  useEffect(() => {
    const h = e => {
      if(e.data?.type==='ZOHO_AUTH_SUCCESS') loadAccounts();
      if(e.data?.type==='ZOHO_AUTH_ERROR') alert('Zoho error: '+e.data.error);
    };
    window.addEventListener('message',h);
    return ()=>window.removeEventListener('message',h);
  },[loadAccounts]);

  async function connectZoho(accountId) {
    try { const {url}=await emailAPI.getZohoAuthUrl(accountId); window.open(url,'_blank','width=520,height=640'); }
    catch(e){ alert('Zoho auth error: '+(e.response?.data?.error||e.message)); }
  }

  async function handleDeleteAccount(id) {
    if(!window.confirm('Remove this email account?')) return;
    await emailAPI.deleteAccount(id).catch(()=>{});
    if(activeAccount===id){ setActiveAccount(null); setEmails([]); setActiveEmail(null); }
    loadAccounts();
  }

  // ── Select account ────────────────────────────────────
  function selectAccount(id) {
    setActiveAccount(id);
    setPage(1);
    setActiveFolder('INBOX');
    setActiveEmail(null);
    setEmailBody(null);
    setSearchResults(null);
    setSearchQ('');
    setFetchError('');
    setEmails([]);
  }

  // ── Load folders ──────────────────────────────────────
  useEffect(() => {
    if(!activeAccount) return;
    emailAPI.getFolders(activeAccount).then(setFolders).catch(()=>{});
  },[activeAccount]);

  // ── Load emails ───────────────────────────────────────
  const loadEmails = useCallback(async () => {
    if(!activeAccount) return;
    setLoadingList(true); setActiveEmail(null); setEmailBody(null); setSearchResults(null);
    try {
      const r=await emailAPI.getMessages(activeAccount,{folder:activeFolder,page,limit:50});
      setEmails(r.emails||[]); setTotal(r.total||0); setFetchError('');
    } catch(e) {
      const data=e.response?.data;
      if(data?.needsAuth) setFetchError('ZOHO_NOT_CONNECTED');
      else setFetchError(data?.error||e.message||'Failed to load emails');
    }
    setLoadingList(false);
  },[activeAccount,activeFolder,page]);

  useEffect(()=>{ loadEmails(); },[loadEmails]);

  // ── Open email ────────────────────────────────────────
  async function openEmail(email) {
    setActiveEmail(email); setEmailBody(null); setLoadingBody(true);
    try {
      const body=await emailAPI.getBody(activeAccount,email.uid,activeFolder);
      setEmailBody(body);
    } catch(e) {
      setEmailBody({ htmlBody:'', textBody:e.response?.data?.error||e.message||'Failed to load content', error:true });
    }
    setLoadingBody(false);
  }

  async function deleteEmail(uid,folder) {
    if(!window.confirm('Delete this email?')) return;
    try { await emailAPI.delete(activeAccount,uid,folder); setEmails(p=>p.filter(e=>e.uid!==uid)); if(activeEmail?.uid===uid){setActiveEmail(null);setEmailBody(null);} }
    catch(e){ alert('Delete failed: '+e.message); }
  }

  async function deleteSelected() {
    if(!selectedEmails.size||!window.confirm(`Delete ${selectedEmails.size} email(s)?`)) return;
    for(const uid of selectedEmails) await emailAPI.delete(activeAccount,uid,activeFolder).catch(()=>{});
    setEmails(p=>p.filter(e=>!selectedEmails.has(e.uid))); setSelectedEmails(new Set());
  }

  async function doSearch(q) {
    if(!q.trim()){ setSearchResults(null); return; }
    setLoadingList(true);
    try { setSearchResults(await emailAPI.search(activeAccount,q,activeFolder)); } catch(e){ console.error(e); }
    setLoadingList(false);
  }

  // ── Send email ────────────────────────────────────────
  async function sendEmail() {
    const fromId = compose.fromAccount || activeAccount;
    if(!fromId){ alert('Select a From account.'); return; }
    if(!compose.to||!compose.subject){ alert('To and Subject are required.'); return; }
    setSending(true);
    try {
      await emailAPI.send(fromId,{
        to:compose.to, cc:compose.cc, subject:compose.subject,
        text:compose.body,
        html:'<div>'+compose.body.replace(/\n/g,'<br>')+'</div>',
      });
      setComposing(false);
      setCompose({to:'',cc:'',subject:'',body:'',fromAccount:null});
      alert('✅ Email sent successfully!');
    } catch(e){
      alert('❌ Failed to send: '+(e.response?.data?.error||e.message));
    }
    setSending(false);
  }

  function openCompose(prefill={}) {
    setCompose({ to:'', cc:'', subject:'', body:'', fromAccount:activeAccount, ...prefill });
    setComposing(true);
  }

  function toggleSelect(uid) {
    setSelectedEmails(p=>{ const n=new Set(p); n.has(uid)?n.delete(uid):n.add(uid); return n; });
  }

  const displayList    = searchResults??emails;
  const gmailAccs      = accounts.filter(a=>a.type==='gmail');
  const zohoAccs       = accounts.filter(a=>a.type==='zoho');
  const activeAcc      = accounts.find(a=>a.id===activeAccount);
  const zohoNeedsConn  = activeAcc?.type==='zoho'&&!activeAcc?.zohoConnected;
  const accentColor    = activeAcc?.type==='zoho'?'#E05D2E':'#EA4335';

  return (
    <div className="tab-layout">

      {/* ── Header ── */}
      <div className="tab-header">
        <span className="tab-title">📧 Email</span>
        {activeAccount && (
          <div className="search-bar">
            <span style={{color:'var(--text3)'}}>🔍</span>
            <input value={searchQ} onChange={e=>{setSearchQ(e.target.value);if(!e.target.value)setSearchResults(null);}} onKeyDown={e=>e.key==='Enter'&&doSearch(searchQ)} placeholder="Search emails…"/>
            {searchQ&&<button className="compose-action" onClick={()=>{setSearchQ('');setSearchResults(null);}}>×</button>}
          </div>
        )}
        <button className="btn btn-primary" onClick={()=>openCompose()} disabled={!activeAccount}>✏️ Compose</button>
      </div>

      {/* ── Body ── */}
      <div className="tab-body">

        {/* ── LEFT PANEL: Accounts + Folders ── */}
        <div className="panel-left" style={{width:220,display:'flex',flexDirection:'column',overflow:'hidden'}}>
          <div style={{overflowY:'auto',flex:1}}>

            {/* Gmail accounts */}
            <div style={{padding:'10px 14px 4px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <span style={{fontSize:11,fontWeight:700,color:'var(--text3)',letterSpacing:'.07em',textTransform:'uppercase'}}>Gmail</span>
              <button onClick={()=>setAddModal('gmail')} style={{fontSize:11,color:'#EA4335',background:'none',border:'none',cursor:'pointer',fontWeight:700}}>+ Add</button>
            </div>
            {gmailAccs.length===0&&<div style={{padding:'4px 14px 8px',fontSize:12,color:'var(--text3)'}}>No Gmail accounts</div>}
            {gmailAccs.map(acc=>(
              <div key={acc.id} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 14px',cursor:'pointer',borderRadius:6,margin:'1px 6px',background:activeAccount===acc.id?'var(--accent-t)':'transparent',position:'relative'}} onClick={()=>selectAccount(acc.id)}>
                <div style={{width:28,height:28,borderRadius:'50%',background:'#EA4335',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,color:'#fff',fontWeight:700,flexShrink:0}}>{acc.label[0].toUpperCase()}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:activeAccount===acc.id?700:500,color:activeAccount===acc.id?'#EA4335':'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{acc.label}</div>
                  <div style={{fontSize:11,color:'var(--text3)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{acc.user}</div>
                </div>
                <button onClick={e=>{e.stopPropagation();handleDeleteAccount(acc.id);}} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text3)',fontSize:14,opacity:0,position:'absolute',right:8}} className="acc-del-btn" title="Remove">×</button>
              </div>
            ))}

            {/* Zoho accounts */}
            <div style={{padding:'10px 14px 4px',display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:4}}>
              <span style={{fontSize:11,fontWeight:700,color:'var(--text3)',letterSpacing:'.07em',textTransform:'uppercase'}}>Zoho Mail</span>
              <button onClick={()=>setAddModal('zoho')} style={{fontSize:11,color:'#E05D2E',background:'none',border:'none',cursor:'pointer',fontWeight:700}}>+ Add</button>
            </div>
            {zohoAccs.length===0&&<div style={{padding:'4px 14px 8px',fontSize:12,color:'var(--text3)'}}>No Zoho accounts</div>}
            {zohoAccs.map(acc=>(
              <div key={acc.id}>
                <div style={{display:'flex',alignItems:'center',gap:8,padding:'7px 14px',cursor:'pointer',borderRadius:6,margin:'1px 6px',background:activeAccount===acc.id?'rgba(224,93,46,0.1)':'transparent',position:'relative'}} onClick={()=>selectAccount(acc.id)}>
                  <div style={{width:28,height:28,borderRadius:'50%',background:acc.zohoConnected?'#E05D2E':'#9ca3af',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,color:'#fff',fontWeight:700,flexShrink:0}}>{acc.label[0].toUpperCase()}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:activeAccount===acc.id?700:500,color:activeAccount===acc.id?'#E05D2E':'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{acc.label}</div>
                    <div style={{fontSize:11,color:'var(--text3)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{acc.user}</div>
                  </div>
                  {!acc.zohoConnected&&<span style={{fontSize:9,background:'#fef9c3',color:'#854d0e',border:'1px solid #fde047',borderRadius:4,padding:'1px 4px',fontWeight:600,flexShrink:0}}>AUTH</span>}
                </div>
                {!acc.zohoConnected&&<button onClick={()=>connectZoho(acc.id)} style={{margin:'2px 14px 6px',fontSize:11,padding:'4px 10px',borderRadius:6,border:'1.5px solid #E05D2E',background:'none',color:'#E05D2E',cursor:'pointer',fontWeight:600,width:'calc(100% - 28px)'}}>🔗 Connect Zoho</button>}
              </div>
            ))}

            {/* Folders — only show when account selected */}
            {activeAccount && (
              <>
                <div style={{padding:'12px 14px 4px',borderTop:'1px solid var(--border)',marginTop:8}}>
                  <span style={{fontSize:11,fontWeight:700,color:'var(--text3)',letterSpacing:'.07em',textTransform:'uppercase'}}>Folders</span>
                </div>
                {FOLDERS.map(f=>(
                  <button key={f} onClick={()=>{setActiveFolder(f);setPage(1);setSearchResults(null);setSearchQ('');}} style={{display:'flex',alignItems:'center',gap:8,width:'100%',padding:'7px 14px',border:'none',cursor:'pointer',borderRadius:6,background:activeFolder===f?'var(--accent-t)':'transparent',color:activeFolder===f?'var(--accent)':'var(--text2)',fontSize:13}}>
                    {FOLDER_ICONS[f]||'📁'} {f}
                  </button>
                ))}
                {folders.filter(f=>!FOLDERS.includes(f.name)).slice(0,15).map(f=>(
                  <button key={f.name} onClick={()=>{setActiveFolder(f.name);setPage(1);}} style={{display:'flex',alignItems:'center',gap:8,width:'100%',padding:'6px 14px',border:'none',cursor:'pointer',background:activeFolder===f.name?'var(--accent-t)':'transparent',color:'var(--text3)',fontSize:12.5}}>
                    📁 {f.label||f.name}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>

        {/* ── MIDDLE: Email list ── */}
        <div style={{width:340,borderRight:'1px solid var(--border)',display:'flex',flexDirection:'column',overflow:'hidden',background:'var(--bg2)',flexShrink:0}}>

          {/* Selected account banner */}
          {activeAcc ? (
            <div style={{padding:'10px 14px',borderBottom:'1px solid var(--border)',background:'var(--bg)',display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
              <div style={{width:32,height:32,borderRadius:'50%',background:accentColor,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,color:'#fff',fontWeight:700,flexShrink:0}}>{activeAcc.label[0].toUpperCase()}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:13,color:'var(--text)'}}>{activeAcc.label}</div>
                <div style={{fontSize:11,color:'var(--text3)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{activeAcc.user}</div>
              </div>
              <span style={{fontSize:10,padding:'2px 8px',borderRadius:20,background:activeAcc.type==='gmail'?'#fef2f2':'#fff8f0',color:accentColor,fontWeight:600,border:`1px solid ${accentColor}44`}}>{activeAcc.type==='gmail'?'Gmail':'Zoho'}</span>
            </div>
          ) : (
            <div style={{padding:'14px',borderBottom:'1px solid var(--border)',fontSize:13,color:'var(--text3)',textAlign:'center',background:'var(--bg)'}}>← Select an account</div>
          )}

          {/* Toolbar */}
          {activeAcc && (
            <div style={{padding:'8px 12px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
              <input type="checkbox" onChange={e=>setSelectedEmails(e.target.checked?new Set(displayList.map(m=>m.uid)):new Set())} checked={selectedEmails.size===displayList.length&&displayList.length>0} style={{cursor:'pointer'}}/>
              {selectedEmails.size>0
                ? <><span style={{fontSize:12,color:'var(--text2)'}}>{selectedEmails.size} selected</span><button className="btn btn-danger btn-sm" onClick={deleteSelected}>🗑 Delete</button></>
                : <span style={{fontSize:12,color:'var(--text3)'}}>{searchResults?`${searchResults.length} results`:`${displayList.length} of ${total}`}</span>
              }
              <div style={{marginLeft:'auto',display:'flex',gap:4}}>
                <button className="btn btn-ghost btn-sm" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1}>‹</button>
                <button className="btn btn-ghost btn-sm" onClick={()=>setPage(p=>p+1)} disabled={emails.length<50}>›</button>
                <button className="btn btn-ghost btn-sm" onClick={loadEmails}>↻</button>
              </div>
            </div>
          )}

          <div className="panel-scroll">
            {!activeAccount && (
              <div className="empty-state" style={{padding:40}}>
                <div className="empty-icon">📧</div>
                <div className="empty-title">No account selected</div>
                <div className="empty-sub">Choose an account from the left panel</div>
              </div>
            )}
            {activeAccount && zohoNeedsConn && (
              <div style={{margin:'12px 14px',padding:'14px',background:'#fff8f0',border:'1px solid #fed7aa',borderRadius:10,fontSize:13,color:'#92400e',lineHeight:1.7}}>
                <div style={{fontWeight:600,marginBottom:8}}>📮 Zoho not connected</div>
                <div style={{fontSize:12.5,marginBottom:10}}>Authorise access to read emails from this account.</div>
                <button onClick={()=>connectZoho(activeAccount)} style={{padding:'6px 16px',background:'#E05D2E',color:'#fff',border:'none',borderRadius:8,fontWeight:600,fontSize:13,cursor:'pointer'}}>🔗 Connect Zoho</button>
              </div>
            )}
            {activeAccount && fetchError && fetchError!=='ZOHO_NOT_CONNECTED' && !zohoNeedsConn && (
              <div style={{margin:'12px 14px',padding:'10px 14px',background:'rgba(220,38,38,0.08)',border:'1px solid rgba(220,38,38,0.25)',borderRadius:8,fontSize:12.5,color:'var(--red)',lineHeight:1.6}}>⚠️ {fetchError}</div>
            )}
            {activeAccount && loadingList && <div style={{padding:20,color:'var(--text3)',textAlign:'center',fontSize:13}}>Loading…</div>}
            {activeAccount && !loadingList && !fetchError && !zohoNeedsConn && displayList.length===0 && (
              <div className="empty-state" style={{padding:30}}><div className="empty-icon" style={{fontSize:32}}>📭</div><div className="empty-sub">No emails here.</div></div>
            )}
            {displayList.map(email=>(
              <div key={email.uid} className={`list-item ${activeEmail?.uid===email.uid?'active':''} ${!email.isRead?'unread':''}`} onClick={()=>openEmail(email)}>
                <input type="checkbox" checked={selectedEmails.has(email.uid)} onChange={e=>{e.stopPropagation();toggleSelect(email.uid);}} onClick={e=>e.stopPropagation()} style={{flexShrink:0,marginTop:2}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                    <span style={{fontSize:13,color:'var(--text)',fontWeight:!email.isRead?600:400,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:160}}>{parseName(email.from)}</span>
                    <span style={{fontSize:11,color:'var(--text3)',flexShrink:0}}>{fmtDate(email.date)}</span>
                  </div>
                  <div className="email-subject">{email.subject}</div>
                  <div className="email-preview">{email.snippet}</div>
                </div>
                {!email.isRead&&<div className="unread-dot"/>}
              </div>
            ))}
          </div>
        </div>

        {/* ── RIGHT: Email detail ── */}
        <div className="panel-right">
          {!activeEmail ? (
            <div className="empty-state">
              <div className="empty-icon">📧</div>
              <div className="empty-title">{activeAccount?'Select an email':'Select an account first'}</div>
              <div className="empty-sub">{activeAccount?'Choose an email from the list to read it.':'Pick a Gmail or Zoho account from the left.'}</div>
            </div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',height:'100%',overflow:'hidden'}}>
              <div style={{padding:'16px 22px',borderBottom:'1px solid var(--border)',background:'var(--bg2)',flexShrink:0}}>
                <div style={{fontSize:18,fontWeight:700,marginBottom:10}}>{activeEmail.subject}</div>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                  <div className="avatar" style={{background:strColor(activeEmail.from),flexShrink:0}}>{initials(parseName(activeEmail.from))}</div>
                  <div>
                    <div style={{fontWeight:600,fontSize:14}}>{parseName(activeEmail.from)}</div>
                    <div style={{fontSize:12,color:'var(--text3)'}}>{parseEmail(activeEmail.from)} → {activeEmail.to}</div>
                    {activeEmail.date&&<div style={{fontSize:11,color:'var(--text3)',marginTop:2}}>{new Date(activeEmail.date).toLocaleString()}</div>}
                  </div>
                  <div style={{marginLeft:'auto',display:'flex',gap:6}}>
                    <button className="btn btn-sm" onClick={()=>openCompose({to:activeEmail.from,subject:activeEmail.subject.startsWith('Re:')?activeEmail.subject:`Re: ${activeEmail.subject}`,body:`\n\n--- Original ---\nFrom: ${activeEmail.from}\n${emailBody?.textBody||''}`})}>↩ Reply</button>
                    <button className="btn btn-sm" onClick={()=>openCompose({subject:`Fwd: ${activeEmail.subject}`,body:`\n\n--- Forwarded ---\nFrom: ${activeEmail.from}\n${emailBody?.textBody||''}`})}>→ Fwd</button>
                    <button className="btn btn-danger btn-sm" onClick={()=>deleteEmail(activeEmail.uid,activeFolder)}>🗑</button>
                  </div>
                </div>
              </div>
              <div style={{flex:1,overflow:'auto'}}>
                {loadingBody&&<div style={{padding:24,color:'var(--text3)',textAlign:'center'}}>Loading…</div>}
                {emailBody&&(
                  emailBody.htmlBody
                    ? <iframe srcDoc={emailBody.htmlBody} title="email" style={{width:'100%',height:'100%',minHeight:400,border:'none',background:'#fff'}} sandbox="allow-same-origin allow-popups"/>
                    : <div style={{padding:22,color:emailBody.error?'var(--red)':'var(--text)',lineHeight:1.7,fontSize:14,whiteSpace:'pre-wrap'}}>{emailBody.textBody||'(No content)'}</div>
                )}
                {emailBody?.attachments?.length>0&&(
                  <div style={{padding:'12px 22px',borderTop:'1px solid var(--border)'}}>
                    <div style={{fontSize:12,color:'var(--text3)',marginBottom:8}}>Attachments ({emailBody.attachments.length})</div>
                    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                      {emailBody.attachments.map((a,i)=>(
                        <div key={i} style={{padding:'6px 12px',borderRadius:8,border:'1px solid var(--border)',fontSize:13,color:'var(--text2)',display:'flex',alignItems:'center',gap:6}}>
                          📎 {a.filename||'attachment'} <span style={{color:'var(--text3)',fontSize:11}}>({Math.round((a.size||0)/1024)}KB)</span>
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
      {composing&&(
        <div className="modal-overlay" onClick={()=>setComposing(false)}>
          <div className="modal" style={{width:600}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              {compose.subject?.startsWith('Re:')?'↩ Reply':compose.subject?.startsWith('Fwd:')?'→ Forward':'✏️ New Email'}
              <button className="modal-close" onClick={()=>setComposing(false)}>×</button>
            </div>
            <div className="modal-body" style={{gap:10}}>
              <div className="field">
                <label>From *</label>
                <select className="input" value={compose.fromAccount||activeAccount||''} onChange={e=>setCompose({...compose,fromAccount:e.target.value})}>
                  <option value="">— Select account —</option>
                  {accounts.map(a=><option key={a.id} value={a.id}>{a.label} &lt;{a.user}&gt;</option>)}
                </select>
              </div>
              <div className="field"><label>To *</label><input className="input" placeholder="recipient@email.com" value={compose.to} onChange={e=>setCompose({...compose,to:e.target.value})}/></div>
              <div className="field"><label>CC</label><input className="input" placeholder="cc@email.com" value={compose.cc} onChange={e=>setCompose({...compose,cc:e.target.value})}/></div>
              <div className="field"><label>Subject *</label><input className="input" placeholder="Subject" value={compose.subject} onChange={e=>setCompose({...compose,subject:e.target.value})}/></div>
              <div className="field"><label>Message</label><textarea className="input" rows={10} placeholder="Write your email…" value={compose.body} onChange={e=>setCompose({...compose,body:e.target.value})}/></div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={()=>setComposing(false)}>Discard</button>
              <button className="btn btn-primary" onClick={sendEmail} disabled={sending}>{sending?'Sending…':'Send ➤'}</button>
            </div>
          </div>
        </div>
      )}

      {addModal&&<AddAccountModal type={addModal} onClose={()=>setAddModal(null)} onSaved={()=>{setAddModal(null);loadAccounts();}}/>}

      <style>{`.acc-del-btn { opacity: 0 !important; } .panel-left div:hover > .acc-del-btn { opacity: 1 !important; }`}</style>
    </div>
  );
}
