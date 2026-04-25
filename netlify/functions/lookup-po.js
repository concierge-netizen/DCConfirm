// ============================================================
// HANDS Logistics — GET /api/lookup-po?po={itemId}
//
// Public-safe lookup endpoint for the Assign Purpose form.
// When the form receives a bare ?po=X URL (no ?data= payload),
// it can call this endpoint to get the metadata it needs to
// populate the "Order Information" panel.
//
// Returns a SAFE subset of fields — no internal notes, no billing
// data, no special instructions. Only what's needed for display.
//
// Required env vars:
//   MONDAY_TOKEN
// ============================================================

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const NVIO_BOARD_ID = '18405667848';

const COL = {
  direction:   'color_mm1t2es',
  clientName:  'text1',
  clientEmail: 'email_mm1t5t04',
  account:     'text_mm1thc9z',
  project:     'text_mm1t684g',
  carrier:     'text_mm1txgg0',
  tracking:    'text',
  shipDate:    'date',
  contents:    'long_text_mm1tft13'
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
    const q = '{ items(ids:[' + po + ']) { id name board { id } column_values { id text value } } }';
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version':'2023-04' },
      body: JSON.stringify({ query: q })
    });
    const data = await r.json();
    if (data.errors) throw new Error('Monday error');

    const item = data.data.items && data.data.items[0];
    if (!item) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'PO not found' }) };
    if (item.board && String(item.board.id) !== NVIO_BOARD_ID) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'PO not on warehouse I/O board' }) };
    }

    const cols = item.column_values;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        itemId:      item.id,
        po:          item.id,
        clientName:  getCol(cols, COL.clientName),
        clientEmail: getCol(cols, COL.clientEmail),
        account:     getCol(cols, COL.account) || getCol(cols, COL.project),
        direction:   getCol(cols, COL.direction),
        date:        getCol(cols, COL.shipDate),
        carrier:     getCol(cols, COL.carrier),
        tracking:    getCol(cols, COL.tracking),
        contents:    getCol(cols, COL.contents)
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
