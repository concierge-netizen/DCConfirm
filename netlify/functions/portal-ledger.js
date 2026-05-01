/**
 * GET /portal/api/ledger — authenticated user's ledger.
 * Reads from the monday.com-backed datastore.
 *
 * Query params:
 *   ?clientId=GHOST   (admin only — for client-scoped admin views)
 *
 * Accepts both `clientId` (camelCase) and `client_id` (snake_case) for
 * backward compat with anything still passing the old name.
 */
const ds = require('./_portal-datastore-monday');
const { requireAuth, resolveTargetClient, json, handleError, handleOptions } = require('./_portal-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  try {
    const ctx = await requireAuth(event);
    const qs = event.queryStringParameters || {};
    const requestedClientId = qs.clientId || qs.client_id || null;
    const client = await resolveTargetClient(ctx, requestedClientId);

    // Admins viewing PLACEHOLDER (no clientId picked yet) — return a thin
    // "pick a client" payload so the frontend can render the picker.
    if (client.clientId === 'PLACEHOLDER') {
      const allClients = await ds.listClients();
      return json(200, {
        shellMode: false,
        client: { clientId: 'PLACEHOLDER', name: 'Select a client', terms: 'NET 60' },
        summary: { outstandingBalance: 0, overdueAmount: 0, pendingActions: 0 },
        invoices: [], payments: [], adjustments: [], actions: [],
        paymentInfo: { open_invoices: [] },
        isAdmin: ctx.isAdmin,
        adminPicker: {
          message: 'Select a client to view their ledger.',
          clients: allClients.map(c => ({ clientId: c.client_id, name: c.display_name }))
        }
      });
    }

    const [summary, invoices, payments, adjustments, actions, paymentInfo] = await Promise.all([
      ds.getClientSummary(client.clientId),
      ds.getInvoices(client.clientId),
      ds.getPayments(client.clientId),
      ds.getAdjustments(client.clientId),
      ds.getClientActions(client.clientId),
      ds.getPaymentInfo(client.clientId),
    ]);

    // Map summary into the shape the frontend KPI cards expect.
    const summaryUI = summary ? {
      outstandingBalance: summary.total_outstanding,
      overdueAmount:      0,                // no due-date logic yet; keep field for UI
      pendingActions:     summary.open_count,
      totalBilled:        summary.total_billed,
      totalPaid:          summary.total_paid,
      invoiceCount:       summary.invoice_count,
      paidCount:          summary.paid_count,
      asOf:               summary.as_of
    } : null;

    return json(200, {
      shellMode: false,
      client: {
        clientId: client.clientId,
        name: client.name || client.display_name,
        terms: client.terms,
        primaryContact: client.contact_name
      },
      summary: summaryUI,
      invoices: ctx.isAdmin ? invoices : invoices.map(ds.toClientView),
      payments,
      adjustments,
      actions,
      paymentInfo,
      isAdmin: ctx.isAdmin,
    });
  } catch (err) { return handleError(err); }
};
