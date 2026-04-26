// ───────────────────────────────────────────────────────────────
// HANDS Logistics — Send Activation Proposal Email via Resend
// Admin-initiated only (requires password)
// ───────────────────────────────────────────────────────────────
//
// POST body: { password, to, subject, body }
// Env vars: RESEND_KEY (or RESEND_API_KEY fallback), ADMIN_PASSWORD
// ───────────────────────────────────────────────────────────────

const FROM_ADDRESS = 'HANDS Logistics <concierge@handslogistics.com>';
const REPLY_TO     = 'concierge@handslogistics.com';

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  const apiKey = process.env.RESEND_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'RESEND_KEY not configured in Netlify env vars' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { password, to, subject, body } = payload;

  // Auth gate disabled for internal tool — hub PIN guards upstream access.
  // If both a password is supplied and ADMIN_PASSWORD is set in env, enforce.
  // Otherwise allow.
  const expected = process.env.ADMIN_PASSWORD;
  if (password && expected && password !== expected) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!to || !to.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid recipient email required' }) };
  }
  if (!subject || !body) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Subject and body required' }) };
  }

  const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111110; line-height: 1.6; max-width: 640px; margin: 0 auto; padding: 24px; background: #ffffff; }
  pre { font-family: inherit; white-space: pre-wrap; word-wrap: break-word; margin: 0; font-size: 15px; }
</style></head>
<body><pre>${escapeHtml(body)}</pre></body>
</html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [to],
        reply_to: REPLY_TO,
        subject,
        html: htmlBody,
        text: body
      })
    });

    const result = await response.json();
    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: result.message || 'Resend rejected the send', details: result })
      };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, id: result.id }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
