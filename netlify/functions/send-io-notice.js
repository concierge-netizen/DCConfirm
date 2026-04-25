// ============================================================
// HANDS Logistics — POST /api/send-io-notice
//
// Sends a branded warehouse I/O notification email (inbound receipt or
// outbound shipment) via Resend. Reads item data directly from the NV I/O
// 2026 Monday board, renders the email, sends, and flips the Notice Sent
// checkbox on the Monday item.
//
// Called by the Warehouse I/O form right after it creates the Monday item.
//
// Request body:
//   { itemId: "<monday item id>", ccEmails: [optional extras] }
//
// Response:
//   { success:true, direction, sentTo:[...], itemId }
//
// Required env vars:
//   MONDAY_TOKEN
//   RESEND_KEY
// ============================================================

const { renderIoNoticeHtml } = require('./_email-builder');

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const RESEND_KEY   = 're_Xi5en35b_9XFtdPxMhPrZ2bLfSE2jtRwD'; // hardcoded — matches send-confirmation.js to avoid env mismatch
const BOARD_ID     = '18405667848';

const FROM          = 'HANDS Logistics <concierge@handslogistics.com>';
const INBOUND_TEAM  = ['concierge@handslogistics.com', 'inbound@handslogistics.com'];
const OUTBOUND_TEAM = ['concierge@handslogistics.com'];

const COL = {
  direction:      'color_mm1t2es',
  purpose:        'color_mm1th2fd',
  clientName:     'text1',
  clientEmail:    'email_mm1t5t04',
  account:        'text_mm1thc9z',
  project:        'text_mm1t684g',
  carrier:        'text_mm1txgg0',
  tracking:       'text',
  shipDate:       'date',
  estDate:        'date4',
  address:        'long_text_mm1t6mkn',
  contents:       'long_text_mm1tft13',
  instructions:   'long_text',
  cartons:        'numeric_mm1t1786',
  pallets:        'numeric_mm1tjxes',
  weight:         'numeric_mm1tga5r',
  photo1:         'link_mm1tj6c1',
  photo2:         'link_mm1tcmmh',
  noticeSent:     'boolean_mm1trns6',
  sendInbound:    'color_mm1t824v',
  sendOutbound:   'color_mm1t5hde'
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

async function mondayQuery(query) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version':'2023-04' },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error('Monday error: ' + JSON.stringify(data.errors || data));
  return data;
}

function getCol(cols, id) {
  const c = (cols || []).find(x => x.id === id);
  return (c && c.text && c.text.trim()) ? c.text.trim() : '';
}

function getLinkUrl(cols, id) {
  const c = (cols || []).find(x => x.id === id);
  if (!c || !c.value) return '';
  try { const p = JSON.parse(c.value); return p.url || ''; }
  catch (e) { return c.text || ''; }
}

