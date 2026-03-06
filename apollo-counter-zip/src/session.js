/**
 * session.js — Multi-account Apollo login manager
 *
 * Features:
 *  - 3 accounts, each with its own IMAP inbox for OTP
 *  - Staggered startup: account 1 logs in at t=0, account 2 at t+30min, account 3 at t+60min
 *    so sessions never all expire at the same time
 *  - Turnstile captcha solved via Capsolver on every login
 *  - Auto re-login when session expires (401/403) or within 10min of expiry
 *  - Round-robin: each search request rotates to the next ready account
 */

const https = require('https');
const { fetchOtpFromEmail } = require('./imap');

// ─── Capsolver config ─────────────────────────────────────────────────────────
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY
  || 'CAP-D3066E7DCF80005676B3C5DD6C46CA7D4A28B0A9D857CD4E0A614155F83FC499';

// Apollo's Cloudflare Turnstile site key (stable, from login page source)
const TURNSTILE_SITE_KEY = '0x4AAAAAAABkMYinukE8nzYS';
const APOLLO_ORIGIN     = 'https://app.apollo.io';

// ─── Account pool ─────────────────────────────────────────────────────────────
// Each account has its own Apollo credentials + its own IMAP inbox for OTP emails.
// IMAP config mirrors imap.js but is per-account so each Gmail reads its own inbox.
const ACCOUNTS = [
  {
    id: 1,
    email:    process.env.APOLLO_EMAIL_1    || process.env.APOLLO_EMAIL,
    password: process.env.APOLLO_PASSWORD_1 || process.env.APOLLO_PASSWORD,
    imap: {
      provider: process.env.IMAP_PROVIDER_1 || process.env.IMAP_PROVIDER || 'gmail',
      password: process.env.IMAP_PASSWORD_1 || process.env.IMAP_PASSWORD || process.env.GMAIL_APP_PASSWORD_1,
      host:     process.env.IMAP_HOST_1     || null,
      port:     process.env.IMAP_PORT_1     || 993,
    },
  },
  {
    id: 2,
    email:    process.env.APOLLO_EMAIL_2,
    password: process.env.APOLLO_PASSWORD_2,
    imap: {
      provider: process.env.IMAP_PROVIDER_2 || 'gmail',
      password: process.env.IMAP_PASSWORD_2 || process.env.GMAIL_APP_PASSWORD_2,
      host:     process.env.IMAP_HOST_2     || null,
      port:     process.env.IMAP_PORT_2     || 993,
    },
  },
  {
    id: 3,
    email:    process.env.APOLLO_EMAIL_3,
    password: process.env.APOLLO_PASSWORD_3,
    imap: {
      provider: process.env.IMAP_PROVIDER_3 || 'gmail',
      password: process.env.IMAP_PASSWORD_3 || process.env.GMAIL_APP_PASSWORD_3,
      host:     process.env.IMAP_HOST_3     || null,
      port:     process.env.IMAP_PORT_3     || 993,
    },
  },
].filter(a => a.email && a.password);

// ─── Session store ────────────────────────────────────────────────────────────
// sessions[email] = { cookies, csrfToken, expiresAt, loggedIn, account }
const sessions = {};

// Round-robin pointer
let rrIndex = 0;

// ─── Staggered warm-up ────────────────────────────────────────────────────────
// Call this once at app startup.
// Account 1 logs in immediately, account 2 after 30 min, account 3 after 60 min.
// This ensures sessions expire at different times so there's always one ready.
async function warmAllSessions() {
  if (ACCOUNTS.length === 0) {
    throw new Error('No Apollo accounts configured. Check your .env file.');
  }

  const STAGGER_MS = 30 * 60 * 1000; // 30 minutes

  console.log(`[Auth] Warming ${ACCOUNTS.length} account(s) with 30-min stagger...`);

  // Login account 1 immediately (synchronously, so it's ready before we return)
  await loginAccount(ACCOUNTS[0]).catch(e =>
    console.error(`[Auth] Account 1 warm-up failed: ${e.message}`)
  );

  // Schedule accounts 2 and 3 in the background — they'll be ready before their
  // sessions are actually needed (assuming requests start coming in immediately)
  for (let i = 1; i < ACCOUNTS.length; i++) {
    const delay = i * STAGGER_MS;
    const acc = ACCOUNTS[i];
    console.log(`[Auth] Account ${acc.id} scheduled to login in ${delay / 60000} min`);
    setTimeout(async () => {
      try {
        await loginAccount(acc);
      } catch (e) {
        console.error(`[Auth] Account ${acc.id} staggered login failed: ${e.message}`);
      }
    }, delay).unref(); // .unref() so the timer doesn't block process exit
  }

  console.log('[Auth] Account 1 is ready. Accounts 2/3 will log in in background.');
}

