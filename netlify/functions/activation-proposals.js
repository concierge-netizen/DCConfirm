// ───────────────────────────────────────────────────────────────
// HANDS Logistics — Activation Proposals API
// Handles: save / load / list / accept / changes
// Persistence: Netlify Blobs
// On accept: creates or updates an Ops Board item with all 4 schedule
// dates, status="Approved", Activity Type="Activation"
// ───────────────────────────────────────────────────────────────
//
// Routes (all POST, action in body):
//   action=save              → save proposal, returns slug (admin only)
//   action=load  + slug      → fetch proposal data (public)
//   action=list              → list all proposals (admin only)
//   action=accept + slug     → mark accepted, write to Ops Board, email Jon
//   action=changes + slug    → send change request, email Jon
//
// Env vars:
//   RESEND_KEY            — for notification emails to Jon
//   ADMIN_PASSWORD        — for save/list (or fallback to hardcoded HANDS2026)
//   MONDAY_TOKEN          — for Ops Board write-back on accept
// ───────────────────────────────────────────────────────────────

// Lazy-require so an import failure produces a clean 500 with details
// (rather than a top-of-module crash that causes a generic 502).
let _blobs = null;
function getBlobsStore(name) {
  if (!_blobs) {
    try {
      _blobs = require('@netlify/blobs');
    } catch (e) {
      throw new Error('@netlify/blobs not installed: ' + e.message);
    }
  }
  // Newer @netlify/blobs auto-detects Netlify environment. If that fails,
  // fall back to explicit config from env vars (which Netlify always sets).
  try {
    return _blobs.getStore(name);
  } catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) {
      return _blobs.getStore({ name, siteID, token });
    }
    throw new Error('getStore failed (auto-detect + explicit config both failed): ' + e.message);
  }
}

const FROM_ADDRESS  = 'HANDS Logistics <concierge@handslogistics.com>';
const JON_EMAIL     = 'concierge@handslogistics.com';
const OPS_BOARD     = '4550650855';
const ACTIVATION_GROUP_ID = 'topics'; // default Ops Board group for new activations

// Ops Board column IDs (verified via get_board_info)
const COL = {
  client:        'text',           // Client name
  account:       'text4',          // Account
  project:       'text5',          // Project Name
  deliveryDate:  'text2',          // Delivery Date (plain text MMM D, YYYY uppercase)
  deliveryTime:  'text9',          // Delivery Time
  address:       'long_text8',     // Delivery Address
  notes:         'long_text',      // Description
  logisticsStatus: 'color',        // LOGISTICS STATUS (status column)
  projectStatus: 'status',         // PROJECT STATUS (status column)
  billingStatus: 'status2',        // BILLING STATUS (status column)
  activityType:  'color_mm1wxn5k', // Activity Type (status)
  clientEmail:   'client_email1',  // Email column
  // Time columns (hour-only, format HH:MM)
  startHour:     'start',          // Load-in start time (hour column)
  strikeHour:    'strike',         // Strike start time (hour column) — kept as event-end time
  // New datetime columns (created earlier in this build)
  eventStart:    'date_mm2sv91q',  // Event Start (Live)
  eventEnd:      'date_mm2s7tq2',  // Event End (Live)
  // Activation Time Frame (timeline column)
  timeframe:     'timerange'       // Spans load-in start → strike end (the outer crew window)
};

const TAX_RATE = 0.08375;

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action } = payload;

  // Get blob store with detailed error reporting if it fails
  let store;
  try {
    store = getBlobsStore('activation-proposals');
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Blob store unavailable',
        detail: e.message,
        hint: 'Check that @netlify/blobs installed correctly. If this persists, verify package.json was deployed and trigger a "Clear cache and deploy site" from Netlify dashboard.'
      })
    };
  }

  try {
    if (action === 'save')    return await handleSave(payload, store, headers);
    if (action === 'load')    return await handleLoad(payload, store, headers);
    if (action === 'list')    return await handleList(payload, store, headers);
    if (action === 'accept')  return await handleAccept(payload, store, headers);
    if (action === 'changes') return await handleChanges(payload, store, headers);
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
  } catch (err) {
    console.error('activation-proposals error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: err.message || 'Server error',
        stack: err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : undefined
      })
    };
  }
};

// ── Auth ──
// Internal tool: auth gate is disabled by default. We only enforce the
// password if (a) the request supplies one AND (b) ADMIN_PASSWORD is set
// in the env. Otherwise calls proceed. The hub PIN gate at /hub guards
// upstream access; the public proposal view (/activation-proposal/<slug>)
// is intentionally unauthenticated since the slug acts as the access token.
function checkAdmin(password) {
  // No password supplied → allow (internal tool, hub PIN already gates).
  if (!password) return true;
  // Password supplied → must match ADMIN_PASSWORD if set.
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return true; // no env-configured password → accept anything
  return password === expected;
}

