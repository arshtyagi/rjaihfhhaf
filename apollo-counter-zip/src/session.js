/**
 * session.js — Multi-account Apollo login manager
 *
 * Login flow (pure HTTPS, no browser, no Turnstile):
 *  1. GET app.apollo.io/  x2  →  collect seed cookies (dwndvc, zp_device_id, X-CSRF-TOKEN)
 *  2. POST /api/v1/auth/login  →  { email, password, timezone_offset, cacheKey }
 *  3. If otp_required  →  read OTP from IMAP  →  POST /api/v1/auth/otp_verify
 *  4. Store merged cookies + CSRF token for reuse
 *
 * 3 accounts, staggered 30 min apart so sessions never all expire together.
 * Round-robin: each search rotates to the next ready account.
 */

const https = require('https');
const { fetchOtpFromEmail } = require('./imap');

const APOLLO_ORIGIN = 'https://app.apollo.io';
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
  console.log(`[Auth] Warming ${ACCOUNTS.length} account(s) — 30 min stagger`);

  // Account 1 immediately
  await loginAccount(ACCOUNTS[0]).catch(e =>
    console.error(`[Auth] Account 1 failed: ${e.message}`)
  );

  // Accounts 2 & 3 in background, staggered
  for (let i = 1; i < ACCOUNTS.length; i++) {
    const delay = i * 30 * 60 * 1000;
    const acc = ACCOUNTS[i];
    console.log(`[Auth] Account ${acc.id} scheduled in ${i * 30} min`);
    setTimeout(async () => {
      try { await loginAccount(acc); }
      catch (e) { console.error(`[Auth] Account ${acc.id} failed: ${e.message}`); }
    }, delay).unref();
  }
}

// ─── Get a valid session (round-robin, auto re-login) ─────────────────────────
async function getValidSession(forceEmail = null) {
  if (ACCOUNTS.length === 0) throw new Error('No accounts configured');

  if (forceEmail) {
    const acc = ACCOUNTS.find(a => a.email === forceEmail);
    if (!acc) throw new Error(`Account ${forceEmail} not found`);
    return _ensureSession(acc);
  }

  // Try each account in rotation — use first one with a live session
  for (let i = 0; i < ACCOUNTS.length; i++) {
    const idx = (rrIndex + i) % ACCOUNTS.length;
    const s = sessions[ACCOUNTS[idx].email];
    if (s && s.loggedIn && Date.now() < s.expiresAt) {
      rrIndex = (idx + 1) % ACCOUNTS.length;
      return s;
    }
  }

  // None ready — log in now
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
    console.log(`[Auth] Invalidating session: ${email}`);
    sessions[email].loggedIn = false;
    sessions[email].expiresAt = 0;
  }
}

// ─── Full login flow ──────────────────────────────────────────────────────────
// ─── Helper: POST login with optional captcha token ──────────────────────────
async function postLogin(account, cookies, csrfToken, turnstileToken) {
  const bodyObj = {
    email:           account.email,
    password:        account.password,
    timezone_offset: new Date().getTimezoneOffset(),
    cacheKey:        Date.now(),
  };
  if (turnstileToken) bodyObj.cf_turnstile_token = turnstileToken;
  const body = JSON.stringify(bodyObj);
  return httpsRequestFull({
    hostname: 'app.apollo.io',
    path:     '/api/v1/auth/login',
    method:   'POST',
    headers: {
      'Content-Type':      'application/json',
      'Content-Length':    Buffer.byteLength(body),
      'Accept':            '*/*',
      'Accept-Language':   'en-GB,en-US;q=0.9,en;q=0.8',
      'Origin':            'https://app.apollo.io',
      'Referer':           'https://app.apollo.io/',
      'User-Agent':        UA,
      'x-csrf-token':      csrfToken || '',
      'x-referer-host':    'app.apollo.io',
      'x-referer-path':    '/login',
      'x-accept-language': 'en',
      'sec-fetch-dest':    'empty',
      'sec-fetch-mode':    'cors',
      'sec-fetch-site':    'same-origin',
      'Cookie':            cookiesToString(cookies),
    },
  }, body);
}