// Validate a list of candidate email addresses; dedupe case-insensitively.
function sanitizeEmails(list) {
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const seen = new Set();
  const out = [];
  (list || []).forEach(function(raw){
    if (!raw) return;
    const s = String(raw).trim();
    if (!EMAIL.test(s)) return;
    const lower = s.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    out.push(s);
  });
  return out;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!MONDAY_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'MONDAY_TOKEN not set' }) };
  if (!RESEND_KEY)   return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'RESEND_KEY not set' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const itemId = body.itemId;
  const extraCCs = Array.isArray(body.ccEmails) ? body.ccEmails : [];
  if (!itemId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing itemId' }) };

  try {
    // 1. Fetch the Monday item
    const q = '{ items(ids:[' + itemId + ']) { id name column_values { id text value } } }';
    const data = await mondayQuery(q);
    const item = data.data.items && data.data.items[0];
    if (!item) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Item not found', itemId }) };
    }
    const cols = item.column_values || [];

    const direction = (getCol(cols, COL.direction) || '').toLowerCase(); // "inbound" or "outbound"
    const isInbound = direction === 'inbound';
    const isOutbound = direction === 'outbound';
    if (!isInbound && !isOutbound) {
      return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: 'Direction column is blank — cannot decide which email to send', itemId }) };
    }

    // Assemble render fields
    const fields = {
      itemId:         item.id,
      itemName:       item.name,
      direction:      isInbound ? 'Inbound' : 'Outbound',
      purpose:        getCol(cols, COL.purpose) || '—',
      clientName:     getCol(cols, COL.clientName) || 'Valued Client',
      clientEmail:    getCol(cols, COL.clientEmail) || '',
      account:        getCol(cols, COL.account) || '',
      project:        getCol(cols, COL.project) || '',
      carrier:        getCol(cols, COL.carrier) || '—',
      tracking:       getCol(cols, COL.tracking) || '—',
      shipDate:       getCol(cols, COL.shipDate) || getCol(cols, COL.estDate) || 'TBD',
      address:        getCol(cols, COL.address) || '',
      contents:       getCol(cols, COL.contents) || 'See shipment details on file.',
      instructions:   getCol(cols, COL.instructions) || '',
      cartons:        getCol(cols, COL.cartons) || '',
      pallets:        getCol(cols, COL.pallets) || '',
      weight:         getCol(cols, COL.weight) || '',
      photoUrl1:      getLinkUrl(cols, COL.photo1),
      photoUrl2:      getLinkUrl(cols, COL.photo2),
      mondayUrl:      'https://handslogistics.monday.com/boards/' + BOARD_ID + '/pulses/' + item.id
    };

    const subjectBase = isInbound
      ? 'Inbound Receipt'
      : 'Outbound Shipment Notice';
    const subjectTail = fields.project ? (' — ' + fields.project) : (fields.account ? (' — ' + fields.account) : '');
    const subject = subjectBase + subjectTail + ' | PO #' + fields.itemId;

    const html = renderIoNoticeHtml(fields);

    // Build recipient list
    const teamAddresses = isInbound ? INBOUND_TEAM : OUTBOUND_TEAM;
    const toAddresses = sanitizeEmails(fields.clientEmail ? [fields.clientEmail] : teamAddresses);
    const ccAddresses = sanitizeEmails(
      (fields.clientEmail ? teamAddresses : []) // if client is To, team goes CC
        .concat(extraCCs)
    );

    if (!toAddresses.length) {
      return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: 'No valid recipients for I/O notice', itemId }) };
    }

    // 2. Send via Resend
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: toAddresses,
        cc: ccAddresses.length ? ccAddresses : undefined,
        subject: subject,
        html: html
      })
    });
    const resendBody = await resendRes.json();
    if (!resendRes.ok) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Resend API error', status: resendRes.status, detail: resendBody }) };
    }

    // 3. Write back to Monday — flip Notice Sent + flip corresponding trigger column to SENT
    //    (non-fatal: email already left the building)
    let writeBackError = null;
    try {
      const monCols = {};
      monCols[COL.noticeSent] = { checked: 'true' };
      if (isInbound)  monCols[COL.sendInbound]  = { label: 'SENT' };
      if (isOutbound) monCols[COL.sendOutbound] = { label: 'SENT' };
      const mutation = 'mutation { change_multiple_column_values(item_id:' + item.id + ', board_id:' + BOARD_ID + ', column_values:' + JSON.stringify(JSON.stringify(monCols)) + ') { id } }';
      await mondayQuery(mutation);

      // Audit note
      const noteBody = '📦 ' + fields.direction + ' notice email sent to ' + toAddresses.join(', ') +
        (ccAddresses.length ? ' (cc: ' + ccAddresses.join(', ') + ')' : '');
      const noteMut = 'mutation { create_update(item_id:' + item.id + ', body:' + JSON.stringify(noteBody) + ') { id } }';
      await mondayQuery(noteMut);
    } catch (e) { writeBackError = e.message; }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        direction: fields.direction,
        sentTo: toAddresses,
        ccSentTo: ccAddresses,
        emailId: resendBody.id,
        itemId: item.id,
        writeBackError
      })
    };
  } catch (err) {
    console.error('send-io-notice error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