function getSiteUrl() {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://ops.handslogistics.com';
}

function makeSlug(client, projectName) {
  const base = ((projectName || client || 'activation') + '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 36);
  const stamp = Date.now().toString(36).slice(-5);
  return `${base}-${stamp}`;
}

// ── Totals ──
function calcTotals(proposal) {
  const items = proposal.lineItems || [];
  const subtotal = items.reduce((s, it) => s + ((it.qty || 0) * (it.unitPrice || 0)), 0);
  const tax = proposal.includeTax ? subtotal * TAX_RATE : 0;
  const total = subtotal + tax;
  return { subtotal, tax, total };
}

// ── SAVE ──
async function handleSave(payload, store, headers) {
  const { password, proposal } = payload;
  if (!checkAdmin(password)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!proposal || !proposal.client) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing proposal data' }) };
  }

  const slug = proposal.slug || makeSlug(proposal.client, proposal.projectName);
  const now = new Date().toISOString();

  const record = {
    slug,
    client:         proposal.client || '',
    contact:        proposal.contact || '',
    email:          proposal.email || '',
    proposalDate:   proposal.proposalDate || '',
    projectName:    proposal.projectName || '',
    opsItemId:      proposal.opsItemId || '',
    venueName:      proposal.venueName || '',
    venueAddress:   proposal.venueAddress || '',
    schedule:       proposal.schedule || {},
    scopeOfWork:    proposal.scopeOfWork || '',
    lineItems:      proposal.lineItems || [],
    includeTax:     !!proposal.includeTax,
    paymentTerms:   proposal.paymentTerms || '',
    customNotes:    proposal.customNotes || '',
    // ── Reserved for future deck render (Phase: PDF deck via puppeteer) ──
    // These slots are saved on every record so when we add deck UI later we
    // don't need a data migration. Empty defaults are intentional.
    brandColor:     proposal.brandColor || '',          // single hex e.g. "#0a3a5e"; palette auto-generated
    designSlides:   Array.isArray(proposal.designSlides)  ? proposal.designSlides  : [],  // [{ imageUrl, caption }]
    deliverables:   Array.isArray(proposal.deliverables)  ? proposal.deliverables  : [],  // [{ title, schematicUrl, dimensions, notes, window }]
    sourcingItems:  Array.isArray(proposal.sourcingItems) ? proposal.sourcingItems : [],  // [{ name, vendor, photoUrl, qty, leadTime, notes }]
    deckTemplate:   proposal.deckTemplate || 'brand-event',  // future: which template to render with
    // ── End reserved fields ──
    createdAt:      proposal.createdAt || now,
    updatedAt:      now,
    status:         proposal.status || 'sent'
  };

  await store.setJSON(slug, record);
  return { statusCode: 200, headers, body: JSON.stringify({ success: true, slug, proposal: record }) };
}

// ── LOAD (public) ──
async function handleLoad(payload, store, headers) {
  const { slug } = payload;
  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };
  const record = await store.get(slug, { type: 'json' });
  if (!record) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Proposal not found' }) };
  return { statusCode: 200, headers, body: JSON.stringify({ success: true, proposal: record }) };
}

// ── LIST (admin) ──
async function handleList(payload, store, headers) {
  if (!checkAdmin(payload.password)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  const { blobs } = await store.list();
  const proposals = [];
  for (const blob of blobs) {
    const record = await store.get(blob.key, { type: 'json' });
    if (record) proposals.push(record);
  }
  proposals.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { statusCode: 200, headers, body: JSON.stringify({ success: true, proposals }) };
}

// ── ACCEPT ──
async function handleAccept(payload, store, headers) {
  const { slug } = payload;
  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };

  const record = await store.get(slug, { type: 'json' });
  if (!record) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

  // Idempotency — if already accepted, no-op
  if (record.status === 'accepted') {
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, alreadyAccepted: true }) };
  }

  record.status = 'accepted';
  record.acceptedAt = new Date().toISOString();

  // Write to Monday — create new Ops item or update existing
  let mondayResult = { skipped: true };
  if (process.env.MONDAY_TOKEN) {
    try {
      mondayResult = await pushToMonday(record);
      record.opsItemId = mondayResult.itemId || record.opsItemId;
    } catch (e) {
      console.error('Monday write failed:', e);
      mondayResult = { error: e.message };
    }
  }

  await store.setJSON(slug, record);

  // Notify Jon
  await sendNotification({
    subject: `✓ ACCEPTED — ${record.client} · ${record.projectName || ''}`,
    body: buildAcceptNotification(record, mondayResult)
  });

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, monday: mondayResult }) };
}

