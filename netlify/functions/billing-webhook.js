// billing-webhook.js
// Monday webhook receiver for HANDS Operations 2026 board.
//
// Two responsibilities:
//
// 1. LOGISTICS STATUS (column `color`) → COMPLETE
//    - Auto-flip BILLING STATUS (column `status2`) to "Invoice Pending"
//    - Move item into the "Ready for Billing" group (group_mm18z2ae)
//    - Skip if BILLING STATUS is already in SKIP_STATUSES (don't overwrite
//      an active billing stage)
//
// 2. PAYMENTS column (text_mm31avnx) → changed
//    - Parse the JSON payment array
//    - Sum payment amounts
//    - If sum >= invoice_amount - 0.01, auto-flip BILLING STATUS to "Funded"
//    - Otherwise if sum > 0 and status not in skip-list, set BILLING STATUS
//      to "Partial Bill Submitted"
//    - If sum < invoice_amount and status is currently Funded, do NOT
//      auto-revert (manual reversal only)
//
// Monday webhook URL: https://ops.handslogistics.com/.netlify/functions/billing-webhook
// Subscribe twice on Ops board (4550650855):
//   - column change → `color`         (LOGISTICS STATUS)
//   - column change → `text_mm31avnx` (PAYMENTS)

const MONDAY_API_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjYzNjEzNzc5MSwiYWFpIjoxMSwidWlkIjoxNDk4NzI0NSwiaWFkIjoiMjAyNi0wMy0yMlQxNzoyNTo1MC4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NjYxOTgxNSwicmduIjoidXNlMSJ9.RLTGytTbLaran19E20Ag8nzxdaWuwVKVZNx3fdvAIBQ';
const BOARD_ID = 4550650855;

// Columns
const LOGISTICS_COL   = 'color';              // LOGISTICS STATUS
const BILLING_COL     = 'status2';            // BILLING STATUS
const INVOICE_AMT_COL = 'numeric_mm1weeyp';   // Invoice Amount (numeric)
const PAYMENTS_COL    = 'text_mm31avnx';      // Payments JSON longtext

// Groups
const READY_FOR_BILLING_GROUP = 'group_mm18z2ae';

// Status labels — must match Monday EXACTLY (case-sensitive).
// These are aligned with the labels the portal uses in app.js
// (see openInvoiceEditor → billingStatus options): NOT STARTED,
// ESTIMATE READY, ESTIMATE APPROVED, INVOICE PENDING, SUBMITTED,
// PARTIAL BILL SUBMITTED, READY TO SEND, FUNDED, CANCELLED, NOT ACCEPTED.
//
// "FUNDED" is the portal's terminal "paid" state (see statusClass()
// returns 'good' for FUNDED). We flip there on full payment.
const LOGISTICS_COMPLETE_LABEL  = 'Done';
const BILLING_INVOICE_PENDING   = 'INVOICE PENDING';
const BILLING_PARTIAL           = 'PARTIAL BILL SUBMITTED';
const BILLING_FUNDED            = 'FUNDED';

// BILLING STATUS labels we will NOT overwrite when LOGISTICS flips to COMPLETE.
const SKIP_STATUSES = [
  'INVOICE PENDING',
  'SUBMITTED',
  'PARTIAL BILL SUBMITTED',
  'READY TO SEND',
  'FUNDED',
  'CANCELLED',
  'NOT ACCEPTED'
];

const PAID_TOLERANCE = 0.01;

// ── helpers ────────────────────────────────────────────────────────────────

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

function ok(body) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || { ok: true }) };
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

async function readItemColumns(itemId, columnIds) {
  const idsCsv = columnIds.map(c => `"${c}"`).join(',');
  const q = `{ items(ids: [${Number(itemId)}]) { id column_values(ids: [${idsCsv}]) { id text value } } }`;
  const data = await mondayCall(q);
  const item = data.items && data.items[0];
  if (!item) return null;
  const cols = {};
  (item.column_values || []).forEach(c => { cols[c.id] = c; });
  return { id: item.id, cols };
}

async function setStatus(itemId, columnId, label) {
  const value = JSON.stringify(JSON.stringify({ label }));
  const m = `mutation { change_simple_column_value(item_id: ${Number(itemId)}, board_id: ${BOARD_ID}, column_id: "${columnId}", value: ${value}) { id } }`;
  return mondayCall(m);
}

