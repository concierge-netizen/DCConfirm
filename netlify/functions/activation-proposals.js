// ───────────────────────────────────────────────────────────────
// HANDS Logistics — Activation Proposals API (Blobs-backed)
// Handles: save / load / list / accept / changes
//
// Storage:
//   - Netlify Blobs (store: "activation-proposals", key: <slug>)
//     holds the full proposal JSON. No size limit that matters
//     (5GB per blob, 600 byte keys). Source of truth.
//   - Monday Ops Board (4550650855) item carries operational fields
//     only: slug, client, project name, dates, statuses, totals.
//     Used for board visibility, billing pipeline, and discovery.
//
// On save:    create/update Monday item → write Blob (Blob is canonical)
// On load:    read Blob by slug. Fall through to Monday if Blob missing.
// On list:    enumerate Blobs (paginated), return slug list with metadata.
// On accept:  update Blob status + Monday status, send notification.
// On changes: update Blob status + Monday status, post Monday update,
//             send notification.
// ───────────────────────────────────────────────────────────────

const { connectLambda, getStore } = require('@netlify/blobs');

const FROM_ADDRESS  = 'HANDS Logistics <concierge@handslogistics.com>';
const JON_EMAIL     = 'concierge@handslogistics.com';
const OPS_BOARD     = '4550650855';
const PROPOSAL_GROUP_ID = 'new_group84798'; // Unconfirmed group

const BLOB_STORE = 'activation-proposals';
const TAX_RATE = 0.08375;

// Ops Board column IDs
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
  proposalSlug:     'text_mm2sp5ek'   // slug column (for board-side lookup if ever needed)
  // proposalData column on Monday is no longer used — Blobs hold the JSON.
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

  // REQUIRED for Lambda-compat functions to use Blobs
  try { connectLambda(event); }
  catch (e) { console.error('connectLambda failed:', e); }

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

// ─────────────────────────────────────────────────────────────
// AUTH (permissive — internal tool, hub PIN gates upstream)
// ─────────────────────────────────────────────────────────────
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
// BLOB STORE
// ─────────────────────────────────────────────────────────────
function store() {
  return getStore({ name: BLOB_STORE, consistency: 'strong' });
}

async function readProposal(slug) {
  const s = store();
  // setJSON/getJSON would also work but explicit JSON parse gives clearer errors
  const raw = await s.get(slug, { type: 'text' });
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) {
    console.warn('Blob JSON parse failed for slug', slug, e.message);
    return null;
  }
}

async function writeProposal(slug, record) {
  const s = store();
  await s.set(slug, JSON.stringify(record));
}

