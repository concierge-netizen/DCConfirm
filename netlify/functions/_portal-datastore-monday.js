/**
 * _portal-datastore-monday.js
 *
 * monday.com-backed datastore for the HANDS Client Portal.
 * Implements the same 9 read functions as _portal-datastore-stub.js,
 * but pulls live data from three boards:
 *
 *   18411243307  Client Portal Registry  (email -> client_id, role)
 *   4550650855   Operations 2026         (POs / invoices / billing status)
 *   4550650927   Subitems                (line items + client comments)
 *
 * Auth model
 * ----------
 * The Registry's "Account Name" column carries a canonical client code
 * (GHOST, CAMPARI, MOET, BACARDI, WGS, ALPS, ...). For HANDS admins the
 * value is "*" — the wildcard means "see all clients". The portal-auth
 * layer interprets role from this convention; we do not depend on the
 * Role status column (which is currently unused / mislabeled).
 *
 * Billing projection
 * ------------------
 * monday's BILLING STATUS is a single-state machine on each PO. We
 * project it into three portal entities:
 *
 *   Invoice    Every PO with a non-empty BILLING STATUS becomes an
 *              invoice row. Amount = Invoice Amount, fallback to
 *              Estimate Amount. Status maps to {pending, sent, paid,
 *              partial, cancelled}.
 *   Payment    Synthesised when BILLING STATUS == "FUNDED". Date =
 *              COMPLETED ON, amount = invoice amount.
 *   Adjustment Synthesised when Invoice Amount differs from Estimate
 *              Amount (the delta), plus any PO flagged
 *              "PARTIAL BILL SUBMITTED".
 *
 * No monday writes happen here. This file is read-only.
 */

'use strict';

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2023-10';

const REGISTRY_BOARD_ID = 18411243307;
const OPS_BOARD_ID = 4550650855;
const SUBITEMS_BOARD_ID = 4550650927;

// Registry column IDs
const REG_COL_EMAIL = 'email_mm2ynca2';
const REG_COL_ACCOUNT = 'text_mm2yvg5f';   // canonical client code, "*" for admin
const REG_COL_DISPLAY = 'text_mm2ycg7j';
const REG_COL_CONTACT = 'text_mm2yr54g';

// Ops 2026 column IDs (subset we actually read)
const OPS_COL_CLIENT_CODE   = 'text_mm2y7gxz';
const OPS_COL_BILLING       = 'status2';
const OPS_COL_LOGISTICS     = 'color';
const OPS_COL_ACTIVITY      = 'color_mm1wxn5k';
const OPS_COL_INVOICE_AMT   = 'numeric_mm1weeyp';
const OPS_COL_ESTIMATE_AMT  = 'numeric_mm1wq77t';
const OPS_COL_DEADLINE      = 'date';
const OPS_COL_COMPLETED     = 'date6';
const OPS_COL_PROJECT       = 'text5';
const OPS_COL_ACCOUNT       = 'text4';
const OPS_COL_DESCRIPTION   = 'long_text';
const OPS_COL_DELIV_ADDR    = 'long_text8';
const OPS_COL_DELIV_DATE    = 'text2';
const OPS_COL_DELIV_TIME    = 'text9';
const OPS_COL_PAYPAL_ORDER  = 'text_mm2pgscy';
const OPS_COL_PAYMENT_LINK  = 'link_mm2pe3b5';
const OPS_COL_ESTIMATE_LINK = 'link_mm1wdh3';

// Subitem column IDs
const SUB_COL_CLIENT_COMMENT = 'long_text_mm2yppcg';
const SUB_COL_CLIENT_GROUP   = 'text_mm2yvd45';

// Single PayPal hosted-button link used for all invoices (Plan C, Q2=a).
// Clients enter the invoice amount on PayPal's hosted page.
const PAYPAL_HOSTED_BUTTON_URL = 'https://www.paypal.com/ncp/payment/NA9M3B6MBEACQ';

// Notifications: where client-action emails go (Plan C, Q1).
const NOTIFICATION_EMAIL = 'jon@handslogistics.com';

