// netlify/functions/preview-pod.js
//
// Sends a PREVIEW POD email to jon@ / charles@ ONLY.
// Photos are already uploaded to Cloudinary by the client before calling this.
// Does NOT write to Monday, does NOT send to the actual client.
// The orange PREVIEW banner at the top makes it obvious.
//
// Required env vars: MONDAY_TOKEN, RESEND_KEY

const { renderPodHtml, mondayQuery, getCol, sanitizeEmailList } = require('./_email-builder');

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const RESEND_KEY   = process.env.RESEND_KEY;
const PREVIEW_TO   = ['jon@handslogistics.com', 'charles@handslogistics.com'];
const FROM         = 'HANDS Logistics <concierge@handslogistics.com>';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const { itemId, photoUrl, photoUrl2, receivedBy, deliveredDate, deliveredTime, ccEmails } = body;
    if (!itemId) throw new Error('Missing itemId');
    if (!RESEND_KEY) throw new Error('RESEND_KEY not set');

    // Fetch Monday item for context
    const query = `{ items (ids: [${itemId}]) { id name column_values { id type text value } } }`;
    const data = await mondayQuery(MONDAY_TOKEN, query);
    if (!data.data.items || !data.data.items.length) throw new Error('Item not found: ' + itemId);
    const item = data.data.items[0];
    const cols = item.column_values;

    const emailFields = {
      pulseId:         item.id,
      clientName:      getCol(cols, 'text')          || 'Valued Client',
      account:         getCol(cols, 'text4')         || '',
      projectName:     getCol(cols, 'text5')         || '',
      deliveryAddress: getCol(cols, 'long_text8')    || 'N/A',
      description:     getCol(cols, 'long_text')     || 'See order details on file.',
      receivedBy:      receivedBy || getCol(cols, 'text_mm1p831b') || 'Driver',
      deliveredDate:   deliveredDate || getCol(cols, 'text2') || 'TBD',
      deliveredTime:   deliveredTime || getCol(cols, 'text9') || 'TBD',
      photoUrl:        photoUrl  || '',
      photoUrl2:       photoUrl2 || '',
      clientEmail:     getCol(cols, 'client_email1')
    };

    // Preview does NOT send to the CCs — it only reports them back for display.
    const ccExtras = sanitizeEmailList(ccEmails, emailFields.clientEmail, 10);

    // Subject: project name first, then PO number
    const subject = emailFields.projectName
      ? '[PREVIEW] Proof of Delivery — ' + emailFields.projectName + ' | PO #' + emailFields.pulseId
      : '[PREVIEW] Proof of Delivery — PO #' + emailFields.pulseId;
    const html = renderPodHtml(emailFields, true); // true = show preview banner

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: PREVIEW_TO, subject, html })
    });
    const emailData = await emailRes.json();
    if (!emailRes.ok) throw new Error('Resend error: ' + JSON.stringify(emailData));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        sentTo: PREVIEW_TO,
        clientEmail: emailFields.clientEmail || '',
        ccExtras: ccExtras
      })
    };

  } catch (err) {
    console.error('preview-pod error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
