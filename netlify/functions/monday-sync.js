// netlify/functions/monday-sync.js
// GET  ?itemId=xxx        → fetch monday item, return mapped work order fields
// GET  ?groups=1          → return list of board groups for picker
// POST {action:'create'}  → create new monday item, return itemId
// POST {action:'update'}  → write work order fields back to monday item

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const BOARD_ID = 4550650855;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

async function monday(query) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_TOKEN,
      'API-Version': '2023-04'
    },
    body: JSON.stringify({ query })
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// Map monday column values to work order fields
function mapCols(item) {
  const cols = {};
  (item.column_values || []).forEach(c => { cols[c.id] = { text: c.text || '', value: c.value }; });

  // Parse date from monday date column (value is JSON like {"date":"2026-05-01"})
  let eventDate = '';
  try { eventDate = JSON.parse(cols['date4']?.value || '{}').date || cols['date4']?.text || ''; } catch {}

  // Parse time from hour column (value is JSON like {"hour":14,"minute":0})
  let startTime = '';
  try {
    const h = JSON.parse(cols['hour']?.value || '{}');
    if (h.hour !== undefined) startTime = String(h.hour).padStart(2,'0') + ':' + String(h.minute||0).padStart(2,'0');
  } catch {}

  return {
    mondayItemId: item.id,
    name:         item.name || '',
    account:      cols['text4']?.text  || '',
    activityType: cols['color_mm1wxn5k']?.text || 'Brand Activation',
    status:       cols['color']?.text  || 'Scheduled',
    eventDate,
    startTime,
    endTime:      cols['text8']?.text  || '',
    venue:        cols['text5']?.text  || '',
    address:      cols['text6']?.text  || '',
    contactName:  cols['text']?.text   || '',
    contactPhone: cols['phone']?.text  || '',
    notes:        cols['long_text']?.text || '',
    setupNotes:   cols['text_mm1wxn5x']?.text || '',
    teardownNotes:cols['text_mm1wxn5y']?.text || '',
    groupId:      item.group?.id || '',
    groupTitle:   item.group?.title || ''
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const params = event.queryStringParameters || {};

  // ── GET groups list ───────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && params.groups) {
    try {
      const data = await monday(`{ boards(ids:[${BOARD_ID}]) { groups { id title } } }`);
      const groups = data.boards[0].groups;
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(groups) };
    } catch(err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── GET fetch item ────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && params.itemId) {
    try {
      const data = await monday(`{
        items(ids:[${params.itemId}]) {
          id name
          group { id title }
          column_values { id text value }
        }
      }`);
      const item = data.items && data.items[0];
      if (!item) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Item not found' }) };
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(mapCols(item)) };
    } catch(err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // ── POST create new item ──────────────────────────────────────────────────
  if (body.action === 'create') {
    try {
      const { name, groupId, account, activityType, eventDate, startTime } = body;
      if (!name) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'name required' }) };
      if (!groupId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'groupId required' }) };

      // Build column values
      const cols = {};
      if (account)      cols['text4']           = account;
      if (activityType) cols['color_mm1wxn5k']  = { label: activityType };
      if (eventDate)    cols['date4']            = { date: eventDate };
      if (startTime) {
        const [h, m] = startTime.split(':');
        cols['hour'] = { hour: parseInt(h)||0, minute: parseInt(m)||0 };
      }

      const colsJson = JSON.stringify(JSON.stringify(cols));
      const mutation = `mutation {
        create_item(
          board_id: ${BOARD_ID},
          group_id: "${groupId}",
          item_name: ${JSON.stringify(name)},
          column_values: ${colsJson}
        ) { id }
      }`;

      const data = await monday(mutation);
      const itemId = data.create_item.id;
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, itemId }) };
    } catch(err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── POST update existing item ─────────────────────────────────────────────
  if (body.action === 'update') {
    try {
      const { itemId, name, account, activityType, status, eventDate, startTime, endTime, venue, address, contactName, setupNotes, teardownNotes, notes } = body;
      if (!itemId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'itemId required' }) };

      const cols = {};
      if (account)       cols['text4']            = account;
      if (activityType)  cols['color_mm1wxn5k']   = { label: activityType };
      if (status)        cols['color']             = { label: status };
      if (endTime)       cols['text8']             = endTime;
      if (venue)         cols['text5']             = venue;
      if (address)       cols['text6']             = address;
      if (contactName)   cols['text']              = contactName;
      if (setupNotes)    cols['text_mm1wxn5x']     = setupNotes;
      if (teardownNotes) cols['text_mm1wxn5y']     = teardownNotes;
      if (notes)         cols['long_text']         = { text: notes };
      if (eventDate)     cols['date4']             = { date: eventDate };
      if (startTime) {
        const [h, m] = startTime.split(':');
        cols['hour'] = { hour: parseInt(h)||0, minute: parseInt(m)||0 };
      }

      const colsJson = JSON.stringify(JSON.stringify(cols));
      const mutation = `mutation {
        change_multiple_column_values(
          item_id: ${itemId},
          board_id: ${BOARD_ID},
          column_values: ${colsJson}
        ) { id }
      }`;

      // Also update item name if changed
      if (name) {
        await monday(`mutation { change_item_value(board_id:${BOARD_ID}, item_id:${itemId}, column_id:"name", value:${JSON.stringify(JSON.stringify(name))}) { id } }`);
      }

      await monday(mutation);
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, itemId }) };
    } catch(err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
};
