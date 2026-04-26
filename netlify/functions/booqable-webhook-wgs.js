// HANDS Logistics — Booqable Webhook (WGS tenant)
// Per-client webhook receiver. Each Booqable tenant points at its own URL,
// e.g. WGS's Booqable account points at /api/booqable-webhook-wgs.
// This function knows its slug ('wgs') and looks up the matching monday item
// by WBS code (e.g. WGS-12345) when an order status event fires.
//
// To onboard a new client:
//   1. Copy this file as booqable-webhook-{slug}.js, change SLUG below
//   2. Add a matching _redirects rule
//   3. Register the URL in their Booqable account's webhook settings
//
// Env var: MONDAY_TOKEN

const SLUG = 'wgs';

const CLIENTS = require('./_clients-config');

const STATUS_MAP = {
  'order.reserved':  'DELIVERY SCHEDULED',
  'order.started':   'OUT FOR DELIVERY',
  'order.stopped':   'COMPLETE',
  'order.archived':  'ON HOLD'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const WBS_COL = 'text20';
const STATUS_COL = 'color';

async function mondayFetch(token, query, variables) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2023-04'
    },
    body: JSON.stringify(variables ? { query, variables } : { query })
  });
  const j = await res.json();
  if (j.errors) throw new Error('Monday error: ' + JSON.stringify(j.errors));
  return j.data;
}

async function findItemByWbs(token, boardId, wbs) {
  const query =
    'query ($board: [ID!], $col: ID!, $val: [String]) { ' +
      'items_page_by_column_values (board_id: $board, columns: [{column_id: $col, column_values: $val}], limit: 5) { items { id name } } }';
  const data = await mondayFetch(token, query, {
    board: [String(boardId)],
    col: WBS_COL,
    val: [wbs]
  });
  const items = (data.items_page_by_column_values && data.items_page_by_column_values.items) || [];
  return items.length ? items[0].id : null;
}

async function updateItemStatus(token, boardId, itemId, newStatus) {
  const cols = JSON.stringify({ [STATUS_COL]: { label: newStatus } });
  const mutation =
    'mutation ($board: ID!, $item: ID!, $cols: JSON!) { ' +
      'change_multiple_column_values (board_id: $board, item_id: $item, column_values: $cols) { id } }';
  await mondayFetch(token, mutation, {
    board: String(boardId),
    item: String(itemId),
    cols
  });
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method not allowed' };
  }

  const TOKEN = process.env.MONDAY_TOKEN;
  if (!TOKEN) {
    return {
      statusCode: 500,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ error: 'MONDAY_TOKEN not configured' })
    };
  }

  const clientConfig = CLIENTS[SLUG];
  if (!clientConfig) {
    return {
      statusCode: 500,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ error: 'Client config missing for slug: ' + SLUG })
    };
  }
  const wbsPrefix = (clientConfig.monday && clientConfig.monday.wbs_prefix) || clientConfig.short_name;
  const boardId = (clientConfig.monday && clientConfig.monday.ops_board) || '4550650855';

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) {
    return {
      statusCode: 400,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  // Booqable v4 webhook payloads can come in multiple shapes
  const eventName = payload.event || payload.topic || payload.type;
  const orderData = (payload.data && payload.data.id) ? payload.data
                  : (payload.payload && payload.payload.data) ? payload.payload.data
                  : (payload.payload && payload.payload.id) ? payload.payload
                  : null;

  if (!eventName || !orderData || !orderData.id) {
    return {
      statusCode: 200,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ignored: true, reason: 'Missing event or order id' })
    };
  }

  const orderId = orderData.id;
  const newStatus = STATUS_MAP[eventName];
  if (!newStatus) {
    return {
      statusCode: 200,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ignored: true, reason: 'Event not mapped: ' + eventName })
    };
  }

  const wbs = wbsPrefix + '-' + orderId;

  try {
    const itemId = await findItemByWbs(TOKEN, boardId, wbs);
    if (!itemId) {
      return {
        statusCode: 200,
        headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ignored: true, reason: 'No monday item with WBS ' + wbs })
      };
    }
    await updateItemStatus(TOKEN, boardId, itemId, newStatus);
    return {
      statusCode: 200,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        success: true,
        slug: SLUG,
        booqable_order: orderId,
        monday_item: itemId,
        wbs: wbs,
        event: eventName,
        new_status: newStatus
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ error: err.message })
    };
  }
};
