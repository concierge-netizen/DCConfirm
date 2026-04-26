// HANDS Logistics — GET /api/gmail-auth-callback
// Phase B: Receives the OAuth code from Google, swaps it for a refresh token,
// validates the email matches the slug from `state`, and renders a one-time
// success page that shows the refresh token in a copy-button code block.
//
// Required env vars:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//
// Flow:
//   1. Google sends ?code=...&state=<slug>  (state was set by gmail-auth.js)
//   2. POST to https://oauth2.googleapis.com/token  → access_token + refresh_token + id_token
//   3. Decode id_token (a JWT) to get the email of the account that signed in
//   4. Compare against expected email for this slug — show warning if mismatch
//   5. Render success page with refresh token + the env var name to paste it into

exports.config = { maxDuration: 10 };

const ACCOUNTS = {
  jon:       { email: 'jon@handslogistics.com',       label: 'Jon',       envVar: 'GMAIL_TOKEN_JON' },
  concierge: { email: 'concierge@handslogistics.com', label: 'Concierge', envVar: 'GMAIL_TOKEN_CONCIERGE' },
  inbound:   { email: 'inbound@handslogistics.com',   label: 'Inbound',   envVar: 'GMAIL_TOKEN_INBOUND' }
};

const REDIRECT_URI = 'https://ops.handslogistics.com/api/gmail-auth-callback';
const HEADERS_HTML = { 'Content-Type': 'text/html; charset=utf-8' };

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS_HTML, body: errorPage('Method not allowed', 'This endpoint only accepts GET requests.') };
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      statusCode: 500,
      headers: HEADERS_HTML,
      body: errorPage(
        'Server misconfigured',
        'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET env var is missing. Set both in Netlify (Site config → Environment variables) for all 4 deploy contexts, then retry.'
      )
    };
  }

  const params = event.queryStringParameters || {};
  const code = params.code;
  const state = (params.state || '').toLowerCase().trim();
  const oauthError = params.error;

  // User clicked "Cancel" or denied consent on Google's screen
  if (oauthError) {
    return {
      statusCode: 200,
      headers: HEADERS_HTML,
      body: errorPage(
        'Authorization cancelled',
        `Google returned: ${escapeHtml(oauthError)}. ${params.error_description ? escapeHtml(params.error_description) : ''} Click below to try again.`
      )
    };
  }

  if (!code) {
    return {
      statusCode: 400,
      headers: HEADERS_HTML,
      body: errorPage('Missing code', 'Google did not return an authorization code. Try starting the flow again from /api/gmail-auth.')
    };
  }

  if (!ACCOUNTS[state]) {
    return {
      statusCode: 400,
      headers: HEADERS_HTML,
      body: errorPage(
        'Invalid state',
        `Expected one of: jon, concierge, inbound. Got: "${escapeHtml(state)}". This means the OAuth round-trip lost the account context — restart from /api/gmail-auth.`
      )
    };
  }

  const expected = ACCOUNTS[state];

  // Exchange the auth code for tokens
  let tokenResp;
  try {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    tokenResp = await r.json();

    if (!r.ok) {
      return {
        statusCode: 502,
        headers: HEADERS_HTML,
        body: errorPage(
          'Token exchange failed',
          `Google returned HTTP ${r.status}: ${escapeHtml(tokenResp.error || 'unknown')} &mdash; ${escapeHtml(tokenResp.error_description || 'no detail')}`
        )
      };
    }
  } catch (err) {
    return {
      statusCode: 502,
      headers: HEADERS_HTML,
      body: errorPage('Network error', `Could not reach Google&rsquo;s token endpoint: ${escapeHtml(err.message)}`)
    };
  }

  const refreshToken = tokenResp.refresh_token;
  const idToken = tokenResp.id_token;

  if (!refreshToken) {
    // This happens if the user previously authorized this app and Google
    // skipped re-issuing the refresh token. The fix is to revoke at
    // https://myaccount.google.com/permissions and try again.
    return {
      statusCode: 200,
      headers: HEADERS_HTML,
      body: errorPage(
        'No refresh token returned',
        'Google did not issue a refresh_token. This usually means you previously authorized this app on this account. Visit https://myaccount.google.com/permissions, revoke "HANDS Logistics" (or whatever your OAuth app is named), then restart the flow from /api/gmail-auth.'
      )
    };
  }

  // Decode the id_token (JWT) to get the actual email signed-in user
  let actualEmail = null;
  if (idToken) {
    try {
      const parts = idToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        actualEmail = (payload.email || '').toLowerCase();
      }
    } catch (_) { /* ignore — actualEmail stays null */ }
  }

  const expectedEmail = expected.email.toLowerCase();
  const mismatch = actualEmail && actualEmail !== expectedEmail;

  return {
    statusCode: 200,
    headers: HEADERS_HTML,
    body: successPage({
      slug: state,
      label: expected.label,
      envVar: expected.envVar,
      expectedEmail,
      actualEmail,
      mismatch,
      refreshToken
    })
  };
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function successPage(d) {
  const warningBlock = d.mismatch ? `
    <div class="warn">
      <div class="warn-label">&#9888; ACCOUNT MISMATCH</div>
      <div class="warn-body">
        You picked <strong>${escapeHtml(d.label)}</strong> on the picker page (expected
        <code>${escapeHtml(d.expectedEmail)}</code>) but signed in as
        <code>${escapeHtml(d.actualEmail)}</code>.<br><br>
        <strong>Do not paste this token into ${escapeHtml(d.envVar)}.</strong>
        Either restart the flow and pick the right account, or paste it into the env var
        that matches <code>${escapeHtml(d.actualEmail)}</code>.
      </div>
    </div>
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HANDS &mdash; OAuth Success</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', system-ui, sans-serif;
      background: #0a0a0a; color: #e8e8e8;
      min-height: 100vh; padding: 32px 20px;
      display: flex; align-items: flex-start; justify-content: center;
    }
    .wrap { max-width: 720px; width: 100%; }
    .eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; letter-spacing: 0.2em;
      color: ${d.mismatch ? '#ffb84d' : '#a0d6b4'};
      text-transform: uppercase; margin-bottom: 8px;
    }
    h1 {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 56px; letter-spacing: 0.04em;
      margin: 0 0 8px; color: #ffffff; font-weight: 400;
    }
    .sub { color: #888; font-size: 14px; margin: 0 0 24px; line-height: 1.5; }
    .meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 8px 16px;
      background: #161616;
      border: 1px solid #2a2a2a;
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 24px;
      font-size: 13px;
    }
    .meta dt { color: #777; font-family: 'JetBrains Mono', monospace; font-size: 11px;
               letter-spacing: 0.05em; text-transform: uppercase; }
    .meta dd { margin: 0; color: #e0e0e0; }
    .meta dd code { font-family: 'JetBrains Mono', monospace; color: #a0d6b4; }

    .token-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px; letter-spacing: 0.05em;
      color: #777; text-transform: uppercase;
      margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;
    }
    .token-box {
      background: #0f0f0f; border: 1px solid #2a2a2a; border-radius: 8px;
      padding: 16px; font-family: 'JetBrains Mono', monospace; font-size: 12px;
      color: #e0e0e0; word-break: break-all; line-height: 1.6;
      user-select: all; cursor: pointer;
      transition: border-color .15s ease;
    }
    .token-box:hover { border-color: #a0d6b4; }
    .copy-btn {
      background: #a0d6b4; color: #0a0a0a; border: none;
      padding: 6px 14px; font-family: 'JetBrains Mono', monospace;
      font-size: 11px; font-weight: 500; letter-spacing: 0.05em;
      border-radius: 4px; cursor: pointer; text-transform: uppercase;
      transition: background .15s ease;
    }
    .copy-btn:hover { background: #7fc49e; }
    .copy-btn.copied { background: #fff; color: #0a0a0a; }

    .steps {
      margin-top: 32px; padding: 20px 24px;
      background: #161616; border: 1px solid #2a2a2a;
      border-radius: 10px; line-height: 1.7;
    }
    .steps h2 {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 22px; letter-spacing: 0.04em;
      margin: 0 0 12px; color: #ffffff; font-weight: 400;
    }
    .steps ol { margin: 0; padding-left: 20px; color: #ccc; font-size: 14px; }
    .steps li { margin-bottom: 8px; }
    .steps code {
      font-family: 'JetBrains Mono', monospace;
      background: #0f0f0f; padding: 2px 6px; border-radius: 4px;
      color: #a0d6b4; font-size: 12px;
    }
    .next {
      margin-top: 24px; padding-top: 20px; border-top: 1px solid #2a2a2a;
      font-size: 13px; color: #888;
    }
    .next a { color: #a0d6b4; text-decoration: none; }
    .next a:hover { text-decoration: underline; }

    .warn {
      background: rgba(255, 184, 77, 0.1); border: 1px solid #ffb84d;
      border-radius: 10px; padding: 16px 20px; margin-bottom: 24px;
    }
    .warn-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px; letter-spacing: 0.1em;
      color: #ffb84d; font-weight: 500;
      margin-bottom: 8px; text-transform: uppercase;
    }
    .warn-body { color: #e8e8e8; font-size: 13px; line-height: 1.6; }
    .warn-body code {
      font-family: 'JetBrains Mono', monospace;
      background: #0f0f0f; padding: 1px 5px; border-radius: 3px;
      color: #ffb84d; font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="eyebrow">${d.mismatch ? 'ATTENTION REQUIRED' : 'HANDS LOGISTICS &middot; OAUTH SUCCESS'}</div>
    <h1>${d.mismatch ? 'CHECK BEFORE PASTING' : 'TOKEN ISSUED'}</h1>
    <p class="sub">
      ${d.mismatch
        ? 'Google issued a refresh token, but the signed-in account does not match what you picked. Read the warning below before pasting.'
        : 'Google issued a refresh token for this account. Copy it and paste it into the matching Netlify env var.'}
    </p>

    ${warningBlock}

    <dl class="meta">
      <dt>Account</dt>      <dd>${escapeHtml(d.label)} (<code>${escapeHtml(d.actualEmail || d.expectedEmail)}</code>)</dd>
      <dt>Env var</dt>      <dd><code>${escapeHtml(d.envVar)}</code></dd>
      <dt>Slug</dt>         <dd><code>${escapeHtml(d.slug)}</code></dd>
    </dl>

    <div class="token-label">
      <span>REFRESH TOKEN</span>
      <button class="copy-btn" id="copyBtn" onclick="copyToken()">Copy</button>
    </div>
    <div class="token-box" id="tokenBox" onclick="copyToken()">${escapeHtml(d.refreshToken)}</div>

    <div class="steps">
      <h2>NEXT STEPS</h2>
      <ol>
        <li>Click <strong>Copy</strong> above (or click the token box).</li>
        <li>Open Netlify &rarr; <strong>DCConfirm</strong> &rarr; Site config &rarr; Environment variables.</li>
        <li>Click <strong>Add a variable</strong>.</li>
        <li>Key: <code>${escapeHtml(d.envVar)}</code></li>
        <li>Value: paste the token. Set scope to <strong>All deploy contexts</strong>.</li>
        <li>Save. Trigger a fresh deploy (or wait for the next one) so the function reads the new env var.</li>
      </ol>
    </div>

    <p class="next">
      Need to authorize another account? <a href="/api/gmail-auth">&larr; Back to picker</a>
    </p>
  </div>

  <script>
    function copyToken() {
      const txt = document.getElementById('tokenBox').textContent;
      const btn = document.getElementById('copyBtn');
      navigator.clipboard.writeText(txt).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 1800);
      }).catch(err => {
        alert('Copy failed — select the token manually and copy: ' + err.message);
      });
    }
  </script>
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
    .box { max-width: 560px; width: 100%; background: #161616; border: 1px solid #2a2a2a;
           border-radius: 10px; padding: 32px; }
    .eyebrow { font-family: monospace; font-size: 11px; letter-spacing: 0.2em; color: #ff6b6b;
               text-transform: uppercase; margin-bottom: 8px; }
    h1 { font-family: 'Bebas Neue', sans-serif; font-size: 40px; letter-spacing: 0.04em;
         margin: 0 0 16px; color: #ffffff; font-weight: 400; }
    p { color: #ccc; line-height: 1.5; margin: 0 0 16px; }
    a { color: #a0d6b4; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: monospace; background: #0f0f0f; padding: 2px 6px; border-radius: 4px;
           color: #a0d6b4; font-size: 12px; }
  </style>
</head>
<body>
  <div class="box">
    <div class="eyebrow">ERROR</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${detail}</p>
    <p><a href="/api/gmail-auth">&larr; Back to picker</a></p>
  </div>
</body>
</html>`;
}
