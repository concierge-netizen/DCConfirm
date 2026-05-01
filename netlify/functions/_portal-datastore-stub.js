/**
 * portal-datastore-stub.js — Path 4 (hollow shell) datastore.
 * Returns hardcoded placeholder data so the portal renders end-to-end
 * without any Google Sheets or monday.com connection.
 *
 * To switch to real data later: replace the body of these functions.
 * Function signatures match what lib/auth.js + each function expects.
 */

const PLACEHOLDER_NOTICE = 'Connecting to data sources — coming soon.';

// User lookup. Allowlists Jon and Charles as admins so you can sign in
// and see the portal shell. Everyone else gets "User not in registry."
const ALLOWLIST = {
  // populate with the email you sign into Clerk with
  // e.g. 'jon@handslogistics.com': { clientId: '*', role: 'admin', status: 'Active' }
};

async function getUserByEmail(email) {
  const lower = (email || '').toLowerCase();
  const u = ALLOWLIST[lower];
  if (!u) return null;
  return {
    email: lower,
    clientId: u.clientId,
    role: u.role,
    displayName: '',
    status: u.status,
  };
}

async function getClientById(clientId) {
  return {
    clientId,
    name: 'Pending Setup',
    accountNumber: '',
    ledgerSheetId: '',
    primaryContact: '',
    primaryEmail: '',
    terms: 'NET 30',
    status: 'Active',
    paypalHandle: '',
    notes: PLACEHOLDER_NOTICE,
  };
}

async function listClients() {
  return [];
}

async function getClientSummary(_clientId) {
  return {
    outstandingBalance: 0,
    overdueAmount: 0,
    pendingActions: 0,
    notice: PLACEHOLDER_NOTICE,
  };
}

async function getInvoices(_clientId, _opts = {}) {
  return [];
}

async function getPayments(_clientId) {
  return [];
}

async function getAdjustments(_clientId) {
  return [];
}

async function getClientActions(_clientId) {
  return [];
}

async function getPaymentInfo() {
  return {
    notice: PLACEHOLDER_NOTICE,
    methods: [],
  };
}

function toClientView(invoice) {
  // Strip internal fields. With no real invoices, this is a no-op.
  const { internalDescription, ...rest } = invoice || {};
  return rest;
}

module.exports = {
  getUserByEmail,
  getClientById,
  listClients,
  getClientSummary,
  getInvoices,
  getPayments,
  getAdjustments,
  getClientActions,
  getPaymentInfo,
  toClientView,
};
