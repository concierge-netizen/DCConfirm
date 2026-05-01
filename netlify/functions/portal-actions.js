/**
 * POST /portal/api/actions — submit a client action (e.g., a question or
 * dispute) on a specific PO. Posts a monday update and triggers an email
 * notification to NOTIFICATION_EMAIL.
 *
 * Body:  { poId, message }
 * Auth:  any signed-in user. Non-admins are restricted to their own POs
 *        (enforced in datastore.postClientAction).
 */
const ds = require('./_portal-datastore-monday');
const { requireAuth, json, handleError, handleOptions } = require('./_portal-auth');

const MAX_MESSAGE_LEN = 4000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST only' });
  }
  try {
    const ctx = await requireAuth(event);

    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch (_e) { return json(400, { error: 'Invalid JSON body' }); }

    const poId = String(body.poId || '').trim();
    const message = String(body.message || '').trim();

    if (!poId) return json(400, { error: 'poId is required' });
    if (!message) return json(400, { error: 'message is required' });
    if (message.length > MAX_MESSAGE_LEN) {
      return json(400, { error: 'message exceeds ' + MAX_MESSAGE_LEN + ' chars' });
    }

    const result = await ds.postClientAction({
      poId:         poId,
      message:      message,
      submittedBy:  ctx.email,
      clientCode:   ctx.isAdmin ? null : (ctx.client && ctx.client.clientId),
      isAdmin:      ctx.isAdmin
    });

    // Best-effort email notification — non-blocking. If the mail provider
    // is unconfigured or the call fails, we still return success since the
    // monday update IS the source of truth.
    try {
      await sendNotificationEmail({
        to:      result.notifyEmail,
        subject: '[HANDS Portal] New client action on PO ' + poId,
        body:    'From:  ' + ctx.email + '\n' +
                 'PO:    ' + poId + '\n' +
                 'When:  ' + new Date().toISOString() + '\n' +
                 'Link:  ' + result.mondayUrl + '\n\n' +
                 'Message:\n' + message
      });
    } catch (e) {
      console.error('[portal-actions] notify email failed (non-fatal):', e.message);
    }

    return json(200, {
      shellMode: false,
      ok: true,
      updateId: result.updateId,
      mondayUrl: result.mondayUrl
    });
  } catch (err) {
    if (err.status) return json(err.status, { error: err.message });
    return handleError(err);
  }
};

/**
 * Best-effort notification email. Currently uses Netlify's existing
 * `/api/send-pod` infrastructure if SENDGRID_API_KEY is set — otherwise
 * it logs the message and returns. Replace with whichever provider you
 * standardize on (SendGrid, Resend, Mailgun, etc).
 */
async function sendNotificationEmail(args) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.log('[portal-actions] notification (no SENDGRID_API_KEY, would have sent):',
                JSON.stringify({ to: args.to, subject: args.subject }));
    return;
  }
  const fromAddr = process.env.PORTAL_NOTIFY_FROM || 'concierge@handslogistics.com';
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: args.to }] }],
      from: { email: fromAddr },
      subject: args.subject,
      content: [{ type: 'text/plain', value: args.body }]
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('SendGrid HTTP ' + res.status + ': ' + t.slice(0, 200));
  }
}
