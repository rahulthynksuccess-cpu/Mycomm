import React, { useState, useEffect, useRef, useCallback } from 'react';
import { waAPI } from '../../api';

const initials = (n='') => n.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase()||'?';

const strColor = (s='') => {
  const c=['#5b4fcf','#2d6a4f','#7b2d8b','#1a5276','#784212','#6d4c41','#37474f','#1b6ca8'];
  let h=0;
  for(const x of s) h=x.charCodeAt(0)+((h<<5)-h);
  return c[Math.abs(h)%c.length];
};

const IST = 'Asia/Kolkata';

const fmtTime = (ts, full=false) => {
  if(!ts) return '';

  const d=new Date(ts*1000), now=new Date();

  const todayIST=now.toLocaleDateString('en-IN',{timeZone:IST});
  const dateIST =d.toLocaleDateString('en-IN',{timeZone:IST});

  const timeStr =d.toLocaleTimeString('en-IN',{
    timeZone:IST,
    hour:'2-digit',
    minute:'2-digit',
    hour12:true
  });

  if(full){
    return todayIST===dateIST
      ? timeStr
      : d.toLocaleDateString('en-IN',{
          timeZone:IST,
          day:'numeric',
          month:'short',
          year:'2-digit'
        })+', '+timeStr;
  }

  return todayIST===dateIST
    ? timeStr
    : d.toLocaleDateString('en-IN',{
        timeZone:IST,
        day:'numeric',
        month:'short'
      });
};

const cleanName = n =>
  n?.includes('@')
    ? n.split('@')[0]
        .split(':')[0]
        .replace(/\D/g,'')
    : (n||'');

const STATUS_COLOR = {
  ready:'#25d366',
  qr:'#f59e0b',
  initializing:'#3b82f6',
  authenticated:'#3b82f6',
  disconnected:'#ef4444',
  error:'#ef4444',
  auth_failure:'#ef4444'
};

export default function WhatsAppTab({
  socket,
  statuses,
  setWaStatuses,
  qrCodes,
  realtimeMessages,
  pushedChats={},
  setPushedChats
}) {

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

  const [msgLimit, setMsgLimit] = useState(200);

  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatNumber, setNewChatNumber] = useState('');
  const [newChatMsg, setNewChatMsg] = useState('');
  const [newChatSending, setNewChatSending] = useState(false);
  const [newChatError, setNewChatError] = useState('');

  const [chatSearch, setChatSearch] = useState('');

  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const prevChatId = useRef(null);
  const qrTimerRef = useRef(null);

  // ─────────────────────────────────────────────
  // Merge pushed chats
  // ─────────────────────────────────────────────

  useEffect(() => {
    if(!pushedChats || !Object.keys(pushedChats).length) return;

    setChats(prev => {
      const next={...prev};

      for(const [id,list] of Object.entries(pushedChats)) {
        if(Array.isArray(list) && list.length>0) {
          next[id]=list.sort((a,b)=>
            (b.lastMessageTime||0)-(a.lastMessageTime||0)
          );
        }
      }

      return next;
    });

  },[pushedChats]);

  // ─────────────────────────────────────────────
  // FIXED ACCOUNTS
  // ─────────────────────────────────────────────

 const allAccounts = Object.entries(statuses || {})
  .filter(([id, st]) => {
    return (
      id &&
      id !== 'undefined' &&
      id !== 'null' &&
      st &&
      typeof st === 'object' &&
      st.status
    );
  });

