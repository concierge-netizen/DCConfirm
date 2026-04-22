// ============================================================
// HANDS Logistics — POST /api/monday-webhook
// Receives Monday.com webhook events when SEND DC column flips to "Yes"
// Handles Monday's challenge handshake automatically.
// ============================================================

const { fetchItem, extractFields, buildEmail, markSent } = require('./_email-builder');

const RESEND_API_KEY = 're_Xi5en35b_9XFtdPxMhPrZ2bLfSE2jtRwD';
const FROM_ADDRESS   = 'HANDS Logistics <concierge@handslogistics.com>';
const DEFAULT_BCC    = ['concierge@handslogistics.com'];
const TRIGGER_COLUMN = 'color_mm1qe2ht';       // SEND DC
const TRIGGER_LABEL  = 'Yes';

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (err) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // 1. Monday challenge handshake — just echo it back
  if (payload.challenge) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: payload.challenge })
    };
  }

  // 2. Normal event — Monday sends { event: { pulseId, columnId, value: { label: { text } } } }
  const ev = payload.event;
  if (!ev) {
    return { statusCode: 200, body: JSON.stringify({ ignored: 'no event' }) };
  }

  const itemId = ev.pulseId;
  const columnId = ev.columnId;

  if (!itemId) {
    return { statusCode: 200, body: JSON.stringify({ ignored: 'no pulseId' }) };
  }

  // Only fire when the SEND DC column changed to "Yes"
  if (columnId !== TRIGGER_COLUMN) {
    return { statusCode: 200, body: JSON.stringify({ ignored: 'wrong column', columnId }) };
  }

  const newLabel = ev.value && ev.value.label && ev.value.label.text;
  if (newLabel !== TRIGGER_LABEL) {
    return { statusCode: 200, body: JSON.stringify({ ignored: 'not Yes', newLabel }) };
  }

  // 3. Send the confirmation
  try {
    const item = await fetchItem(itemId);
    const fields = extractFields(item);

    if (!fields.clientEmail) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          skipped: 'no client email',
          itemId: itemId,
          itemName: item.name
        })
      };
    }

    const { subject, html } = buildEmail(fields);

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [fields.clientEmail],
        bcc: DEFAULT_BCC,
        subject: subject,
        html: html
      })
    });

    const resendBody = await resendRes.json();
    if (!resendRes.ok) {
      return {
        statusCode: 200, // return 200 so Monday doesn't retry
        body: JSON.stringify({
          error: 'Resend failed',
          status: resendRes.status,
          detail: resendBody,
          itemId: itemId
        })
      };
    }

    // Write back to Monday
    let writeBackError = null;
    try { await markSent(itemId); }
    catch (err) { writeBackError = err.message; }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        emailId: resendBody.id,
        sentTo: fields.clientEmail,
        itemId: itemId,
        writeBackError: writeBackError
      })
    };

  } catch (err) {
    return {
      statusCode: 200, // always return 200 to Monday
      body: JSON.stringify({ error: err.message, itemId: itemId })
    };
  }
};
