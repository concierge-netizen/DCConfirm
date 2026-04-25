// netlify/functions/submit-pod.js
//
// Called by the POD upload portal AFTER the driver has uploaded photos
// directly to Cloudinary from the browser. Body contains the resulting
// public Cloudinary URLs plus the driver-entered fields.
//
// Flow:
//   1. Write photo URLs, Received By, Delivered Date, Delivered Time to Monday
//      (also clears SEND POD and flips POD Email Sent = checked)
//   2. Fetch full item data (client email, project, address, etc.)
//   3. Send branded POD email via Resend
//   4. Post a Monday update noting the POD went out
//
// Required env vars: MONDAY_TOKEN, RESEND_KEY

const { renderPodHtml, mondayQuery, getCol, getLinkUrl, sanitizeEmailList } = require('./_email-builder');

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const RESEND_KEY   = process.env.RESEND_KEY;
const BOARD_ID     = '4550650855';
const FROM         = 'HANDS Logistics <concierge@handslogistics.com>';
const CC_ALWAYS    = ['concierge@handslogistics.com'];

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// ── Write driver submission back to Monday ────────────────────
// Uses the same link columns the email will read from, so the email's
// "View Photo" buttons land on the public Cloudinary URLs.
async function writeToMonday(itemId, photoUrl, photoUrl2, receivedBy, deliveredDate, deliveredTime) {
  const cols = {
    text_mm1p831b: receivedBy || '',
    color_mm1qkyf: { index: 5 },        // clear SEND POD so the webhook can't double-fire
    boolean_mm1jr3gr: { checked: 'true' } // mark POD Email Sent (board signal)
  };
  if (deliveredDate) cols.text0  = deliveredDate;   // Delivered On
  if (deliveredTime) cols.text00 = deliveredTime;   // Delivered Time
  if (photoUrl)  cols.link_mm1pgr61 = { url: photoUrl,  text: 'POD Photo 1' };
  if (photoUrl2) cols.link_mm1pay5j = { url: photoUrl2, text: 'POD Photo 2' };

  const mutation = `mutation { change_multiple_column_values(item_id: ${itemId}, board_id: ${BOARD_ID}, column_values: ${JSON.stringify(JSON.stringify(cols))}) { id } }`;
  return mondayQuery(MONDAY_TOKEN, mutation);
}

async function fetchItemData(itemId) {
  const query = `{ items (ids: [${itemId}]) { id name column_values { id type text value } } }`;
  const data = await mondayQuery(MONDAY_TOKEN, query);
  if (!data.data.items || !data.data.items.length) throw new Error('Item not found: ' + itemId);
  return data.data.items[0];
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const { itemId, photoUrl, photoUrl2, receivedBy, deliveredDate, deliveredTime, ccEmails } = body;
    if (!itemId) throw new Error('Missing itemId');

    console.log('submit-pod — itemId:', itemId, 'receivedBy:', receivedBy, 'date:', deliveredDate, 'time:', deliveredTime, 'ccCount:', Array.isArray(ccEmails) ? ccEmails.length : 0);

    // 1. Write to Monday (photo URLs, Received By, Delivered Date/Time, flip checkbox)
    await writeToMonday(itemId, photoUrl || '', photoUrl2 || '', receivedBy || '', deliveredDate || '', deliveredTime || '');

    // 2. Fetch full item data for the email
    const item = await fetchItemData(itemId);
    const cols = item.column_values;

    const emailFields = {
      pulseId:         item.id,
      clientName:      getCol(cols, 'text')          || 'Valued Client',
      account:         getCol(cols, 'text4')         || '',
      projectName:     getCol(cols, 'text5')         || '',
      deliveryAddress: getCol(cols, 'long_text8')    || 'N/A',
      description:     getCol(cols, 'long_text')     || 'See order details on file.',
      receivedBy:      receivedBy || getCol(cols, 'text_mm1p831b') || 'Driver',
      // Driver-entered actual delivery date/time wins; fall back to scheduled only if blank
      deliveredDate:   deliveredDate || getCol(cols, 'text2') || 'TBD',
      deliveredTime:   deliveredTime || getCol(cols, 'text9') || 'TBD',
      photoUrl:        photoUrl  || getLinkUrl(cols, 'link_mm1pgr61'),
      photoUrl2:       photoUrl2 || getLinkUrl(cols, 'link_mm1pay5j'),
      clientEmail:     getCol(cols, 'client_email1')
    };

    // Validate and dedupe CC list server-side — exclude primary recipient to avoid dupes
    const ccExtras = sanitizeEmailList(ccEmails, emailFields.clientEmail, 10);

    // 3. Send email (non-fatal — Monday already has all the data)
    let emailSent = false;
    let emailError = '';
    try {
      if (!RESEND_KEY) throw new Error('RESEND_KEY not set in environment variables');

      // Subject: project name first, then PO number
      const subject = emailFields.projectName
        ? 'Proof of Delivery — ' + emailFields.projectName + ' | PO #' + emailFields.pulseId
        : 'Proof of Delivery — PO #' + emailFields.pulseId;
      const html    = renderPodHtml(emailFields, false);

      const toAddresses = emailFields.clientEmail ? [emailFields.clientEmail] : CC_ALWAYS;
      // CC_ALWAYS (concierge@) + any driver-entered CCs
      const ccAddresses = (emailFields.clientEmail ? CC_ALWAYS : []).concat(ccExtras);

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: toAddresses, cc: ccAddresses, subject, html })
      });
      const emailData = await emailRes.json();
      if (!emailRes.ok) throw new Error('Resend error: ' + JSON.stringify(emailData));
      emailSent = true;
      console.log('POD email sent — to:', toAddresses, 'cc:', ccAddresses);
    } catch (e) {
      emailError = e.message;
      console.error('Email send failed (non-fatal):', e.message);
    }

    // 4. Post a monday update (non-fatal)
    // Build the body as a JS string, then JSON.stringify it for safe GraphQL embedding —
    // this escapes quotes, newlines, and anything else in receivedBy/clientEmail.
    try {
      const ts = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      const recipient = emailFields.clientEmail || 'HANDS team';
      const ccNote = ccExtras.length ? ' (cc: ' + ccExtras.join(', ') + ')' : '';
      const emailNote = emailSent ? 'Email sent to ' + recipient + ccNote + '.' : 'Email send FAILED — retry manually.';
      const updateBody = 'POD submitted — Received by: ' + emailFields.receivedBy + '. ' + emailNote + ' ' + ts;
      const updateMutation = `mutation { create_update(item_id: ${item.id}, body: ${JSON.stringify(updateBody)}) { id } }`;
      await mondayQuery(MONDAY_TOKEN, updateMutation);
    } catch (e) { console.log('update post failed (non-fatal):', e.message); }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        emailSent,
        emailError: emailError || undefined,
        sentTo: emailFields.clientEmail || '',
        ccSentTo: ccExtras
      })
    };

  } catch (err) {
    console.error('submit-pod error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