async function loginAccount(account) {
  console.log(`[Auth] ── Logging in account ${account.id}: ${account.email}`);

  // Step 1: Get seed cookies
  let { cookies: seedCookies, csrfToken: seedCsrf } = await getSeedCookies();
  console.log(`[Auth]   CSRF: ${seedCsrf ? seedCsrf.slice(0, 20) + '...' : '(none)'}`);
  console.log(`[Auth]   Seed cookies: ${seedCookies.map(c => c.name).join(', ')}`);

  // Step 2: Try login without captcha first (normal case)
  let loginRes = await postLogin(account, seedCookies, seedCsrf, null);
  console.log(`[Auth]   Login HTTP ${loginRes.statusCode}`);

  let responseData = {};
  try { responseData = JSON.parse(loginRes.body); } catch (_) {}

  // If captcha is needed, solve it and retry once
  const needsCaptcha =
    loginRes.statusCode === 403 ||
    responseData.captcha_required ||
    (typeof loginRes.body === 'string' && loginRes.body.includes('captcha'));

  if (needsCaptcha) {
    console.log(`[Auth]   Captcha detected — solving...`);
    let solution;
    try {
      solution = await solveTurnstile();
    } catch (err) {
      throw new Error(`Captcha required but solver failed: ${err.message}`);
    }
    // Merge any CF cookies returned by the solver (e.g. cf_clearance)
    if (solution.cookies && solution.cookies.length) {
      seedCookies = mergeCookies(seedCookies, solution.cookies);
      console.log(`[Auth]   CF cookies from solver: ${solution.cookies.map(c=>c.name).join(', ')}`);
    }
    loginRes = await postLogin(account, seedCookies, seedCsrf, solution.token || null);
    console.log(`[Auth]   Login (with captcha) HTTP ${loginRes.statusCode}`);
    try { responseData = JSON.parse(loginRes.body); } catch (_) {}
  }

  if (loginRes.statusCode === 403) {
    throw new Error(`Login blocked (403) even after captcha. Body: ${loginRes.body.slice(0, 200)}`);
  }
  if (loginRes.statusCode === 401 || loginRes.statusCode === 422) {
    throw new Error(`Wrong credentials (${loginRes.statusCode}): ${responseData.message || ''}`);
  }
  if (loginRes.statusCode !== 200) {
    throw new Error(`Login failed HTTP ${loginRes.statusCode}: ${loginRes.body.slice(0, 300)}`);
  }

  // Merge session cookies
  let cookies = mergeCookies(
    seedCookies,
    parseSetCookieHeaders(loginRes.headers['set-cookie'] || [])
  );
  let csrfToken = cookieValue(cookies, 'X-CSRF-TOKEN') || seedCsrf;

  // Step 3: OTP if required
  if (responseData.otp_required) {
    console.log(`[Auth]   OTP required — reading IMAP for ${account.email}...`);
    const otp = await fetchOtpForAccount(account);
    console.log(`[Auth]   OTP: ${otp}`);

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

    cookies   = mergeCookies(cookies, parseSetCookieHeaders(otpRes.headers['set-cookie'] || []));
    csrfToken = cookieValue(cookies, 'X-CSRF-TOKEN') || csrfToken;
  }

  // Step 4: Store session
  const rememberCookie = cookies.find(c => c.name === 'remember_token_leadgenie_v2');
  let expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 day default
  if (rememberCookie?.expires) {
    const p = new Date(rememberCookie.expires).getTime();
    if (!isNaN(p)) expiresAt = p;
  }
  expiresAt -= 10 * 60 * 1000; // 10 min safety buffer

  sessions[account.email] = { cookies, csrfToken, expiresAt, loggedIn: true, account };
  console.log(`[Auth] ✓ Account ${account.id} ready — expires ${new Date(expiresAt).toISOString()}`);
  return sessions[account.email];
}

// ─── Collect seed cookies from Apollo (2 GETs) ───────────────────────────────
// First GET: gets device cookies (dwndvc, zp_device_id)
// Second GET with those cookies: gets session cookies (X-CSRF-TOKEN, _leadgenie_session)
async function getSeedCookies() {
  // GET 1
  const r1 = await httpsRequestFull({
    hostname: 'app.apollo.io',
    path:     '/',
    method:   'GET',
    headers: {
      'User-Agent':      UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'sec-fetch-dest':  'document',
      'sec-fetch-mode':  'navigate',
      'sec-fetch-site':  'none',
    },
  });
  let cookies = parseSetCookieHeaders(r1.headers['set-cookie'] || []);

  // GET 2 — send cookies from GET 1 to get CSRF token
  const r2 = await httpsRequestFull({
    hostname: 'app.apollo.io',
    path:     '/',
    method:   'GET',
    headers: {
      'User-Agent':      UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Referer':         'https://app.apollo.io/',
      'sec-fetch-dest':  'document',
      'sec-fetch-mode':  'navigate',
      'sec-fetch-site':  'same-origin',
      'Cookie':          cookiesToString(cookies),
    },
  });
  cookies = mergeCookies(cookies, parseSetCookieHeaders(r2.headers['set-cookie'] || []));

  const csrfToken = cookieValue(cookies, 'X-CSRF-TOKEN');
  return { cookies, csrfToken };
}

