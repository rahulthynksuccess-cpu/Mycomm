const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, '..', 'calendar_tokens.json');

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/auth/google/callback'
  );
}

// ─── Token persistence ─────────────────────────────────
function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return {};
  return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
}

function saveTokens(accountId, tokens) {
  const all = loadTokens();
  all[accountId] = tokens;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(all, null, 2));
}

function getAuthClient(accountId) {
  const tokens = loadTokens();
  if (!tokens[accountId]) throw new Error(`No calendar tokens for ${accountId}. Please re-authenticate.`);
  const auth = getOAuth2Client();
  auth.setCredentials(tokens[accountId]);
  // Auto-refresh: save new tokens if refreshed
  auth.on('tokens', (newTokens) => {
    const merged = { ...tokens[accountId], ...newTokens };
    saveTokens(accountId, merged);
  });
  return auth;
}

// ─── OAuth flow ────────────────────────────────────────
function getAuthUrl(accountId) {
  const auth = getOAuth2Client();
  return auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    state: accountId,
  });
}

async function handleCallback(code, accountId) {
  const auth = getOAuth2Client();
  const { tokens } = await auth.getToken(code);
  saveTokens(accountId, tokens);
  return tokens;
}

// ─── Calendar list ─────────────────────────────────────
async function getCalendars(accountId) {
  const auth = getAuthClient(accountId);
  const cal = google.calendar({ version: 'v3', auth });
  const res = await cal.calendarList.list();
  return res.data.items.map(c => ({
    id: c.id,
    summary: c.summary,
    description: c.description,
    color: c.backgroundColor,
    primary: c.primary || false,
    accessRole: c.accessRole,
    accountId,
  }));
}

// ─── Events ────────────────────────────────────────────
async function getEvents(accountId, options = {}) {
  const {
    calendarId = 'primary',
    timeMin = new Date().toISOString(),
    timeMax,
    maxResults = 100,
    q,
  } = options;

  const auth = getAuthClient(accountId);
  const cal = google.calendar({ version: 'v3', auth });

  const params = {
    calendarId,
    timeMin,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  };
  if (timeMax) params.timeMax = timeMax;
  if (q) params.q = q;

  const res = await cal.events.list(params);
  return res.data.items.map(e => formatEvent(e, accountId, calendarId));
}

async function getEventsRange(accountId, startDate, endDate) {
  const calendars = await getCalendars(accountId).catch(() => [{ id: 'primary' }]);
  const allEvents = [];

  for (const calendar of calendars) {
    const events = await getEvents(accountId, {
      calendarId: calendar.id,
      timeMin: new Date(startDate).toISOString(),
      timeMax: new Date(endDate).toISOString(),
      maxResults: 200,
    }).catch(() => []);
    allEvents.push(...events.map(e => ({ ...e, calendarName: calendar.summary, calendarColor: calendar.color })));
  }

  return allEvents;
}

async function createEvent(accountId, calendarId = 'primary', event) {
  const auth = getAuthClient(accountId);
  const cal = google.calendar({ version: 'v3', auth });
  const res = await cal.events.insert({
    calendarId,
    resource: {
      summary: event.title,
      description: event.description || '',
      location: event.location || '',
      start: event.allDay
        ? { date: event.start }
        : { dateTime: event.start, timeZone: event.timeZone || 'Asia/Kolkata' },
      end: event.allDay
        ? { date: event.end }
        : { dateTime: event.end, timeZone: event.timeZone || 'Asia/Kolkata' },
      attendees: (event.attendees || []).map(email => ({ email })),
      reminders: {
        useDefault: false,
        overrides: [{ method: 'email', minutes: 30 }, { method: 'popup', minutes: 10 }],
      },
      colorId: event.colorId || null,
      recurrence: event.recurrence || null,
    },
    sendUpdates: event.attendees?.length ? 'all' : 'none',
  });
  return formatEvent(res.data, accountId, calendarId);
}

async function updateEvent(accountId, calendarId = 'primary', eventId, updates) {
  const auth = getAuthClient(accountId);
  const cal = google.calendar({ version: 'v3', auth });
  const existing = await cal.events.get({ calendarId, eventId });
  const merged = {
    ...existing.data,
    summary: updates.title || existing.data.summary,
    description: updates.description ?? existing.data.description,
    location: updates.location ?? existing.data.location,
    start: updates.start ? (updates.allDay ? { date: updates.start } : { dateTime: updates.start, timeZone: 'Asia/Kolkata' }) : existing.data.start,
    end: updates.end ? (updates.allDay ? { date: updates.end } : { dateTime: updates.end, timeZone: 'Asia/Kolkata' }) : existing.data.end,
    attendees: updates.attendees ? updates.attendees.map(e => ({ email: e })) : existing.data.attendees,
  };
  const res = await cal.events.update({ calendarId, eventId, resource: merged, sendUpdates: 'all' });
  return formatEvent(res.data, accountId, calendarId);
}

async function deleteEvent(accountId, calendarId = 'primary', eventId) {
  const auth = getAuthClient(accountId);
  const cal = google.calendar({ version: 'v3', auth });
  await cal.events.delete({ calendarId, eventId, sendUpdates: 'all' });
  return { deleted: true, eventId };
}

// ─── Format event for frontend ─────────────────────────
function formatEvent(e, accountId, calendarId) {
  return {
    id: e.id,
    title: e.summary || '(No Title)',
    description: e.description || '',
    location: e.location || '',
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || '',
    allDay: !e.start?.dateTime,
    color: e.colorId || null,
    status: e.status,
    attendees: (e.attendees || []).map(a => ({ email: a.email, name: a.displayName, status: a.responseStatus })),
    organizer: e.organizer?.email || '',
    htmlLink: e.htmlLink || '',
    accountId,
    calendarId,
  };
}

function getConnectedAccounts() {
  return Object.keys(loadTokens());
}

module.exports = {
  getAuthUrl,
  handleCallback,
  getCalendars,
  getEvents,
  getEventsRange,
  createEvent,
  updateEvent,
  deleteEvent,
  getConnectedAccounts,
};
