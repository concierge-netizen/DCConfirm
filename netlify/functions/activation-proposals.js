// ───────────────────────────────────────────────────────────────
// HANDS Logistics — Activation Proposals API (Monday-backed)
// Handles: save / load / list / accept / changes
//
// Storage: Monday Ops Board (4550650855) — proposal JSON lives in a
// long_text column on each item. Slug lives in a text column for lookup.
// Items land in the "Unconfirmed" group at status "Proposal Submitted"
// when saved. On accept: status → "Setup Scheduled" + Billing → "ESTIMATE
// APPROVED". On changes: status → "INFORMATION NEEDED" + change notes
// posted as a Monday update.
//
// Why Monday-native: simpler infrastructure, no @netlify/blobs dependency,
// proposals visible in Monday immediately, single source of truth.
// ───────────────────────────────────────────────────────────────

const FROM_ADDRESS  = 'HANDS Logistics <concierge@handslogistics.com>';
const JON_EMAIL     = 'concierge@handslogistics.com';
const OPS_BOARD     = '4550650855';
const PROPOSAL_GROUP_ID = 'new_group84798'; // Unconfirmed group — proposals land here until accepted

const TAX_RATE = 0.08375;

// Ops Board column IDs (verified via get_board_info)
const COL = {
  client:           'text',
  account:          'text4',
  project:          'text5',
  deliveryDate:     'text2',
  deliveryTime:     'text9',
  address:          'long_text8',
  notes:            'long_text',
  logisticsStatus:  'color',
  projectStatus:    'status',
  billingStatus:    'status2',
  activityType:     'color_mm1wxn5k',
  clientEmail:      'client_email1',
  startHour:        'start',
  strikeHour:       'strike',
  eventStart:       'date_mm2sv91q',
  eventEnd:         'date_mm2s7tq2',
  timeframe:        'timerange',
  // Storage columns (created in this build)
  proposalData:     'long_text_mm2sscgy',
  proposalSlug:     'text_mm2sp5ek'
};

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  if (!process.env.MONDAY_TOKEN) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'MONDAY_TOKEN not configured in Netlify env vars' })
    };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action } = payload;

  try {
    if (action === 'save')    return await handleSave(payload, headers);
    if (action === 'load')    return await handleLoad(payload, headers);
    if (action === 'list')    return await handleList(payload, headers);
    if (action === 'accept')  return await handleAccept(payload, headers);
    if (action === 'changes') return await handleChanges(payload, headers);
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
  } catch (err) {
    console.error('activation-proposals error:', err);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({
        error: err.message || 'Server error',
        stack: err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : undefined
      })
    };
  }
};

