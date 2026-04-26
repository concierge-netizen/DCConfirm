// HANDS Logistics — Generic Monday.com GraphQL Proxy
// Accepts { query, variables } POSTs and forwards to monday.com/v2.
// Token + API-Version attached server-side.
// Same-origin Referer guard prevents casual scraping from other origins.

const MONDAY_API_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjYzNjEzNzc5MSwiYWFpIjoxMSwidWlkIjoxNDk4NzI0NSwiaWFkIjoiMjAyNi0wMy0yMlQxNzoyNTo1MC4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NjYxOTgxNSwicmduIjoidXNlMSJ9.RLTGytTbLaran19E20Ag8nzxdaWuwVKVZNx3fdvAIBQ';

// Allowed Referer hostnames. Same-origin requests from the deployed site
// will have one of these in the Referer header.
const ALLOWED_HOSTS = [
  'ops.handslogistics.com',
  'dcconfirm.netlify.app'
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function refererAllowed(event) {
  const ref = (event.headers && (event.headers.referer || event.headers.Referer)) || '';
  if (!ref) return false;
  try {
    const u = new URL(ref);
    return ALLOWED_HOSTS.indexOf(u.hostname) !== -1;
  } catch (e) {
    return false;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method not allowed' };
  }
  if (!refererAllowed(event)) {
    return {
      statusCode: 403,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ error: 'Forbidden: invalid origin' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const query = body.query;
    const variables = body.variables || undefined;
    if (!query || typeof query !== 'string') {
      return {
        statusCode: 400,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ error: 'Missing or invalid query' })
      };
    }

    const payload = variables ? { query: query, variables: variables } : { query: query };
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_TOKEN,
        'API-Version': '2023-04'
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    return {
      statusCode: res.status,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: text
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ error: err.message })
    };
  }
};
