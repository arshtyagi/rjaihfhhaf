/**
 * auth.js — Multi-account Apollo login manager
 *
 * Features:
 *  - Multiple accounts with round-robin session usage
 *  - Auto re-login when session expires (401/403)
 *  - Capsolver integration for Cloudflare Turnstile / hCaptcha
 *  - CSRF token extraction from cookies
 *  - Persistent session storage per account
 */

const https = require('https');
const http = require('http');

// ─── Account pool config ──────────────────────────────────────────────────────
// Add 2-3 accounts here. Each will have its own independent session.
const ACCOUNTS = [
  {
    email: process.env.APOLLO_EMAIL_1 || process.env.APOLLO_EMAIL,
    password: process.env.APOLLO_PASSWORD_1 || process.env.APOLLO_PASSWORD,
  },
  // Uncomment and fill for additional accounts:
  // {
  //   email: process.env.APOLLO_EMAIL_2,
  //   password: process.env.APOLLO_PASSWORD_2,
  // },
  // {
  //   email: process.env.APOLLO_EMAIL_3,
  //   password: process.env.APOLLO_PASSWORD_3,
  // },
].filter(a => a.email && a.password);

const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY || 'CAP-D3066E7DCF80005676B3C5DD6C46CA7D4A28B0A9D857CD4E0A614155F83FC499';

// Apollo Cloudflare Turnstile site key (from login page)
const APOLLO_TURNSTILE_SITE_KEY = '0x4AAAAAAABkMYinukE8nzYS';
const APOLLO_LOGIN_URL = 'https://app.apollo.io';

// ─── In-memory session store ──────────────────────────────────────────────────
// sessions[email] = { cookies: [...], csrfToken: '', expiresAt: Date, loggedIn: bool }
const sessions = {};

// ─── Round-robin account index ────────────────────────────────────────────────
let accountIndex = 0;

// ─── Capsolver: solve Cloudflare Turnstile ────────────────────────────────────
async function solveTurnstile() {
  console.log('  [Capsolver] Solving Cloudflare Turnstile...');

  // Step 1: Create task
  const createTaskBody = JSON.stringify({
    clientKey: CAPSOLVER_API_KEY,
    task: {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: APOLLO_LOGIN_URL,
      websiteKey: APOLLO_TURNSTILE_SITE_KEY,
    },
  });

  const taskRes = await httpRequest({
    hostname: 'api.capsolver.com',
    path: '/createTask',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(createTaskBody),
    },
  }, createTaskBody);

  if (taskRes.errorId !== 0) {
    throw new Error(`Capsolver createTask failed: ${taskRes.errorDescription}`);
  }

  const taskId = taskRes.taskId;
  console.log(`  [Capsolver] Task created: ${taskId}`);

  // Step 2: Poll for result (up to 120s)
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(3000);

    const resultBody = JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId });
    const result = await httpRequest({
      hostname: 'api.capsolver.com',
      path: '/getTaskResult',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(resultBody),
      },
    }, resultBody);

    if (result.status === 'ready') {
      console.log('  [Capsolver] ✓ Turnstile solved');
      return result.solution.token;
    }

    if (result.status === 'failed' || result.errorId !== 0) {
      throw new Error(`Capsolver task failed: ${result.errorDescription}`);
    }

    console.log('  [Capsolver] Waiting for solution...');
  }

  throw new Error('Capsolver timeout: Turnstile not solved within 120s');
}