// ── CHANGES REQUESTED ──
async function handleChanges(payload, store, headers) {
  const { slug, notes } = payload;
  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };

  const record = await store.get(slug, { type: 'json' });
  if (!record) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

  record.status = 'changes_requested';
  record.lastChangeRequest = {
    at: new Date().toISOString(),
    notes: notes || ''
  };
  await store.setJSON(slug, record);

  // If linked to an Ops item, post the change request as a Monday update too
  if (record.opsItemId && process.env.MONDAY_TOKEN) {
    try {
      const updateBody = `🔄 Client requested changes on activation proposal:\n\n${notes || '(no notes)'}\n\nProposal: ${getSiteUrl()}/activation-proposal/${record.slug}`;
      await mondayQuery(`mutation { create_update(item_id:${record.opsItemId}, body:${JSON.stringify(updateBody)}) { id } }`);
    } catch (e) {
      console.error('Monday update post failed:', e);
    }
  }

  await sendNotification({
    subject: `↩ CHANGES REQUESTED — ${record.client} · ${record.projectName || ''}`,
    body: buildChangeRequestNotification(record, notes)
  });

  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
}

// ─────────────────────────────────────────────────────────────
// MONDAY HELPERS
// ─────────────────────────────────────────────────────────────
async function mondayQuery(query) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': process.env.MONDAY_TOKEN,
      'API-Version': '2023-04'
    },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Monday HTTP ' + res.status + ': ' + JSON.stringify(data).slice(0, 400));
  if (data.errors && data.errors.length) {
    throw new Error('Monday: ' + data.errors.map(e => e.message).join(' | '));
  }
  return data;
}

