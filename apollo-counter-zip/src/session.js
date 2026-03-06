/**
 * session.js — Multi-account Apollo login manager
 *
 * Login flow (pure HTTPS, no browser):
 *  1. GET /  → collect set-cookie headers (dwndvc, zp_device_id, etc.)
 *  2. GET /  again following Location redirect → get cf_clearance + X-CSRF-TOKEN
 *  3. Capsolver solves Turnstile → cf_turnstile_token
 *  4. POST /api/v1/auth/login  with all seed cookies + turnstile token
 *  5. If otp_required → read OTP from IMAP → POST /api/v1/auth/otp_verify
 *  6. Store merged session cookies for reuse
 */

const https = require('https');
const { fetchOtpFromEmail } = require('./imap');

// ─── Config ───────────────────────────────────────────────────────────────────
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY
  || 'CAP-D3066E7DCF80005676B3C5DD6C46CA7D4A28B0A9D857CD4E0A614155F83FC499';

// Turnstile site key — from Apollo login page HTML (data-sitekey attribute)
// Error 110200 means wrong key — Apollo uses this key on app.apollo.io
const TURNSTILE_SITE_KEY = '0x4AAAAAAA3bJHSNYMxIAp-0';
const APOLLO_ORIGIN      = 'https://app.apollo.io';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// ─── Account pool ─────────────────────────────────────────────────────────────
const ACCOUNTS = [
  {
    id: 1,
    email:    process.env.APOLLO_EMAIL_1    || process.env.APOLLO_EMAIL,
    password: process.env.APOLLO_PASSWORD_1 || process.env.APOLLO_PASSWORD,
    imap: {
      provider: process.env.IMAP_PROVIDER_1 || process.env.IMAP_PROVIDER || 'gmail',
      password: process.env.IMAP_PASSWORD_1 || process.env.IMAP_PASSWORD,
      host:     process.env.IMAP_HOST_1 || null,
      port:     parseInt(process.env.IMAP_PORT_1 || '993', 10),
    },
  },
  {
    id: 2,
    email:    process.env.APOLLO_EMAIL_2,
    password: process.env.APOLLO_PASSWORD_2,
    imap: {
      provider: process.env.IMAP_PROVIDER_2 || 'gmail',
      password: process.env.IMAP_PASSWORD_2,
      host:     process.env.IMAP_HOST_2 || null,
      port:     parseInt(process.env.IMAP_PORT_2 || '993', 10),
    },
  },
  {
    id: 3,
    email:    process.env.APOLLO_EMAIL_3,
    password: process.env.APOLLO_PASSWORD_3,
    imap: {
      provider: process.env.IMAP_PROVIDER_3 || 'gmail',
      password: process.env.IMAP_PASSWORD_3,
      host:     process.env.IMAP_HOST_3 || null,
      port:     parseInt(process.env.IMAP_PORT_3 || '993', 10),
    },
  },
].filter(a => a.email && a.password);

// ─── Session store ────────────────────────────────────────────────────────────
const sessions = {};
let rrIndex = 0;

// ─── Staggered warm-up ────────────────────────────────────────────────────────
async function warmAllSessions() {
  if (ACCOUNTS.length === 0) throw new Error('No Apollo accounts in .env');

  console.log(`[Auth] Warming ${ACCOUNTS.length} account(s) — 30 min stagger between each`);

  // Account 1 — login now, block until ready
  await loginAccount(ACCOUNTS[0]).catch(e =>
    console.error(`[Auth] Account 1 failed: ${e.message}`)
  );

  // Accounts 2 & 3 — staggered in background
  for (let i = 1; i < ACCOUNTS.length; i++) {
    const delay = i * 30 * 60 * 1000;
    const acc = ACCOUNTS[i];
    console.log(`[Auth] Account ${acc.id} will login in ${i * 30} min`);
    setTimeout(async () => {
      try { await loginAccount(acc); }
      catch (e) { console.error(`[Auth] Account ${acc.id} failed: ${e.message}`); }
    }, delay).unref();
  }

  console.log('[Auth] Account 1 ready. Others scheduled.');
}

// ─── Get a valid session (round-robin) ────────────────────────────────────────
async function getValidSession(forceEmail = null) {
  if (ACCOUNTS.length === 0) throw new Error('No accounts configured');

  if (forceEmail) {
    const acc = ACCOUNTS.find(a => a.email === forceEmail);
    if (!acc) throw new Error(`Account ${forceEmail} not found`);
    return _ensureSession(acc);
  }

  for (let i = 0; i < ACCOUNTS.length; i++) {
    const idx = (rrIndex + i) % ACCOUNTS.length;
    const acc = ACCOUNTS[idx];
    const s = sessions[acc.email];
    if (s && s.loggedIn && Date.now() < s.expiresAt) {
      rrIndex = (idx + 1) % ACCOUNTS.length;
      return s;
    }
  }

  const acc = ACCOUNTS[rrIndex % ACCOUNTS.length];
  rrIndex = (rrIndex + 1) % ACCOUNTS.length;
  return _ensureSession(acc);
}

