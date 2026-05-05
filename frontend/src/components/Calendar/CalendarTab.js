import React, { useState, useEffect, useCallback } from 'react';
import { calendarAPI } from '../../api';
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, isSameMonth, isSameDay, isToday,
  addMonths, subMonths, addWeeks, subWeeks, addDays, subDays,
  format, parseISO, startOfDay, endOfDay,
} from 'date-fns';

const VIEWS = ['month', 'week', 'day', 'agenda'];
const EVENT_COLORS = ['#7c5cfc','#3ecf8e','#60a5fa','#f472b6','#fbbf24','#f87171','#a78bfa','#34d399'];

export default function CalendarTab() {
  const [accounts, setAccounts]               = useState([]);
  const [calendars, setCalendars]             = useState({});
  const [events, setEvents]                   = useState([]);
  const [view, setView]                       = useState('month');
  const [currentDate, setCurrentDate]         = useState(new Date());
  const [selectedEvent, setSelectedEvent]     = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEventModal, setShowEventModal]   = useState(false);
  const [newEvent, setNewEvent]               = useState(defaultEvent());
  const [loading, setLoading]                 = useState(false);

  // Load accounts (Gmail email accounts + their OAuth status)
  const loadAccounts = useCallback(() => {
    calendarAPI.getAccounts().then(accs => {
      setAccounts(accs);
      // Load calendars for already-connected accounts
      accs.filter(a => a.isConnected).forEach(a => {
        calendarAPI.getCalendars(a.id).then(cals => {
          setCalendars(prev => ({ ...prev, [a.id]: cals }));
        }).catch(() => {});
      });
    }).catch(console.error);
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const loadEvents = useCallback(async () => {
    const connectedAccounts = accounts.filter(a => a.isConnected);
    if (!connectedAccounts.length) return;
    setLoading(true);
    try {
      const { start, end } = getViewRange(view, currentDate);
      const allEvents = [];
      for (const acc of connectedAccounts) {
        const evts = await calendarAPI.getEvents(acc.id, {
          start: start.toISOString(),
          end: end.toISOString(),
        }).catch(() => []);
        const cals = calendars[acc.id] || [];
        evts.forEach(e => {
          const cal = cals.find(c => c.id === e.calendarId);
          allEvents.push({ ...e, calendarColor: cal?.color || 'var(--accent)', accountLabel: acc.label || acc.id });
        });
      }
      setEvents(allEvents);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [accounts, view, currentDate, calendars]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // Listen for Google OAuth callback from popup window
  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === 'GOOGLE_AUTH_SUCCESS') {
        loadAccounts();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [loadAccounts]);

  async function connectAccount(accountId) {
    try {
      const { url } = await calendarAPI.getAuthUrl(accountId);
      if (!url) { alert('Server did not return an auth URL. Check GOOGLE_CLIENT_ID is set in Railway.'); return; }
      window.open(url, '_blank', 'width=500,height=600');
    } catch (e) {
      const msg = e.response?.data?.error || e.message;
      alert('Cannot connect: ' + msg);
    }
  }

  async function createEvent() {
    if (!newEvent.title.trim()) { alert('Title is required.'); return; }
    const connectedAccounts = accounts.filter(a => a.isConnected);
    if (!connectedAccounts.length) { alert('Connect a Google account first.'); return; }
    try {
      const accountId = newEvent.accountId || connectedAccounts[0].id;
      const calendarId = newEvent.calendarId || 'primary';
      const created = await calendarAPI.createEvent(accountId, { ...newEvent, calendarId });
      setEvents(prev => [...prev, { ...created, calendarColor: EVENT_COLORS[0] }]);
      setShowCreateModal(false);
      setNewEvent(defaultEvent());
    } catch (e) { alert('Failed to create event: ' + e.message); }
  }

  async function deleteEvent() {
    if (!selectedEvent) return;
    if (!window.confirm('Delete this event?')) return;
    try {
      await calendarAPI.deleteEvent(selectedEvent.accountId, selectedEvent.id, selectedEvent.calendarId);
      setEvents(prev => prev.filter(e => e.id !== selectedEvent.id));
      setShowEventModal(false);
      setSelectedEvent(null);
    } catch (e) { alert('Failed to delete: ' + e.message); }
  }

  function openCreateAtDate(date) {
    const d = format(date, "yyyy-MM-dd'T'HH:00");
    setNewEvent({ ...defaultEvent(), start: d, end: format(addDays(date, 0), "yyyy-MM-dd'T'HH:00").replace(/T\d{2}/, `T${String(new Date(d).getHours() + 1).padStart(2,'0')}`) });
    setShowCreateModal(true);
  }

  function navigate(dir) {
    if (view === 'month') setCurrentDate(dir > 0 ? addMonths(currentDate, 1) : subMonths(currentDate, 1));
    else if (view === 'week') setCurrentDate(dir > 0 ? addWeeks(currentDate, 1) : subWeeks(currentDate, 1));
    else setCurrentDate(dir > 0 ? addDays(currentDate, 1) : subDays(currentDate, 1));
  }

  const eventsOnDay = (day) => events.filter(e => {
    const start = parseISO(e.start);
    const end = e.end ? parseISO(e.end) : start;
    return isSameDay(start, day) || (start <= day && end >= day);
  });

  const connectedAccounts = accounts.filter(a => a.isConnected);
  const unconnectedAccounts = accounts.filter(a => !a.isConnected);

  return (
    <div className="tab-layout">
      {/* Header */}
      <div className="tab-header">
        <span className="tab-title">📅 Calendar</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {VIEWS.map(v => (
            <button key={v} className={`btn btn-sm ${view === v ? 'btn-primary' : ''}`} onClick={() => setView(v)}>
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8 }}>
          <button className="btn btn-sm" onClick={() => navigate(-1)}>‹</button>
          <button className="btn btn-sm" onClick={() => setCurrentDate(new Date())}>Today</button>
          <button className="btn btn-sm" onClick={() => navigate(1)}>›</button>
          <span style={{ fontSize: 15, fontWeight: 600, minWidth: 160 }}>
            {view === 'month' && format(currentDate, 'MMMM yyyy')}
            {view === 'week' && `${format(startOfWeek(currentDate), 'MMM d')} – ${format(endOfWeek(currentDate), 'MMM d, yyyy')}`}
            {view === 'day' && format(currentDate, 'EEEE, MMM d yyyy')}
            {view === 'agenda' && 'Upcoming Events'}
          </span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {loading && <span style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'center' }}>Syncing…</span>}
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New Event</button>
        </div>
      </div>

      <div className="tab-body" style={{ flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* Sidebar */}
          <div style={{ width: 210, borderRight: '1px solid var(--border)', background: 'var(--bg2)', overflowY: 'auto', flexShrink: 0 }}>

            {/* Connected accounts */}
            <div className="section-label">Connected</div>
            {connectedAccounts.length === 0 && (
              <div style={{ padding: '6px 14px 10px', fontSize: 12, color: 'var(--text3)', lineHeight: 1.6 }}>
                No accounts connected yet.
              </div>
            )}
            {connectedAccounts.map(acc => (
              <div key={acc.id}>
                <div style={{ padding: '6px 14px', fontSize: 13, fontWeight: 600, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3ecf8e', flexShrink: 0, display: 'inline-block' }} />
                  {acc.label || acc.user}
                  <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 400, marginLeft: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90 }}>{acc.user}</span>
                </div>
                {(calendars[acc.id] || []).map(cal => (
                  <div key={cal.id} style={{ padding: '3px 14px 3px 26px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text3)' }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: cal.color || 'var(--accent)', flexShrink: 0, display: 'inline-block' }} />
                    {cal.summary}
                  </div>
                ))}
              </div>
            ))}

            {/* Unconnected Gmail accounts — show connect button */}
            {unconnectedAccounts.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 8 }}>Not Connected</div>
                {unconnectedAccounts.map(acc => (
                  <div key={acc.id} style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text2)', marginBottom: 4 }}>{acc.label || acc.user}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.user}</div>
                    <button
                      onClick={() => connectAccount(acc.id)}
                      style={{
                        width: '100%', padding: '5px 0', borderRadius: 6,
                        border: '1.5px solid #4285F4', background: 'none',
                        color: '#4285F4', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      🔗 Connect Google Calendar
                    </button>
                  </div>
                ))}
              </>
            )}

            {accounts.length === 0 && (
              <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text3)', lineHeight: 1.7 }}>
                Add a Gmail account in the Email tab first, then connect it to Google Calendar here.
              </div>
            )}
          </div>

          {/* Calendar view area */}
          <div style={{ flex: 1, overflow: 'auto', padding: view === 'agenda' ? 20 : 0 }}>
            {connectedAccounts.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📅</div>
                <div className="empty-title">No calendar connected</div>
                <div className="empty-sub">
                  {accounts.length > 0
                    ? 'Click "Connect Google Calendar" in the sidebar to authorise calendar access.'
                    : 'Add a Gmail account in the Email tab first, then connect it here.'}
                </div>
              </div>
            ) : (
              <>
                {view === 'month' && <MonthView currentDate={currentDate} events={events} eventsOnDay={eventsOnDay} onDayClick={openCreateAtDate} onEventClick={e => { setSelectedEvent(e); setShowEventModal(true); }} />}
                {view === 'week'  && <WeekView  currentDate={currentDate} events={events} eventsOnDay={eventsOnDay} onDayClick={openCreateAtDate} onEventClick={e => { setSelectedEvent(e); setShowEventModal(true); }} />}
                {view === 'day'   && <DayView   currentDate={currentDate} events={eventsOnDay(currentDate)} onEventClick={e => { setSelectedEvent(e); setShowEventModal(true); }} onTimeClick={openCreateAtDate} />}
                {view === 'agenda' && <AgendaView events={events} onEventClick={e => { setSelectedEvent(e); setShowEventModal(true); }} />}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Create event modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" style={{ width: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              ➕ New Event
              <button className="modal-close" onClick={() => setShowCreateModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Title *</label>
                <input className="input" placeholder="Event title" value={newEvent.title} onChange={e => setNewEvent({ ...newEvent, title: e.target.value })} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="field">
                  <label>Start</label>
                  <input className="input" type="datetime-local" value={newEvent.start} onChange={e => setNewEvent({ ...newEvent, start: e.target.value })} />
                </div>
                <div className="field">
                  <label>End</label>
                  <input className="input" type="datetime-local" value={newEvent.end} onChange={e => setNewEvent({ ...newEvent, end: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label>
                  <input type="checkbox" checked={newEvent.allDay} onChange={e => setNewEvent({ ...newEvent, allDay: e.target.checked })} style={{ marginRight: 6 }} />
                  All day
                </label>
              </div>
              <div className="field">
                <label>Location</label>
                <input className="input" placeholder="Location" value={newEvent.location} onChange={e => setNewEvent({ ...newEvent, location: e.target.value })} />
              </div>
              <div className="field">
                <label>Description</label>
                <textarea className="input" rows={3} placeholder="Description" value={newEvent.description} onChange={e => setNewEvent({ ...newEvent, description: e.target.value })} />
              </div>
              <div className="field">
                <label>Attendees (comma-separated emails)</label>
                <input className="input" placeholder="a@example.com, b@example.com" value={newEvent.attendeesRaw || ''} onChange={e => setNewEvent({ ...newEvent, attendeesRaw: e.target.value, attendees: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} />
              </div>
              {connectedAccounts.length > 0 && (
                <div className="field">
                  <label>Calendar account</label>
                  <select className="input" value={newEvent.accountId || connectedAccounts[0].id} onChange={e => setNewEvent({ ...newEvent, accountId: e.target.value })}>
                    {connectedAccounts.map(a => <option key={a.id} value={a.id}>{a.label} ({a.user})</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label>Color</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {EVENT_COLORS.map(c => (
                    <div
                      key={c}
                      onClick={() => setNewEvent({ ...newEvent, color: c })}
                      style={{
                        width: 24, height: 24, borderRadius: '50%', background: c, cursor: 'pointer',
                        border: newEvent.color === c ? '3px solid white' : '3px solid transparent',
                        outline: newEvent.color === c ? `2px solid ${c}` : 'none',
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={createEvent}>Create Event</button>
            </div>
          </div>
        </div>
      )}

      {/* Event detail modal */}
      {showEventModal && selectedEvent && (
        <div className="modal-overlay" onClick={() => setShowEventModal(false)}>
          <div className="modal" style={{ width: 440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header" style={{ borderLeft: `4px solid ${selectedEvent.calendarColor || 'var(--accent)'}`, paddingLeft: 18 }}>
              {selectedEvent.title}
              <button className="modal-close" onClick={() => setShowEventModal(false)}>×</button>
            </div>
            <div className="modal-body" style={{ gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Row icon="🕐" label="When">
                  {selectedEvent.allDay
                    ? format(parseISO(selectedEvent.start), 'EEEE, MMMM d yyyy')
                    : `${fmtDt(selectedEvent.start)} → ${fmtDt(selectedEvent.end)}`}
                </Row>
                {selectedEvent.location && <Row icon="📍" label="Location">{selectedEvent.location}</Row>}
                {selectedEvent.description && <Row icon="📝" label="Description">{selectedEvent.description}</Row>}
                {selectedEvent.organizer && <Row icon="👤" label="Organizer">{selectedEvent.organizer}</Row>}
                {selectedEvent.attendees?.length > 0 && (
                  <Row icon="👥" label="Attendees">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {selectedEvent.attendees.map((a, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                          <span style={{ color: statusColor(a.status) }}>●</span>
                          {a.name || a.email}
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>({a.status})</span>
                        </div>
                      ))}
                    </div>
                  </Row>
                )}
                {selectedEvent.htmlLink && (
                  <a href={selectedEvent.htmlLink} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--accent)' }}>
                    Open in Google Calendar ↗
                  </a>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-danger" onClick={deleteEvent}>🗑 Delete</button>
              <button className="btn" onClick={() => setShowEventModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-views ────────────────────────────────────────────

function MonthView({ currentDate, eventsOnDay, onDayClick, onEventClick }) {
  const start = startOfWeek(startOfMonth(currentDate));
  const end = endOfWeek(endOfMonth(currentDate));
  const days = eachDayOfInterval({ start, end });
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', borderBottom: '1px solid var(--border)' }}>
        {DAY_NAMES.map(d => (
          <div key={d} style={{ padding: '8px 0', textAlign: 'center', fontSize: 12, fontWeight: 600, color: 'var(--text3)' }}>{d}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gridTemplateRows: `repeat(${days.length / 7},1fr)`, flex: 1 }}>
        {days.map(day => {
          const dayEvents = eventsOnDay(day);
          const isOther = !isSameMonth(day, currentDate);
          const isNow = isToday(day);
          return (
            <div
              key={day}
              onClick={() => onDayClick(day)}
              style={{
                borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
                padding: '6px 6px 4px',
                background: isNow ? 'var(--accent-t)' : isOther ? 'var(--bg)' : 'var(--bg2)',
                cursor: 'pointer', overflow: 'hidden', minHeight: 80,
              }}
            >
              <div style={{
                fontSize: 12, fontWeight: isNow ? 700 : 400, marginBottom: 4,
                color: isNow ? '#fff' : isOther ? 'var(--text3)' : 'var(--text)',
                display: 'flex', alignItems: 'center', justifyContent: isNow ? 'center' : 'flex-start',
                width: isNow ? 22 : 'auto', height: isNow ? 22 : 'auto',
                background: isNow ? 'var(--accent)' : 'transparent',
                borderRadius: isNow ? '50%' : 0,
              }}>
                {format(day, 'd')}
              </div>
              {dayEvents.slice(0, 3).map(e => (
                <div
                  key={e.id}
                  onClick={ev => { ev.stopPropagation(); onEventClick(e); }}
                  style={{
                    background: e.calendarColor || 'var(--accent)',
                    color: '#fff', borderRadius: 4, padding: '1px 5px',
                    fontSize: 11, marginBottom: 2, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer',
                  }}
                >
                  {!e.allDay && format(parseISO(e.start), 'HH:mm')} {e.title}
                </div>
              ))}
              {dayEvents.length > 3 && (
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>+{dayEvents.length - 3} more</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({ currentDate, eventsOnDay, onDayClick, onEventClick }) {
  const start = startOfWeek(currentDate);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '50px repeat(7,1fr)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div />
        {days.map(day => (
          <div
            key={day} onClick={() => onDayClick(day)}
            style={{ padding: '10px 4px', textAlign: 'center', cursor: 'pointer',
              background: isToday(day) ? 'var(--accent-t)' : 'transparent',
              borderRight: '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>{format(day, 'EEE')}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: isToday(day) ? 'var(--accent)' : 'var(--text)' }}>{format(day, 'd')}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '50px repeat(7,1fr)', flex: 1 }}>
        <div style={{ borderRight: '1px solid var(--border)' }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} style={{ height: 60, borderBottom: '1px solid var(--border)', padding: '2px 6px 0', fontSize: 10, color: 'var(--text3)', textAlign: 'right' }}>
              {h === 0 ? '' : `${h}:00`}
            </div>
          ))}
        </div>
        {days.map(day => (
          <div key={day} style={{ position: 'relative', borderRight: '1px solid var(--border)' }}>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} style={{ height: 60, borderBottom: '1px solid var(--border)' }} />
            ))}
            {eventsOnDay(day).filter(e => !e.allDay).map(e => {
              const startH = new Date(e.start).getHours() + new Date(e.start).getMinutes() / 60;
              const endH = e.end ? new Date(e.end).getHours() + new Date(e.end).getMinutes() / 60 : startH + 1;
              const top = startH * 60;
              const height = Math.max((endH - startH) * 60, 20);
              return (
                <div
                  key={e.id}
                  onClick={() => onEventClick(e)}
                  style={{
                    position: 'absolute', top, left: 2, right: 2, height,
                    background: e.calendarColor || 'var(--accent)',
                    borderRadius: 4, padding: '2px 5px',
                    fontSize: 11, color: '#fff', overflow: 'hidden',
                    cursor: 'pointer', zIndex: 1,
                  }}
                >
                  {e.title}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function DayView({ currentDate, events, onEventClick, onTimeClick }) {
  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'auto' }}>
      <div style={{ width: 60, borderRight: '1px solid var(--border)', flexShrink: 0 }}>
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} style={{ height: 64, borderBottom: '1px solid var(--border)', padding: '2px 8px 0', fontSize: 11, color: 'var(--text3)', textAlign: 'right' }}>
            {h === 0 ? '' : `${h}:00`}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        {Array.from({ length: 24 }, (_, h) => (
          <div
            key={h}
            onClick={() => { const d = new Date(currentDate); d.setHours(h, 0, 0); onTimeClick(d); }}
            style={{ height: 64, borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
          />
        ))}
        {events.filter(e => !e.allDay).map(e => {
          const startH = new Date(e.start).getHours() + new Date(e.start).getMinutes() / 60;
          const endH = e.end ? new Date(e.end).getHours() + new Date(e.end).getMinutes() / 60 : startH + 1;
          return (
            <div
              key={e.id}
              onClick={() => onEventClick(e)}
              style={{
                position: 'absolute', top: startH * 64, left: 4, right: 4,
                height: Math.max((endH - startH) * 64, 24),
                background: e.calendarColor || 'var(--accent)',
                borderRadius: 6, padding: '4px 8px',
                fontSize: 13, color: '#fff', cursor: 'pointer', overflow: 'hidden', zIndex: 1,
              }}
            >
              <div style={{ fontWeight: 600 }}>{e.title}</div>
              <div style={{ fontSize: 11, opacity: 0.8 }}>{fmtDt(e.start)} – {fmtDt(e.end)}</div>
              {e.location && <div style={{ fontSize: 11, opacity: 0.8 }}>📍 {e.location}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgendaView({ events, onEventClick }) {
  const sorted = [...events].sort((a, b) => new Date(a.start) - new Date(b.start));
  if (sorted.length === 0) return (
    <div className="empty-state"><div className="empty-icon">📅</div><div className="empty-title">No upcoming events</div></div>
  );
  let lastDay = null;
  return (
    <div style={{ maxWidth: 680 }}>
      {sorted.map(e => {
        const day = format(parseISO(e.start), 'EEEE, MMMM d yyyy');
        const showDay = day !== lastDay;
        lastDay = day;
        return (
          <React.Fragment key={e.id}>
            {showDay && (
              <div style={{ padding: '14px 0 6px', fontSize: 13, fontWeight: 700, color: 'var(--text2)', borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
                {day}
              </div>
            )}
            <div
              onClick={() => onEventClick(e)}
              style={{
                display: 'flex', gap: 14, padding: '10px 12px', borderRadius: 8,
                cursor: 'pointer', marginBottom: 4,
                border: '1px solid var(--border)',
                background: 'var(--bg2)',
                borderLeft: `4px solid ${e.calendarColor || 'var(--accent)'}`,
              }}
            >
              <div style={{ minWidth: 80, fontSize: 12, color: 'var(--text2)', paddingTop: 2 }}>
                {e.allDay ? 'All day' : fmtDt(e.start)}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{e.title}</div>
                {e.location && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>📍 {e.location}</div>}
                {e.attendees?.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>
                    👥 {e.attendees.map(a => a.name || a.email).join(', ')}
                  </div>
                )}
              </div>
              {e.end && !e.allDay && (
                <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)', alignSelf: 'center' }}>
                  {fmtDt(e.end)}
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function Row({ icon, label, children }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>{children}</div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────

function defaultEvent() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const base = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
  const end  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours()+1)}:00`;
  return { title: '', description: '', location: '', start: base, end, allDay: false, attendees: [], attendeesRaw: '', color: EVENT_COLORS[0], accountId: '', calendarId: 'primary' };
}

function getViewRange(view, date) {
  if (view === 'month') return { start: startOfWeek(startOfMonth(date)), end: endOfWeek(endOfMonth(date)) };
  if (view === 'week')  return { start: startOfWeek(date), end: endOfWeek(date) };
  if (view === 'day')   return { start: startOfDay(date), end: endOfDay(date) };
  return { start: new Date(), end: addMonths(new Date(), 3) };
}

const fmtDt = dt => { try { return format(parseISO(dt), 'h:mm a'); } catch { return dt; } };
const statusColor = s => s === 'accepted' ? 'var(--green)' : s === 'declined' ? 'var(--red)' : 'var(--amber)';
