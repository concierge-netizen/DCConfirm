// HANDS Logistics — Booqable Order Creation (multi-tenant)
// Receives deployment requests from /clients/{slug}, creates the order in
// the matching Booqable tenant in "concept" status, mirrors to monday Ops
// board, sends a notification email to HANDS team, sends a confirmation
// email to the requesting client contact.
//
// Routing: client picks itself by slug in the request body. Slug determines:
//   - Which Booqable tenant + key to use
//   - Branding voice in the emails
//   - WBS prefix on the monday item (e.g. WGS-12345)
//
// Env vars: MONDAY_TOKEN, RESEND_KEY, BOOQABLE_KEY_<SLUG> (per client)

const CLIENTS = require('./_clients-config');

const OPS_BOARD_ID = 4550650855;
const NOTIFY_FALLBACK = 'jon@handslogistics.com';
const FROM_EMAIL = 'HANDS Logistics <jon@handslogistics.com>';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  };
}

function slugValid(s) {
  return typeof s === 'string' && /^[a-z0-9-]+$/.test(s) && s.length > 0 && s.length < 40;
}

// ─────────────────────────────────────────────────────────────────────────
// Booqable helpers (per-tenant)
// ─────────────────────────────────────────────────────────────────────────

async function booqable(method, endpoint, body, token, base) {
  const res = await fetch(base + '/' + endpoint, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const msg = (parsed && (parsed.errors || parsed.message)) || text;
    throw new Error('Booqable ' + method + ' ' + endpoint + ' failed (' + res.status + '): ' + JSON.stringify(msg).slice(0, 400));
  }
  return parsed;
}

async function getOrCreateCustomer(token, base, customer) {
  const search = await booqable('GET',
    'customers?filter[email]=' + encodeURIComponent(customer.email) + '&per_page=1',
    null, token, base);
  if (search && search.data && search.data.length > 0) {
    return search.data[0].id;
  }
  const created = await booqable('POST', 'customers', {
    data: {
      type: 'customers',
      attributes: {
        name: customer.name,
        email: customer.email,
        phone: customer.phone || '',
        properties: customer.company ? { company: customer.company } : undefined
      }
    }
  }, token, base);
  return created && created.data && created.data.id;
}

async function createOrder(token, base, customerId, payload) {
  const order = await booqable('POST', 'orders', {
    data: {
      type: 'orders',
      attributes: {
        starts_at: payload.startDate,
        stops_at: payload.endDate,
        status: 'concept',
        properties: {
          delivery_address: payload.deliveryAddress || '',
          event_details: payload.eventDetails || '',
          source: 'HANDS Asset Portal'
        }
      },
      relationships: {
        customer: { data: { type: 'customers', id: customerId } }
      }
    }
  }, token, base);
  const orderId = order && order.data && order.data.id;
  if (!orderId) throw new Error('Order creation returned no ID');

  for (const line of payload.items) {
    await booqable('POST', 'lines', {
      data: {
        type: 'lines',
        attributes: { quantity: line.quantity || 1 },
        relationships: {
          order:   { data: { type: 'orders',   id: orderId } },
          product: { data: { type: 'products', id: line.productId } }
        }
      }
    }, token, base).catch(err => {
      console.error('Line item add failed for product ' + line.productId + ': ' + err.message);
    });
  }

  return orderId;
}

// ─────────────────────────────────────────────────────────────────────────
// Monday helpers
// ─────────────────────────────────────────────────────────────────────────