async function _ensureSession(account) {
  const s = sessions[account.email];
  if (s && s.loggedIn && Date.now() < s.expiresAt) return s;
  return loginAccount(account);
}

function invalidateSession(email) {
  if (sessions[email]) {
    console.log(`[Auth] Session invalidated: ${email}`);
    sessions[email].loggedIn = false;
    sessions[email].expiresAt = 0;
  }
}

// ─── Full login flow ──────────────────────────────────────────────────────────
async function loginAccount(account) {
  console.log(`[Auth] ── Logging in account ${account.id}: ${account.email}`);

  // Step 1: Load Apollo homepage — follow up to 3 redirects, collect all cookies
  // This gives us: dwndvc, zp_device_id, __cf_bm, cf_clearance, X-CSRF-TOKEN
  const { cookies: seedCookies, csrfToken: seedCsrf } = await loadApolloHomepage();
  console.log(`[Auth]   Seed CSRF: ${seedCsrf ? seedCsrf.slice(0, 20) + '...' : '(none — CF may have blocked)'}`);

  // Step 2: Solve Turnstile
  let turnstileToken = null;
  try {
    turnstileToken = await solveTurnstile();
  } catch (err) {
    console.warn(`[Auth]   Turnstile failed: ${err.message}`);
    // Without turnstile Apollo will 403 — re-throw so we don't waste the attempt
    throw new Error(`Cannot login without Turnstile token: ${err.message}`);
  }

  // Step 3: POST /api/v1/auth/login
  const loginBody = JSON.stringify({
    email:           account.email,
    password:        account.password,
    timezone_offset: new Date().getTimezoneOffset(),
    cacheKey:        Date.now(),
    cf_turnstile_token: turnstileToken,
  });

  const loginRes = await httpsRequestFull({
    hostname: 'app.apollo.io',
    path:     '/api/v1/auth/login',
    method:   'POST',
    headers: {
      'Content-Type':      'application/json',
      'Content-Length':    Buffer.byteLength(loginBody),
      'Accept':            '*/*',
      'Accept-Language':   'en-GB,en-US;q=0.9,en;q=0.8',
      'Origin':            'https://app.apollo.io',
      'Referer':           'https://app.apollo.io/',
      'User-Agent':        UA,
      'x-csrf-token':      seedCsrf || '',
      'x-referer-host':    'app.apollo.io',
      'x-referer-path':    '/login',
      'x-accept-language': 'en',
      'Cookie':            cookiesToString(seedCookies),
    },
  }, loginBody);

  console.log(`[Auth]   Login HTTP ${loginRes.statusCode}`);

  let responseData = {};
  try { responseData = JSON.parse(loginRes.body); } catch (_) {}

  if (loginRes.statusCode === 403) {
    throw new Error(`Login blocked by Cloudflare (403). CF clearance missing or Turnstile rejected.`);
  }
  if (loginRes.statusCode === 401 || loginRes.statusCode === 422) {
    throw new Error(`Login failed (${loginRes.statusCode}): ${responseData.message || 'wrong credentials'}`);
  }
  if (loginRes.statusCode !== 200) {
    throw new Error(`Login failed HTTP ${loginRes.statusCode}: ${loginRes.body.slice(0, 300)}`);
  }

  // Merge response cookies
  let cookies = mergeCookies(
    seedCookies,
    parseSetCookieHeaders(loginRes.headers['set-cookie'] || [])
  );
  let csrfToken = cookieValue(cookies, 'X-CSRF-TOKEN') || seedCsrf;

  // Step 4: OTP if required
  if (responseData.otp_required) {
    console.log(`[Auth]   OTP required — reading from IMAP (${account.email})...`);

    const otp = await fetchOtpForAccount(account);
    console.log(`[Auth]   OTP obtained: ${otp}`);

    const otpBody = JSON.stringify({ otp_code: otp, cacheKey: Date.now() });
    const otpRes  = await httpsRequestFull({
      hostname: 'app.apollo.io',
      path:     '/api/v1/auth/otp_verify',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(otpBody),
        'Accept':            '*/*',
        'Origin':            'https://app.apollo.io',
        'Referer':           'https://app.apollo.io/',
        'User-Agent':        UA,
        'x-csrf-token':      csrfToken,
        'x-referer-host':    'app.apollo.io',
        'x-referer-path':    '/login',
        'x-accept-language': 'en',
        'Cookie':            cookiesToString(cookies),
      },
    }, otpBody);

    console.log(`[Auth]   OTP verify HTTP ${otpRes.statusCode}`);
    if (otpRes.statusCode !== 200) throw new Error(`OTP verify failed: HTTP ${otpRes.statusCode}`);

    cookies    = mergeCookies(cookies, parseSetCookieHeaders(otpRes.headers['set-cookie'] || []));
    csrfToken  = cookieValue(cookies, 'X-CSRF-TOKEN') || csrfToken;
  }

  // Step 5: Store session
  const rememberCookie = cookies.find(c => c.name === 'remember_token_leadgenie_v2');
  let expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  if (rememberCookie?.expires) {
    const p = new Date(rememberCookie.expires).getTime();
    if (!isNaN(p)) expiresAt = p;
  }
  expiresAt -= 10 * 60 * 1000; // 10 min buffer

  sessions[account.email] = { cookies, csrfToken, expiresAt, loggedIn: true, account };
  console.log(`[Auth] ✓ Account ${account.id} ready — expires ${new Date(expiresAt).toISOString()}`);
  return sessions[account.email];
}