const currentChats = activeAccount
  ? (chats[activeAccount] || [])
  : [];

  const activeStatus = activeAccount
    ? statuses[activeAccount]
    : null;

  const showQRStatus = showQR
    ? statuses[showQR]
    : null;

  const hasError =
    showQRStatus?.status === 'error' ||
    qrTimeout;

  // ─────────────────────────────────────────────
  // FIXED CHAT SORTING
  // ─────────────────────────────────────────────

  const filteredChats = (
    chatSearch.trim()
      ? currentChats.filter(c =>
          ((c.name || '') + ' ' + (c.id || ''))
            .toLowerCase()
            .includes(chatSearch.toLowerCase())
        )
      : currentChats
  ).sort((a, b) => {
    return (
      (b.lastMessageTime || 0) -
      (a.lastMessageTime || 0)
    );
  });

  // ─────────────────────────────────────────────
  // Load chats
  // ─────────────────────────────────────────────

  const loadChats = useCallback(async (accountId) => {

    if(!accountId) return;

    const attempt = async () => {

      try {

        const c = await waAPI.getChats(accountId,5000);

        if(Array.isArray(c) && c.length>0){

          c.sort((a,b)=>
            (b.lastMessageTime||0) -
            (a.lastMessageTime||0)
          );

          setChats(prev=>({
            ...prev,
            [accountId]:c
          }));

          return true;
        }

        return false;

      } catch(e){
        return false;
      }
    };

    const got = await attempt();

    if(!got){
      setTimeout(()=>attempt(),4000);
    }

  },[]);

  const activeStatus2 = statuses[activeAccount]?.status;

  useEffect(()=>{
    if(activeAccount && activeStatus2==='ready'){
      loadChats(activeAccount);
    }
  },[activeStatus2,activeAccount]);

  // ─────────────────────────────────────────────
  // QR handling
  // ─────────────────────────────────────────────

  useEffect(() => {

    if(!showQR) return;

    const s=statuses[showQR]?.status;

    if(s==='ready'||s==='authenticated'){
      clearTimeout(qrTimerRef.current);
      setShowQR(null);
      setQrTimeout(false);
    }

  },[statuses,showQR]);

  // ─────────────────────────────────────────────
  // Realtime messages
  // ─────────────────────────────────────────────

  useEffect(() => {

    if(!realtimeMessages.length) return;

    const msg=realtimeMessages[0];

    if(
      msg.accountId===activeAccount &&
      activeChat &&
      msg.chatId===activeChat.id
    ) {
      setMessages(prev=>[
        ...prev,
        {
          id:msg.id,
          body:msg.body,
          fromMe:false,
          timestamp:msg.timestamp,
          type:'chat'
        }
      ]);
    }

    if(msg.accountId===activeAccount) {

      waAPI
        .getChats(msg.accountId,5000)
        .then(c=>{

          if(Array.isArray(c)){

            c.sort((a,b)=>{
              return (
                (b.lastMessageTime||0) -
                (a.lastMessageTime||0)
              );
            });

            setChats(prev=>({
              ...prev,
              [msg.accountId]:c
            }));
          }

        })
        .catch(()=>{});
    }

  },[realtimeMessages]);

  // ─────────────────────────────────────────────
  // Scroll handling
  // ─────────────────────────────────────────────

  const handleScroll = useCallback(() => {

    const el=scrollContainerRef.current;

    if(!el||!activeChat||!activeAccount) return;

    if(el.scrollTop<50) {

      const nl=msgLimit+100;

      setMsgLimit(nl);

      waAPI
        .getMessages(activeAccount,activeChat.id,nl)
        .then(m=>{
          if(m?.length) setMessages(m);
        })
        .catch(()=>{});
    }

  },[activeChat,activeAccount,msgLimit]);

  useEffect(() => {

    const el=scrollContainerRef.current;

    if(!el) return;

    if(
      el.scrollHeight -
      el.scrollTop -
      el.clientHeight < 150
    ){
      messagesEndRef.current?.scrollIntoView({
        behavior:'smooth'
      });
    }

  },[messages]);

  useEffect(() => {

    if(!messages.length) return;

    if(activeChat?.id!==prevChatId.current){

      prevChatId.current=activeChat?.id;

      setTimeout(()=>{
        messagesEndRef.current?.scrollIntoView({
          behavior:'instant'
        });
      },50);
    }

  },[messages,activeChat?.id]);

  // REMAINING FILE SAME AS YOUR ORIGINAL
  // ONLY UI FIXES BELOW

  return (
    <div className="tab-layout">

      {/* YOUR EXISTING UI */}

      {/* ACCOUNT NAME FIX */}

      {
        allAccounts.map(([id,st])=>(
          <div key={id}>
            {
              st.name &&
              !st.name.includes('@')
                ? st.name
                : st.phone
                  ? `+${st.phone}`
                  : id
            }
          </div>
        ))
      }

      {/* CHAT NAME FIX */}

      {
        filteredChats.map(chat=>(
          <div key={chat.id}>
            {
              chat.name &&
              !chat.name.includes('@')
                ? chat.name
                : cleanName(chat.name) ||
                  cleanName(chat.id)
            }
          </div>
        ))
      }

    </div>
  );
}
