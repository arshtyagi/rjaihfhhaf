require('dotenv').config();
const express = require('express');
const { ensureSession, getSessionData, invalidateSession, getSessionStatus } = require('./session');
const { parseApolloUrl, callApolloApi } = require('./apollo');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;

// ─── Auth middleware ──────────────────────────────────────────────────────────
function checkSecret(req, res, next) {
  if (!API_SECRET) return next();
  const token = req.headers['x-api-secret'] || req.query.secret;
  if (token !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — send x-api-secret header' });
  }
  next();
}

// ─── Core count logic ─────────────────────────────────────────────────────────
async function getCount(apolloUrl, retried = false) {
  await ensureSession();
  const { cookies, csrfToken } = getSessionData();
  const payload = parseApolloUrl(apolloUrl);

  try {
    const response = await callApolloApi(payload, cookies, csrfToken);
    return response.pipeline_total ?? 0;
  } catch (err) {
    if (err.authError && !retried) {
      console.log('[Count] Auth error — invalidating session and retrying...');
      invalidateSession();
      return getCount(apolloUrl, true);
    }
    throw err;
  }
}

// ─── POST /count ──────────────────────────────────────────────────────────────
// Body: { "url": "https://app.apollo.io/#/people?..." }
// Returns: { "count": 2220 }
app.post('/count', checkSecret, async (req, res) => {
  const apolloUrl = req.body.url || req.body.apollo_url;
  if (!apolloUrl) return res.status(400).json({ error: 'Missing "url" field in request body' });

  console.log(`[POST /count] ${apolloUrl.slice(0, 80)}...`);
  try {
    const count = await getCount(apolloUrl);
    console.log(`[POST /count] → ${count}`);
    res.json({ count });
  } catch (err) {
    console.error('[POST /count] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /count?url=... ───────────────────────────────────────────────────────
app.get('/count', checkSecret, async (req, res) => {
  const apolloUrl = req.query.url;
  if (!apolloUrl) return res.status(400).json({ error: 'Missing "url" query param' });

  try {
    const count = await getCount(apolloUrl);
    res.json({ count });
  } catch (err) {
    console.error('[GET /count] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /session-status ──────────────────────────────────────────────────────
app.get('/session-status', checkSecret, (req, res) => {
  res.json(getSessionStatus());
});

// ─── POST /invalidate-session ─────────────────────────────────────────────────
app.post('/invalidate-session', checkSecret, (req, res) => {
  invalidateSession();
  res.json({ ok: true, message: 'Session cleared — next /count will re-login' });
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// ─── Web UI ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Apollo Counter</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #07090f;
    --surface: #0e1117;
    --border: #1c2333;
    --accent: #f97316;
    --accent-dim: #7c3c15;
    --green: #22c55e;
    --green-bg: #052010;
    --green-border: #14532d;
    --red: #f87171;
    --red-bg: #1a0505;
    --red-border: #7f1d1d;
    --text: #e2e8f0;
    --muted: #64748b;
    --subtle: #1e293b;
    --mono: 'Courier New', 'Consolas', monospace;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--mono);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  /* ── Header ── */
  header {
    width: 100%;
    background: var(--surface);
    border-bottom: 1px solid var(--accent);
    padding: 18px 40px;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .logo-badge {
    width: 38px; height: 38px;
    background: var(--accent);
    border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; font-weight: 900; color: var(--bg);
    flex-shrink: 0;
    letter-spacing: -1px;
  }
  .logo-name { font-size: 16px; font-weight: 700; letter-spacing: 3px; color: var(--accent); }
  .logo-sub  { font-size: 10px; color: var(--muted); letter-spacing: 1px; margin-top: 2px; }
  .session-pill {
    margin-left: auto;
    font-size: 11px;
    letter-spacing: 1px;
    padding: 5px 12px;
    border-radius: 20px;
    border: 1px solid var(--border);
    color: var(--muted);
    cursor: default;
    transition: all .3s;
  }
  .session-pill.active { border-color: var(--green-border); color: var(--green); }

  /* ── Layout ── */
  main {
    width: 100%;
    max-width: 740px;
    padding: 48px 20px 60px;
    display: flex;
    flex-direction: column;
    gap: 28px;
  }

  /* ── Cards ── */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 28px 32px;
  }

  /* ── Labels ── */
  label {
    display: block;
    font-size: 10px;
    letter-spacing: 2px;
    color: var(--accent);
    margin-bottom: 10px;
    text-transform: uppercase;
  }

  /* ── Inputs ── */
  textarea, input[type="text"], input[type="password"] {
    width: 100%;
    background: #080d16;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 13px 15px;
    color: var(--text);
    font-family: var(--mono);
    font-size: 12px;
    outline: none;
    resize: vertical;
    transition: border-color .2s;
    line-height: 1.6;
  }
  textarea:focus, input:focus { border-color: var(--accent); }
  textarea { min-height: 90px; }

  /* ── Button ── */
  .btn {
    width: 100%;
    padding: 15px 20px;
    background: var(--accent);
    border: none;
    border-radius: 7px;
    color: var(--bg);
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 3px;
    cursor: pointer;
    transition: opacity .2s, transform .1s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  .btn:hover:not(:disabled) { opacity: .88; }
  .btn:active:not(:disabled) { transform: scale(.99); }
  .btn:disabled { opacity: .35; cursor: not-allowed; }

  /* ── Result ── */
  .result-box {
    display: none;
    background: var(--green-bg);
    border: 1px solid var(--green-border);
    border-radius: 10px;
    padding: 32px;
    text-align: center;
    animation: fadeIn .4s ease;
  }
  .result-box.show { display: block; }
  .count-num {
    font-size: 80px;
    font-weight: 900;
    color: var(--green);
    letter-spacing: -4px;
    line-height: 1;
  }
  .count-label { font-size: 13px; color: var(--muted); margin-top: 10px; }

  /* ── Error ── */
  .error-box {
    display: none;
    background: var(--red-bg);
    border: 1px solid var(--red-border);
    border-radius: 8px;
    padding: 16px 20px;
    font-size: 12px;
    color: var(--red);
    line-height: 1.7;
    animation: fadeIn .3s ease;
  }
  .error-box.show { display: block; }

  /* ── Info ── */
  .info {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.8;
    border-left: 2px solid var(--accent-dim);
    padding-left: 14px;
  }
  .info code {
    background: var(--subtle);
    padding: 1px 6px;
    border-radius: 3px;
    color: #38bdf8;
    font-size: 11px;
  }

  /* ── Spinner ── */
  .spin { display: inline-block; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  /* ── API docs ── */
  details { color: var(--muted); font-size: 12px; line-height: 1.8; }
  summary { cursor: pointer; color: var(--muted); font-size: 11px; letter-spacing: 1px; padding: 6px 0; }
  summary:hover { color: var(--text); }
  pre {
    background: #060a12;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    font-size: 11px;
    color: #38bdf8;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    margin-top: 12px;
    line-height: 1.6;
  }
</style>
</head>
<body>

<header>
  <div class="logo-badge">A</div>
  <div>
    <div class="logo-name">APOLLO COUNTER</div>
    <div class="logo-sub">SEARCH URL → pipeline_total</div>
  </div>
  <div class="session-pill" id="sessionPill">● CHECKING SESSION...</div>
</header>

<main>

  <!-- URL Input -->
  <div class="card">
    <label>Apollo Search URL</label>
    <textarea id="urlInput"
      placeholder="https://app.apollo.io/#/people?page=1&personTitles[]=owner&personTitles[]=ceo&qOrganizationSearchListId=..."></textarea>

    ${API_SECRET ? `
    <label style="margin-top:18px">API Secret</label>
    <input type="password" id="secretInput" placeholder="x-api-secret value" />
    ` : ''}

    <button class="btn" id="fetchBtn" onclick="fetchCount()" style="margin-top:20px">
      → GET COUNT
    </button>
  </div>

  <!-- Result -->
  <div class="result-box" id="resultBox">
    <div class="count-num" id="countNum">—</div>
    <div class="count-label">matching contacts in Apollo</div>
  </div>

  <!-- Error -->
  <div class="error-box" id="errorBox"></div>

  <!-- Info -->
  <div class="card">
    <div class="info">
      <strong style="color:#94a3b8">How it works:</strong><br>
      The server logs into Apollo using your configured credentials, caches the session,
      then fires the internal Apollo API call with your URL's filters applied.<br><br>
      If Apollo asks for a verification code, it's fetched automatically from your inbox via IMAP.<br><br>
      Session is cached for <strong style="color:#94a3b8">${process.env.SESSION_TTL_MINUTES || 60} minutes</strong> —
      subsequent requests don't re-login.<br><br>
      <strong style="color:#94a3b8">API usage:</strong><br>
      <code>POST /count</code> · body: <code>{"url": "..."}</code> · returns: <code>{"count": 2220}</code><br>
      Header: <code>x-api-secret: your-secret</code>
    </div>
  </div>

  <!-- API docs -->
  <details>
    <summary>▸ API REFERENCE</summary>
    <pre>
# Count endpoint
POST /count
Content-Type: application/json
x-api-secret: your-secret

{ "url": "https://app.apollo.io/#/people?page=1&personTitles[]=ceo..." }

→ { "count": 2220 }

# Session status
GET /session-status
→ { "active": true, "expiresInMinutes": 47, "apolloEmail": "you@example.com" }

# Force re-login
POST /invalidate-session

# Health check
GET /health
→ { "ok": true, "uptime": 3600 }
    </pre>
  </details>

</main>

<script>
  // ── Session pill ──────────────────────────────────────────────────────────
  async function checkSession() {
    try {
      const res = await fetch('/session-status'${API_SECRET ? `, {headers:{"x-api-secret":document.getElementById("secretInput")?.value||""}}` : ''});
      const data = await res.json();
      const pill = document.getElementById('sessionPill');
      if (data.active) {
        pill.textContent = '● SESSION ACTIVE · ' + data.expiresInMinutes + 'min';
        pill.classList.add('active');
      } else {
        pill.textContent = '○ NO SESSION · WILL LOGIN ON NEXT REQUEST';
        pill.classList.remove('active');
      }
    } catch {}
  }
  checkSession();
  setInterval(checkSession, 30000);

  // ── Fetch count ───────────────────────────────────────────────────────────
  async function fetchCount() {
    const url = document.getElementById('urlInput').value.trim();
    if (!url) { alert('Please paste an Apollo search URL'); return; }

    const btn = document.getElementById('fetchBtn');
    const resultBox = document.getElementById('resultBox');
    const errorBox = document.getElementById('errorBox');
    const countNum = document.getElementById('countNum');

    btn.disabled = true;
    btn.innerHTML = '<span class="spin">⟳</span> LOGGING IN & FETCHING...';
    resultBox.classList.remove('show');
    errorBox.classList.remove('show');

    try {
      const headers = { 'Content-Type': 'application/json' };
      ${API_SECRET ? 'const secret = document.getElementById("secretInput")?.value?.trim(); if (secret) headers["x-api-secret"] = secret;' : ''}

      const res = await fetch('/count', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unknown server error');

      countNum.textContent = data.count.toLocaleString();
      resultBox.classList.add('show');
      checkSession();
    } catch (err) {
      errorBox.innerHTML = '<strong>Error:</strong> ' + err.message;
      errorBox.classList.add('show');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '→ GET COUNT';
    }
  }

  // Allow Enter key in URL textarea (Ctrl+Enter)
  document.getElementById('urlInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) fetchCount();
  });
</script>

</body>
</html>`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  Apollo Counter ready`);
  console.log(`    UI  → http://localhost:${PORT}`);
  console.log(`    API → POST http://localhost:${PORT}/count`);
  if (API_SECRET) console.log(`    Auth: x-api-secret header required`);
  console.log(`    Apollo account: ${process.env.APOLLO_EMAIL || '(not set)'}`);
  console.log(`    IMAP provider:  ${process.env.IMAP_PROVIDER || 'gmail'}`);
  console.log('');
});