async function createMondayItem(mondayToken, clientConfig, customer, orderId, payload) {
  const itemCount = payload.items.length;
  const itemNote = itemCount === 1 ? '1 item' : itemCount + ' items';
  const itemName = clientConfig.short_name + ' — ' + (customer.company || customer.name) + ' (' + itemNote + ')';

  let deliveryDateText = '';
  try {
    const d = new Date(payload.startDate);
    const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
    deliveryDateText = months[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  } catch (e) { /* leave blank */ }

  const wbsPrefix = (clientConfig.monday && clientConfig.monday.wbs_prefix) || clientConfig.short_name || clientConfig.slug.toUpperCase();
  const wbs = wbsPrefix + '-' + orderId;

  const description = [
    'BOOQABLE ORDER: ' + orderId + ' (' + clientConfig.name + ')',
    'Contact: ' + customer.name + ' <' + customer.email + '>' + (customer.phone ? ' · ' + customer.phone : ''),
    customer.company ? 'Company: ' + customer.company : null,
    payload.deliveryAddress ? 'Delivery: ' + payload.deliveryAddress : null,
    payload.eventDetails ? 'Notes: ' + payload.eventDetails : null,
    'Items requested: ' + payload.items.map(i =>
      (i.quantity || 1) + '× ' + (i.productName || i.productId)).join(', ')
  ].filter(Boolean).join('\n');

  const columnValues = {
    text:                customer.name,
    text4:               clientConfig.name,                       // Account = client company name
    text5:               'Asset Deployment — ' + clientConfig.short_name,
    text2:               deliveryDateText,
    long_text8:          payload.deliveryAddress || '',
    long_text:           description,
    text20:              wbs,
    color_mm1wxn5k:      { label: 'Delivery' },
    color:               { label: 'INTAKE' }
  };

  const mutation = 'mutation ($name: String!, $cols: JSON!) { ' +
    'create_item (board_id: ' + ((clientConfig.monday && clientConfig.monday.ops_board) || OPS_BOARD_ID) + ', item_name: $name, column_values: $cols) { id } }';

  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': mondayToken,
      'API-Version': '2023-04'
    },
    body: JSON.stringify({
      query: mutation,
      variables: { name: itemName, cols: JSON.stringify(columnValues) }
    })
  });
  const j = await res.json();
  if (j.errors) throw new Error('Monday error: ' + JSON.stringify(j.errors));
  return j.data && j.data.create_item && j.data.create_item.id;
}

// ─────────────────────────────────────────────────────────────────────────
// Email rendering (HANDS-branded, references the client by name)
// ─────────────────────────────────────────────────────────────────────────

function renderInternalEmail(clientConfig, customer, orderId, mondayItemId, payload) {
  const wbsPrefix = (clientConfig.monday && clientConfig.monday.wbs_prefix) || clientConfig.short_name;
  const reference = wbsPrefix + '-' + orderId;
  const itemRows = payload.items.map(i =>
    '<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">' +
    (i.quantity || 1) + '× ' + (i.productName || i.productId) +
    '</td></tr>'
  ).join('');

  return (
    '<div style="font-family:DM Sans,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#1a1a1a">' +
      '<div style="background:#1a1a1a;color:#fff;padding:24px 28px;border-bottom:3px solid #a0d6b4">' +
        '<div style="font-family:DM Mono,monospace;font-size:10px;color:#a0d6b4;letter-spacing:.18em;text-transform:uppercase;margin-bottom:6px">' + clientConfig.name + ' · Asset Deployment</div>' +
        '<div style="font-family:Cormorant Garamond,Georgia,serif;font-size:28px;letter-spacing:.5px">New Deployment Request</div>' +
        '<div style="font-family:DM Mono,monospace;font-size:11px;color:rgba(255,255,255,.6);letter-spacing:.12em;margin-top:6px">Reference ' + reference + '</div>' +
      '</div>' +
      '<div style="padding:24px 28px">' +
        '<table style="width:100%;font-size:13px;line-height:1.6">' +
          '<tr><td style="color:#666;width:120px">Client</td><td><strong>' + customer.name + '</strong></td></tr>' +
          (customer.company ? '<tr><td style="color:#666">Company</td><td>' + customer.company + '</td></tr>' : '') +
          '<tr><td style="color:#666">Account</td><td>' + clientConfig.name + '</td></tr>' +
          '<tr><td style="color:#666">Email</td><td><a href="mailto:' + customer.email + '" style="color:#1a1a1a">' + customer.email + '</a></td></tr>' +
          (customer.phone ? '<tr><td style="color:#666">Phone</td><td>' + customer.phone + '</td></tr>' : '') +
          '<tr><td style="color:#666">Dates</td><td>' + payload.startDate.slice(0,10) + ' → ' + payload.endDate.slice(0,10) + '</td></tr>' +
          (payload.deliveryAddress ? '<tr><td style="color:#666;vertical-align:top">Delivery</td><td>' + payload.deliveryAddress + '</td></tr>' : '') +
          (payload.eventDetails ? '<tr><td style="color:#666;vertical-align:top">Notes</td><td>' + payload.eventDetails + '</td></tr>' : '') +
        '</table>' +
        '<div style="margin:20px 0 8px;font-family:DM Mono,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#666">Assets Requested</div>' +
        '<table style="width:100%;font-size:13px;border:1px solid #eee">' + itemRows + '</table>' +
        '<div style="margin-top:24px">' +
          '<a href="https://' + clientConfig.booqable_subdomain + '.booqable.com/orders/' + orderId + '" style="background:#a0d6b4;color:#1a1a1a;padding:10px 18px;text-decoration:none;font-family:DM Mono,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;border-radius:2px;margin-right:8px;display:inline-block">Open in Booqable</a>' +
          (mondayItemId ? '<a href="https://handslogistics.monday.com/boards/' + OPS_BOARD_ID + '/pulses/' + mondayItemId + '" style="background:#1a1a1a;color:#fff;padding:10px 18px;text-decoration:none;font-family:DM Mono,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;border-radius:2px;display:inline-block">Open in monday</a>' : '') +
        '</div>' +
      '</div>' +
      '<div style="background:#f8f7f4;padding:14px 28px;font-family:DM Mono,monospace;font-size:10px;color:#888;letter-spacing:.1em;text-align:center;text-transform:uppercase">' +
        'HANDS Logistics · Las Vegas · ops.handslogistics.com' +
      '</div>' +
    '</div>'
  );
}