// Build a Monday text2 string (uppercase month-day-year) from YYYY-MM-DD
function isoToText2(iso) {
  if (!iso) return '';
  const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${months[m-1]} ${d}, ${y}`;
}

// Push proposal to Ops Board — create or update.
// Status flow on Accept:
//   LOGISTICS STATUS → "Setup Scheduled" (label exists)
//   BILLING STATUS   → "ESTIMATE APPROVED" (label exists)
//   ACTIVITY TYPE    → "Activation"
async function pushToMonday(record) {
  const sch = record.schedule || {};
  const totals = calcTotals(record);

  const cols = {};

  // Status fields
  cols[COL.logisticsStatus] = { label: 'Setup Scheduled' };
  cols[COL.billingStatus]   = { label: 'ESTIMATE APPROVED' };
  cols[COL.activityType]    = { label: 'Activation' };

  // Identity
  if (record.client)      cols[COL.client]    = record.client;
  if (record.client)      cols[COL.account]   = record.client; // account = client by default
  if (record.projectName) cols[COL.project]   = record.projectName;
  if (record.email)       cols[COL.clientEmail] = { email: record.email, text: record.email };

  // Delivery Date / Time mirror event start (the live window's start, not load-in)
  if (sch.eventStartDate) cols[COL.deliveryDate] = isoToText2(sch.eventStartDate);
  if (sch.eventStartTime) cols[COL.deliveryTime] = formatTimeAmPm(sch.eventStartTime);

  // Address
  if (record.venueAddress || record.venueName) {
    cols[COL.address] = { text: [record.venueName, record.venueAddress].filter(Boolean).join(' — ') };
  }

  // Notes — proposal link + scope of work
  const noteText = `Activation proposal accepted: ${record.slug}\n` +
                   `Total: $${totals.total.toFixed(2)}${record.includeTax ? ' (incl. NV tax)' : ''}\n` +
                   `Proposal: ${getSiteUrl()}/activation-proposal/${record.slug}\n\n` +
                   (record.scopeOfWork || '');
  cols[COL.notes] = { text: noteText.slice(0, 1900) }; // long_text has limits

  // Hour columns (start = load-in time, strike = strike-end time)
  // Format: { hour: H, minute: M } where both are integers in 24-hour
  if (sch.loadinTime) {
    const [h, m] = sch.loadinTime.split(':').map(Number);
    cols[COL.startHour] = { hour: h, minute: m || 0 };
  }
  if (sch.strikeTime) {
    const [h, m] = sch.strikeTime.split(':').map(Number);
    cols[COL.strikeHour] = { hour: h, minute: m || 0 };
  }

  // New datetime columns — Event Start / Event End (the inner LIVE window)
  // Format: { date: "YYYY-MM-DD", time: "HH:MM:SS" }
  if (sch.eventStartDate) {
    const v = { date: sch.eventStartDate };
    if (sch.eventStartTime) v.time = sch.eventStartTime + ':00';
    cols[COL.eventStart] = v;
  }
  if (sch.eventEndDate) {
    const v = { date: sch.eventEndDate };
    if (sch.eventEndTime) v.time = sch.eventEndTime + ':00';
    cols[COL.eventEnd] = v;
  }

  // Activation Time Frame (timeline) — full crew window: load-in date → strike date
  if (sch.loadinDate && sch.strikeDate) {
    cols[COL.timeframe] = {
      from: sch.loadinDate,
      to:   sch.strikeDate
    };
  }

  // Triple-stringify for column_values argument
  const updates = JSON.stringify(JSON.stringify(cols));

  let itemId = record.opsItemId;
  if (itemId) {
    // UPDATE existing item
    const m = `mutation { change_multiple_column_values(item_id:${itemId}, board_id:${OPS_BOARD}, column_values:${updates}) { id } }`;
    await mondayQuery(m);
    const noteBody = `✓ Activation proposal accepted. View: ${getSiteUrl()}/activation-proposal/${record.slug}`;
    try { await mondayQuery(`mutation { create_update(item_id:${itemId}, body:${JSON.stringify(noteBody)}) { id } }`); } catch (_) {}
    return { itemId, action: 'updated' };
  }

  // CREATE new item in Unconfirmed group (intake group)
  const itemName = record.projectName || `${record.client} — Activation`;
  const m = `mutation { create_item(board_id:${OPS_BOARD}, group_id:"new_group84798", item_name:${JSON.stringify(itemName)}, column_values:${updates}) { id } }`;
  const data = await mondayQuery(m);
  itemId = data.data.create_item.id;
  const noteBody = `Created from accepted activation proposal: ${getSiteUrl()}/activation-proposal/${record.slug}`;
  try { await mondayQuery(`mutation { create_update(item_id:${itemId}, body:${JSON.stringify(noteBody)}) { id } }`); } catch (_) {}
  return { itemId, action: 'created' };
}

// Format "HH:MM" → "H:MM AM/PM" for delivery time column
function formatTimeAmPm(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = h === 0 ? 12 : (h > 12 ? h - 12 : h);
  return `${hh}:${String(m || 0).padStart(2,'0')} ${period}`;
}

// ─────────────────────────────────────────────────────────────
// EMAIL NOTIFICATIONS
// ─────────────────────────────────────────────────────────────
async function sendNotification({ subject, body }) {
  const apiKey = process.env.RESEND_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_KEY not set — skipping notification');
    return;
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [JON_EMAIL],
        subject,
        text: body,
        html: `<pre style="font-family: -apple-system, sans-serif; white-space: pre-wrap; font-size: 14px; line-height: 1.6;">${escapeHtml(body)}</pre>`
      })
    });
  } catch (e) {
    console.error('Notification send failed:', e);
  }
}

function buildAcceptNotification(record, mondayResult) {
  const url = `${getSiteUrl()}/activation-proposal/${record.slug}`;
  const totals = calcTotals(record);
  let body = `Activation proposal accepted!\n\n`;
  body += `Client:   ${record.client}\n`;
  body += `Project:  ${record.projectName || '(none)'}\n`;
  body += `Contact:  ${record.contact || '(not provided)'}\n`;
  body += `Email:    ${record.email || '(not provided)'}\n`;
  body += `Total:    $${totals.total.toFixed(2)}${record.includeTax ? ' (incl. NV tax)' : ''}\n`;
  body += `Slug:     ${record.slug}\n`;
  body += `Accepted: ${record.acceptedAt}\n\n`;

  const sch = record.schedule || {};
  if (sch.eventStartDate) {
    body += `Event:    ${sch.eventStartDate} ${sch.eventStartTime || ''}\n`;
    body += `Venue:    ${record.venueName || ''} ${record.venueAddress || ''}\n\n`;
  }

  body += `View:  ${url}\n`;

  if (mondayResult && mondayResult.itemId) {
    body += `Monday Ops Board: PO #${mondayResult.itemId} (${mondayResult.action})\n`;
  } else if (mondayResult && mondayResult.error) {
    body += `\nMonday write failed: ${mondayResult.error}\n(You'll need to log this manually.)\n`;
  }

  body += `\nNext: send PayPal invoice for the deposit.`;
  return body;
}

function buildChangeRequestNotification(record, notes) {
  const url = `${getSiteUrl()}/activation-proposal/${record.slug}`;
  let body = `${record.client} requested changes to their activation proposal.\n\n`;
  body += `Client:   ${record.client}\n`;
  body += `Project:  ${record.projectName || '(none)'}\n`;
  body += `Contact:  ${record.contact || '(not provided)'}\n`;
  body += `Email:    ${record.email || '(not provided)'}\n`;
  body += `Slug:     ${record.slug}\n\n`;
  body += `Their notes:\n`;
  body += `────────────────────────\n`;
  body += `${notes || '(no notes provided)'}\n`;
  body += `────────────────────────\n\n`;
  body += `View:  ${url}\n`;
  return body;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
