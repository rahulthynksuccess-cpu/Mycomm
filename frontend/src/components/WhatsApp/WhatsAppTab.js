import React, { useState, useEffect, useRef, useCallback } from 'react';
import { waAPI } from '../../api';

const initials = (n='') => n.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase()||'?';
const strColor = (s='') => {
  const c=['#5b4fcf','#2d6a4f','#7b2d8b','#1a5276','#784212','#6d4c41','#37474f','#1b6ca8'];
  let h=0; for(const x of s) h=x.charCodeAt(0)+((h<<5)-h);
  return c[Math.abs(h)%c.length];
};
const IST = 'Asia/Kolkata';
const fmtTime = (ts, full=false) => {
  if(!ts) return '';
  const d=new Date(ts*1000), now=new Date();
  const todayIST=now.toLocaleDateString('en-IN',{timeZone:IST});
  const dateIST =d.toLocaleDateString('en-IN',{timeZone:IST});
  const timeStr =d.toLocaleTimeString('en-IN',{timeZone:IST,hour:'2-digit',minute:'2-digit',hour12:true});
  if(full) return todayIST===dateIST ? timeStr : d.toLocaleDateString('en-IN',{timeZone:IST,day:'numeric',month:'short',year:'2-digit'})+', '+timeStr;
  return todayIST===dateIST ? timeStr : d.toLocaleDateString('en-IN',{timeZone:IST,day:'numeric',month:'short'});
};
// FIX #1: Only strip raw JID strings, never strip saved contact names
const cleanName = n => {
  if (!n) return '';
  if (n.includes('@')) return n.split('@')[0].split(':')[0].replace(/\D/g, '');
  return n;
};

const STATUS_COLOR = { ready:'#25d366', qr:'#f59e0b', initializing:'#3b82f6', authenticated:'#3b82f6', disconnected:'#ef4444', error:'#ef4444', auth_failure:'#ef4444' };