function renderClientEmail(clientConfig, customer, orderId, payload) {
  const wbsPrefix = (clientConfig.monday && clientConfig.monday.wbs_prefix) || clientConfig.short_name;
  const reference = wbsPrefix + '-' + orderId;
  const itemRows = payload.items.map(i =>
    '<tr><td style="padding:6px 0;border-bottom:1px solid #eee">' +
    (i.quantity || 1) + '× ' + (i.productName || i.productId) +
    '</td></tr>'
  ).join('');

  return (
    '<div style="font-family:DM Sans,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#1a1a1a">' +
      '<div style="background:#1a1a1a;color:#fff;padding:32px 28px;border-bottom:3px solid #a0d6b4;text-align:center">' +
        '<div style="font-family:DM Mono,monospace;font-size:10px;color:#a0d6b4;letter-spacing:.2em;text-transform:uppercase;margin-bottom:10px">' + clientConfig.name + '</div>' +
        '<div style="font-family:Cormorant Garamond,Georgia,serif;font-size:32px;letter-spacing:.5px">Request Received</div>' +
        '<div style="font-family:DM Mono,monospace;font-size:11px;color:rgba(255,255,255,.6);letter-spacing:.12em;text-transform:uppercase;margin-top:8px">Reference ' + reference + '</div>' +
      '</div>' +
      '<div style="padding:28px">' +
        '<p style="font-size:15px;line-height:1.6;margin:0 0 16px">Hi ' + customer.name.split(' ')[0] + ',</p>' +
        '<p style="font-size:14px;line-height:1.7;margin:0 0 20px;color:#444">Thanks for the request. We\'ve received your asset deployment request and our team will be in touch within one business day to confirm logistics and timing.</p>' +
        '<div style="background:#f8f7f4;border-left:3px solid #a0d6b4;padding:16px 20px;margin:20px 0">' +
          '<div style="font-family:DM Mono,monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#666;margin-bottom:8px">Your Request</div>' +
          '<div style="font-size:13px;color:#444">Dates: <strong>' + payload.startDate.slice(0,10) + ' → ' + payload.endDate.slice(0,10) + '</strong></div>' +
          '<table style="width:100%;font-size:13px;margin-top:8px">' + itemRows + '</table>' +
        '</div>' +
        '<p style="font-size:13px;line-height:1.6;color:#666;margin:16px 0 0">Track your request anytime at <a href="https://ops.handslogistics.com/clients/' + clientConfig.slug + '/track" style="color:#3f8c63">ops.handslogistics.com/clients/' + clientConfig.slug + '/track</a> using reference <strong>' + reference + '</strong> and this email address.</p>' +
      '</div>' +
      '<div style="background:#1a1a1a;color:#a0d6b4;padding:20px 28px;text-align:center">' +
        '<div style="font-family:Cormorant Garamond,Georgia,serif;font-size:20px;letter-spacing:.3px">Events and Production. In Better HANDS.</div>' +
        '<div style="font-family:DM Mono,monospace;font-size:9px;color:#888;letter-spacing:.12em;text-transform:uppercase;margin-top:8px">Brand Activations · Supply Chain · Concierge Logistics</div>' +
      '</div>' +
    '</div>'
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Resend send helpers
// ─────────────────────────────────────────────────────────────────────────

async function sendEmail(resendKey, to, subject, html, replyTo) {
  const body = {
    from: FROM_EMAIL,
    to: Array.isArray(to) ? to : [to],
    subject: subject,
    html: html
  };
  if (replyTo) body.reply_to = replyTo;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Resend failed: ' + res.status + ' ' + t.slice(0, 200));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  // 1. Resolve the client
  const slug = payload.slug;
  if (!slugValid(slug)) {
    return jsonResponse(400, { error: 'Missing or invalid slug' });
  }
  const clientConfig = CLIENTS[slug];
  if (!clientConfig) {
    return jsonResponse(404, { error: 'Unknown client: ' + slug });
  }

  // 2. Validate the request body
  const customer = payload.customer || {};
  if (!customer.name || !customer.email)              return jsonResponse(400, { error: 'customer.name and customer.email required' });
  if (!payload.startDate || !payload.endDate)         return jsonResponse(400, { error: 'startDate and endDate required (ISO 8601)' });
  if (!Array.isArray(payload.items) || !payload.items.length) return jsonResponse(400, { error: 'items array required' });

  // 3. Pull credentials
  const BOOQABLE_TOKEN = process.env[clientConfig.booqable_env_var];
  const MONDAY_TOKEN   = process.env.MONDAY_TOKEN;
  const RESEND_KEY     = process.env.RESEND_KEY;
  if (!BOOQABLE_TOKEN) {
    return jsonResponse(500, { error: 'Booqable env var not configured: ' + clientConfig.booqable_env_var });
  }
  const booqableBase = 'https://' + clientConfig.booqable_subdomain + '.booqable.com/api/4';

  let customerId, orderId, mondayItemId;
  const wbsPrefix = (clientConfig.monday && clientConfig.monday.wbs_prefix) || clientConfig.short_name;

  // 4. Find or create the Booqable customer
  try {
    customerId = await getOrCreateCustomer(BOOQABLE_TOKEN, booqableBase, customer);
    if (!customerId) throw new Error('No customer ID returned');
  } catch (err) {
    return jsonResponse(500, { error: 'Customer step failed: ' + err.message });
  }

  // 5. Create the Booqable order
  try {
    orderId = await createOrder(BOOQABLE_TOKEN, booqableBase, customerId, payload);
  } catch (err) {
    return jsonResponse(500, { error: 'Order creation failed: ' + err.message });
  }

  // 6. Mirror to monday.com (non-fatal — proceed even if it fails)
  if (MONDAY_TOKEN) {
    try {
      mondayItemId = await createMondayItem(MONDAY_TOKEN, clientConfig, customer, orderId, payload);
    } catch (err) {
      console.error('Monday mirror failed (non-fatal): ' + err.message);
    }
  }

  // 7. Notify HANDS team (non-fatal)
  if (RESEND_KEY) {
    const internalHtml = renderInternalEmail(clientConfig, customer, orderId, mondayItemId, payload);
    const notifyTo = (clientConfig.notify_emails && clientConfig.notify_emails.length) ? clientConfig.notify_emails : [NOTIFY_FALLBACK];
    try {
      await sendEmail(RESEND_KEY, notifyTo,
        'New deployment request — ' + clientConfig.short_name + ' · ' + (customer.company || customer.name) + ' (' + wbsPrefix + '-' + orderId + ')',
        internalHtml,
        customer.email);
    } catch (err) {
      console.error('Notify email failed (non-fatal): ' + err.message);
    }

    // 8. Confirm to client (non-fatal, async)
    const clientHtml = renderClientEmail(clientConfig, customer, orderId, payload);
    sendEmail(RESEND_KEY, [customer.email],
      'We\'ve received your request — ' + clientConfig.name,
      clientHtml).catch(err => {
        console.error('Client confirmation email failed: ' + err.message);
      });
  }

  return jsonResponse(200, {
    success: true,
    orderId: orderId,
    reference: wbsPrefix + '-' + orderId,
    mondayItemId: mondayItemId || null,
    slug: slug
  });
};
