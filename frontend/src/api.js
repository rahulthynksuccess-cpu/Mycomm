import axios from 'axios';

const BASE = process.env.REACT_APP_API_URL || 'http://localhost:4000';

const api = axios.create({ baseURL: BASE, timeout: 30000 });

// ─── Email ─────────────────────────────────────────────
export const emailAPI = {
  getAccounts: () => api.get('/api/email/accounts').then(r => r.data),
  getFolders: (accountId) => api.get(`/api/email/${accountId}/folders`).then(r => r.data),
  getMessages: (accountId, params = {}) => api.get(`/api/email/${accountId}/messages`, { params }).then(r => r.data),
  getBody: (accountId, uid, folder) => api.get(`/api/email/${accountId}/messages/${uid}`, { params: { folder } }).then(r => r.data),
  send: (accountId, data) => api.post(`/api/email/${accountId}/send`, data).then(r => r.data),
  delete: (accountId, uid, folder) => api.delete(`/api/email/${accountId}/messages/${uid}`, { params: { folder } }).then(r => r.data),
  move: (accountId, uid, fromFolder, toFolder) => api.post(`/api/email/${accountId}/messages/${uid}/move`, { fromFolder, toFolder }).then(r => r.data),
  flag: (accountId, uid, flag, folder) => api.patch(`/api/email/${accountId}/messages/${uid}/flag`, { flag, folder }).then(r => r.data),
  search: (accountId, q, folder) => api.get(`/api/email/${accountId}/search`, { params: { q, folder } }).then(r => r.data),
};

// ─── Calendar ──────────────────────────────────────────
export const calendarAPI = {
  getAccounts: () => api.get('/api/calendar/accounts').then(r => r.data),
  getAuthUrl: (accountId) => api.get('/api/calendar/auth', { params: { accountId } }).then(r => r.data),
  getCalendars: (accountId) => api.get(`/api/calendar/${accountId}/calendars`).then(r => r.data),
  getEvents: (accountId, params = {}) => api.get(`/api/calendar/${accountId}/events`, { params }).then(r => r.data),
  createEvent: (accountId, event) => api.post(`/api/calendar/${accountId}/events`, event).then(r => r.data),
  updateEvent: (accountId, eventId, updates) => api.patch(`/api/calendar/${accountId}/events/${eventId}`, updates).then(r => r.data),
  deleteEvent: (accountId, eventId, calendarId) => api.delete(`/api/calendar/${accountId}/events/${eventId}`, { params: { calendarId } }).then(r => r.data),
};

// ─── WhatsApp ──────────────────────────────────────────
export const waAPI = {
  getStatus: () => api.get('/api/whatsapp/status').then(r => r.data),
  addSession: (accountId) => api.post('/api/whatsapp/sessions', { accountId }).then(r => r.data),
  removeSession: (accountId) => api.delete(`/api/whatsapp/sessions/${accountId}`).then(r => r.data),
  getChats: (accountId, limit = 30) => api.get(`/api/whatsapp/${accountId}/chats`, { params: { limit } }).then(r => r.data),
  getMessages: (accountId, chatId, limit = 50) => api.get(`/api/whatsapp/${accountId}/chats/${encodeURIComponent(chatId)}/messages`, { params: { limit } }).then(r => r.data),
  send: (accountId, to, body) => api.post(`/api/whatsapp/${accountId}/send`, { to, body }).then(r => r.data),
};

export default api;
