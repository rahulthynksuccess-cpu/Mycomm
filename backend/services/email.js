const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

// ─── Account config from .env ──────────────────────────
function getAccounts() {
  try {
    return JSON.parse(process.env.EMAIL_ACCOUNTS || '[]');
  } catch (e) {
    console.error('Invalid EMAIL_ACCOUNTS in .env:', e.message);
    return [];
  }
}

// ─── IMAP config per provider ──────────────────────────
function getImapConfig(account) {
  const base = { user: account.user, password: account.password, tls: true, tlsOptions: { rejectUnauthorized: false } };
  if (account.type === 'gmail') return { ...base, host: 'imap.gmail.com', port: 993 };
  if (account.type === 'zoho')  return { ...base, host: 'imap.zoho.in',   port: 993 };
  // fallback: custom IMAP
  return { ...base, host: account.imapHost, port: account.imapPort || 993 };
}

// ─── SMTP config per provider ──────────────────────────
function getSmtpConfig(account) {
  if (account.type === 'gmail') return { host: 'smtp.gmail.com', port: 587, secure: false, auth: { user: account.user, pass: account.password } };
  if (account.type === 'zoho')  return { host: 'smtp.zoho.in',   port: 587, secure: false, auth: { user: account.user, pass: account.password } };
  return { host: account.smtpHost, port: account.smtpPort || 587, secure: false, auth: { user: account.user, pass: account.password } };
}

// ─── Open IMAP + select mailbox ────────────────────────
function openImap(account, mailbox = 'INBOX') {
  return new Promise((resolve, reject) => {
    const imap = new Imap(getImapConfig(account));
    imap.once('ready', () => {
      imap.openBox(mailbox, false, (err, box) => {
        if (err) { imap.end(); return reject(err); }
        resolve({ imap, box });
      });
    });
    imap.once('error', reject);
    imap.connect();
  });
}

// ─── Fetch email list (headers only) ──────────────────
async function fetchEmails(accountId, options = {}) {
  const { folder = 'INBOX', limit = 50, page = 1, search = ['ALL'] } = options;
  const account = getAccounts().find(a => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  return new Promise((resolve, reject) => {
    const imap = new Imap(getImapConfig(account));
    const emails = [];

    imap.once('ready', () => {
      imap.openBox(folder, true, (err, box) => {
        if (err) { imap.end(); return reject(err); }

        const total = box.messages.total;
        if (total === 0) { imap.end(); return resolve({ emails: [], total: 0 }); }

        // Calculate range for pagination
        const end = total - (page - 1) * limit;
        const start = Math.max(1, end - limit + 1);
        const range = `${start}:${end}`;

        const fetch = imap.seq.fetch(range, {
          bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE CC REPLY-TO MESSAGE-ID)', 'TEXT'],
          struct: true,
          size: true,
        });

        fetch.on('message', (msg, seqno) => {
          const email = { seqno, accountId, folder, flags: [] };
          const buffers = {};

          msg.on('body', (stream, info) => {
            buffers[info.which] = [];
            stream.on('data', chunk => buffers[info.which].push(chunk));
            stream.once('end', () => {
              buffers[info.which] = Buffer.concat(buffers[info.which]).toString('utf8');
            });
          });

          msg.once('attributes', attrs => {
            email.uid = attrs.uid;
            email.flags = attrs.flags;
            email.date = attrs.date;
          });

          msg.once('end', () => {
            const header = Imap.parseHeader(buffers['HEADER.FIELDS (FROM TO SUBJECT DATE CC REPLY-TO MESSAGE-ID)'] || '');
            email.from    = header.from?.[0] || '';
            email.to      = header.to?.[0] || '';
            email.cc      = header.cc?.[0] || '';
            email.subject = header.subject?.[0] || '(No Subject)';
            email.messageId = header['message-id']?.[0] || '';
            email.snippet  = (buffers['TEXT'] || '').replace(/<[^>]*>/g, '').slice(0, 200);
            email.isRead   = email.flags.includes('\\Seen');
            email.isStarred = email.flags.includes('\\Flagged');
            emails.push(email);
          });
        });

        fetch.once('error', (err) => { imap.end(); reject(err); });
        fetch.once('end', () => {
          imap.end();
          resolve({ emails: emails.reverse(), total, folder });
        });
      });
    });

    imap.once('error', reject);
    imap.connect();
  });
}