// Billing status -> portal status projection
const BILLING_TO_INVOICE_STATUS = {
  'ESTIMATE READY':         'pending',
  'ESTIMATE APPROVED':      'pending',
  'INVOICE PENDING':        'pending',
  'READY TO SEND':          'pending',
  'SUBMITTED':              'sent',
  'PARTIAL BILL SUBMITTED': 'partial',
  'FUNDED':                 'paid',
  'CANCELLED':              'cancelled',
  'NOT ACCEPTED':           'cancelled',
  'NOT STARTED':            'draft'
};

const ADMIN_WILDCARD = '*';

// ---------------------------------------------------------------------------
// monday transport
// ---------------------------------------------------------------------------

async function mondayQuery(query, variables) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) {
    throw new Error('MONDAY_TOKEN is not set in the environment');
  }

  const body = JSON.stringify({ query: query, variables: variables || {} });

  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
      'API-Version': MONDAY_API_VERSION
    },
    body: body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('monday HTTP ' + res.status + ': ' + text.slice(0, 500));
  }

  const json = await res.json();
  if (json.errors) {
    const msg = Array.isArray(json.errors)
      ? json.errors.map(function (e) { return typeof e === 'string' ? e : (e.message || JSON.stringify(e)); }).join('; ')
      : JSON.stringify(json.errors);
    throw new Error('monday GraphQL error: ' + msg);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Column-value helpers (defensive — every field can be null/undefined)
// ---------------------------------------------------------------------------

function colMap(item) {
  const map = {};
  const cv = (item && item.column_values) || [];
  for (let i = 0; i < cv.length; i++) {
    map[cv[i].id] = cv[i];
  }
  return map;
}

function txt(map, id) {
  const c = map[id];
  if (!c) return '';
  return (c.text == null) ? '' : String(c.text).trim();
}

function num(map, id) {
  const t = txt(map, id);
  if (!t) return 0;
  const n = Number(t.replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
}

function jsonVal(map, id) {
  const c = map[id];
  if (!c || c.value == null) return null;
  try {
    return JSON.parse(c.value);
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory caching (lambda-warm only — resets on cold start)
// Keeps a single portal session from hammering monday across N endpoint calls.
// ---------------------------------------------------------------------------

const cache = {
  registry: null,                  // { fetchedAt, items }
  posByClient: Object.create(null) // { [clientCode]: { fetchedAt, items } }
};
const REGISTRY_TTL_MS = 60 * 1000;
const POS_TTL_MS = 30 * 1000;

function fresh(entry, ttl) {
  return entry && (Date.now() - entry.fetchedAt) < ttl;
}

// ---------------------------------------------------------------------------
// Registry loaders
// ---------------------------------------------------------------------------

async function loadRegistry() {
  if (fresh(cache.registry, REGISTRY_TTL_MS)) return cache.registry.items;

  const q = `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        items_page(limit: 200) {
          items {
            id
            name
            column_values { id text value }
          }
        }
      }
    }
  `;
  const data = await mondayQuery(q, { boardId: [String(REGISTRY_BOARD_ID)] });
  const board = (data.boards && data.boards[0]) || null;
  const items = (board && board.items_page && board.items_page.items) || [];

  const out = items.map(function (it) {
    const m = colMap(it);
    const account = txt(m, REG_COL_ACCOUNT);
    // The Registry "Status" column (color_mm2y9adn) is "Done" for active rows.
    // Map "Done" -> "Active" since that's what _portal-auth.js gates on.
    const statusLabel = txt(m, 'color_mm2y9adn');
    const isActive = (statusLabel === 'Done' || statusLabel === 'Active' || statusLabel === '');
    const role = account === ADMIN_WILDCARD ? 'admin' : 'client';
    return {
      monday_item_id: it.id,
      registry_name:  it.name,
      email:          txt(m, REG_COL_EMAIL).toLowerCase(),
      client_id:      account,                                        // "*" for admins
      clientId:       account,                                        // camelCase alias for _portal-auth.js
      display_name:   txt(m, REG_COL_DISPLAY) || it.name,
      name:           txt(m, REG_COL_DISPLAY) || it.name,             // alias expected by auth
      contact_name:   txt(m, REG_COL_CONTACT),
      role:           role,
      status:         isActive ? 'Active' : 'Inactive',               // auth gates on this
      terms:          'NET 15'                                        // updated 2026-05-01: Net 15 standard across HANDS
    };
  });

  cache.registry = { fetchedAt: Date.now(), items: out };
  return out;
}

// ---------------------------------------------------------------------------
// Ops 2026 PO loader (per client)
// ---------------------------------------------------------------------------

async function loadPOsForClient(clientCode) {
  const cacheKey = clientCode.toUpperCase();
  if (fresh(cache.posByClient[cacheKey], POS_TTL_MS)) {
    return cache.posByClient[cacheKey].items;
  }

  const q = `
    query ($boardId: ID!, $code: String!) {
      items_page_by_column_values(
        board_id: $boardId
        columns: [{ column_id: "${OPS_COL_CLIENT_CODE}", column_values: [$code] }]
        limit: 500
      ) {
        items {
          id
          name
          created_at
          updated_at
          column_values { id text value }
          subitems {
            id
            name
            created_at
            column_values { id text value }
          }
        }
      }
    }
  `;
  const data = await mondayQuery(q, {
    boardId: String(OPS_BOARD_ID),
    code: cacheKey
  });
  const items = (data.items_page_by_column_values && data.items_page_by_column_values.items) || [];

  cache.posByClient[cacheKey] = { fetchedAt: Date.now(), items: items };
  return items;
}

// Helper: aggregate POs across many clients (admin views)
async function loadPOsForClients(clientCodes) {
  const all = [];
  for (let i = 0; i < clientCodes.length; i++) {
    try {
      const items = await loadPOsForClient(clientCodes[i]);
      for (let j = 0; j < items.length; j++) {
        all.push({ clientCode: clientCodes[i], po: items[j] });
      }
    } catch (e) {
      // Don't let one bad client tank the whole admin view.
      console.error('[portal-datastore] loadPOsForClient failed for ' + clientCodes[i] + ':', e.message);
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Projection: PO -> { invoice, payment, adjustments[] }
// ---------------------------------------------------------------------------

function projectPO(po, clientCode) {
  const m = colMap(po);

  const billingText = txt(m, OPS_COL_BILLING);                 // e.g. "FUNDED" or ""
  const invStatus   = BILLING_TO_INVOICE_STATUS[billingText] || (billingText ? 'unknown' : null);

  const invoiceAmt  = num(m, OPS_COL_INVOICE_AMT);
  const estimateAmt = num(m, OPS_COL_ESTIMATE_AMT);
  const amount      = invoiceAmt > 0 ? invoiceAmt : estimateAmt;

  const project     = txt(m, OPS_COL_PROJECT) || po.name;
  const account     = txt(m, OPS_COL_ACCOUNT);
  const activity    = txt(m, OPS_COL_ACTIVITY);
  const logistics   = txt(m, OPS_COL_LOGISTICS);

  const deadlineV   = jsonVal(m, OPS_COL_DEADLINE);
  const completedV  = jsonVal(m, OPS_COL_COMPLETED);
  const dueDate     = (deadlineV && deadlineV.date) || null;
  const completedOn = (completedV && completedV.date) || null;

  const paymentLink = jsonVal(m, OPS_COL_PAYMENT_LINK);
  const paymentUrl  = (paymentLink && paymentLink.url) || null;
  const estimateLink= jsonVal(m, OPS_COL_ESTIMATE_LINK);
  const estimateUrl = (estimateLink && estimateLink.url) || null;

  // Only emit an invoice if there's something to bill against.
  // (Skip POs with empty BILLING STATUS AND no estimate amount — those are
  // pre-billing operational rows, not invoices.)
  let invoice = null;
  if (billingText || invoiceAmt > 0 || estimateAmt > 0) {
    invoice = {
      id:           'INV-' + po.id,
      po_id:        po.id,
      client_id:    clientCode,
      number:       'GHOST-' + po.id,                  // matches QBO format from billing skill
      project:      project,
      account:      account,
      activity:     activity,
      logistics:    logistics,
      billing_raw:  billingText,
      status:       invStatus || 'draft',
      amount:       amount,
      invoice_amount:  invoiceAmt,
      estimate_amount: estimateAmt,
      due_date:     dueDate,
      issued_date:  po.created_at || null,
      completed_on: completedOn,
      estimate_url: estimateUrl,
      payment_url:  paymentUrl,
      monday_url:   'https://handslogistics.monday.com/boards/' + OPS_BOARD_ID + '/pulses/' + po.id
    };
  }

  // Payment: synth when FUNDED.
  let payment = null;
  if (billingText === 'FUNDED' && amount > 0) {
    payment = {
      id:        'PMT-' + po.id,
      invoice_id:'INV-' + po.id,
      po_id:     po.id,
      client_id: clientCode,
      amount:    amount,
      paid_date: completedOn || dueDate || null,
      method:    paymentUrl ? 'online' : 'recorded',
      reference: txt(m, OPS_COL_PAYPAL_ORDER) || ('GHOST-' + po.id)
    };
  }

  // Adjustments:
  //   1) Invoice vs estimate delta (when both populated)
  //   2) PARTIAL BILL SUBMITTED flag
  const adjustments = [];
  if (invoiceAmt > 0 && estimateAmt > 0 && invoiceAmt !== estimateAmt) {
    const delta = invoiceAmt - estimateAmt;
    adjustments.push({
      id:        'ADJ-' + po.id + '-DELTA',
      invoice_id:'INV-' + po.id,
      po_id:     po.id,
      client_id: clientCode,
      kind:      delta > 0 ? 'addition' : 'credit',
      amount:    delta,
      reason:    'Invoice amount differs from approved estimate ($'
                  + estimateAmt.toFixed(2) + ' -> $' + invoiceAmt.toFixed(2) + ')',
      dated:     completedOn || dueDate || null
    });
  }
  if (billingText === 'PARTIAL BILL SUBMITTED') {
    adjustments.push({
      id:        'ADJ-' + po.id + '-PARTIAL',
      invoice_id:'INV-' + po.id,
      po_id:     po.id,
      client_id: clientCode,
      kind:      'partial',
      amount:    0,
      reason:    'Partial bill submitted; balance pending',
      dated:     dueDate || null
    });
  }

  return { invoice: invoice, payment: payment, adjustments: adjustments };
}

// Client-action timeline = subitem comments + estimate-accept events
function projectActions(po, clientCode) {
  const out = [];

  // Estimate accept event (best-effort signal: BILLING STATUS landed on
  // ESTIMATE APPROVED, FUNDED, SUBMITTED, etc.)
  const m = colMap(po);
  const billing = txt(m, OPS_COL_BILLING);
  const billingV = jsonVal(m, OPS_COL_BILLING);
  if (billing === 'ESTIMATE APPROVED') {
    out.push({
      id:        'ACT-' + po.id + '-APPROVE',
      po_id:     po.id,
      client_id: clientCode,
      kind:      'estimate_approved',
      message:   'Estimate approved for ' + (txt(m, OPS_COL_PROJECT) || po.name),
      at:        (billingV && billingV.changed_at) || po.updated_at || null
    });
  }

  // Subitem client comments
  const subs = po.subitems || [];
  for (let i = 0; i < subs.length; i++) {
    const sm = colMap(subs[i]);
    const comment = txt(sm, SUB_COL_CLIENT_COMMENT);
    if (comment) {
      out.push({
        id:         'ACT-' + subs[i].id + '-CMT',
        po_id:      po.id,
        subitem_id: subs[i].id,
        client_id:  clientCode,
        kind:       'client_comment',
        message:    comment,
        line:       subs[i].name,
        at:         subs[i].created_at || null
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Required interface — the 9 functions used by _portal-auth.js + endpoints
// ---------------------------------------------------------------------------

/**
 * Look up a registry entry by login email. Returns null if no match.
 */
async function getUserByEmail(email) {
  if (!email) return null;
  const target = String(email).trim().toLowerCase();
  const reg = await loadRegistry();
  for (let i = 0; i < reg.length; i++) {
    if (reg[i].email && reg[i].email === target) return reg[i];
  }
  return null;
}

/**
 * Look up a client by canonical code (GHOST, CAMPARI, ...). Admins are
 * not returned here — admins use listClients() instead.
 */
async function getClientById(clientId) {
  if (!clientId) return null;
  const target = String(clientId).trim().toUpperCase();
  if (target === ADMIN_WILDCARD) return null;
  const reg = await loadRegistry();
  for (let i = 0; i < reg.length; i++) {
    if (reg[i].role === 'client' && reg[i].client_id.toUpperCase() === target) {
      return reg[i];
    }
  }
  return null;
}

/**
 * Admin scope: list every client row in the Registry (excludes admin rows).
 */
async function listClients() {
  const reg = await loadRegistry();
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < reg.length; i++) {
    if (reg[i].role !== 'client') continue;
    const key = reg[i].client_id.toUpperCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(reg[i]);
  }
  out.sort(function (a, b) { return a.display_name.localeCompare(b.display_name); });
  return out;
}

/**
 * Aggregate financial summary for a client.
 * Numbers are rolled up across all of the client's POs.
 */
async function getClientSummary(clientId) {
  const client = await getClientById(clientId);
  if (!client) return null;

  const pos = await loadPOsForClient(client.client_id);
  let totalBilled = 0, totalPaid = 0, totalOutstanding = 0;
  let invoiceCount = 0, paidCount = 0, openCount = 0;

  for (let i = 0; i < pos.length; i++) {
    const p = projectPO(pos[i], client.client_id);
    if (!p.invoice) continue;
    invoiceCount += 1;
    totalBilled += p.invoice.amount;
    if (p.invoice.status === 'paid') {
      paidCount += 1;
      totalPaid += p.invoice.amount;
    } else if (p.invoice.status === 'sent' || p.invoice.status === 'partial' || p.invoice.status === 'pending') {
      openCount += 1;
      totalOutstanding += p.invoice.amount;
    }
  }

  return {
    client_id:        client.client_id,
    display_name:     client.display_name,
    contact_name:     client.contact_name,
    invoice_count:    invoiceCount,
    paid_count:       paidCount,
    open_count:       openCount,
    total_billed:     totalBilled,
    total_paid:       totalPaid,
    total_outstanding:totalOutstanding,
    as_of:            new Date().toISOString()
  };
}

async function getInvoices(clientId) {
  const client = await getClientById(clientId);
  if (!client) return [];
  const pos = await loadPOsForClient(client.client_id);
  const out = [];
  for (let i = 0; i < pos.length; i++) {
    const p = projectPO(pos[i], client.client_id);
    if (p.invoice) out.push(p.invoice);
  }
  out.sort(function (a, b) {
    const ad = a.due_date || a.issued_date || '';
    const bd = b.due_date || b.issued_date || '';
    return bd.localeCompare(ad);
  });
  return out;
}

async function getPayments(clientId) {
  const client = await getClientById(clientId);
  if (!client) return [];
  const pos = await loadPOsForClient(client.client_id);
  const out = [];
  for (let i = 0; i < pos.length; i++) {
    const p = projectPO(pos[i], client.client_id);
    if (p.payment) out.push(p.payment);
  }
  out.sort(function (a, b) { return (b.paid_date || '').localeCompare(a.paid_date || ''); });
  return out;
}

async function getAdjustments(clientId) {
  const client = await getClientById(clientId);
  if (!client) return [];
  const pos = await loadPOsForClient(client.client_id);
  const out = [];
  for (let i = 0; i < pos.length; i++) {
    const p = projectPO(pos[i], client.client_id);
    for (let j = 0; j < p.adjustments.length; j++) out.push(p.adjustments[j]);
  }
  out.sort(function (a, b) { return (b.dated || '').localeCompare(a.dated || ''); });
  return out;
}

async function getClientActions(clientId) {
  const client = await getClientById(clientId);
  if (!client) return [];
  const pos = await loadPOsForClient(client.client_id);
  const out = [];
  for (let i = 0; i < pos.length; i++) {
    const acts = projectActions(pos[i], client.client_id);
    for (let j = 0; j < acts.length; j++) out.push(acts[j]);
  }
  out.sort(function (a, b) { return (b.at || '').localeCompare(a.at || ''); });
  return out;
}

/**
 * "How can I pay?" surface for the portal payment screen.
 * Returns the most recent open invoice's payment context, plus
 * client-level totals.
 */
async function getPaymentInfo(clientId) {
  const summary = await getClientSummary(clientId);
  if (!summary) return null;

  const invoices = await getInvoices(clientId);
  const open = invoices.filter(function (i) {
    return i.status === 'sent' || i.status === 'partial' || i.status === 'pending';
  });

  return {
    client_id:        summary.client_id,
    display_name:     summary.display_name,
    total_outstanding: summary.total_outstanding,
    open_invoices:    open,
    instructions: {
      remit_to:    'Next Wave Beverages on behalf of HANDS Logistics',
      remit_email: 'info@nextwavebev.com',
      ach: {
        bank:     'Contact info@nextwavebev.com for current ACH instructions',
        memo:     'Include invoice number(s)'
      },
      check: {
        payable_to: 'Next Wave Beverages',
        memo:       'Include invoice number(s)'
      },
      terms:        'NET 15 unless otherwise specified on the invoice'
    }
  };
}

/**
 * Cache invalidation — call after any write so subsequent reads see fresh data.
 */
function invalidateCache(clientCode) {
  if (clientCode) {
    delete cache.posByClient[clientCode.toUpperCase()];
  } else {
    cache.registry = null;
    cache.posByClient = Object.create(null);
  }
}

/**
 * WRITE: post a client-submitted comment as a monday update on a PO.
 * Used by /api/portal-actions when a client submits a question/dispute.
 *
 * Authorization: caller must verify the PO actually belongs to clientCode
 * BEFORE calling this. The adapter does that check itself as a safety net,
 * because dropping a comment onto someone else's PO would be a data leak.
 *
 * Returns { ok: true, updateId, mondayUrl } on success.
 */
async function postClientAction(args) {
  const poId = String(args.poId || '').trim();
  const message = String(args.message || '').trim();
  const submittedBy = String(args.submittedBy || '').trim();
  const clientCode = String(args.clientCode || '').trim().toUpperCase();
  const isAdmin = !!args.isAdmin;

  if (!poId) throw new Error('poId is required');
  if (!message) throw new Error('message is required');
  if (!submittedBy) throw new Error('submittedBy email is required');

  // Safety: confirm this PO actually belongs to the claimed client (unless admin).
  if (!isAdmin) {
    if (!clientCode) throw new Error('clientCode is required for non-admin actions');
    const owned = await loadPOsForClient(clientCode);
    const match = owned.find(function (p) { return String(p.id) === poId; });
    if (!match) {
      const e = new Error('PO ' + poId + ' does not belong to client ' + clientCode);
      e.status = 403;
      throw e;
    }
  }

  const body =
    'CLIENT MESSAGE via portal\n' +
    'From: ' + submittedBy + '\n' +
    'At:   ' + new Date().toISOString() + '\n\n' +
    message;

  const q = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
  `;
  const data = await mondayQuery(q, { itemId: poId, body: body });
  const updateId = data && data.create_update && data.create_update.id;

  if (clientCode) invalidateCache(clientCode);

  return {
    ok: true,
    updateId: updateId,
    mondayUrl: 'https://handslogistics.monday.com/boards/' + OPS_BOARD_ID + '/pulses/' + poId,
    notifyEmail: NOTIFICATION_EMAIL
  };
}

/**
 * WRITE: admin updates an invoice (Invoice Amount, BILLING STATUS, Project Name).
 * Always posts an audit-trail monday update line documenting who changed what.
 *
 * args: { poId, fields: { invoiceAmount?, billingStatus?, projectName? }, adminEmail }
 *
 * billingStatus must be one of the canonical labels:
 *   ESTIMATE READY, READY TO SEND, NOT STARTED, CANCELLED, NOT ACCEPTED,
 *   SUBMITTED, ESTIMATE APPROVED, PARTIAL BILL SUBMITTED, INVOICE PENDING, FUNDED
 *
 * Returns { ok: true, changes: [{field, before, after}], updateId }.
 */
async function updateInvoice(args) {
  const poId = String(args.poId || '').trim();
  const fields = args.fields || {};
  const adminEmail = String(args.adminEmail || '').trim();

  if (!poId) throw new Error('poId is required');
  if (!adminEmail) throw new Error('adminEmail is required');

  // Read current values so we can produce a useful audit-trail message.
  const readQ = `
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        column_values(ids: ["${OPS_COL_INVOICE_AMT}", "${OPS_COL_BILLING}", "${OPS_COL_PROJECT}", "${OPS_COL_CLIENT_CODE}"]) {
          id text value
        }
      }
    }
  `;
  const readData = await mondayQuery(readQ, { itemId: [poId] });
  const item = (readData.items && readData.items[0]) || null;
  if (!item) throw new Error('PO ' + poId + ' not found');
  const before = colMap(item);
  const beforeAmount  = txt(before, OPS_COL_INVOICE_AMT);
  const beforeBilling = txt(before, OPS_COL_BILLING);
  const beforeProject = txt(before, OPS_COL_PROJECT);
  const clientCode    = txt(before, OPS_COL_CLIENT_CODE);

  // Build a column_values blob with only the fields the admin actually set.
  const colVals = {};
  const changes = [];

  if (fields.invoiceAmount !== undefined && fields.invoiceAmount !== null && fields.invoiceAmount !== '') {
    const n = Number(fields.invoiceAmount);
    if (!isFinite(n) || n < 0) throw new Error('invoiceAmount must be a non-negative number');
    colVals[OPS_COL_INVOICE_AMT] = String(n);
    changes.push({ field: 'Invoice Amount', before: beforeAmount || '(empty)', after: '$' + n.toFixed(2) });
  }

  if (fields.billingStatus !== undefined && fields.billingStatus !== null && fields.billingStatus !== '') {
    const label = String(fields.billingStatus).trim();
    const validLabels = Object.keys(BILLING_TO_INVOICE_STATUS);
    if (validLabels.indexOf(label) === -1) {
      throw new Error('billingStatus must be one of: ' + validLabels.join(', '));
    }
    colVals[OPS_COL_BILLING] = { label: label };
    changes.push({ field: 'Billing Status', before: beforeBilling || '(empty)', after: label });
  }

  if (fields.projectName !== undefined && fields.projectName !== null) {
    const pn = String(fields.projectName).trim();
    colVals[OPS_COL_PROJECT] = pn;
    changes.push({ field: 'Project Name', before: beforeProject || '(empty)', after: pn || '(cleared)' });
  }

  if (changes.length === 0) {
    return { ok: true, changes: [], note: 'No fields changed.' };
  }

  // Push the column-value updates.
  const writeQ = `
    mutation ($boardId: ID!, $itemId: ID!, $vals: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $vals) {
        id
      }
    }
  `;
  await mondayQuery(writeQ, {
    boardId: String(OPS_BOARD_ID),
    itemId:  poId,
    vals:    JSON.stringify(colVals)
  });

  // Write the audit-trail update line.
  const auditLines = ['INVOICE EDITED via portal', 'By: ' + adminEmail, 'At: ' + new Date().toISOString(), ''];
  for (let i = 0; i < changes.length; i++) {
    auditLines.push('• ' + changes[i].field + ': ' + changes[i].before + ' → ' + changes[i].after);
  }
  const auditQ = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
  `;
  const auditData = await mondayQuery(auditQ, { itemId: poId, body: auditLines.join('\n') });
  const updateId = auditData && auditData.create_update && auditData.create_update.id;

  if (clientCode) invalidateCache(clientCode);

  return {
    ok: true,
    changes: changes,
    updateId: updateId,
    mondayUrl: 'https://handslogistics.monday.com/boards/' + OPS_BOARD_ID + '/pulses/' + poId
  };
}

/**
 * Resolve the PayPal payment URL for a given invoice/PO.
 * Plan C, Q2=a: ALWAYS the hosted button. Per-PO links on the column
 * are ignored to avoid surprising clients with stale or unreviewed URLs.
 */
function getPaymentUrlForInvoice(/* invoiceId */) {
  return PAYPAL_HOSTED_BUTTON_URL;
}

/**
 * Admin view: aggregate getClientActions across all clients in the registry.
 * Used by /api/portal-admin-actions.
 */
async function getAllClientActions() {
  const clients = await listClients();
  const out = [];
  for (let i = 0; i < clients.length; i++) {
    try {
      const acts = await getClientActions(clients[i].client_id);
      for (let j = 0; j < acts.length; j++) {
        out.push(Object.assign({}, acts[j], {
          client_id: clients[i].client_id,
          client_display_name: clients[i].display_name
        }));
      }
    } catch (e) {
      console.error('[portal-datastore] getAllClientActions: client ' + clients[i].client_id + ' failed:', e.message);
    }
  }
  out.sort(function (a, b) { return (b.at || '').localeCompare(a.at || ''); });
  return out;
}

/**
 * Strip internal fields before sending to the browser. Endpoint code
 * pipes every outbound payload through this so we don't leak monday IDs
 * unless we mean to.
 */
function toClientView(obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(toClientView);
  if (typeof obj !== 'object') return obj;

  const HIDE = { monday_item_id: 1, registry_name: 1 };
  const out = {};
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (HIDE[k]) continue;
    const v = obj[k];
    out[k] = (v && typeof v === 'object') ? toClientView(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diagnostics — _portal-auth.js can call this on cold start to fail loud
// ---------------------------------------------------------------------------

async function selfTest() {
  const reg = await loadRegistry();
  return {
    ok: true,
    registry_size: reg.length,
    admin_count:   reg.filter(function (r) { return r.role === 'admin'; }).length,
    client_count:  reg.filter(function (r) { return r.role === 'client'; }).length
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Required by _portal-auth.js + endpoint functions:
  getUserByEmail:    getUserByEmail,
  getClientById:     getClientById,
  listClients:       listClients,
  getClientSummary:  getClientSummary,
  getInvoices:       getInvoices,
  getPayments:       getPayments,
  getAdjustments:    getAdjustments,
  getClientActions:  getClientActions,
  getPaymentInfo:    getPaymentInfo,
  toClientView:      toClientView,

  // Plan C additions (writes + admin reads + payments):
  postClientAction:        postClientAction,
  updateInvoice:           updateInvoice,
  getPaymentUrlForInvoice: getPaymentUrlForInvoice,
  getAllClientActions:     getAllClientActions,

  // Bonus:
  selfTest:          selfTest,

  // Constants exposed for endpoints:
  PAYPAL_HOSTED_BUTTON_URL: PAYPAL_HOSTED_BUTTON_URL,
  NOTIFICATION_EMAIL:       NOTIFICATION_EMAIL,

  // Exposed for unit tests / debugging:
  _internal: {
    mondayQuery:    mondayQuery,
    loadRegistry:   loadRegistry,
    loadPOsForClient: loadPOsForClient,
    projectPO:      projectPO,
    projectActions: projectActions,
    invalidateCache: invalidateCache,
    BILLING_TO_INVOICE_STATUS: BILLING_TO_INVOICE_STATUS
  }
};
