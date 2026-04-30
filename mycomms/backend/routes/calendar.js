const router = require('express').Router();
const {
  getAuthUrl,
  getCalendars,
  getEvents,
  getEventsRange,
  createEvent,
  updateEvent,
  deleteEvent,
  getConnectedAccounts,
} = require('../services/calendar');

// GET /api/calendar/accounts — list connected calendar accounts
router.get('/accounts', (req, res) => {
  res.json(getConnectedAccounts().map(id => ({ id })));
});

// GET /api/calendar/auth?accountId=... — get OAuth URL to connect a Google account
router.get('/auth', (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });
  const url = getAuthUrl(accountId);
  res.json({ url });
});

// GET /api/calendar/:accountId/calendars — list all calendars for an account
router.get('/:accountId/calendars', async (req, res) => {
  try {
    const calendars = await getCalendars(req.params.accountId);
    res.json(calendars);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calendar/:accountId/events — get events (with optional date range)
router.get('/:accountId/events', async (req, res) => {
  try {
    const { start, end, calendarId, q } = req.query;
    let events;
    if (start && end) {
      events = await getEventsRange(req.params.accountId, start, end);
    } else {
      events = await getEvents(req.params.accountId, { calendarId, q });
    }
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calendar/:accountId/events — create an event
router.post('/:accountId/events', async (req, res) => {
  try {
    const { calendarId = 'primary', ...event } = req.body;
    const created = await createEvent(req.params.accountId, calendarId, event);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/calendar/:accountId/events/:eventId — update an event
router.patch('/:accountId/events/:eventId', async (req, res) => {
  try {
    const { calendarId = 'primary', ...updates } = req.body;
    const updated = await updateEvent(req.params.accountId, calendarId, req.params.eventId, updates);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/calendar/:accountId/events/:eventId — delete an event
router.delete('/:accountId/events/:eventId', async (req, res) => {
  try {
    const { calendarId = 'primary' } = req.query;
    const result = await deleteEvent(req.params.accountId, calendarId, req.params.eventId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
