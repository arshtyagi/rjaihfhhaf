/**
 * imap.js — fetch Apollo OTP from any IMAP-compatible inbox
 *
 * Supports: Gmail, Google Workspace, Outlook/Hotmail, any generic IMAP server
 * Config via environment variables (see .env.example)
 */

const Imap = require('imap');
const { simpleParser } = require('mailparser');

// ─── Resolve IMAP config from env ─────────────────────────────────────────────
function getImapConfig() {
  const provider = (process.env.IMAP_PROVIDER || 'gmail').toLowerCase();

  // Allow fully custom IMAP host to override everything
  if (process.env.IMAP_HOST) {
    return {
      user: process.env.APOLLO_EMAIL,
      password: process.env.IMAP_PASSWORD,
      host: process.env.IMAP_HOST,
      port: parseInt(process.env.IMAP_PORT) || 993,
      tls: process.env.IMAP_TLS !== 'false',
      tlsOptions: { rejectUnauthorized: false },
    };
  }

  const presets = {
    gmail: {
      host: 'imap.gmail.com',
      port: 993,
      // Gmail needs an App Password: myaccount.google.com/apppasswords
      password: process.env.IMAP_PASSWORD || process.env.GMAIL_APP_PASSWORD,
    },
    // Google Workspace uses identical IMAP settings to Gmail
    'google-workspace': {
      host: 'imap.gmail.com',
      port: 993,
      password: process.env.IMAP_PASSWORD || process.env.GMAIL_APP_PASSWORD,
    },
    outlook: {
      host: 'outlook.office365.com',
      port: 993,
      password: process.env.IMAP_PASSWORD,
    },
    hotmail: {
      host: 'outlook.office365.com',
      port: 993,
      password: process.env.IMAP_PASSWORD,
    },
  };

  const preset = presets[provider] || presets.gmail;

  return {
    user: process.env.APOLLO_EMAIL,  // Same email as Apollo login
    password: preset.password,
    host: preset.host,
    port: preset.port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 15000,
    connTimeout: 20000,
  };
}

// ─── Open IMAP connection ──────────────────────────────────────────────────────
function openImapConnection() {
  return new Promise((resolve, reject) => {
    const config = getImapConfig();

    if (!config.password) {
      return reject(new Error(
        'IMAP password not set. Set IMAP_PASSWORD (or GMAIL_APP_PASSWORD for Gmail) in your .env'
      ));
    }

    console.log(`  [IMAP] Connecting to ${config.host}:${config.port} as ${config.user}`);

    const imap = new Imap(config);
    imap.once('ready', () => resolve(imap));
    imap.once('error', reject);
    imap.connect();
  });
}

// ─── Search inbox for Apollo OTP email ────────────────────────────────────────
function searchForOtp(imap, sinceDate) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', false, (err) => {
      if (err) return reject(err);

      // Search criteria: recent unseen emails from Apollo
      // We use SINCE (not UID) so it works across all providers
      const criteria = [
        'UNSEEN',
        ['FROM', 'apollo.io'],
        ['SINCE', sinceDate],
      ];

      imap.search(criteria, (err, results) => {
        if (err) {
          // Fallback: try without UNSEEN in case provider doesn't support it well
          imap.search([['FROM', 'apollo.io'], ['SINCE', sinceDate]], (err2, results2) => {
            if (err2) return reject(err2);
            resolve(results2 || []);
          });
          return;
        }
        resolve(results || []);
      });
    });
  });
}

// ─── Extract OTP from email body ──────────────────────────────────────────────
function extractOtpFromEmail(emailText, emailHtml) {
  const sources = [emailText, emailHtml].filter(Boolean);

  for (const source of sources) {
    // Strip HTML tags for cleaner matching
    const plain = source.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

    // Patterns Apollo uses — ordered most specific → least specific
    const patterns = [
      /verification code[:\s]+(\d{6})/i,
      /your code[:\s]+(\d{6})/i,
      /one.time.password[:\s]+(\d{6})/i,
      /enter.+?(\d{6}).+?to/i,
      // Apollo puts the OTP on its own line as bold text — match isolated 6-digit numbers
      /(?:^|\s)(\d{6})(?:\s|$)/m,
      /\b([0-9]{6})\b/,              // Any standalone 6-digit number
    ];

    for (const pattern of patterns) {
      const match = plain.match(pattern);
      if (match) return match[1];
    }
  }

  return null;
}

// ─── Parse messages and extract OTP ──────────────────────────────────────────
function parseMessages(imap, messageIds) {
  return new Promise((resolve, reject) => {
    if (!messageIds.length) return resolve(null);

    // Fetch most recent first
    const ids = messageIds.slice(-5); // Last 5 matches max
    const fetch = imap.fetch(ids, { bodies: '' });

    // FIX: collect Promises for each message so we await them all before resolving.
    // The original code resolved in fetch.once('end') before simpleParser callbacks
    // had fired, because simpleParser is async — this was a race condition.
    const parsePromises = [];

    fetch.on('message', (msg) => {
      const parsePromise = new Promise((res) => {
        msg.on('body', (stream) => {
          simpleParser(stream, (err, parsed) => {
            if (err) return res(null);
            const otp = extractOtpFromEmail(parsed.text, parsed.html);
            res(otp || null);
          });
        });
      });
      parsePromises.push(parsePromise);
    });

    fetch.once('end', async () => {
      try {
        const results = await Promise.all(parsePromises);
        const otps = results.filter(Boolean);
        resolve(otps.length > 0 ? otps[otps.length - 1] : null);
      } catch (e) {
        resolve(null);
      }
    });

    fetch.once('error', reject);
  });
}

// ─── Main: poll until OTP found ───────────────────────────────────────────────
async function fetchOtpFromEmail(timeoutMs = 120000) {
  const startedAt = new Date();
  const deadline = Date.now() + timeoutMs;
  // Search emails from 3 minutes before we started (handles clock skew)
  const sinceDate = new Date(startedAt.getTime() - 3 * 60 * 1000);

  console.log(`  [IMAP] Waiting for Apollo OTP email (timeout: ${timeoutMs / 1000}s)...`);

  while (Date.now() < deadline) {
    let imap;
    try {
      imap = await openImapConnection();
      const messageIds = await searchForOtp(imap, sinceDate);

      if (messageIds.length > 0) {
        console.log(`  [IMAP] Found ${messageIds.length} matching email(s), parsing...`);
        const otp = await parseMessages(imap, messageIds);

        if (otp) {
          imap.end();
          console.log(`  [IMAP] ✓ OTP found: ${otp}`);
          return otp;
        }
        console.log('  [IMAP] Email found but no OTP extracted yet, retrying...');
      } else {
        console.log('  [IMAP] No email yet, retrying in 6s...');
      }

      imap.end();
    } catch (err) {
      console.error('  [IMAP] Error:', err.message);
      if (imap) try { imap.end(); } catch (_) {}
    }

    // Wait before next poll
    await new Promise(r => setTimeout(r, 6000));
  }

  throw new Error(`OTP not received within ${timeoutMs / 1000}s. Check IMAP credentials and that Apollo sends verification to ${process.env.APOLLO_EMAIL}`);
}

module.exports = { fetchOtpFromEmail };
