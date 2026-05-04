/**
 * GET /portal/api/ledger — authenticated user's ledger.
 * Reads from the monday.com-backed datastore.
 *
 * Query params:
 *   ?clientId=GHOST   (admin only — for client-scoped admin views)
 *   ?asClient=1       (admin only — render the response exactly as the
 *                      client would see it: stripped of internal fields
 *                      via toClientView(), with isAdmin: false so the
 *                      frontend hides admin chrome)
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
    const asClient = (qs.asClient === '1' || qs.asClient === 'true');
    const client = await resolveTargetClient(ctx, requestedClientId);

    // Admins viewing PLACEHOLDER (no clientId picked yet) — return a thin
    // "pick a client" payload so the frontend can render the picker.
    // Each client card carries a per-client summary so the picker shows
    // outstanding balance + pending actions without a second round-trip.
    if (client.clientId === 'PLACEHOLDER') {
      const allClients = await ds.listClients();

      // Fan out rollups in parallel. One slow client doesn't tank the picker —
      // any failure becomes a {summary: null} card showing zeros.
      const pickerClients = await Promise.all(allClients.map(async (c) => {
        let summary = null;
        try {
          const s = await ds.getClientSummary(c.client_id);
          if (s) {
            summary = {
              outstandingBalance: s.total_outstanding,
              pendingActions:     s.open_count,
              totalBilled:        s.total_billed,
              totalPaid:          s.total_paid,
              invoiceCount:       s.invoice_count,
              operationalCount:   s.operational_count,
              totalActivity:      s.total_activity
            };
          }
        } catch (e) {
          console.error('[portal-ledger] picker rollup failed for ' + c.client_id + ':', e.message);
        }
        return {
          clientId: c.client_id,
          name:     c.display_name,
          summary:  summary
        };
      }));

      return json(200, {
        shellMode: false,
        client: { clientId: 'PLACEHOLDER', name: 'Select a client', terms: 'NET 15' },
        summary: { outstandingBalance: 0, overdueAmount: 0, pendingActions: 0 },
        invoices: [], payments: [], adjustments: [], actions: [],
        paymentInfo: { open_invoices: [] },
        isAdmin: ctx.isAdmin,
        adminPicker: {
          message: 'Select a client to view their ledger.',
          clients: pickerClients
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
      operationalCount:   summary.operational_count,
      totalActivity:      summary.total_activity,
      asOf:               summary.as_of
    } : null;

    // v0.10c: when an admin requests asClient=1, render the response exactly
    // as the client would see it — toClientView strips internal fields, and
    // isAdmin is forced to false so the frontend hides admin chrome (Edit
    // buttons, Record Payment, etc). Only real admins can request this; for
    // a non-admin the flag is a no-op (data is already client-shaped).
    const renderAsClient = ctx.isAdmin && asClient;
    const invoicesPayload = (renderAsClient || !ctx.isAdmin) ? invoices.map(ds.toClientView) : invoices;

    return json(200, {
      shellMode: false,
      client: {
        clientId: client.clientId,
        name: client.name || client.display_name,
        terms: client.terms,
        primaryContact: client.contact_name
      },
      summary: summaryUI,
      invoices: invoicesPayload,
      payments,
      adjustments,
      actions,
      paymentInfo,
      isAdmin: renderAsClient ? false : ctx.isAdmin,
    });
  } catch (err) { return handleError(err); }
};