async function moveItemToGroup(itemId, groupId) {
  const m = `mutation { move_item_to_group(item_id: ${Number(itemId)}, group_id: "${groupId}") { id } }`;
  return mondayCall(m);
}

function maybeChallenge(parsed) {
  if (parsed && typeof parsed.challenge === 'string') {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: parsed.challenge }) };
  }
  return null;
}

// ── handlers ───────────────────────────────────────────────────────────────

async function handleLogisticsChange(itemId, newLabel) {
  if (newLabel !== LOGISTICS_COMPLETE_LABEL) return { skipped: 'logistics not COMPLETE', newLabel };

  const item = await readItemColumns(itemId, [BILLING_COL]);
  if (!item) return { skipped: 'item not found' };
  const currentBilling = ((item.cols[BILLING_COL] && item.cols[BILLING_COL].text) || '').toUpperCase();

  if (SKIP_STATUSES.indexOf(currentBilling) !== -1) {
    return { skipped: 'billing already in protected state', currentBilling };
  }

  await setStatus(itemId, BILLING_COL, BILLING_INVOICE_PENDING);
  await moveItemToGroup(itemId, READY_FOR_BILLING_GROUP);
  return { action: 'flipped to Invoice Pending and moved to Ready for Billing' };
}

async function handlePaymentsChange(itemId) {
  const item = await readItemColumns(itemId, [PAYMENTS_COL, INVOICE_AMT_COL, BILLING_COL]);
  if (!item) return { skipped: 'item not found' };

  const paymentsRaw = (item.cols[PAYMENTS_COL] && item.cols[PAYMENTS_COL].text) || '';
  const invoiceAmtRaw = (item.cols[INVOICE_AMT_COL] && item.cols[INVOICE_AMT_COL].text) || '';
  const currentBilling = ((item.cols[BILLING_COL] && item.cols[BILLING_COL].text) || '').toUpperCase();

  const payments = parsePayments(paymentsRaw);
  if (payments === null) {
    return { skipped: 'payments column has non-JSON content', paymentsRaw };
  }

  const totalPaid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const invoiceAmt = parseFloat(invoiceAmtRaw);

  if (!isFinite(invoiceAmt) || invoiceAmt <= 0) {
    return { skipped: 'no valid invoice amount', invoiceAmtRaw, totalPaid };
  }

  const fullyPaid = totalPaid >= (invoiceAmt - PAID_TOLERANCE);
  const hasPartial = !fullyPaid && totalPaid > 0;

  if (fullyPaid && currentBilling !== BILLING_FUNDED) {
    await setStatus(itemId, BILLING_COL, BILLING_FUNDED);
    return { action: 'flipped to FUNDED', totalPaid, invoiceAmt };
  }

  if (hasPartial && currentBilling !== BILLING_FUNDED && currentBilling !== BILLING_PARTIAL && currentBilling !== 'CANCELLED' && currentBilling !== 'NOT ACCEPTED') {
    await setStatus(itemId, BILLING_COL, BILLING_PARTIAL);
    return { action: 'flipped to PARTIAL BILL SUBMITTED', totalPaid, invoiceAmt };
  }

  if (!fullyPaid && currentBilling === BILLING_FUNDED) {
    return { skipped: 'partial vs funded mismatch — not auto-reverting', totalPaid, invoiceAmt, currentBilling };
  }

  return { skipped: 'no flip needed', totalPaid, invoiceAmt, currentBilling, fullyPaid, hasPartial };
}

// ── entry point ────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let parsed;
  try { parsed = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  const challenge = maybeChallenge(parsed);
  if (challenge) return challenge;

  const ev = parsed.event || {};
  const itemId = ev.pulseId || ev.itemId;
  const columnId = ev.columnId;

  if (!itemId || !columnId) {
    return ok({ skipped: 'missing itemId or columnId', parsed });
  }

  try {
    if (columnId === LOGISTICS_COL) {
      const newLabel = (ev.value && ev.value.label && (ev.value.label.text || ev.value.label)) || '';
      const result = await handleLogisticsChange(itemId, newLabel);
      return ok({ branch: 'logistics', itemId, ...result });
    }

    if (columnId === PAYMENTS_COL) {
      const result = await handlePaymentsChange(itemId);
      return ok({ branch: 'payments', itemId, ...result });
    }

    return ok({ skipped: 'column not handled', columnId });
  } catch (err) {
    return ok({ error: err.message });
  }
};