// ─── Fetch OTP using this account's own IMAP inbox ───────────────────────────
async function fetchOtpForAccount(account) {
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
    if (saved.IMAP_HOST) process.env.IMAP_HOST = saved.IMAP_HOST;
    else delete process.env.IMAP_HOST;
    if (saved.IMAP_PORT) process.env.IMAP_PORT = saved.IMAP_PORT;
    else delete process.env.IMAP_PORT;
  }
}


// ─── Captcha solvers (only called when captcha is detected) ──────────────────
// Tries Capsolver first, falls back to 2captcha if Capsolver fails.

const CAPSOLVER_API_KEY  = process.env.CAPSOLVER_API_KEY
  || 'CAP-D3066E7DCF80005676B3C5DD6C46CA7D4A28B0A9D857CD4E0A614155F83FC499';
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY || '';

const SITE_KEY    = process.env.TURNSTILE_SITE_KEY || '0x4AAAAAAADnPIDROrmt1Wwj';
const APOLLO_URL  = 'https://app.apollo.io';

// Main entry — tries Capsolver first, falls back to 2captcha
// Returns { token, cookies[] } — token for login body, cookies merged into seed cookies
async function solveTurnstile() {
  let solution = null;

  if (CAPSOLVER_API_KEY) {
    try {
      solution = await _solveWithCapsolver();
    } catch (err) {
      console.warn(`[Capsolver] Failed: ${err.message} — trying 2captcha...`);
    }
  }

  if (!solution && TWOCAPTCHA_API_KEY) {
    solution = await _solveWith2Captcha();
  }

  if (!solution) {
    throw new Error('No captcha solver available. Set CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY in .env');
  }

  return solution; // { token, cookies: [{name,value},...] }
}

// ── Capsolver ─────────────────────────────────────────────────────────────────
// Uses AntiCloudflareTask — handles both CF Challenge and Turnstile automatically
async function _solveWithCapsolver() {
  console.log('[Capsolver] Solving Cloudflare Challenge...');
  const createRes = await httpsJsonPost('api.capsolver.com', '/createTask', JSON.stringify({
    clientKey: CAPSOLVER_API_KEY,
    task: {
      type:       'AntiCloudflareTask',   // works for CF Challenge + Turnstile
      websiteURL: APOLLO_URL,
      websiteKey: SITE_KEY,
      metadata:   { type: 'challenge' },  // tells Capsolver it's a JS challenge
    },
  }));
  if (createRes.errorId !== 0) throw new Error(createRes.errorDescription);

  const { taskId } = createRes;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const poll = await httpsJsonPost('api.capsolver.com', '/getTaskResult',
      JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId }));
    if (poll.status === 'ready') {
      console.log('[Capsolver] ✓ CF challenge solved');
      // AntiCloudflareTask returns cookies including cf_clearance
      return poll.solution;
    }
    if (poll.status === 'failed' || poll.errorId !== 0) throw new Error(poll.errorDescription);
  }
  throw new Error('Capsolver timed out after 120s');
}

// ── 2captcha ──────────────────────────────────────────────────────────────────
// Uses turnstile method — 2captcha handles CF challenge the same way
async function _solveWith2Captcha() {
  console.log('[2captcha] Solving Cloudflare Challenge...');

  // 2captcha uses their v2 JSON API for CF challenges
  // POST to /in.php with method=turnstile — sitekey is optional for pure CF challenge
  const submitBody = JSON.stringify({
    clientKey: TWOCAPTCHA_API_KEY,
    task: {
      type:       'TurnstileTaskProxyless',
      websiteURL: APOLLO_URL,
      websiteKey: SITE_KEY,
    },
  });

  const submitRes = await httpsJsonPost('api.2captcha.com', '/createTask', submitBody);
  if (submitRes.errorId !== 0) throw new Error(`2captcha submit failed: ${submitRes.errorDescription || submitRes.errorCode}`);

  const taskId = submitRes.taskId;
  console.log(`[2captcha] Task ${taskId} — polling...`);

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const poll = await httpsJsonPost('api.2captcha.com', '/getTaskResult',
      JSON.stringify({ clientKey: TWOCAPTCHA_API_KEY, taskId }));

    if (poll.status === 'ready') {
      console.log('[2captcha] ✓ Token ready');
      return { token: poll.solution.token };
    }
    if (poll.errorId !== 0) throw new Error(`2captcha error: ${poll.errorDescription || poll.errorCode}`);
  }
  throw new Error('2captcha timed out after 120s');
}

function httpsJsonPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const req = require('https').request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpsRequestFull(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers:    res.headers,
        body:       data,
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
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
