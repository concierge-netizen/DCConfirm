// HANDS Logistics — GET /api/gmail-auth
// Phase B: one-time OAuth bootstrap to capture refresh tokens for 3 Gmail accounts.
//
// Two modes:
//   GET /api/gmail-auth                  → renders an account picker page (3 buttons)
//   GET /api/gmail-auth?account=<slug>   → 302 redirect to Google's consent screen
//
// Slug values: jon | concierge | inbound  (anything else → 400)
//
// State param carries the slug through the round-trip so the callback knows
// which env var slot the resulting refresh token belongs in.
//
// Required env vars:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET   (used by the callback, not here)
//
// This function is invoked manually 3 times (once per account) during initial
// setup and never again. After all 3 GMAIL_TOKEN_* env vars are populated it
// can be removed — but it's safer to leave it deployed in case a token is
// revoked and needs re-issuing.

exports.config = { maxDuration: 10 };

const ACCOUNTS = {
  jon:       { email: 'jon@handslogistics.com',       label: 'Jon',       envVar: 'GMAIL_TOKEN_JON' },
  concierge: { email: 'concierge@handslogistics.com', label: 'Concierge', envVar: 'GMAIL_TOKEN_CONCIERGE' },
  inbound:   { email: 'inbound@handslogistics.com',   label: 'Inbound',   envVar: 'GMAIL_TOKEN_INBOUND' }
};

// gmail.modify covers read, send, drafts, label-modify on threads/messages.
// gmail.labels covers label CRUD (create_label, list_labels). modify covers
// most label use but .labels is the canonical scope for create/delete.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels'
].join(' ');

const REDIRECT_URI = 'https://ops.handslogistics.com/api/gmail-auth-callback';

const HEADERS_HTML = { 'Content-Type': 'text/html; charset=utf-8' };
const HEADERS_JSON = { 'Content-Type': 'application/json' };

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS_JSON, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return {
      statusCode: 500,
      headers: HEADERS_HTML,
      body: errorPage('Server misconfigured', 'GOOGLE_CLIENT_ID env var is not set in Netlify.')
    };
  }

  const params = event.queryStringParameters || {};
  const slug = (params.account || '').toLowerCase().trim();

  // Mode 1: no account param → render picker page
  if (!slug) {
    return { statusCode: 200, headers: HEADERS_HTML, body: pickerPage() };
  }

  // Mode 2: account param → validate + redirect to Google
  if (!ACCOUNTS[slug]) {
    return {
      statusCode: 400,
      headers: HEADERS_HTML,
      body: errorPage(
        'Invalid account',
        `"${escapeHtml(slug)}" is not a recognized account. Valid: jon, concierge, inbound.`
      )
    };
  }

  const account = ACCOUNTS[slug];

  // Build Google OAuth URL.
  // access_type=offline + prompt=consent ensures we always get a refresh_token,
  // even if the user has already granted consent before. login_hint pre-fills
  // the email field to make picking the right account easier.
  const oauthParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    login_hint: account.email,
    state: slug,
    include_granted_scopes: 'true'
  });

  const oauthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + oauthParams.toString();

  return {
    statusCode: 302,
    headers: { Location: oauthUrl },
    body: ''
  };
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function pickerPage() {
  const cards = Object.entries(ACCOUNTS).map(([slug, a]) => `
    <a class="card" href="/api/gmail-auth?account=${slug}">
      <div class="card-label">${escapeHtml(a.label)}</div>
      <div class="card-email">${escapeHtml(a.email)}</div>
      <div class="card-env">&rarr; ${escapeHtml(a.envVar)}</div>
    </a>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HANDS &mdash; Gmail OAuth Bootstrap</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', system-ui, sans-serif;
      background: #0a0a0a;
      color: #e8e8e8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 20px;
    }
    .wrap { max-width: 640px; width: 100%; }
    .eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.2em;
      color: #a0d6b4;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    h1 {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 56px;
      letter-spacing: 0.04em;
      margin: 0 0 8px;
      color: #ffffff;
      font-weight: 400;
    }
    .sub {
      color: #888;
      font-size: 14px;
      margin: 0 0 32px;
      line-height: 1.5;
    }
    .grid { display: grid; gap: 12px; }
    .card {
      display: block;
      background: #161616;
      border: 1px solid #2a2a2a;
      border-radius: 10px;
      padding: 20px 24px;
      text-decoration: none;
      color: inherit;
      transition: border-color .15s ease, background .15s ease, transform .15s ease;
    }
    .card:hover {
      border-color: #a0d6b4;
      background: #1c1c1c;
      transform: translateY(-1px);
    }
    .card-label {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 24px;
      letter-spacing: 0.03em;
      color: #ffffff;
      margin-bottom: 4px;
    }
    .card-email { font-size: 14px; color: #e0e0e0; margin-bottom: 6px; }
    .card-env {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #a0d6b4;
      letter-spacing: 0.05em;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #2a2a2a;
      font-size: 12px;
      color: #555;
      line-height: 1.6;
    }
    .footer code {
      font-family: 'JetBrains Mono', monospace;
      background: #161616;
      padding: 2px 6px;
      border-radius: 4px;
      color: #a0d6b4;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="eyebrow">HANDS LOGISTICS &middot; OAUTH BOOTSTRAP</div>
    <h1>GMAIL ACCESS SETUP</h1>
    <p class="sub">
      One-time setup. Click an account, sign in with Google, copy the refresh token from the success page,
      and paste it into the matching Netlify env var. Repeat for each account.
    </p>

    <div class="grid">
      ${cards}
    </div>

    <div class="footer">
      Each link redirects you to Google&rsquo;s consent screen. Sign in with the
      matching account &mdash; the page will warn you if you pick the wrong one.
      Tokens land in env vars: <code>GMAIL_TOKEN_JON</code>, <code>GMAIL_TOKEN_CONCIERGE</code>,
      <code>GMAIL_TOKEN_INBOUND</code>.
    </div>
  </div>
</body>
</html>`;
}

function errorPage(title, detail) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HANDS &mdash; ${escapeHtml(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'DM Sans', system-ui, sans-serif; background: #0a0a0a; color: #e8e8e8;
           margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
           padding: 32px 20px; }
    .box { max-width: 520px; width: 100%; background: #161616; border: 1px solid #2a2a2a;
           border-radius: 10px; padding: 32px; }
    .eyebrow { font-family: monospace; font-size: 11px; letter-spacing: 0.2em; color: #ff6b6b;
               text-transform: uppercase; margin-bottom: 8px; }
    h1 { font-family: 'Bebas Neue', sans-serif; font-size: 40px; letter-spacing: 0.04em;
         margin: 0 0 16px; color: #ffffff; font-weight: 400; }
    p { color: #ccc; line-height: 1.5; margin: 0 0 16px; }
    a { color: #a0d6b4; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="box">
    <div class="eyebrow">ERROR</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
    <p><a href="/api/gmail-auth">&larr; Back to picker</a></p>
  </div>
</body>
</html>`;
}