// ── Auth (permissive — internal tool, hub PIN gates upstream) ──
function checkAdmin(password) {
  if (!password) return true;
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return true;
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

function calcTotals(proposal) {
  const items = proposal.lineItems || [];
  const subtotal = items.reduce((s, it) => s + ((it.qty || 0) * (it.unitPrice || 0)), 0);
  const tax = proposal.includeTax ? subtotal * TAX_RATE : 0;
  return { subtotal, tax, total: subtotal + tax };
}

// ─────────────────────────────────────────────────────────────
// MONDAY API
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

// Find an item by its slug column value
async function findItemBySlug(slug) {
  const safeSlug = String(slug).replace(/"/g, '');
  const q = `query {
    items_page_by_column_values(
      board_id: ${OPS_BOARD},
      columns: [{column_id: "${COL.proposalSlug}", column_values: ["${safeSlug}"]}],
      limit: 5
    ) {
      items {
        id
        name
        column_values { id text value }
      }
    }
  }`;
  const data = await mondayQuery(q);
  const items = data.data.items_page_by_column_values?.items || [];
  return items[0] || null;
}

function itemToProposal(item) {
  if (!item) return null;
  const cols = {};
  (item.column_values || []).forEach(c => { cols[c.id] = c; });

  const rawJson = cols[COL.proposalData]?.text || '';
  let proposal = {};
  if (rawJson) {
    try { proposal = JSON.parse(rawJson); }
    catch (e) { console.warn('Failed to parse proposal JSON for item', item.id, e.message); }
  }

  proposal.opsItemId = item.id;
  proposal.slug = proposal.slug || (cols[COL.proposalSlug]?.text || '');
  proposal.client = proposal.client || (cols[COL.client]?.text || '');
  proposal.projectName = proposal.projectName || (cols[COL.project]?.text || item.name || '');

  return proposal;
}

function buildColumnValues(record, statusOverrides) {
  const sch = record.schedule || {};
  const totals = calcTotals(record);
  const cols = {};

  if (record.client)       cols[COL.client]    = record.client;
  if (record.client)       cols[COL.account]   = record.client;
  if (record.projectName)  cols[COL.project]   = record.projectName;
  if (record.email)        cols[COL.clientEmail] = { email: record.email, text: record.email };

  cols[COL.activityType] = { label: 'Activation' };
  if (statusOverrides) {
    if (statusOverrides.logistics) cols[COL.logisticsStatus] = { label: statusOverrides.logistics };
    if (statusOverrides.billing)   cols[COL.billingStatus]   = { label: statusOverrides.billing };
    if (statusOverrides.project)   cols[COL.projectStatus]   = { label: statusOverrides.project };
  }

  if (sch.eventStartDate) cols[COL.deliveryDate] = isoToText2(sch.eventStartDate);
  if (sch.eventStartTime) cols[COL.deliveryTime] = formatTimeAmPm(sch.eventStartTime);

  if (record.venueAddress || record.venueName) {
    cols[COL.address] = { text: [record.venueName, record.venueAddress].filter(Boolean).join(' — ') };
  }

  if (sch.loadinTime) {
    const [h, m] = sch.loadinTime.split(':').map(Number);
    cols[COL.startHour] = { hour: h || 0, minute: m || 0 };
  }
  if (sch.strikeTime) {
    const [h, m] = sch.strikeTime.split(':').map(Number);
    cols[COL.strikeHour] = { hour: h || 0, minute: m || 0 };
  }

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

  if (sch.loadinDate && sch.strikeDate) {
    cols[COL.timeframe] = { from: sch.loadinDate, to: sch.strikeDate };
  }

  const noteText = `Activation Proposal: ${record.slug || ''}\n` +
                   `Total: $${totals.total.toFixed(2)}${record.includeTax ? ' (incl. NV tax)' : ''}\n` +
                   `Proposal: ${getSiteUrl()}/activation-proposal/${record.slug}\n\n` +
                   (record.scopeOfWork || '');
  cols[COL.notes] = { text: noteText.slice(0, 1900) };

  // Storage: full JSON blob + slug for lookup
  cols[COL.proposalData] = { text: JSON.stringify(record).slice(0, 60000) };
  cols[COL.proposalSlug] = record.slug || '';

  return cols;
}

// ─────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────

async function handleSave(payload, headers) {
  if (!checkAdmin(payload.password)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  const { proposal } = payload;
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
    brandColor:     proposal.brandColor || '',
    designSlides:   Array.isArray(proposal.designSlides)  ? proposal.designSlides  : [],
    deliverables:   Array.isArray(proposal.deliverables)  ? proposal.deliverables  : [],
    sourcingItems:  Array.isArray(proposal.sourcingItems) ? proposal.sourcingItems : [],
    deckTemplate:   proposal.deckTemplate || 'brand-event',
    createdAt:      proposal.createdAt || now,
    updatedAt:      now,
    status:         proposal.status || 'sent'
  };

  let itemId = record.opsItemId;
  if (!itemId) {
    const existing = await findItemBySlug(slug);
    if (existing) itemId = existing.id;
  }

  // Status for newly-saved or re-saved-not-yet-accepted proposals
  const statusOverrides = {
    logistics: 'Proposal Submitted',
    billing:   'ESTIMATE READY',
    project:   'PROPOSAL SUBMITTED'
  };

  // If the existing item is already accepted, don't reset it back to "Proposal Submitted"
  if (itemId && record.status === 'accepted') {
    statusOverrides.logistics = 'Setup Scheduled';
    statusOverrides.billing = 'ESTIMATE APPROVED';
    statusOverrides.project = 'IN PROGRESS';
  }

  const cols = buildColumnValues(record, statusOverrides);
  const colsStr = JSON.stringify(JSON.stringify(cols));

  if (itemId) {
    const m = `mutation { change_multiple_column_values(item_id: ${itemId}, board_id: ${OPS_BOARD}, column_values: ${colsStr}) { id } }`;
    await mondayQuery(m);
    record.opsItemId = itemId;
  } else {
    const itemName = record.projectName || `${record.client} — Activation`;
    const m = `mutation { create_item(board_id: ${OPS_BOARD}, group_id: "${PROPOSAL_GROUP_ID}", item_name: ${JSON.stringify(itemName)}, column_values: ${colsStr}) { id } }`;
    const data = await mondayQuery(m);
    itemId = data.data.create_item.id;
    record.opsItemId = itemId;
  }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, slug, proposal: record }) };
}