// ─── Get a ready session (round-robin, auto re-login) ─────────────────────────
async function getValidSession(forceEmail = null) {
  if (ACCOUNTS.length === 0) {
    throw new Error('No accounts configured.');
  }

  if (forceEmail) {
    const acc = ACCOUNTS.find(a => a.email === forceEmail);
    if (!acc) throw new Error(`Account ${forceEmail} not in pool`);
    return _ensureSession(acc);
  }

  // Try accounts in round-robin order, pick first one that has a valid session
  for (let i = 0; i < ACCOUNTS.length; i++) {
    const idx = (rrIndex + i) % ACCOUNTS.length;
    const acc = ACCOUNTS[idx];
    const s = sessions[acc.email];
    if (s && s.loggedIn && Date.now() < s.expiresAt) {
      rrIndex = (idx + 1) % ACCOUNTS.length;
      return s;
    }
  }

  // No ready session — use the next account and log in now
  const acc = ACCOUNTS[rrIndex % ACCOUNTS.length];
  rrIndex = (rrIndex + 1) % ACCOUNTS.length;
  return _ensureSession(acc);
}

async function _ensureSession(account) {
  const s = sessions[account.email];
  if (s && s.loggedIn && Date.now() < s.expiresAt) return s;
  return loginAccount(account);
}

// ─── Invalidate (called on 401/403) ──────────────────────────────────────────
function invalidateSession(email) {
  if (sessions[email]) {
    console.log(`[Auth] Invalidating session for ${email}`);
    sessions[email].loggedIn = false;
    sessions[email].expiresAt = 0;
  }
}

// ─── Full login flow ──────────────────────────────────────────────────────────
async function loginAccount(account) {
  console.log(`\n[Auth] ── Logging in account ${account.id}: ${account.email}`);

  // Step 1: Load the login page to get seed cookies + CSRF token
  const { cookies: seedCookies, csrfToken: seedCsrf } = await getSeedCookies();
  console.log(`[Auth]   Seed CSRF: ${seedCsrf ? seedCsrf.slice(0, 20) + '...' : '(none)'}`);

  // Step 2: Solve Turnstile captcha via Capsolver
  let turnstileToken = null;
  try {
    turnstileToken = await solveTurnstile();
  } catch (err) {
    console.warn(`[Auth]   Turnstile failed (${err.message}), proceeding without token`);
  }

  // Step 3: POST login
  const loginBody = JSON.stringify({
    email:            account.email,
    password:         account.password,
    timezone_offset:  new Date().getTimezoneOffset(),
    cacheKey:         Date.now(),
    ...(turnstileToken ? { cf_turnstile_token: turnstileToken } : {}),
  });

  const loginRes = await httpsRequestFull({
    hostname: 'app.apollo.io',
    path:     '/api/v1/auth/login',
    method:   'POST',
    headers: {
      'Content-Type':    'application/json',
      'Content-Length':  Buffer.byteLength(loginBody),
      'Accept':          '*/*',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Origin':          'https://app.apollo.io',
      'Referer':         'https://app.apollo.io/',
      'User-Agent':      UA,
      'x-csrf-token':    seedCsrf || '',
      'x-referer-host':  'app.apollo.io',
      'x-referer-path':  '/login',
      'x-accept-language': 'en',
      'Cookie':          cookiesToString(seedCookies),
    },
  }, loginBody);

  console.log(`[Auth]   Login response: HTTP ${loginRes.statusCode}`);

  // Step 4: Check if OTP is required (Apollo sends 200 with otp_required flag)
  let responseData = {};
  try { responseData = JSON.parse(loginRes.body); } catch (_) {}

  // Merge cookies from login response
  let cookies = mergeCookies(
    seedCookies,
    parseSetCookieHeaders(loginRes.headers['set-cookie'] || [])
  );
  let csrfToken = cookieValue(cookies, 'X-CSRF-TOKEN') || seedCsrf;

  if (loginRes.statusCode === 200 && responseData.otp_required) {
    console.log(`[Auth]   OTP required — fetching from IMAP (${account.email})...`);

    // Override IMAP env vars temporarily for this account's inbox
    const origEmail    = process.env.APOLLO_EMAIL;
    const origProvider = process.env.IMAP_PROVIDER;
    const origPassword = process.env.IMAP_PASSWORD;
    const origHost     = process.env.IMAP_HOST;
    const origPort     = process.env.IMAP_PORT;

    process.env.APOLLO_EMAIL    = account.email;
    process.env.IMAP_PROVIDER   = account.imap.provider;
    process.env.IMAP_PASSWORD   = account.imap.password;
    if (account.imap.host) process.env.IMAP_HOST = account.imap.host;
    if (account.imap.port) process.env.IMAP_PORT = String(account.imap.port);

    let otp;
    try {
      otp = await fetchOtpFromEmail(120000);
    } finally {
      // Restore
      process.env.APOLLO_EMAIL    = origEmail;
      process.env.IMAP_PROVIDER   = origProvider;
      process.env.IMAP_PASSWORD   = origPassword;
      if (origHost) process.env.IMAP_HOST = origHost; else delete process.env.IMAP_HOST;
      if (origPort) process.env.IMAP_PORT = origPort; else delete process.env.IMAP_PORT;
    }

    // Submit OTP
    const otpBody = JSON.stringify({ otp_code: otp, cacheKey: Date.now() });
    const otpRes  = await httpsRequestFull({
      hostname: 'app.apollo.io',
      path:     '/api/v1/auth/otp_verify',
      method:   'POST',
      headers: {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(otpBody),
        'Accept':          '*/*',
        'Origin':          'https://app.apollo.io',
        'Referer':         'https://app.apollo.io/',
        'User-Agent':      UA,
        'x-csrf-token':    csrfToken,
        'x-referer-host':  'app.apollo.io',
        'x-referer-path':  '/login',
        'x-accept-language': 'en',
        'Cookie':          cookiesToString(cookies),
      },
    }, otpBody);

    console.log(`[Auth]   OTP verify response: HTTP ${otpRes.statusCode}`);

    if (otpRes.statusCode !== 200) {
      throw new Error(`OTP verification failed: HTTP ${otpRes.statusCode}`);
    }

    // Merge OTP response cookies
    cookies = mergeCookies(
      cookies,
      parseSetCookieHeaders(otpRes.headers['set-cookie'] || [])
    );
    csrfToken = cookieValue(cookies, 'X-CSRF-TOKEN') || csrfToken;

  } else if (loginRes.statusCode !== 200) {
    const msg = responseData.message || loginRes.body.slice(0, 200);
    throw new Error(`Login failed HTTP ${loginRes.statusCode}: ${msg}`);
  }

  // Step 5: Determine session expiry from remember_token cookie
  const rememberCookie = cookies.find(c => c.name === 'remember_token_leadgenie_v2');
  let expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // fallback: 7 days
  if (rememberCookie?.expires) {
    const parsed = new Date(rememberCookie.expires).getTime();
    if (!isNaN(parsed)) expiresAt = parsed;
  }
  expiresAt -= 10 * 60 * 1000; // expire 10 min early

  sessions[account.email] = { cookies, csrfToken, expiresAt, loggedIn: true, account };

  console.log(`[Auth] ✓ Account ${account.id} (${account.email}) logged in — session until ${new Date(expiresAt).toISOString()}\n`);
  return sessions[account.email];
}

