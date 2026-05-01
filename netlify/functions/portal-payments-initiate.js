/**
 * POST /portal/api/payments/initiate — return the payment URL for an invoice.
 *
 * Plan C, Q2=a: always returns the PayPal hosted button URL. The client is
 * responsible for entering the invoice amount on PayPal's hosted page and
 * referencing the invoice number in PayPal's note field.
 *
 * Body:  { invoiceId } or { poId } — accepted but only used in the response
 *        for client-side reference. The URL itself is the same for every
 *        invoice today.
 * Auth:  any signed-in user.
 */
const ds = require('./_portal-datastore-monday');
const { requireAuth, json, handleError, handleOptions } = require('./_portal-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  try {
    await requireAuth(event);

    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch (_e) { /* empty body is allowed */ }

    const invoiceId = String(body.invoiceId || body.poId || '').trim();
    const paymentUrl = ds.getPaymentUrlForInvoice(invoiceId);

    return json(200, {
      shellMode: false,
      ok: true,
      buttonLabel: 'Pay Invoice',
      paymentUrl:  paymentUrl,
      invoiceRef:  invoiceId || null,
      instructions: 'You will be redirected to PayPal. Enter the invoice amount and reference the invoice number in the PayPal note.'
    });
  } catch (err) {
    return handleError(err);
  }
};