async function handleLoad(payload, headers) {
  const { slug } = payload;
  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };

  const item = await findItemBySlug(slug);
  if (!item) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Proposal not found' }) };

  const proposal = itemToProposal(item);
  if (!proposal) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Proposal data unreadable' }) };

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, proposal }) };
}

async function handleList(payload, headers) {
  if (!checkAdmin(payload.password)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Fetch all activation items, then filter client-side by presence of slug.
  // Using items_page with no filters is the most reliable across Monday API versions.
  const data = await mondayQuery(`query {
    boards(ids: [${OPS_BOARD}]) {
      items_page(limit: 200) {
        items {
          id name updated_at
          column_values { id text value }
        }
      }
    }
  }`);
  const allItems = data.data.boards[0]?.items_page?.items || [];

  const proposals = allItems
    .map(it => {
      const cols = {};
      it.column_values.forEach(c => { cols[c.id] = c; });
      const slug = (cols[COL.proposalSlug]?.text || '').trim();
      const isActivation = (cols[COL.activityType]?.text || '') === 'Activation';
      if (!slug || !isActivation) return null;
      const p = itemToProposal(it);
      if (p) p.updatedAt = p.updatedAt || it.updated_at;
      return p;
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, proposals }) };
}

async function handleAccept(payload, headers) {
  const { slug } = payload;
  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };

  const item = await findItemBySlug(slug);
  if (!item) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

  const record = itemToProposal(item);

  if (record.status === 'accepted') {
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, alreadyAccepted: true }) };
  }

  record.status = 'accepted';
  record.acceptedAt = new Date().toISOString();
  record.updatedAt = record.acceptedAt;

  const cols = buildColumnValues(record, {
    logistics: 'Setup Scheduled',
    billing:   'ESTIMATE APPROVED',
    project:   'IN PROGRESS'
  });
  const colsStr = JSON.stringify(JSON.stringify(cols));
  await mondayQuery(`mutation { change_multiple_column_values(item_id: ${item.id}, board_id: ${OPS_BOARD}, column_values: ${colsStr}) { id } }`);

  const updateBody = `✓ Activation proposal accepted by client. View: ${getSiteUrl()}/activation-proposal/${slug}`;
  try {
    await mondayQuery(`mutation { create_update(item_id: ${item.id}, body: ${JSON.stringify(updateBody)}) { id } }`);
  } catch (_) {}

  await sendNotification({
    subject: `✓ ACCEPTED — ${record.client} · ${record.projectName || ''}`,
    body: buildAcceptNotification(record)
  });

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, opsItemId: item.id }) };
}

async function handleChanges(payload, headers) {
  const { slug, notes } = payload;
  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };

  const item = await findItemBySlug(slug);
  if (!item) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

  const record = itemToProposal(item);
  record.status = 'changes_requested';
  record.lastChangeRequest = { at: new Date().toISOString(), notes: notes || '' };
  record.updatedAt = record.lastChangeRequest.at;

  const cols = buildColumnValues(record, {
    logistics: 'INFORMATION NEEDED',
    project:   'INFORMATION NEEDED'
  });
  const colsStr = JSON.stringify(JSON.stringify(cols));
  await mondayQuery(`mutation { change_multiple_column_values(item_id: ${item.id}, board_id: ${OPS_BOARD}, column_values: ${colsStr}) { id } }`);

  const updateBody = `🔄 Client requested changes:\n\n${notes || '(no notes)'}\n\nProposal: ${getSiteUrl()}/activation-proposal/${slug}`;
  try {
    await mondayQuery(`mutation { create_update(item_id: ${item.id}, body: ${JSON.stringify(updateBody)}) { id } }`);
  } catch (_) {}

  await sendNotification({
    subject: `↩ CHANGES REQUESTED — ${record.client} · ${record.projectName || ''}`,
    body: buildChangeRequestNotification(record, notes)
  });

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, opsItemId: item.id }) };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function isoToText2(iso) {
  if (!iso) return '';
  const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${months[m-1]} ${d}, ${y}`;
}

function formatTimeAmPm(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = h === 0 ? 12 : (h > 12 ? h - 12 : h);
  return `${hh}:${String(m || 0).padStart(2,'0')} ${period}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
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

function buildAcceptNotification(record) {
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
  if (record.opsItemId) body += `Monday: PO #${record.opsItemId}\n`;
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
  body += `Their notes:\n────────────────────────\n${notes || '(no notes provided)'}\n────────────────────────\n\n`;
  body += `View:  ${url}\n`;
  if (record.opsItemId) body += `Monday: PO #${record.opsItemId}\n`;
  return body;
}