// ─── Capsolver: solve Cloudflare Turnstile ────────────────────────────────────
async function solveTurnstile() {
  console.log('[Capsolver] Solving Turnstile...');

  const createBody = JSON.stringify({
    clientKey: CAPSOLVER_API_KEY,
    task: {
      type:       'AntiTurnstileTaskProxyLess',
      websiteURL: APOLLO_ORIGIN,
      websiteKey: TURNSTILE_SITE_KEY,
    },
  });

  const createRes = await httpsJsonRequest('api.capsolver.com', '/createTask', createBody);
  if (createRes.errorId !== 0) {
    throw new Error(`Capsolver createTask error: ${createRes.errorDescription}`);
  }

  const taskId = createRes.taskId;
  const deadline = Date.now() + 120000;

  while (Date.now() < deadline) {
    await sleep(3000);
    const pollBody = JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId });
    const pollRes  = await httpsJsonRequest('api.capsolver.com', '/getTaskResult', pollBody);

    if (pollRes.status === 'ready') {
      console.log('[Capsolver] ✓ Turnstile token obtained');
      return pollRes.solution.token;
    }
    if (pollRes.status === 'failed' || pollRes.errorId !== 0) {
      throw new Error(`Capsolver task failed: ${pollRes.errorDescription}`);
    }
  }

  throw new Error('Capsolver timed out after 120s');
}

// ─── Get seed cookies from Apollo homepage ────────────────────────────────────
function getSeedCookies() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'app.apollo.io',
      path:     '/',
      method:   'GET',
      headers: {
        'User-Agent': UA,
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      // Drain the body (required so the socket is released)
      res.resume();
      res.on('end', () => {
        const cookies = parseSetCookieHeaders(res.headers['set-cookie'] || []);
        const csrfToken = cookieValue(cookies, 'X-CSRF-TOKEN');
        resolve({ cookies, csrfToken });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────
function parseSetCookieHeaders(headers) {
  return headers.map(raw => {
    const parts = raw.split(';').map(s => s.trim());
    const eqIdx = parts[0].indexOf('=');
    const name  = parts[0].slice(0, eqIdx).trim();
    const value = parts[0].slice(eqIdx + 1).trim();
    const cookie = { name, value };
    for (const attr of parts.slice(1)) {
      const lo = attr.toLowerCase();
      if (lo.startsWith('expires=')) cookie.expires = attr.slice(8);
    }
    return cookie;
  });
}

function mergeCookies(base, overrides) {
  const map = new Map(base.map(c => [c.name, c]));
  for (const c of overrides) map.set(c.name, c);
  return Array.from(map.values());
}

function cookieValue(cookies, name) {
  return cookies.find(c => c.name === name)?.value || '';
}

function cookiesToString(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function httpsRequestFull(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsJsonRequest(hostname, path, body) {
  const opts = {
    hostname,
    path,
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Exports ──────────────────────────────────────────────────────────────────
// ensureSession is an alias for getValidSession (backward compatibility)
const ensureSession = getValidSession;

module.exports = { warmAllSessions, getValidSession, ensureSession, invalidateSession, loginAccount, ACCOUNTS };
