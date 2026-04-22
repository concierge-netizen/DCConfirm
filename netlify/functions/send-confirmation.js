// ============================================================
// HANDS Logistics — POST /api/send-confirmation
// Body: { itemId: <monday pulse id>, bcc?: string[] }
// Fetches Monday → renders HTML → sends via Resend → marks Monday
// ============================================================

const { fetchItem, extractFields, buildEmail, markSent, sanitizeEmailList } = require('./_email-builder');

const RESEND_API_KEY = 're_Xi5en35b_9XFtdPxMhPrZ2bLfSE2jtRwD';
const FROM_ADDRESS   = 'HANDS Logistics <concierge@handslogistics.com>';
const DEFAULT_BCC    = ['concierge@handslogistics.com'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (err) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const itemId = body.itemId;
  const extraBcc = Array.isArray(body.bcc) ? body.bcc : [];
  const ccInput = body.ccEmails;

  if (!itemId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing itemId' }) };
  }

  try {
    // 1. Fetch Monday item
    const item = await fetchItem(itemId);
    const fields = extractFields(item);

    if (!fields.clientEmail) {
      return {
        statusCode: 422,
        headers: CORS,
        body: JSON.stringify({
          error: 'No client email on item',
          itemId: itemId,
          itemName: item.name
        })
      };
    }

    // Validate + dedupe CCs, excluding the primary client email
    const ccExtras = sanitizeEmailList(ccInput, fields.clientEmail, 10);

    // 2. Render email
    const { subject, html } = buildEmail(fields);

    // 3. Send via Resend
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [fields.clientEmail],
        cc: ccExtras.length ? ccExtras : undefined,
        bcc: DEFAULT_BCC.concat(extraBcc),
        subject: subject,
        html: html
      })
    });

    const resendBody = await resendRes.json();
    if (!resendRes.ok) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({
          error: 'Resend API error',
          status: resendRes.status,
          detail: resendBody
        })
      };
    }

    // 4. Write back to Monday (non-fatal — email already sent)
    let writeBackError = null;
    try { await markSent(itemId); }
    catch (err) { writeBackError = err.message; }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        emailId: resendBody.id,
        sentTo: fields.clientEmail,
        ccSentTo: ccExtras,
        itemId: itemId,
        writeBackError: writeBackError
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message, stack: err.stack })
    };
  }
};
