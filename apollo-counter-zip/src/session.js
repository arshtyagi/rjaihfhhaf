/**
 * session.js — manages the Apollo browser session
 *
 * KEY DESIGN: Uses launchPersistentContext() so the Chromium profile
 * (cookies, localStorage, device trust tokens) is saved to BROWSER_PROFILE_DIR.
 * Mount that directory as a Docker volume → OTP is only needed on the very first
 * run (or if the server IP changes). Subsequent restarts reuse the trusted profile.
 *
 * Flow:
 *  1. Open persistent Chromium profile from /data/browser-profile
 *  2. Navigate to Apollo login, fill credentials
 *  3. OTP screen? → fetch from Gmail IMAP → fill it (first run only)
 *  4. Extract cookies + CSRF token → cache in memory for SESSION_TTL_MINUTES
 *  5. On expiry/401 → re-login (no OTP, device already trusted)
 */

const { chromium } = require('playwright');
const { fetchOtpFromEmail } = require('./imap');

// ─── Config ───────────────────────────────────────────────────────────────────
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || '/data/browser-profile';
const SESSION_TTL_MS = (parseInt(process.env.SESSION_TTL_MINUTES) || 60) * 60 * 1000;

// ─── State ────────────────────────────────────────────────────────────────────
let persistentContext = null;
let sessionCookies    = null;
let csrfToken         = null;
let sessionExpiresAt  = null;
let loginInProgress   = false;
let loginWaiters      = [];

// ─── Persistent browser context ───────────────────────────────────────────────
// launchPersistentContext writes cookies/localStorage to PROFILE_DIR on disk.
// Apollo's "trusted device" flag lives in those cookies → no OTP on restart.
async function getContext() {
  if (persistentContext) return persistentContext;

  console.log(`[Browser] Opening persistent profile: ${PROFILE_DIR}`);

  persistentContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
    ],
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });

  persistentContext.on('close', () => {
    console.log('[Browser] Context closed — will reopen on next request');
    persistentContext = null;
    invalidateSession();
  });

  // Block media/fonts to speed up page loads
  await persistentContext.route(
    '**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm}',
    r => r.abort()
  );

  return persistentContext;
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) { await el.fill(value); return el; }
  }
  throw new Error(`Could not find input: ${selectors.join(', ')}`);
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) { await el.click(); return el; }
  }
  throw new Error(`Could not find button: ${selectors.join(', ')}`);
}

async function findFirst(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return el;
  }
  return null;
}

