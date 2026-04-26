// netlify/functions/fetch-items.js
// Returns active (non-COMPLETE) ops board items for the dispatch tool

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const BOARD_ID     = '4550650855';
const EXCLUDE      = ['COMPLETE', 'Proposal Need'];

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  try {
    const query = `{
      boards(ids: [${BOARD_ID}]) {
        items_page(limit: 100) {
          items {
            id name
            column_values(ids: ["text4","text5","text2","text9","long_text8","client_email1","text20","long_text","color"]) {
              id text
            }
          }
        }
      }
    }`;

    const res  = await fetch('https://api.monday.com/v2', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version': '2023-04' },
      body:    JSON.stringify({ query })
    });

    const data  = await res.json();
    const raw   = (data.data.boards[0].items_page && data.data.boards[0].items_page.items) || [];

    const items = raw
      .filter(function(item) {
        const status = (item.column_values.find(c => c.id === 'color') || {}).text || '';
        return !EXCLUDE.includes(status);
      })
      .map(function(item) {
        const gc = id => { const c = item.column_values.find(c => c.id === id); return (c && c.text) ? c.text.trim() : ''; };
        return {
          id:      item.id,
          name:    item.name,
          account: gc('text4'),
          project: gc('text5'),
          po:      gc('text20'),
          date:    gc('text2'),
          time:    gc('text9'),
          address: gc('long_text8'),
          contact: gc('client_email1'),
          desc:    gc('long_text')
        };
      });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ items }) };

  } catch (err) {
    console.error('fetch-items error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