async function listProposalSlugs() {
  const s = store();
  // Single-page list. Up to 1000 keys per page; we'll page through if more.
  const slugs = [];
  let cursor;
  for (let i = 0; i < 10; i++) { // hard cap to avoid runaway
    const result = await s.list(cursor ? { cursor } : undefined);
    (result.blobs || []).forEach(b => slugs.push(b.key));
    if (!result.cursor) break;
    cursor = result.cursor;
  }
  return slugs;
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
      'API-Version': '2024-01'
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

// Find a Monday item by its slug column value (only used when record.opsItemId is missing)
async function findItemBySlug(slug) {
  const safeSlug = String(slug).replace(/"/g, '');
  const q = `query {
    items_page_by_column_values(
      board_id: ${OPS_BOARD},
      columns: [{column_id: "${COL.proposalSlug}", column_values: ["${safeSlug}"]}],
      limit: 5
    ) {
      items { id }
    }
  }`;
  const data = await mondayQuery(q);
  const items = data.data.items_page_by_column_values?.items || [];
  return items[0] || null;
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

  // Operational summary in the notes column. The full proposal lives in Blobs.
  const noteText = `Activation Proposal: ${record.slug || ''}\n` +
                   `Total: $${totals.total.toFixed(2)}${record.includeTax ? ' (incl. NV tax)' : ''}\n` +
                   `Proposal: ${getSiteUrl()}/activation-proposal/${record.slug}\n\n` +
                   (record.scopeOfWork || '');
  cols[COL.notes] = { text: noteText.slice(0, 1900) };

  // Slug column — for board-side lookup if needed
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

  // Hydrate the canonical record (read existing blob if any to preserve fields like createdAt)
  let prev = null;
  try { prev = await readProposal(slug); }
  catch (e) { console.warn('readProposal threw, treating as new:', e.message); }

  const record = {
    slug,
    client:         proposal.client || (prev?.client || ''),
    contact:        proposal.contact || (prev?.contact || ''),
    email:          proposal.email || (prev?.email || ''),
    proposalDate:   proposal.proposalDate || (prev?.proposalDate || ''),
    projectName:    proposal.projectName || (prev?.projectName || ''),
    opsItemId:      proposal.opsItemId || (prev?.opsItemId || ''),
    venueName:      proposal.venueName || (prev?.venueName || ''),
    venueAddress:   proposal.venueAddress || (prev?.venueAddress || ''),
    schedule:       proposal.schedule || (prev?.schedule || {}),
    scopeOfWork:    proposal.scopeOfWork || (prev?.scopeOfWork || ''),
    lineItems:      Array.isArray(proposal.lineItems) ? proposal.lineItems : (prev?.lineItems || []),
    includeTax:     typeof proposal.includeTax === 'boolean' ? proposal.includeTax : !!prev?.includeTax,
    paymentTerms:   proposal.paymentTerms || (prev?.paymentTerms || ''),
    customNotes:    proposal.customNotes || (prev?.customNotes || ''),
    brandColor:     proposal.brandColor || (prev?.brandColor || ''),
    designSlides:   Array.isArray(proposal.designSlides)  ? proposal.designSlides  : (prev?.designSlides  || []),
    deliverables:   Array.isArray(proposal.deliverables)  ? proposal.deliverables  : (prev?.deliverables  || []),
    sourcingItems:  Array.isArray(proposal.sourcingItems) ? proposal.sourcingItems : (prev?.sourcingItems || []),
    deckTemplate:   proposal.deckTemplate || (prev?.deckTemplate || 'brand-event'),
    createdAt:      prev?.createdAt || proposal.createdAt || now,
    updatedAt:      now,
    status:         proposal.status || prev?.status || 'sent',
    acceptedAt:     prev?.acceptedAt || proposal.acceptedAt || null,
    lastChangeRequest: prev?.lastChangeRequest || null
  };

  // Resolve Monday item id (use existing if known, else search by slug)
  let itemId = record.opsItemId;
  if (!itemId) {
    const existing = await findItemBySlug(slug);
    if (existing) itemId = existing.id;
  }

  const statusOverrides = (record.status === 'accepted')
    ? { logistics: 'Setup Scheduled', billing: 'ESTIMATE APPROVED', project: 'IN PROGRESS' }
    : { logistics: 'Proposal Submitted', billing: 'ESTIMATE READY', project: 'PROPOSAL SUBMITTED' };

  const cols = buildColumnValues(record, statusOverrides);
  const colsStr = JSON.stringify(JSON.stringify(cols));

  if (itemId) {
    await mondayQuery(`mutation { change_multiple_column_values(item_id: ${itemId}, board_id: ${OPS_BOARD}, column_values: ${colsStr}) { id } }`);
  } else {
    const itemName = record.projectName || `${record.client} — Activation`;
    const data = await mondayQuery(`mutation { create_item(board_id: ${OPS_BOARD}, group_id: "${PROPOSAL_GROUP_ID}", item_name: ${JSON.stringify(itemName)}, column_values: ${colsStr}) { id } }`);
    itemId = data.data.create_item.id;
  }
  record.opsItemId = itemId;

  // Canonical write to Blobs (last so failures here don't leave Monday in a wrong state alone)
  await writeProposal(slug, record);

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, slug, proposal: record }) };
}

async function handleLoad(payload, headers) {
  const { slug } = payload;
  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };

  const proposal = await readProposal(slug);
  if (!proposal) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Proposal not found' }) };

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, proposal }) };
}