// ─── Fetch full email body ─────────────────────────────
async function fetchEmailBody(accountId, uid, folder = 'INBOX') {
  const account = getAccounts().find(a => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  return new Promise((resolve, reject) => {
    const imap = new Imap(getImapConfig(account));

    imap.once('ready', () => {
      imap.openBox(folder, false, (err) => {
        if (err) { imap.end(); return reject(err); }

        const fetch = imap.fetch([uid], { bodies: '', struct: true, markSeen: true });
        let buffer = '';

        fetch.on('message', (msg) => {
          msg.on('body', (stream) => {
            stream.on('data', chunk => buffer += chunk.toString('utf8'));
          });
          msg.once('end', async () => {
            const parsed = await simpleParser(buffer);
            imap.end();
            resolve({
              uid,
              from: parsed.from?.text || '',
              to: parsed.to?.text || '',
              cc: parsed.cc?.text || '',
              subject: parsed.subject || '',
              date: parsed.date,
              textBody: parsed.text || '',
              htmlBody: parsed.html || parsed.text || '',
              attachments: (parsed.attachments || []).map(a => ({
                filename: a.filename,
                contentType: a.contentType,
                size: a.size,
                content: a.content.toString('base64'),
              })),
            });
          });
        });

        fetch.once('error', (err) => { imap.end(); reject(err); });
      });
    });

    imap.once('error', reject);
    imap.connect();
  });
}

// ─── Send email ────────────────────────────────────────
async function sendEmail(accountId, { to, cc, bcc, subject, text, html, replyTo, attachments = [] }) {
  const account = getAccounts().find(a => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  const transporter = nodemailer.createTransporter(getSmtpConfig(account));
  await transporter.verify();

  const result = await transporter.sendMail({
    from: `${account.label} <${account.user}>`,
    to, cc, bcc, subject, text, html,
    replyTo: replyTo || account.user,
    attachments,
  });

  return result;
}

// ─── Delete email (move to Trash) ─────────────────────
async function deleteEmail(accountId, uid, folder = 'INBOX') {
  const account = getAccounts().find(a => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  return new Promise((resolve, reject) => {
    const imap = new Imap(getImapConfig(account));
    imap.once('ready', () => {
      imap.openBox(folder, false, (err) => {
        if (err) { imap.end(); return reject(err); }
        imap.addFlags([uid], '\\Deleted', (err) => {
          if (err) { imap.end(); return reject(err); }
          imap.expunge((err) => {
            imap.end();
            if (err) return reject(err);
            resolve({ deleted: true, uid });
          });
        });
      });
    });
    imap.once('error', reject);
    imap.connect();
  });
}

// ─── Move email to folder ──────────────────────────────
async function moveEmail(accountId, uid, fromFolder, toFolder) {
  const account = getAccounts().find(a => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  return new Promise((resolve, reject) => {
    const imap = new Imap(getImapConfig(account));
    imap.once('ready', () => {
      imap.openBox(fromFolder, false, (err) => {
        if (err) { imap.end(); return reject(err); }
        imap.move([uid], toFolder, (err) => {
          imap.end();
          if (err) return reject(err);
          resolve({ moved: true, uid, toFolder });
        });
      });
    });
    imap.once('error', reject);
    imap.connect();
  });
}

// ─── Flag / unflag email ───────────────────────────────
async function flagEmail(accountId, uid, flag, folder = 'INBOX') {
  const account = getAccounts().find(a => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  return new Promise((resolve, reject) => {
    const imap = new Imap(getImapConfig(account));
    imap.once('ready', () => {
      imap.openBox(folder, false, (err) => {
        if (err) { imap.end(); return reject(err); }
        const method = flag.add ? 'addFlags' : 'delFlags';
        imap[method]([uid], flag.name, (err) => {
          imap.end();
          if (err) return reject(err);
          resolve({ flagged: true, uid });
        });
      });
    });
    imap.once('error', reject);
    imap.connect();
  });
}

// ─── Search emails ─────────────────────────────────────
async function searchEmails(accountId, query, folder = 'INBOX') {
  const account = getAccounts().find(a => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  return new Promise((resolve, reject) => {
    const imap = new Imap(getImapConfig(account));
    imap.once('ready', () => {
      imap.openBox(folder, true, (err) => {
        if (err) { imap.end(); return reject(err); }
        imap.search([['OR', ['SUBJECT', query], ['FROM', query]], ['OR', ['TO', query], ['BODY', query]]], (err, uids) => {
          if (err) { imap.end(); return reject(err); }
          if (!uids || uids.length === 0) { imap.end(); return resolve([]); }

          const fetch = imap.fetch(uids.slice(-30), {
            bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
            struct: true,
          });
          const results = [];
          fetch.on('message', (msg) => {
            const email = {};
            msg.on('body', (stream) => {
              let buf = '';
              stream.on('data', c => buf += c.toString('utf8'));
              stream.once('end', () => {
                const h = Imap.parseHeader(buf);
                email.from = h.from?.[0] || '';
                email.subject = h.subject?.[0] || '';
                email.date = h.date?.[0] || '';
              });
            });
            msg.once('attributes', a => { email.uid = a.uid; });
            msg.once('end', () => { email.accountId = accountId; results.push(email); });
          });
          fetch.once('end', () => { imap.end(); resolve(results.reverse()); });
          fetch.once('error', (err) => { imap.end(); reject(err); });
        });
      });
    });
    imap.once('error', reject);
    imap.connect();
  });
}

// ─── Get folder list ───────────────────────────────────
async function getFolders(accountId) {
  const account = getAccounts().find(a => a.id === accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  return new Promise((resolve, reject) => {
    const imap = new Imap(getImapConfig(account));
    imap.once('ready', () => {
      imap.getBoxes((err, boxes) => {
        imap.end();
        if (err) return reject(err);
        const flatten = (obj, prefix = '') => {
          return Object.entries(obj).flatMap(([name, box]) => {
            const full = prefix ? `${prefix}${box.delimiter}${name}` : name;
            const children = box.children ? flatten(box.children, full) : [];
            return [{ name: full, label: name, attribs: box.attribs || [] }, ...children];
          });
        };
        resolve(flatten(boxes));
      });
    });
    imap.once('error', reject);
    imap.connect();
  });
}

module.exports = {
  getAccounts,
  fetchEmails,
  fetchEmailBody,
  sendEmail,
  deleteEmail,
  moveEmail,
  flagEmail,
  searchEmails,
  getFolders,
};
