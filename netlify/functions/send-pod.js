// ============================================================
// HANDS Logistics — POST /api/send-pod
// Body: { itemId: <monday pulse id>, bcc?: string[] }
// Fetches Monday → renders POD HTML → sends via Resend → marks Monday
// ============================================================

const { fetchItem, extractPodFields, buildPodEmail, markPodSent, sanitizeEmailList } = require('./_email-builder');

const RESEND_API_KEY = 're_Xi5en35b_9XFtdPxMhPrZ2bLfSE2jtRwD';
const FROM_ADDRESS   = 'HANDS Logistics <concierge@handslogistics.com>';
const DEFAULT_BCC    = ['concierge@handslogistics.com'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (err) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const itemId = body.itemId;
  const extraBcc = Array.isArray(body.bcc) ? body.bcc : [];
  const ccInput = body.ccEmails;
  if (!itemId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing itemId' }) };

  try {
    const item = await fetchItem(itemId);
    const fields = extractPodFields(item);

    if (!fields.clientEmail) {
      return {
        statusCode: 422,
        headers: CORS,
        body: JSON.stringify({ error: 'No client email on item', itemId, itemName: item.name })
      };
    }

    const ccExtras = sanitizeEmailList(ccInput, fields.clientEmail, 10);
    const { subject, html } = buildPodEmail(fields);

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
        body: JSON.stringify({ error: 'Resend API error', status: resendRes.status, detail: resendBody })
      };
    }

    let writeBackError = null;
    try { await markPodSent(itemId); }
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
        photoUrl: fields.photoUrl,
        photoUrl2: fields.photoUrl2,
        writeBackError: writeBackError
      })
    };

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};
