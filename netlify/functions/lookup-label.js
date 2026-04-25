// ============================================================
// HANDS Logistics — GET /api/lookup-label?po={itemId}
//
// Read-only Monday item lookup for the thermal label generator.
// Returns ONLY the safe fields the label needs to render —
// no internal notes, no billing data, no client emails.
//
// Required env vars:
//   MONDAY_TOKEN
// ============================================================

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;

const COL = {
  account:        'text4',
  project:        'text5',
  client:         'text',
  deliveryDate:   'text2',
  deliveryTime:   'text9',
  address:        'long_text8',
  description:    'long_text',
  logisticsStatus:'color',
  receivedBy:     'text_mm1p831b'
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function getCol(cols, id) {
  const c = (cols || []).find(x => x.id === id);
  return (c && c.text && c.text.trim()) ? c.text.trim() : '';
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!MONDAY_TOKEN)                  return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'MONDAY_TOKEN not set' }) };

  const po = (event.queryStringParameters || {}).po;
  if (!po || !/^\d{6,}$/.test(po))    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid PO' }) };

  try {
    const q = '{ items(ids:[' + po + ']) { id name column_values { id text } } }';
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version':'2023-04' },
      body: JSON.stringify({ query: q })
    });
    const data = await r.json();
    if (data.errors) throw new Error('Monday error: ' + JSON.stringify(data.errors));

    const item = data.data.items && data.data.items[0];
    if (!item) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'PO not found' }) };

    const cols = item.column_values;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        poNumber:        item.id,
        itemName:        item.name,
        account:         getCol(cols, COL.account),
        projectName:     getCol(cols, COL.project),
        clientName:      getCol(cols, COL.client),
        deliveryDate:    getCol(cols, COL.deliveryDate),
        deliveryTime:    getCol(cols, COL.deliveryTime),
        deliveryAddress: getCol(cols, COL.address),
        description:     getCol(cols, COL.description),
        logisticsStatus: getCol(cols, COL.logisticsStatus),
        receivedBy:      getCol(cols, COL.receivedBy)
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