// ─── Main login flow ──────────────────────────────────────────────────────────
async function loginToApollo() {
  console.log('[Login] Starting Apollo login flow...');
  const context = await getContext();
  const page = await context.newPage();

  try {
    // 1. Load login page
    console.log('[Login] Navigating to login page...');
    await page.goto('https://app.apollo.io/#/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
    console.log('[Login] Login form ready');

    // 2. Fill credentials
    await fillFirst(page, [
      'input[type="email"]', 'input[name="email"]', 'input[placeholder*="email" i]',
    ], process.env.APOLLO_EMAIL);

    await fillFirst(page, [
      'input[type="password"]', 'input[name="password"]', 'input[placeholder*="password" i]',
    ], process.env.APOLLO_PASSWORD);

    // 3. Submit
    await clickFirst(page, [
      'button[type="submit"]', 'button:has-text("Log In")',
      'button:has-text("Sign In")', 'button:has-text("Continue")',
    ]);
    console.log('[Login] Credentials submitted');

    await page.waitForTimeout(4000);

    // 4. OTP check
    // With a persistent profile + consistent server IP, this only fires on first ever run.
    // Apollo writes a "trusted device" cookie to the profile after OTP → saved to disk.
    const otpInput = await findFirst(page, [
      'input[autocomplete="one-time-code"]',
      'input[placeholder*="code" i]',
      'input[placeholder*="otp" i]',
      'input[placeholder*="verification" i]',
      'input[placeholder*="6-digit" i]',
      'input[maxlength="6"][type="text"]',
      'input[maxlength="6"][type="number"]',
    ]);

    let otpAttempted = false;
    if (otpInput) {
      console.log('[Login] OTP screen detected (first run / IP changed) — fetching from Gmail...');
      const otp = await fetchOtpFromEmail(120000);
      await otpInput.fill(otp);
      await page.waitForTimeout(400);

      const otpSubmit = await findFirst(page, [
        'button[type="submit"]', 'button:has-text("Verify")',
        'button:has-text("Confirm")', 'button:has-text("Continue")',
      ]);
      if (otpSubmit) await otpSubmit.click();
      else await page.keyboard.press('Enter');

      otpAttempted = true;
      console.log('[Login] OTP submitted — device will be trusted from now on');
      await page.waitForTimeout(3000);
    } else {
      console.log('[Login] No OTP required (trusted device recognised ✓)');
    }

    // 5. Wait for dashboard
    try {
      await page.waitForURL(
        url => /app\.apollo\.io\/#\/(people|home|accounts|contacts|sequences)/.test(url),
        { timeout: 25000 }
      );
    } catch {
      const finalUrl = page.url();
      if (finalUrl.includes('login') || finalUrl.includes('otp') || finalUrl.includes('verify')) {
        throw new Error(
          `Login failed — stuck on: ${finalUrl}. ` +
          (otpAttempted ? 'OTP may be wrong or expired.' : 'Check APOLLO_EMAIL / APOLLO_PASSWORD.')
        );
      }
      console.log('[Login] URL check timed out but not on login page — continuing');
    }

    console.log('[Login] ✓ Logged in — URL:', page.url());

    // 6. Extract cookies + CSRF token
    const cookies = await context.cookies(['https://app.apollo.io']);

    let csrf = null;
    const csrfCookie = cookies.find(c =>
      c.name === 'X-CSRF-TOKEN' || c.name === 'csrf-token' || c.name === '_csrf_token'
    );
    if (csrfCookie) csrf = decodeURIComponent(csrfCookie.value);

    if (!csrf) {
      csrf = await page.evaluate(() =>
        document.querySelector('meta[name="csrf-token"]')?.content || null
      ).catch(() => null);
    }

    if (csrf) {
      console.log('[Login] CSRF token:', csrf.slice(0, 20) + '...');
    } else {
      console.warn('[Login] ⚠ CSRF token not found — API calls may return 422');
    }

    // 7. Cache session in memory
    sessionCookies = cookies;
    csrfToken = csrf;
    sessionExpiresAt = Date.now() + SESSION_TTL_MS;

    await page.close();
    // Do NOT close context — it's persistent and shared across requests

    console.log(`[Session] ✓ Cached for ${Math.round(SESSION_TTL_MS / 60000)} minutes`);

  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
async function ensureSession() {
  const isValid =
    sessionCookies && csrfToken &&
    sessionExpiresAt && Date.now() < sessionExpiresAt;

  if (isValid) {
    const minsLeft = Math.round((sessionExpiresAt - Date.now()) / 60000);
    console.log(`[Session] Reusing cached session (${minsLeft} min remaining)`);
    return;
  }

  if (loginInProgress) {
    console.log('[Session] Login in progress — queuing request...');
    await new Promise((resolve, reject) => loginWaiters.push({ resolve, reject }));
    return;
  }

  loginInProgress = true;
  try {
    await loginToApollo();
    loginWaiters.forEach(w => w.resolve());
  } catch (err) {
    loginWaiters.forEach(w => w.reject(err));
    throw err;
  } finally {
    loginWaiters = [];
    loginInProgress = false;
  }
}

function getSessionData() {
  return { cookies: sessionCookies, csrfToken };
}

function invalidateSession() {
  sessionCookies = null;
  csrfToken = null;
  sessionExpiresAt = null;
  console.log('[Session] Invalidated — will re-login on next request');
}

function getSessionStatus() {
  if (!sessionCookies) return { active: false, reason: 'No session' };
  if (!sessionExpiresAt || Date.now() > sessionExpiresAt) return { active: false, reason: 'Expired' };
  return {
    active: true,
    expiresInMinutes: Math.round((sessionExpiresAt - Date.now()) / 60000),
    apolloEmail: process.env.APOLLO_EMAIL,
    profileDir: PROFILE_DIR,
  };
}

module.exports = { ensureSession, getSessionData, invalidateSession, getSessionStatus };
