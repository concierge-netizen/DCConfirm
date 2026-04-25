// ============================================================
// HANDS Logistics — POST /api/schedule-delivery
//
// Replaces the browser-side Monday API call from
// scheduleadelivery.netlify.app. Token now lives only in
// the env var on this Netlify site (DCConfirm/ops.handslogistics.com).
//
// Request body — exactly what the form already sends:
//   { clientName, clientEmail, clientPhone, account,
//     deliveryAddress, deliveryDate, deliveryTime,
//     projectName, description, specialInstructions,
//     billingEmail, billingCode }
//
// Response: { success:true, itemId } or { error }
//
// Required env vars:
//   MONDAY_TOKEN
// ============================================================

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const BOARD_ID     = '4550650855';
const GROUP_ID     = 'new_group84798'; // Unconfirmed

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function validEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()); }
function trimStr(s) { return (typeof s === 'string') ? s.trim() : ''; }

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!MONDAY_TOKEN)                  return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'MONDAY_TOKEN not set' }) };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Normalize + validate required
  const f = {
    clientName:          trimStr(p.clientName),
    clientEmail:         trimStr(p.clientEmail),
    clientPhone:         trimStr(p.clientPhone),
    account:             trimStr(p.account),
    deliveryAddress:     trimStr(p.deliveryAddress),
    deliveryDate:        trimStr(p.deliveryDate),
    deliveryTime:        trimStr(p.deliveryTime),
    projectName:         trimStr(p.projectName),
    description:         trimStr(p.description),
    specialInstructions: trimStr(p.specialInstructions),
    billingEmail:        trimStr(p.billingEmail),
    billingCode:         trimStr(p.billingCode)
  };

  const required = ['clientName','clientEmail','account','deliveryAddress','deliveryDate','deliveryTime','projectName','description'];
  const missing = required.filter(k => !f[k]);
  if (missing.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing required fields', fields: missing }) };
  if (!validEmail(f.clientEmail))                  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid clientEmail' }) };
  if (f.billingEmail && !validEmail(f.billingEmail)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid billingEmail' }) };

  const itemName = f.account + ' - ' + f.projectName + ' · ' + f.deliveryDate;

  const cols = {
    text:               f.clientName,
    client_email1:      { email: f.clientEmail, text: f.clientEmail },
    text4:              f.account,
    text5:              f.projectName,
    long_text8:         { text: f.deliveryAddress },
    text2:              f.deliveryDate,
    text9:              f.deliveryTime,
    long_text:          { text: f.description },
    long_text_mm1qb1hz: { text: f.specialInstructions || 'None' },
    text07:             f.billingEmail,
    text20:             f.billingCode,
    color:              { label: 'Unconfirmed' },
    status:             { label: 'Unconfirmed' },
    status2:            { label: 'NOT STARTED' }
  };
  if (f.clientPhone) cols.phone = { phone: f.clientPhone, countryShortName: 'US' };

  const mutation = 'mutation { create_item(board_id:' + BOARD_ID + ', group_id:"' + GROUP_ID + '", item_name:' + JSON.stringify(itemName) + ', column_values:' + JSON.stringify(JSON.stringify(cols)) + ') { id } }';

  try {
    const res = await fetch('https://api.monday.com/v2', {
      method:  'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version':'2023-04' },
      body:    JSON.stringify({ query: mutation })
    });
    const data = await res.json();
    if (data.errors || !data.data || !data.data.create_item) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Monday create_item failed', detail: data.errors || data }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, itemId: data.data.create_item.id, itemName })
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