export default function WhatsAppTab({ socket, statuses, setWaStatuses, qrCodes, realtimeMessages, pushedChats={}, setPushedChats }) {
  const [chats,          setChats]          = useState({});
  const [activeAccount,  setActiveAccount]  = useState(null);
  const [activeChat,     setActiveChat]     = useState(null);
  const [messages,       setMessages]       = useState([]);
  const [reply,          setReply]          = useState('');
  const [loading,        setLoading]        = useState(false);
  const [addingSession,  setAddingSession]  = useState(false);
  const [newAccountId,   setNewAccountId]   = useState('');
  const [showQR,         setShowQR]         = useState(null);
  const [qrTimeout,      setQrTimeout]      = useState(false);
  const [msgLimit,       setMsgLimit]       = useState(200);
  const [showNewChat,    setShowNewChat]     = useState(false);
  const [newChatNumber,  setNewChatNumber]  = useState('');
  const [newChatMsg,     setNewChatMsg]     = useState('');
  const [newChatSending, setNewChatSending] = useState(false);
  const [newChatError,   setNewChatError]   = useState('');
  const [chatSearch,     setChatSearch]     = useState('');

  const messagesEndRef     = useRef(null);
  const scrollContainerRef = useRef(null);
  const prevChatId         = useRef(null);
  const qrTimerRef         = useRef(null);

  // ── Merge pushed chats — FIX #2: only replace if new list is non-empty and larger/newer ─────
  useEffect(() => {
    if(!pushedChats||!Object.keys(pushedChats).length) return;
    setChats(prev => {
      const next={...prev};
      for(const [id,list] of Object.entries(pushedChats)) {
        if(Array.isArray(list)&&list.length>0) {
          // Keep the larger list — pushed updates can be partial
          if(!next[id]||list.length>=next[id].length) next[id]=list;
        }
      }
      return next;
    });
  },[pushedChats]);

  // ── Derived ────────────────────────────────────────
  const allAccounts  = Object.entries(statuses);
  const currentChats = activeAccount?(chats[activeAccount]||[]):[];
  const activeStatus = activeAccount?statuses[activeAccount]:null;
  const showQRStatus = showQR?statuses[showQR]:null;
  const hasError     = showQRStatus?.status==='error'||qrTimeout;

  const filteredChats = chatSearch.trim()
    ? currentChats.filter(c=>(c.name||'').toLowerCase().includes(chatSearch.toLowerCase()))
    : currentChats;

  // ── Load chats ─────────────────────────────────────
  const loadChats = useCallback(async (accountId) => {
    if(!accountId) return;
    const attempt = async () => {
      try {
        const c=await waAPI.getChats(accountId,1000);
        if(Array.isArray(c)&&c.length>0){ setChats(prev=>({...prev,[accountId]:c})); return true; }
        return false;
      } catch(e){ return false; }
    };
    const got=await attempt();
    // FIX: Retry several times — server may still be loading cache from DB
    if(!got) {
      for(const delay of [3000,6000,12000,25000]) {
        await new Promise(r=>setTimeout(r,delay));
        const ok=await attempt();
        if(ok) break;
      }
    }
  },[]);

  const activeStatus2 = statuses[activeAccount]?.status;
  useEffect(()=>{ 
    if(activeAccount&&activeStatus2==='ready') loadChats(activeAccount); 
  },[activeStatus2,activeAccount]);

  // FIX: Also load via HTTP if pushed chats are empty for the active account
  useEffect(()=>{
    if(!activeAccount) return;
    const accountChats=chats[activeAccount];
    const isReady=statuses[activeAccount]?.status==='ready';
    if(isReady&&(!accountChats||accountChats.length===0)) {
      loadChats(activeAccount);
    }
  },[chats,activeAccount,statuses]);

  // ── Close QR when ready ────────────────────────────
  useEffect(() => {
    if(!showQR) return;
    const s=statuses[showQR]?.status;
    if(s==='ready'||s==='authenticated'){ clearTimeout(qrTimerRef.current); setShowQR(null); setQrTimeout(false); }
  },[statuses,showQR]);

  // ── Realtime messages ──────────────────────────────
  useEffect(() => {
    if(!realtimeMessages.length) return;
    const msg=realtimeMessages[0];
    if(msg.accountId===activeAccount&&activeChat&&msg.chatId===activeChat.id) {
      setMessages(prev=>[...prev,{id:msg.id,body:msg.body,fromMe:false,timestamp:msg.timestamp,type:'chat'}]);
    }
    if(msg.accountId===activeAccount) {
      waAPI.getChats(msg.accountId).then(c=>setChats(prev=>({...prev,[msg.accountId]:c}))).catch(()=>{});
    }
  },[realtimeMessages]);

  // ── Scroll handling — FIX #3: preserve position when loading older msgs ──
  const handleScroll = useCallback(async () => {
    const el=scrollContainerRef.current;
    if(!el||!activeChat||!activeAccount) return;
    if(el.scrollTop<80) {
      const nl=msgLimit+100; setMsgLimit(nl);
      // Capture scroll height before loading so we can restore position
      const prevScrollHeight=el.scrollHeight;
      const prevScrollTop=el.scrollTop;
      try {
        const m=await waAPI.getMessages(activeAccount,activeChat.id,nl);
        if(m?.length) {
          setMessages(m);
          // Restore scroll position after new messages prepended
          requestAnimationFrame(()=>{
            const newScrollHeight=el.scrollHeight;
            el.scrollTop=prevScrollTop+(newScrollHeight-prevScrollHeight);
          });
        }
      } catch(_) {}
    }
  },[activeChat,activeAccount,msgLimit]);

  // Scroll to bottom only when near bottom (don't interrupt user scrolling up)
  useEffect(() => {
    const el=scrollContainerRef.current;
    if(!el||!messages.length) return;
    const nearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<200;
    if(nearBottom) messagesEndRef.current?.scrollIntoView({behavior:'smooth'});
  },[messages]);

  // On chat switch: always jump to bottom instantly
  useEffect(() => {
    if(!messages.length) return;
    if(activeChat?.id!==prevChatId.current){
      prevChatId.current=activeChat?.id;
      setTimeout(()=>messagesEndRef.current?.scrollIntoView({behavior:'instant'}),60);
    }
  },[messages,activeChat?.id]);

  // ── Session management ─────────────────────────────
  async function startSession(accountId) {
    setQrTimeout(false); clearTimeout(qrTimerRef.current);
    try {
      const s=statuses[accountId]?.status;
      if(s&&!['ready','initializing','authenticated'].includes(s)) {
        await waAPI.removeSession(accountId).catch(()=>{});
        setWaStatuses(prev=>{const n={...prev};delete n[accountId];return n;});
        await new Promise(r=>setTimeout(r,1000));
      }
      setShowQR(accountId);
      await waAPI.addSession(accountId);
      qrTimerRef.current=setTimeout(()=>setQrTimeout(true),90000);
    } catch(e) {
      const msg=e.response?.data?.error||e.message||'Unknown error';
      setWaStatuses(prev=>({...prev,[accountId]:{...(prev[accountId]||{}),status:'error',error:msg}}));
      setQrTimeout(true);
    }
  }

  async function removeAccount(accountId) {
    if(!window.confirm(`Remove WhatsApp account "${accountId}"?`)) return;
    await waAPI.removeSession(accountId).catch(()=>{});
    setWaStatuses(prev=>{const n={...prev};delete n[accountId];return n;});
    if(activeAccount===accountId){setActiveAccount(null);setActiveChat(null);setMessages([]);}
  }

  function handleInitialize() {
    const id=newAccountId.trim()||`wa${Date.now()}`;
    setAddingSession(false); setNewAccountId('');
    startSession(id);
  }

  function closeQR(){ setShowQR(null); setQrTimeout(false); clearTimeout(qrTimerRef.current); }

  // ── Select account ─────────────────────────────────
  function selectAccount(id) {
    setActiveAccount(id);
    setActiveChat(null);
    setMessages([]);
    setChatSearch('');
    if(statuses[id]?.status==='ready') loadChats(id);
  }

  // ── Chat & messaging ───────────────────────────────
  async function openChat(chat) {
    setActiveChat(chat); setMessages([]); setMsgLimit(500); setLoading(true);
    setChats(prev=>({...prev,[activeAccount]:(prev[activeAccount]||[]).map(c=>c.id===chat.id?{...c,unreadCount:0}:c)}));
    try {
      // FIX #3: load up to 500 msgs (backend returns LATEST 500 sorted oldest→newest)
      const m=await waAPI.getMessages(activeAccount,chat.id,500);
      setMessages(m);
    }
    catch(e){ console.error(e); }
    setLoading(false);
    // Always scroll to bottom after loading — show most recent messages first
    setTimeout(()=>messagesEndRef.current?.scrollIntoView({behavior:'instant'}),80);
  }

  async function sendNewChat() {
    const num=newChatNumber.replace(/\D/g,'');
    if(!num||num.length<7){setNewChatError('Enter a valid number with country code');return;}
    if(!newChatMsg.trim()){setNewChatError('Enter a message');return;}
    if(!activeAccount){setNewChatError('Select an account first');return;}
    setNewChatSending(true); setNewChatError('');
    try {
      const jid=num+'@s.whatsapp.net';
      await waAPI.send(activeAccount,jid,newChatMsg.trim());
      openChat({id:jid,name:newChatNumber,isGroup:false,unreadCount:0,lastMessage:newChatMsg.trim(),lastMessageTime:Math.floor(Date.now()/1000)});
      setShowNewChat(false); setNewChatNumber(''); setNewChatMsg('');
    } catch(e){ setNewChatError(e.response?.data?.error||e.message); }
    setNewChatSending(false);
  }

  async function sendMessage() {
    if(!reply.trim()||!activeChat||!activeAccount) return;
    const text=reply.trim(); setReply('');
    try {
      await waAPI.send(activeAccount,activeChat.id,text);
      setMessages(prev=>[...prev,{id:`local-${Date.now()}`,body:text,fromMe:true,timestamp:Math.floor(Date.now()/1000),type:'chat'}]);
    } catch(e){ alert('Failed: '+(e.response?.data?.error||e.message)); setReply(text); }
  }

  const s=activeStatus;

  return (
    <div className="tab-layout">
      <div className="tab-header">
        <span className="tab-title">💬 WhatsApp</span>
        {activeAccount && s?.status==='ready' && (
          <button className="btn btn-sm" onClick={()=>setShowNewChat(true)}>✏️ New Chat</button>
        )}
        <button className="btn btn-primary" onClick={()=>setAddingSession(true)}>+ Add Account</button>
      </div>

      <div className="tab-body">

        {/* ── LEFT PANEL: Accounts + Chats ── */}
        <div className="panel-left" style={{width:280,display:'flex',flexDirection:'column',overflow:'hidden'}}>

          {/* Accounts section */}
          <div style={{flexShrink:0,borderBottom:'1px solid var(--border)',padding:'10px 12px 8px'}}>
            <div style={{fontSize:11,fontWeight:700,color:'var(--text3)',letterSpacing:'.07em',textTransform:'uppercase',marginBottom:6}}>
              WhatsApp Accounts ({allAccounts.length})
            </div>
            {allAccounts.length===0 && (
              <div style={{fontSize:12,color:'var(--text3)',padding:'4px 0'}}>No accounts yet — click + Add Account</div>
            )}
            {allAccounts.map(([id,st])=>(
              <div key={id} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 8px',borderRadius:8,cursor:'pointer',background:activeAccount===id?'var(--accent-t)':'transparent',marginBottom:2}} onClick={()=>selectAccount(id)}>
                {/* Avatar with status dot */}
                <div style={{position:'relative',flexShrink:0}}>
                  <div style={{width:32,height:32,borderRadius:'50%',background:strColor(st.name||id),display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,color:'#fff',fontWeight:700}}>
                    {initials(st.name||id)}
                  </div>
                  <div style={{position:'absolute',bottom:0,right:0,width:10,height:10,borderRadius:'50%',background:STATUS_COLOR[st.status]||'#9ca3af',border:'2px solid var(--bg2)'}}/>
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:activeAccount===id?700:500,color:activeAccount===id?'var(--accent)':'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{st.name||id}</div>
                  <div style={{fontSize:11,color:'var(--text3)'}}>{st.phone?'+'+st.phone:st.status}</div>
                </div>
                <div style={{display:'flex',gap:4,flexShrink:0}}>
                  {st.status==='qr'&&<button onClick={e=>{e.stopPropagation();setShowQR(id);}} style={{fontSize:10,background:'#f59e0b',color:'#fff',border:'none',borderRadius:4,padding:'2px 6px',cursor:'pointer'}}>QR</button>}
                  {['disconnected','error','auth_failure'].includes(st.status)&&<button onClick={e=>{e.stopPropagation();startSession(id);}} style={{fontSize:10,background:'#ef4444',color:'#fff',border:'none',borderRadius:4,padding:'2px 6px',cursor:'pointer'}}>↺</button>}
                  <button onClick={e=>{e.stopPropagation();removeAccount(id);}} style={{fontSize:14,background:'none',border:'none',cursor:'pointer',color:'var(--text3)',lineHeight:1,padding:'0 2px'}} title="Remove">×</button>
                </div>
              </div>
            ))}
          </div>

          {/* Chats section */}
          {!activeAccount ? (
            <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
              <div style={{textAlign:'center',color:'var(--text3)',fontSize:13}}>
                <div style={{fontSize:28,marginBottom:8}}>💬</div>
                Select an account to see chats
              </div>
            </div>
          ) : s?.status!=='ready' ? (
            <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:20,gap:12}}>
              <div style={{fontSize:32}}>{['initializing','authenticated'].includes(s?.status)?'⏳':s?.status==='qr'?'📱':'❌'}</div>
              <div style={{fontSize:13,color:'var(--text3)',textAlign:'center',lineHeight:1.6}}>
                {s?.status==='initializing'&&'Starting up…'}
                {s?.status==='authenticated'&&'Authenticated, loading…'}
                {s?.status==='qr'&&'Scan QR to connect'}
                {s?.status==='disconnected'&&'Disconnected'}
                {s?.status==='error'&&('Error: '+(s?.error||'unknown'))}
                {s?.status==='auth_failure'&&'Auth failed'}
              </div>
              {s?.status==='qr'&&<button className="btn btn-primary btn-sm" onClick={()=>setShowQR(activeAccount)}>Show QR Code</button>}
              {['disconnected','error','auth_failure'].includes(s?.status)&&<button className="btn btn-primary btn-sm" onClick={()=>startSession(activeAccount)}>🔄 Reconnect</button>}
            </div>
          ) : (
            <>
              {/* Chat search */}
              <div style={{padding:'8px 12px',borderBottom:'1px solid var(--border)',flexShrink:0}}>
                <input value={chatSearch} onChange={e=>setChatSearch(e.target.value)} placeholder="Search chats…" style={{width:'100%',padding:'6px 10px',borderRadius:8,border:'1px solid var(--border)',background:'var(--bg2)',color:'var(--text)',fontSize:13,outline:'none',boxSizing:'border-box'}}/>
              </div>
              <div className="panel-scroll">
                {filteredChats.length===0&&(
                  <div style={{padding:20,textAlign:'center',color:'var(--text3)',fontSize:13}}>{chatSearch?'No results':'No chats yet'}</div>
                )}
                {filteredChats.map(chat=>(
                  <div key={chat.id} className={`list-item ${activeChat?.id===chat.id?'active':''}`} style={{position:'relative'}} onClick={()=>openChat(chat)}>
                    <div className="avatar" style={{background:strColor(chat.name),flexShrink:0}}>
                      {chat.isGroup?'👥':initials(chat.name)}
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                        <span style={{fontSize:13.5,color:'var(--text)',fontWeight:chat.unreadCount?600:400,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:160}}>{cleanName(chat.name)||chat.id}</span>
                        <span style={{fontSize:11,color:'var(--text3)',flexShrink:0}}>{fmtTime(chat.lastMessageTime)}</span>
                      </div>
                      <div className="email-preview">{chat.lastMessage||'…'}</div>
                    </div>
                    {chat.unreadCount>0&&(
                      <div style={{position:'absolute',top:12,right:12,background:'#25d366',color:'#fff',borderRadius:'50%',width:18,height:18,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:700}}>{chat.unreadCount}</div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── RIGHT PANEL ── */}
        <div className="panel-right">
          {!activeChat ? (
            <div className="empty-state">
              <div className="empty-icon">💬</div>
              <div className="empty-title">{activeAccount?'Select a chat':'Select an account'}</div>
              <div className="empty-sub">{activeAccount?'Pick a conversation from the left.':'Choose a WhatsApp account from the left panel.'}</div>
            </div>
          ) : (
            <>
              {/* Chat header — shows selected account + chat info */}
              <div style={{padding:'12px 18px',borderBottom:'1px solid var(--border)',background:'var(--bg2)',display:'flex',alignItems:'center',gap:12,flexShrink:0}}>
                <div className="avatar" style={{background:strColor(activeChat.name)}}>{activeChat.isGroup?'👥':initials(activeChat.name)}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:14}}>{cleanName(activeChat.name)||activeChat.id}</div>
                  <div style={{fontSize:12,color:'var(--text3)',display:'flex',alignItems:'center',gap:6}}>
                    {activeChat.isGroup&&<span>Group ·</span>}
                    <span style={{display:'flex',alignItems:'center',gap:4}}>
                      <div style={{width:8,height:8,borderRadius:'50%',background:STATUS_COLOR[statuses[activeAccount]?.status]||'#9ca3af'}}/>
                      {statuses[activeAccount]?.name||activeAccount}
                      {statuses[activeAccount]?.phone&&<span>· +{statuses[activeAccount].phone}</span>}
                    </span>
                  </div>
                </div>
                <button className="btn btn-sm" onClick={()=>loadChats(activeAccount)}>↻</button>
              </div>

              {/* Messages */}
              <div className="panel-scroll" ref={scrollContainerRef} onScroll={handleScroll} style={{background:'var(--bg)'}}>
                <div className="bubble-wrap">
                  {loading&&<div style={{color:'var(--text3)',textAlign:'center',fontSize:13,padding:20}}>Loading messages…</div>}
                  {!loading&&messages.length===0&&<div style={{color:'var(--text3)',textAlign:'center',fontSize:13,padding:40}}>No messages</div>}
                  {messages.filter(m=>m.type!=='protocolMessage'&&m.type!=='senderKeyDistributionMessage'&&(m.body||m.type==='chat')).map((m,i)=>(
                    <div key={m.id||i} className={`bubble-row ${m.fromMe?'me':''}`}>
                      {!m.fromMe&&<div className="avatar avatar-sm" style={{background:strColor(activeChat.name)}}>{initials(activeChat.name)}</div>}
                      <div>
                        <div className={`bubble ${m.fromMe?'me':'them'}`}>{m.body||<em style={{opacity:.5}}>[{m.type}]</em>}</div>
                        <div className="bubble-time">{fmtTime(m.timestamp,true)}</div>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef}/>
                </div>
              </div>

              {/* Compose */}
              <div className="compose-wrap">
                <div className="compose-box">
                  <textarea placeholder={`Message ${cleanName(activeChat.name)||activeChat.id}…`} value={reply} onChange={e=>setReply(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}}} rows={2}/>
                  <div className="compose-toolbar">
                    <label style={{cursor:'pointer',padding:'6px 8px',color:'var(--text3)',fontSize:18,lineHeight:1}} title="Attach">
                      📎<input type="file" style={{display:'none'}} onChange={e=>{const f=e.target.files[0];if(f)alert('File sending coming soon: '+f.name);e.target.value='';}}/>
                    </label>
                    <button className="btn btn-primary" style={{marginLeft:'auto'}} onClick={sendMessage}>Send ➤</button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Add Account modal ── */}
      {addingSession&&(
        <div className="modal-overlay" onClick={()=>setAddingSession(false)}>
          <div className="modal" style={{width:420}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">Add WhatsApp Account<button className="modal-close" onClick={()=>setAddingSession(false)}>×</button></div>
            <div className="modal-body">
              <p style={{color:'var(--text2)',fontSize:13,lineHeight:1.6}}>A QR code will appear. Open WhatsApp → Linked Devices → Link a Device → scan.</p>
              <div className="field">
                <label>Account label (optional)</label>
                <input className="input" placeholder="e.g. personal, work" value={newAccountId} onChange={e=>setNewAccountId(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleInitialize()} autoFocus/>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={()=>setAddingSession(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleInitialize}>Initialize →</button>
            </div>
          </div>
        </div>
      )}

      {/* ── New Chat modal ── */}
      {showNewChat&&(
        <div className="modal-overlay" onClick={()=>setShowNewChat(false)}>
          <div className="modal" style={{width:420}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">✏️ New Chat<button className="modal-close" onClick={()=>setShowNewChat(false)}>×</button></div>
            <div className="modal-body">
              <div className="field"><label>Phone number (with country code)</label><input className="input" placeholder="919876543210" value={newChatNumber} onChange={e=>setNewChatNumber(e.target.value)} autoFocus/></div>
              <div className="field"><label>First message</label><textarea className="input" rows={3} placeholder="Hello!" value={newChatMsg} onChange={e=>setNewChatMsg(e.target.value)}/></div>
              {newChatError&&<div style={{color:'var(--red)',fontSize:13}}>⚠️ {newChatError}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={()=>setShowNewChat(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={sendNewChat} disabled={newChatSending}>{newChatSending?'Sending…':'Send ➤'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── QR modal ── */}
      {showQR&&(
        <div className="qr-overlay" onClick={closeQR}>
          <div className="qr-card" onClick={e=>e.stopPropagation()}>
            <h3>Scan with WhatsApp</h3>
            <p>WhatsApp → Linked Devices → Link a Device</p>
            {qrCodes[showQR] ? (
              <img src={qrCodes[showQR]} alt="QR" style={{width:240,height:240,borderRadius:8,background:'#fff',padding:8}}/>
            ) : hasError ? (
              <div style={{width:240,height:240,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12,background:'var(--bg3)',borderRadius:8,padding:16}}>
                <div style={{fontSize:32}}>⚠️</div>
                <div style={{fontSize:12,color:'var(--red)',textAlign:'center'}}>{showQRStatus?.error||'QR timed out.'}</div>
                <button className="btn btn-primary" style={{width:'100%'}} onClick={()=>startSession(showQR)}>🔄 Retry</button>
              </div>
            ) : (
              <div style={{width:240,height:240,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12,background:'var(--bg3)',borderRadius:8}}>
                <div style={{fontSize:36}}>⏳</div>
                <div style={{fontSize:13,color:'var(--text3)',textAlign:'center',lineHeight:1.6}}>
                  {showQRStatus?.status==='initializing'?'Starting…':'Generating QR…'}<br/>
                  <span style={{fontSize:11}}>May take up to 60s</span>
                </div>
              </div>
            )}
            <div style={{marginTop:12,fontSize:12,color:'var(--text3)'}}>Account: <strong>{showQR}</strong></div>
            <button className="btn" style={{marginTop:14,width:'100%'}} onClick={closeQR}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
