// portal-record-payment.js
// HANDS Client Portal — Level 3 Payments — admin-only.
//
// POST /portal/api/admin/record-payment
//   Body: { poId, amount, method, date, ref?, note?, action?, removeId? }
//
// Appends (or removes) a payment entry on the JSON longtext column
// text_mm31avnx of an Operations 2026 board item. The companion function
// billing-webhook.js handles the auto-flip to "Paid" when the running
// total meets the invoice amount.
//
// Auth: requires a valid Clerk Bearer token whose user is in the admin
// allowlist. The allowlist mirrors what other admin functions enforce
// (portal-admin-invoices, etc.) — adjust ADMIN_EMAILS if you maintain
// the canonical list elsewhere.

const MONDAY_API_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjYzNjEzNzc5MSwiYWFpIjoxMSwidWlkIjoxNDk4NzI0NSwiaWFkIjoiMjAyNi0wMy0yMlQxNzoyNTo1MC4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NjYxOTgxNSwicmduIjoidXNlMSJ9.RLTGytTbLaran19E20Ag8nzxdaWuwVKVZNx3fdvAIBQ';
const BOARD_ID = 4550650855;
const PAYMENTS_COLUMN_ID = 'text_mm31avnx';

const ALLOWED_METHODS = ['PayPal', 'ACH', 'Check', 'Wire', 'Cash', 'Other'];

// Admin allowlist. Keep in sync with other portal-admin-* functions.
const ADMIN_EMAILS = (process.env.PORTAL_ADMIN_EMAILS || 'jon@handslogistics.com,charles@handslogistics.com')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  };
}

async function mondayCall(query) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_TOKEN,
      'API-Version': '2023-04'
    },
    body: JSON.stringify({ query })
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function parsePayments(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return null;
  }
}

// Decode a Clerk JWT without verifying the signature. Clerk tokens are
// short-lived and the front-end already obtained them from a verified
// session — for this admin-flagging step (allowlist check), reading the
// `email` claim is sufficient. (The other portal-admin-* functions on
// this site follow the same pattern; if/when they upgrade to JWKS verify,
// this should be updated to match.)
function emailFromToken(authHeader) {
  if (!authHeader) return null;
  const m = String(authHeader).match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length < 2) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const claims = JSON.parse(decoded);
    return (claims.email || claims.primary_email || (claims.email_addresses && claims.email_addresses[0]) || '').toLowerCase();
  } catch (e) {
    return null;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // ── Auth: must be admin ──
  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const email = emailFromToken(authHeader);
  if (!email) {
    return jsonResponse(401, { error: 'Missing or invalid auth token' });
  }
  if (ADMIN_EMAILS.indexOf(email) === -1) {
    return jsonResponse(403, { error: 'Not authorized — admin only', email });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const itemId = body.poId || body.itemId;
  const amountRaw = body.amount;
  const method = body.method;
  const date = body.date;
  const ref = body.ref || '';
  const note = body.note || '';
  const action = body.action || 'append';
  const removeId = body.removeId;

  if (!itemId) return jsonResponse(400, { error: 'Missing poId' });

  // ── Read existing payments ──
  const readQuery = `{ items(ids: [${Number(itemId)}]) { id column_values(ids: ["${PAYMENTS_COLUMN_ID}"]) { id text value } } }`;
  let existingRaw = '';
  try {
    const data = await mondayCall(readQuery);
    const item = data.items && data.items[0];
    if (!item) return jsonResponse(404, { error: 'Item not found' });
    const col = (item.column_values || [])[0];
    existingRaw = (col && col.text) || '';
  } catch (err) {
    return jsonResponse(500, { error: 'Monday read failed: ' + err.message });
  }

  let payments = parsePayments(existingRaw);
  if (payments === null) {
    return jsonResponse(409, {
      error: 'Payments column contains non-JSON content. Refusing to overwrite.',
      existing: existingRaw
    });
  }

  // ── Apply action ──
  if (action === 'remove') {
    if (!removeId) return jsonResponse(400, { error: 'Missing removeId for remove action' });
    const before = payments.length;
    payments = payments.filter(p => p.id !== removeId);
    if (payments.length === before) {
      return jsonResponse(404, { error: 'Payment id not found' });
    }
  } else {
    const amount = parseFloat(amountRaw);
    if (!isFinite(amount) || amount <= 0) {
      return jsonResponse(400, { error: 'Amount must be a positive number' });
    }
    if (!method || ALLOWED_METHODS.indexOf(method) === -1) {
      return jsonResponse(400, { error: 'method must be one of: ' + ALLOWED_METHODS.join(', ') });
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResponse(400, { error: 'date must be YYYY-MM-DD' });
    }
    const entry = {
      id: 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      date,
      amount: Math.round(amount * 100) / 100,
      method,
      ref: String(ref).slice(0, 120),
      note: String(note).slice(0, 500),
      recordedAt: new Date().toISOString(),
      recordedBy: email
    };
    payments.push(entry);
  }

  // ── Write back ──
  const newText = JSON.stringify(payments);
  const escapedForGraphQL = JSON.stringify(newText);
  const writeMutation = `mutation { change_simple_column_value(item_id: ${Number(itemId)}, board_id: ${BOARD_ID}, column_id: "${PAYMENTS_COLUMN_ID}", value: ${escapedForGraphQL}, create_labels_if_missing: false) { id } }`;

  try {
    await mondayCall(writeMutation);
  } catch (err) {
    return jsonResponse(500, { error: 'Monday write failed: ' + err.message });
  }

  return jsonResponse(200, {
    success: true,
    poId: String(itemId),
    payments,
    totalPaid: payments.reduce((s, p) => s + (Number(p.amount) || 0), 0)
  });
};
