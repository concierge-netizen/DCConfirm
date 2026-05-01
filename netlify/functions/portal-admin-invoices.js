/**
 * POST /portal/api/admin/invoices — admin edits an invoice on a PO.
 *
 * Body: { poId, invoiceAmount?, billingStatus?, projectName? }
 * Auth: admin only.
 *
 * Every change is logged as a monday update line with the admin's email
 * and a before -> after diff (audit trail, Plan C, Q3=yes).
 */
const ds = require('./_portal-datastore-monday');
const { requireAuth, json, handleError, handleOptions } = require('./_portal-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST only' });
  }
  try {
    const ctx = await requireAuth(event, { adminOnly: true });

    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch (_e) { return json(400, { error: 'Invalid JSON body' }); }

    const poId = String(body.poId || '').trim();
    if (!poId) return json(400, { error: 'poId is required' });

    const fields = {};
    if (body.invoiceAmount !== undefined) fields.invoiceAmount = body.invoiceAmount;
    if (body.billingStatus !== undefined) fields.billingStatus = body.billingStatus;
    if (body.projectName   !== undefined) fields.projectName   = body.projectName;

    if (Object.keys(fields).length === 0) {
      return json(400, { error: 'No editable fields provided. Supply invoiceAmount, billingStatus, and/or projectName.' });
    }

    const result = await ds.updateInvoice({
      poId: poId,
      fields: fields,
      adminEmail: ctx.email
    });

    return json(200, Object.assign({ shellMode: false }, result));
  } catch (err) {
    return handleError(err);
  }
};
