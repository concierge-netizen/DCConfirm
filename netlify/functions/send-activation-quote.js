// ── send-activation-quote.js ────────────────────────────────────
// Sends activation proposal/recap emails via Resend.
// Used for both proposal delivery and recap delivery —
// the body & subject are passed in by the admin UI.
// ─────────────────────────────────────────────────────────────────

const RESEND_KEY = process.env.RESEND_KEY;
const FROM_EMAIL = 'HANDS Logistics <concierge@handslogistics.com>';
const REPLY_TO   = 'concierge@handslogistics.com';
const BCC        = 'jon@handslogistics.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method not allowed' };

  if (!RESEND_KEY) {
    return jsonResponse(500, { error: 'RESEND_KEY env var not configured' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }

  const { to, subject, body: messageBody } = body;
  if (!to || !subject || !messageBody) {
    return jsonResponse(400, { error: 'to, subject, body required' });
  }

  // Convert plain text to HTML — preserve line breaks, autolink URLs.
  const htmlBody = textToHtml(messageBody);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        bcc: [BCC],
        reply_to: REPLY_TO,
        subject,
        text: messageBody,
        html: htmlBody
      })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    return jsonResponse(200, { success: true, id: data.id });
  } catch (err) {
    console.error('send-activation-quote error:', err);
    return jsonResponse(500, { error: err.message });
  }
};

function textToHtml(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Autolink http/https URLs
  const linked = escaped.replace(/(https?:\/\/[^\s<>]+)/g, (url) =>
    `<a href="${url}" style="color: #6dba96; text-decoration: underline;">${url}</a>`
  );
  // Wrap in a clean container
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>HANDS Logistics</title></head>
<body style="margin:0;padding:0;background:#f8f7f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111110;">
  <div style="max-width:560px;margin:32px auto;padding:32px;background:#ffffff;border-left:2px solid #6dba96;">
    <div style="font-size:15px;line-height:1.7;white-space:pre-wrap;">${linked}</div>
  </div>
  <div style="max-width:560px;margin:0 auto 32px;padding:0 32px;text-align:center;font-size:11px;color:#7a7a76;letter-spacing:0.1em;text-transform:uppercase;font-family:Menlo,Monaco,monospace;">
    HANDS Logistics · 8540 Dean Martin Dr, Suite 160 · Las Vegas, NV
  </div>
</body></html>`;
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  };
}