async function handleList(payload, headers) {
  if (!checkAdmin(payload.password)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const slugs = await listProposalSlugs();

  // Fetch each blob in parallel. For larger volumes (100+ proposals) we'd add an index;
  // for now this is fine.
  const proposals = await Promise.all(slugs.map(async (slug) => {
    try {
      const p = await readProposal(slug);
      if (!p) return null;
      return {
        slug: p.slug || slug,
        client: p.client || '',
        projectName: p.projectName || '',
        status: p.status || 'sent',
        updatedAt: p.updatedAt || '',
        createdAt: p.createdAt || '',
        opsItemId: p.opsItemId || '',
        // Lightweight summary fields for list views
        eventStartDate: p.schedule?.eventStartDate || '',
        total: calcTotals(p).total
      };
    } catch (e) {
      console.warn('Failed to read blob', slug, e.message);
      return null;
    }
  }));

  const filtered = proposals.filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, proposals: filtered }) };
}

async function handleAccept(payload, headers) {
  const { slug } = payload;
  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };

  const record = await readProposal(slug);
  if (!record) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

  if (record.status === 'accepted') {
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, alreadyAccepted: true }) };
  }

  record.status = 'accepted';
  record.acceptedAt = new Date().toISOString();
  record.updatedAt = record.acceptedAt;

  // Update Monday status
  if (record.opsItemId) {
    const cols = buildColumnValues(record, {
      logistics: 'Setup Scheduled',
      billing:   'ESTIMATE APPROVED',
      project:   'IN PROGRESS'
    });
    const colsStr = JSON.stringify(JSON.stringify(cols));
    try {
      await mondayQuery(`mutation { change_multiple_column_values(item_id: ${record.opsItemId}, board_id: ${OPS_BOARD}, column_values: ${colsStr}) { id } }`);
      const updateBody = `✓ Activation proposal accepted by client. View: ${getSiteUrl()}/activation-proposal/${slug}`;
      try {
        await mondayQuery(`mutation { create_update(item_id: ${record.opsItemId}, body: ${JSON.stringify(updateBody)}) { id } }`);
      } catch (_) {}
    } catch (e) {
      console.warn('Monday update on accept failed (continuing):', e.message);
    }
  }

  // Persist new state to Blob
  await writeProposal(slug, record);

  await sendNotification({
    subject: `✓ ACCEPTED — ${record.client} · ${record.projectName || ''}`,
    body: buildAcceptNotification(record)
  });

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, opsItemId: record.opsItemId || null }) };
}

async function handleChanges(payload, headers) {
  const { slug, notes } = payload;
  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };

  const record = await readProposal(slug);
  if (!record) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

  record.status = 'changes_requested';
  record.lastChangeRequest = { at: new Date().toISOString(), notes: notes || '' };
  record.updatedAt = record.lastChangeRequest.at;

  if (record.opsItemId) {
    const cols = buildColumnValues(record, {
      logistics: 'INFORMATION NEEDED',
      project:   'INFORMATION NEEDED'
    });
    const colsStr = JSON.stringify(JSON.stringify(cols));
    try {
      await mondayQuery(`mutation { change_multiple_column_values(item_id: ${record.opsItemId}, board_id: ${OPS_BOARD}, column_values: ${colsStr}) { id } }`);
      const updateBody = `🔄 Client requested changes:\n\n${notes || '(no notes)'}\n\nProposal: ${getSiteUrl()}/activation-proposal/${slug}`;
      try {
        await mondayQuery(`mutation { create_update(item_id: ${record.opsItemId}, body: ${JSON.stringify(updateBody)}) { id } }`);
      } catch (_) {}
    } catch (e) {
      console.warn('Monday update on changes failed (continuing):', e.message);
    }
  }

  await writeProposal(slug, record);

  await sendNotification({
    subject: `↩ CHANGES REQUESTED — ${record.client} · ${record.projectName || ''}`,
    body: buildChangeRequestNotification(record, notes)
  });

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, opsItemId: record.opsItemId || null }) };
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