// ─── Load Apollo homepage following redirects to get CF cookies ───────────────
// Apollo's homepage goes through Cloudflare which sets cf_clearance via JS challenge.
// We make TWO requests: first gets __cf_bm + redirect, second (to /login) gets
// the actual CSRF token that's set after CF validates the session.
async function loadApolloHomepage() {
  let allCookies = [];

  // Request 1: GET / — gets dwndvc, zp_device_id, __cf_bm
  const res1 = await httpsRequestFull({
    hostname: 'app.apollo.io',
    path:     '/',
    method:   'GET',
    headers: {
      'User-Agent':      UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    },
  });
  allCookies = mergeCookies(allCookies, parseSetCookieHeaders(res1.headers['set-cookie'] || []));

  // Request 2: GET /login — gets X-CSRF-TOKEN (set after CF passes the request)
  const res2 = await httpsRequestFull({
    hostname: 'app.apollo.io',
    path:     '/',
    method:   'GET',
    headers: {
      'User-Agent':      UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Referer':         'https://app.apollo.io/',
      'Cookie':          cookiesToString(allCookies),
    },
  });
  allCookies = mergeCookies(allCookies, parseSetCookieHeaders(res2.headers['set-cookie'] || []));

  const csrfToken = cookieValue(allCookies, 'X-CSRF-TOKEN');
  return { cookies: allCookies, csrfToken };
}

// ─── Fetch OTP using this account's own IMAP config ──────────────────────────
async function fetchOtpForAccount(account) {
  // Swap env vars to point imap.js at the correct inbox for this account
  const saved = {
    APOLLO_EMAIL:  process.env.APOLLO_EMAIL,
    IMAP_PROVIDER: process.env.IMAP_PROVIDER,
    IMAP_PASSWORD: process.env.IMAP_PASSWORD,
    IMAP_HOST:     process.env.IMAP_HOST,
    IMAP_PORT:     process.env.IMAP_PORT,
  };

  process.env.APOLLO_EMAIL  = account.email;
  process.env.IMAP_PROVIDER = account.imap.provider;
  process.env.IMAP_PASSWORD = account.imap.password;
  if (account.imap.host) process.env.IMAP_HOST = account.imap.host;
  else delete process.env.IMAP_HOST;
  process.env.IMAP_PORT = String(account.imap.port || 993);

  try {
    return await fetchOtpFromEmail(120000);
  } finally {
    process.env.APOLLO_EMAIL  = saved.APOLLO_EMAIL;
    process.env.IMAP_PROVIDER = saved.IMAP_PROVIDER;
    process.env.IMAP_PASSWORD = saved.IMAP_PASSWORD;
    if (saved.IMAP_HOST) process.env.IMAP_HOST = saved.IMAP_HOST; else delete process.env.IMAP_HOST;
    if (saved.IMAP_PORT) process.env.IMAP_PORT = saved.IMAP_PORT; else delete process.env.IMAP_PORT;
  }
}

// ─── Capsolver: Cloudflare Turnstile ─────────────────────────────────────────
async function solveTurnstile() {
  console.log('[Capsolver] Creating Turnstile task...');

  const createBody = JSON.stringify({
    clientKey: CAPSOLVER_API_KEY,
    task: {
      type:       'AntiTurnstileTaskProxyLess',
      websiteURL: APOLLO_ORIGIN,
      websiteKey: TURNSTILE_SITE_KEY,
    },
  });

  const createRes = await httpsJsonPost('api.capsolver.com', '/createTask', createBody);
  if (createRes.errorId !== 0) {
    throw new Error(`Capsolver createTask failed: ${createRes.errorDescription}`);
  }

  const { taskId } = createRes;
  console.log(`[Capsolver] Task ${taskId} — polling...`);

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const pollBody = JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId });
    const poll = await httpsJsonPost('api.capsolver.com', '/getTaskResult', pollBody);

    if (poll.status === 'ready') {
      console.log('[Capsolver] ✓ Token ready');
      return poll.solution.token;
    }
    if (poll.status === 'failed' || poll.errorId !== 0) {
      throw new Error(`Capsolver task failed: ${poll.errorDescription}`);
    }
    process.stdout.write('.');
  }
  throw new Error('Capsolver timed out after 120s');
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
      if (attr.toLowerCase().startsWith('expires=')) cookie.expires = attr.slice(8);
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

function httpsJsonPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Exports ──────────────────────────────────────────────────────────────────
const ensureSession = getValidSession; // backward-compat alias

module.exports = {
  warmAllSessions,
  getValidSession,
  ensureSession,
  invalidateSession,
  loginAccount,
  ACCOUNTS,
};
