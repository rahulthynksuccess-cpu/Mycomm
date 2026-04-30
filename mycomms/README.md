# MyComms — Personal Unified Communications Hub

Your personal, free, self-hosted alternative to Unipile.

**Features:**
- 💬 Up to 5 WhatsApp accounts (via WhatsApp Web — no API needed)
- 📧 Multiple email accounts: Gmail, Google Workspace, Zoho
- 📅 Full Google Calendar management across all accounts
- 📤 Send, receive, delete, search — all from one dashboard

---

## Architecture

```
GitHub Repo
├── /frontend  → GitHub Pages (free static hosting)
└── /backend   → Railway / Render / your VPS
```

---

## Step 1 — Fork & Clone

```bash
git clone https://github.com/YOUR_USERNAME/mycomms.git
cd mycomms
```

---

## Step 2 — Configure the Backend

```bash
cd backend
cp .env.example .env
```

Edit `.env` with your actual credentials:

### Gmail / Google Workspace App Password
1. Go to [myaccount.google.com](https://myaccount.google.com) → Security
2. Enable 2-Step Verification (if not already)
3. Search "App Passwords" → Generate one for "Mail"
4. Copy the 16-character password into `.env`

### Zoho App Password
1. Go to [accounts.zoho.in](https://accounts.zoho.in) → Security → App Passwords
2. Generate → copy into `.env`
3. Also enable IMAP: Zoho Mail → Settings → Mail Accounts → IMAP Access → Enable

### Google Calendar (OAuth2)
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g. "MyComms")
3. APIs & Services → Enable APIs → search "Google Calendar API" → Enable
4. APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client IDs
5. Application type: **Web application**
6. Authorized redirect URIs:
   - `http://localhost:4000/auth/google/callback` (local dev)
   - `https://your-railway-app.up.railway.app/auth/google/callback` (production)
7. Download credentials → copy Client ID & Secret to `.env`

---

## Step 3 — Run Locally

```bash
# From the root
npm install
npm run install:all

# Start both frontend and backend
npm run dev
```

- Frontend: http://localhost:3000
- Backend: http://localhost:4000

---

## Step 4 — Deploy Backend to Railway (Free)

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Select your `mycomms` repo
3. Railway detects `railway.toml` automatically
4. Go to Variables tab → add all your `.env` variables
5. Add `PORT=4000`
6. Railway gives you a URL like `https://mycomms-production.up.railway.app`
7. Add that URL's `/auth/google/callback` to your Google Cloud OAuth redirect URIs

---

## Step 5 — Deploy Frontend to GitHub Pages

1. In your GitHub repo → Settings → Pages → Source: **GitHub Actions**
2. Go to Settings → Secrets and variables → Actions → New repository secret:
   - Name: `REACT_APP_API_URL`
   - Value: `https://your-railway-app.up.railway.app`
3. Update `frontend/package.json` → `"homepage"` to your GitHub Pages URL
4. Push to `main` — GitHub Actions auto-deploys
5. Your app is live at `https://YOUR_USERNAME.github.io/mycomms`

---

## Step 6 — Connect WhatsApp

1. Open your app → WhatsApp tab → click **Add Account**
2. Give it a label (e.g. "personal", "work")
3. A QR code appears — open WhatsApp on your phone → three dots → Linked Devices → Link a Device → scan
4. Repeat for up to 5 accounts

Sessions are saved automatically. After a server restart, WhatsApp reconnects without needing to scan again.

---

## File Structure

```
mycomms/
├── backend/
│   ├── server.js              # Express + Socket.io entry point
│   ├── services/
│   │   ├── whatsapp.js        # whatsapp-web.js session manager
│   │   ├── email.js           # IMAP + SMTP (node-imap + nodemailer)
│   │   └── calendar.js        # Google Calendar API
│   ├── routes/
│   │   ├── whatsapp.js        # REST endpoints for WhatsApp
│   │   ├── email.js           # REST endpoints for Email
│   │   ├── calendar.js        # REST endpoints for Calendar
│   │   └── auth.js            # Google OAuth callback
│   ├── sessions/              # WhatsApp session data (auto-created)
│   ├── .env.example
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── App.js             # Root with sidebar + tab routing
│   │   ├── App.css            # All styles (dark theme)
│   │   ├── api.js             # Axios client for all API calls
│   │   └── components/
│   │       ├── WhatsApp/WhatsAppTab.js
│   │       ├── Email/EmailTab.js
│   │       ├── Calendar/CalendarTab.js
│   │       └── Shared/SettingsTab.js
│   ├── public/index.html
│   └── package.json
│
├── .github/workflows/deploy.yml   # Auto-deploy frontend to GitHub Pages
├── railway.toml                    # Railway backend config
└── package.json                    # Root scripts (dev, install:all)
```

---

## Troubleshooting

**WhatsApp disconnects frequently:**
- Railway free tier may sleep — upgrade to Hobby ($5/mo) or use a VPS
- Use Cloudflare Tunnel if running locally: `cloudflared tunnel --url http://localhost:4000`

**IMAP auth failed:**
- Make sure you're using App Passwords, not your real password
- For Gmail: IMAP must be enabled at gmail.com → Settings → See all settings → Forwarding and POP/IMAP

**Calendar not connecting:**
- Check that your redirect URI exactly matches what's in Google Cloud Console
- Make sure the Google Calendar API is enabled (not just created)

**CORS errors in browser:**
- Add your exact GitHub Pages URL to `FRONTEND_URL` in your backend `.env`
- Redeploy the backend after changing env vars

---

## Cost Breakdown

| Service | Cost |
|---|---|
| GitHub (code + Pages) | Free |
| Railway backend | Free ($5 credit/mo) |
| Gmail IMAP | Free |
| Google Calendar API | Free |
| Zoho Mail IMAP | Free |
| whatsapp-web.js | Free (open source) |
| **Total** | **$0/month** |
