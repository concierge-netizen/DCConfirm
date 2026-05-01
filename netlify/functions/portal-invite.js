/**
 * POST /portal/api/admin/invite
 * Send a HANDS Client Portal invite email to a registered client.
 *
 * Auth:   Admin only (Clerk JWT, role=admin in Registry).
 * Body:   { clientId: "GHOST" }
 * Returns: { ok: true, sentTo, displayName, emailId, auditPosted }
 *
 * Side effects:
 *   - Sends HTML email via Resend (from jon@handslogistics.com).
 *   - Posts a monday update to the Registry item (board 18411243307)
 *     with "Portal invite sent to <email> at <iso> by <admin>" as
 *     audit trail. Failure is non-fatal — invite still ships.
 */

const ds = require('./_portal-datastore-monday');
const { requireAuth, json, handleError, handleOptions } = require('./_portal-auth');

const RESEND_API = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'HANDS Logistics <jon@handslogistics.com>';
const PORTAL_URL = 'https://ops.handslogistics.com/portal';
const SUPPORT_EMAIL = 'jon@handslogistics.com';
const REGISTRY_BOARD_ID = 18411243307;
const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2023-10';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const ctx = await requireAuth(event, { adminOnly: true });

    const body = parseBody(event.body);
    const clientId = String(body.clientId || '').trim().toUpperCase();
    if (!clientId) return json(400, { error: 'clientId is required' });

    // Look up the registry row for this client to get email + display_name.
    const client = await ds.getClientById(clientId);
    if (!client) return json(404, { error: 'No registry row matches clientId ' + clientId });
    if (!client.email) return json(400, { error: 'Registry row for ' + clientId + ' has no email' });
    if (client.status !== 'Active') {
      return json(400, { error: 'Registry row for ' + clientId + ' is not Active (status: ' + client.status + ')' });
    }

    // Build email
    const html = buildInviteHtml({
      displayName: client.display_name || client.name || clientId,
      contactName: client.contact_name || '',
      registeredEmail: client.email,
    });
    const text = buildInviteText({
      displayName: client.display_name || client.name || clientId,
      contactName: client.contact_name || '',
      registeredEmail: client.email,
    });

    // Send via Resend
    const sendResult = await resendSend({
      from: FROM_ADDRESS,
      to: [client.email],
      reply_to: SUPPORT_EMAIL,
      subject: 'Your HANDS Logistics client portal is ready',
      html: html,
      text: text,
    });

    // Audit trail — best-effort. A failure here doesn't fail the request.
    let auditPosted = false;
    try {
      await postRegistryAudit({
        registryItemId: client.monday_item_id,
        adminEmail: ctx.email,
        recipientEmail: client.email,
        emailId: sendResult.id,
      });
      auditPosted = true;
    } catch (auditErr) {
      console.error('[portal-invite] audit-trail post failed (non-fatal):', auditErr.message);
    }

    return json(200, {
      ok: true,
      sentTo: client.email,
      displayName: client.display_name || client.name || clientId,
      emailId: sendResult.id,
      auditPosted: auditPosted,
    });
  } catch (err) {
    return handleError(err);
  }
};

function parseBody(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

// ─── Resend transport ────────────────────────────────────────────────
async function resendSend(payload) {
  const key = process.env.RESEND_KEY;
  if (!key) throw new Error('RESEND_KEY env var not set');

  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Resend HTTP ' + res.status + ': ' + (json.message || JSON.stringify(json)));
  }
  return json;
}

