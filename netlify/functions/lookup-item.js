// netlify/functions/lookup-item.js
//
// Called by the POD portal on load to display order details.
// GET /.netlify/functions/lookup-item?po=ITEM_ID
//
// Returns: { account, projectName, clientName, deliveryDate }
//
// Required env var: MONDAY_TOKEN

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const itemId = event.queryStringParameters && event.queryStringParameters.po;
  if (!itemId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing po parameter' }) };

  try {
    const query = `{ items (ids: [${itemId}]) {
      id name
      column_values(ids: ["text4", "text5", "text", "text2", "text9", "client_email1"]) {
        id text
      }
    }}`;

    const res = await fetch('https://api.monday.com/v2', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': MONDAY_TOKEN,
        'API-Version':   '2023-04'
      },
      body: JSON.stringify({ query })
    });

    if (!res.ok) throw new Error('monday API error: ' + res.status);
    const data = await res.json();
    if (data.errors) throw new Error('monday error: ' + JSON.stringify(data.errors));
    if (!data.data.items || !data.data.items.length) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Item not found' }) };
    }

    const item    = data.data.items[0];
    const cols    = item.column_values;
    const getCol  = (id) => { const c = cols.find(c => c.id === id); return (c && c.text) ? c.text.trim() : ''; };

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        itemId:       item.id,
        itemName:     item.name,
        account:      getCol('text4'),
        projectName:  getCol('text5'),
        clientName:   getCol('text'),
        deliveryDate: getCol('text2'),
        deliveryTime: getCol('text9'),
        clientEmail:  getCol('client_email1')
      })
    };

  } catch (err) {
    console.error('lookup-item error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
