/**
 * GET /portal/api/ledger — authenticated user's ledger.
 * Hollow shell: returns valid-shape placeholder data so frontend renders.
 */
const ds = require('./_portal-datastore-stub');
const { requireAuth, resolveTargetClient, json, handleError, handleOptions } = require('./_portal-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  try {
    const ctx = await requireAuth(event);
    const requestedClientId = event.queryStringParameters?.client_id;
    const client = await resolveTargetClient(ctx, requestedClientId);

    const [summary, invoices, payments, adjustments, actions, paymentInfo] = await Promise.all([
      ds.getClientSummary(client.clientId),
      ds.getInvoices(client.clientId, { includeUnpublished: ctx.isAdmin }),
      ds.getPayments(client.clientId),
      ds.getAdjustments(client.clientId),
      ds.getClientActions(client.clientId),
      ds.getPaymentInfo(),
    ]);

    return json(200, {
      shellMode: true,
      shellNotice: 'Connecting to data sources — coming soon.',
      client: {
        clientId: client.clientId,
        name: client.name,
        accountNumber: client.accountNumber,
        terms: client.terms,
        primaryContact: client.primaryContact,
      },
      summary,
      invoices: ctx.isAdmin ? invoices : invoices.map(ds.toClientView),
      payments,
      adjustments,
      actions,
      paymentInfo,
      isAdmin: ctx.isAdmin,
    });
  } catch (err) { return handleError(err); }
};