// ─── Get initial cookies from Apollo login page ───────────────────────────────
async function getInitialCookies() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'app.apollo.io',
      path: '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      const rawCookies = res.headers['set-cookie'] || [];
      const cookies = parseSetCookieHeaders(rawCookies);
      resolve(cookies);
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Login to Apollo ──────────────────────────────────────────────────────────
async function loginAccount(account) {
  console.log(`  [Auth] Logging in as ${account.email}...`);

  // 1. Get initial cookies (CSRF token seed, device ID etc.)
  let initialCookies = await getInitialCookies();

  // 2. Extract CSRF token from cookies
  let csrfToken = cookieValue(initialCookies, 'X-CSRF-TOKEN');

  // 3. Solve captcha if needed
  let captchaToken = null;
  try {
    captchaToken = await solveTurnstile();
  } catch (err) {
    console.warn(`  [Auth] Captcha solve failed (${err.message}), attempting login without it...`);
  }

  // 4. Build login payload
  const loginPayload = {
    email: account.email,
    password: account.password,
    timezone_offset: new Date().getTimezoneOffset(),
    cacheKey: Date.now(),
  };
  if (captchaToken) loginPayload.cf_turnstile_token = captchaToken;

  const body = JSON.stringify(loginPayload);

  const cookieStr = initialCookies.map(c => `${c.name}=${c.value}`).join('; ');

  // 5. POST /api/v1/auth/login
  const loginRes = await httpRequestFull({
    hostname: 'app.apollo.io',
    path: '/api/v1/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Accept': '*/*',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Origin': 'https://app.apollo.io',
      'Referer': 'https://app.apollo.io/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      'x-csrf-token': csrfToken || '',
      'x-referer-host': 'app.apollo.io',
      'x-referer-path': '/login',
      'x-accept-language': 'en',
      'Cookie': cookieStr,
    },
  }, body);

  if (loginRes.statusCode === 401 || loginRes.statusCode === 422) {
    let errMsg = 'Login failed';
    try { errMsg = JSON.parse(loginRes.body).message || errMsg; } catch (_) {}
    throw new Error(`${errMsg} (HTTP ${loginRes.statusCode})`);
  }

  if (loginRes.statusCode !== 200) {
    throw new Error(`Login returned HTTP ${loginRes.statusCode}: ${loginRes.body.slice(0, 200)}`);
  }

  // 6. Merge response cookies with initial cookies
  const responseCookies = parseSetCookieHeaders(loginRes.headers['set-cookie'] || []);
  const mergedCookies = mergeCookies(initialCookies, responseCookies);

  // 7. Extract fresh CSRF token from response cookies
  const freshCsrf = cookieValue(mergedCookies, 'X-CSRF-TOKEN') || csrfToken;

  // 8. Parse session expiry from remember_token cookie (default 7 days)
  const rememberToken = mergedCookies.find(c => c.name === 'remember_token_leadgenie_v2');
  let expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days default
  if (rememberToken?.expires) {
    expiresAt = new Date(rememberToken.expires).getTime();
  }
  // Treat session as expired 10 minutes early to avoid edge cases
  expiresAt -= 10 * 60 * 1000;

  sessions[account.email] = {
    cookies: mergedCookies,
    csrfToken: freshCsrf,
    expiresAt,
    loggedIn: true,
    account,
  };

  console.log(`  [Auth] ✓ Logged in as ${account.email} (session valid until ${new Date(expiresAt).toISOString()})`);
  return sessions[account.email];
}

// ─── Get a valid session (auto re-login if expired) ───────────────────────────
async function getValidSession(forceEmail = null) {
  if (ACCOUNTS.length === 0) {
    throw new Error('No accounts configured. Set APOLLO_EMAIL and APOLLO_PASSWORD in .env');
  }

  // If a specific email is requested, use that account
  if (forceEmail) {
    const account = ACCOUNTS.find(a => a.email === forceEmail);
    if (!account) throw new Error(`Account ${forceEmail} not found in ACCOUNTS`);
    const session = sessions[forceEmail];
    if (session && session.loggedIn && Date.now() < session.expiresAt) {
      return session;
    }
    return loginAccount(account);
  }

  // Round-robin: try each account starting from current index
  const start = accountIndex;
  for (let i = 0; i < ACCOUNTS.length; i++) {
    const idx = (start + i) % ACCOUNTS.length;
    const account = ACCOUNTS[idx];
    const session = sessions[account.email];

    if (session && session.loggedIn && Date.now() < session.expiresAt) {
      // Advance index for next call
      accountIndex = (idx + 1) % ACCOUNTS.length;
      return session;
    }
  }

  // No valid session found — log in with next account in rotation
  const account = ACCOUNTS[accountIndex];
  accountIndex = (accountIndex + 1) % ACCOUNTS.length;
  return loginAccount(account);
}

// ─── Invalidate session (called on 401/403 during API calls) ─────────────────
function invalidateSession(email) {
  if (sessions[email]) {
    console.log(`  [Auth] Session invalidated for ${email}, will re-login on next request`);
    sessions[email].loggedIn = false;
    sessions[email].expiresAt = 0;
  }
}

// ─── Pre-warm all accounts (login all upfront) ───────────────────────────────
async function warmAllSessions() {
  console.log(`  [Auth] Pre-warming ${ACCOUNTS.length} account session(s)...`);
  const results = await Promise.allSettled(ACCOUNTS.map(loginAccount));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`  [Auth] Failed to warm session for ${ACCOUNTS[i].email}: ${r.reason.message}`);
    }
  });
  const ok = results.filter(r => r.status === 'fulfilled').length;
  console.log(`  [Auth] ${ok}/${ACCOUNTS.length} sessions ready`);
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────
function parseSetCookieHeaders(setCookieHeaders) {
  return setCookieHeaders.map(raw => {
    const parts = raw.split(';').map(s => s.trim());
    const [nameVal, ...attrs] = parts;
    const eqIdx = nameVal.indexOf('=');
    const name = nameVal.slice(0, eqIdx).trim();
    const value = nameVal.slice(eqIdx + 1).trim();
    const cookie = { name, value };
    for (const attr of attrs) {
      const lower = attr.toLowerCase();
      if (lower.startsWith('expires=')) {
        cookie.expires = attr.slice('expires='.length);
      } else if (lower === 'httponly') {
        cookie.httpOnly = true;
      } else if (lower === 'secure') {
        cookie.secure = true;
      }
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

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const lib = options.hostname?.startsWith('http://') ? http : https;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpRequestFull(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data,
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  getValidSession,
  invalidateSession,
  warmAllSessions,
  loginAccount,
  ACCOUNTS,
};