// ─── monday audit-trail update ───────────────────────────────────────
async function postRegistryAudit(args) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) throw new Error('MONDAY_TOKEN env var not set');
  if (!args.registryItemId) throw new Error('No monday_item_id on registry row');

  const body =
    'PORTAL INVITE SENT\n' +
    'To:    ' + args.recipientEmail + '\n' +
    'By:    ' + args.adminEmail + '\n' +
    'At:    ' + new Date().toISOString() + '\n' +
    'Email: ' + (args.emailId || '(no id)');

  const query = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
  `;

  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
      'API-Version': MONDAY_API_VERSION,
    },
    body: JSON.stringify({
      query: query,
      variables: { itemId: String(args.registryItemId), body: body },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('monday HTTP ' + res.status + ': ' + text.slice(0, 200));
  }
  const data = await res.json();
  if (data.errors) {
    throw new Error('monday GraphQL: ' + JSON.stringify(data.errors));
  }
  return data.data && data.data.create_update;
}

// ─── Email body templates ────────────────────────────────────────────
function buildInviteHtml(opts) {
  const greeting = opts.contactName ? ('Hi ' + opts.contactName) : 'Hello';
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Your HANDS Logistics client portal is ready</title>',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=DM+Sans:wght@400;500&family=DM+Mono:wght@400;500&display=swap">',
    '</head>',
    '<body style="margin:0;padding:0;background:#e8e2d4;font-family:\'DM Sans\',-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;-webkit-font-smoothing:antialiased;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e2d4;padding:40px 16px;">',
    '<tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#f4f0e8;border:1px solid rgba(26,26,26,0.12);border-radius:4px;overflow:hidden;">',

    // Header bar
    '<tr><td style="background:#1a1a1a;padding:24px 32px;border-bottom:2px solid #a0d6b4;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    '<tr><td style="vertical-align:middle;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
    '<td style="background:#a0d6b4;border-radius:4px;width:36px;height:36px;text-align:center;font-family:Georgia,serif;font-size:22px;font-weight:500;color:#1a1a1a;">H</td>',
    '<td style="padding-left:12px;color:#f4f0e8;font-family:\'Cormorant Garamond\',Georgia,serif;font-size:22px;font-weight:500;letter-spacing:0.5px;">HANDS Logistics<br>',
    '<span style="font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#a0d6b4;">Client Portal</span>',
    '</td></tr></table>',
    '</td></tr></table>',
    '</td></tr>',

    // Body
    '<tr><td style="padding:40px 40px 24px;">',
    '<div style="font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#6fa886;margin-bottom:8px;">You\'re invited</div>',
    '<h1 style="font-family:\'Cormorant Garamond\',Georgia,serif;font-size:36px;font-weight:500;line-height:1.1;margin:0 0 16px;color:#1a1a1a;">Your portal is ready, ' + escapeHtml(opts.displayName) + '.</h1>',
    '<p style="font-size:14px;line-height:1.6;color:#1a1a1a;margin:0 0 16px;">' + greeting + ',</p>',
    '<p style="font-size:14px;line-height:1.6;color:#1a1a1a;margin:0 0 16px;">We\'ve set up your dedicated client portal at HANDS Logistics. Sign in to view invoices, track payment status, and reach us with questions on any project — all in one place.</p>',

    // Email-specific instruction
    '<div style="background:#e8e2d4;border-left:3px solid #a0d6b4;padding:14px 18px;margin:24px 0;border-radius:2px;">',
    '<div style="font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#6a6a6a;margin-bottom:4px;">Sign in with</div>',
    '<div style="font-family:\'DM Mono\',monospace;font-size:14px;color:#1a1a1a;font-weight:500;">' + escapeHtml(opts.registeredEmail) + '</div>',
    '<div style="font-size:12px;color:#4a4a4a;margin-top:6px;line-height:1.5;">Use this exact email when you sign up. We\'ve already added it to our registry — using a different address will block access.</div>',
    '</div>',

    // CTA
    '<div style="text-align:center;margin:32px 0 24px;">',
    '<a href="' + PORTAL_URL + '" style="display:inline-block;background:#a0d6b4;color:#1a1a1a;text-decoration:none;padding:14px 36px;font-family:\'DM Mono\',monospace;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:500;border-radius:2px;border:1px solid #6fa886;">Open Client Portal</a>',
    '</div>',
    '<p style="font-family:\'DM Mono\',monospace;font-size:11px;letter-spacing:0.5px;color:#6a6a6a;text-align:center;margin:0 0 32px;word-break:break-all;">' + PORTAL_URL + '</p>',

    // What you can do
    '<h2 style="font-family:\'Cormorant Garamond\',Georgia,serif;font-size:22px;font-weight:500;color:#1a1a1a;margin:0 0 12px;">In the portal you can</h2>',
    '<ul style="font-size:14px;line-height:1.7;color:#1a1a1a;margin:0 0 24px;padding-left:20px;">',
    '<li>Review your full billing activity — invoices, amounts, dates, and status</li>',
    '<li>See current outstanding balance and payment history at a glance</li>',
    '<li>Pay online via PayPal, ACH/wire (US Bank), or check</li>',
    '<li>Post questions or comments on specific POs — they post directly to our ops team</li>',
    '</ul>',

    '<p style="font-size:14px;line-height:1.6;color:#1a1a1a;margin:0 0 16px;">Reply to this email with any questions, or reach out to <a href="mailto:' + SUPPORT_EMAIL + '" style="color:#6fa886;">' + SUPPORT_EMAIL + '</a> directly.</p>',

    '<p style="font-size:14px;line-height:1.6;color:#1a1a1a;margin:0 0 8px;">Thanks for working with us.</p>',
    '<p style="font-size:14px;line-height:1.6;color:#1a1a1a;margin:0;">— Jon Williams<br><span style="font-family:\'DM Mono\',monospace;font-size:11px;letter-spacing:0.5px;color:#6a6a6a;">CEO, HANDS Logistics</span></p>',
    '</td></tr>',

    // Footer
    '<tr><td style="background:#e8e2d4;padding:20px 40px;border-top:1px solid rgba(26,26,26,0.12);">',
    '<p style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#6a6a6a;text-align:center;margin:0 0 4px;">HANDS Logistics · Las Vegas · ops.handslogistics.com</p>',
    '<p style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;color:#6a6a6a;text-align:center;margin:0;font-style:italic;">Confidential — for the named recipient only.</p>',
    '</td></tr>',

    '</table></td></tr></table>',
    '</body></html>'
  ].join('');
}

function buildInviteText(opts) {
  const greeting = opts.contactName ? ('Hi ' + opts.contactName) : 'Hello';
  return [
    'Your HANDS Logistics client portal is ready, ' + opts.displayName + '.',
    '',
    greeting + ',',
    '',
    'We\'ve set up your dedicated client portal at HANDS Logistics. Sign in to',
    'view invoices, track payment status, and reach us with questions on any',
    'project — all in one place.',
    '',
    'SIGN IN WITH:  ' + opts.registeredEmail,
    'Use this exact email when you sign up. We\'ve already added it to our',
    'registry — using a different address will block access.',
    '',
    'Open the portal:',
    PORTAL_URL,
    '',
    'IN THE PORTAL YOU CAN:',
    '  - Review your full billing activity — invoices, amounts, dates, status',
    '  - See current outstanding balance and payment history at a glance',
    '  - Pay online via PayPal, ACH/wire (US Bank), or check',
    '  - Post questions or comments on specific POs',
    '',
    'Reply to this email with any questions, or reach out to ' + SUPPORT_EMAIL + ' directly.',
    '',
    'Thanks for working with us.',
    '',
    '— Jon Williams',
    '   CEO, HANDS Logistics',
    '',
    '---',
    'HANDS Logistics · Las Vegas · ops.handslogistics.com',
    'Confidential — for the named recipient only.',
  ].join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
