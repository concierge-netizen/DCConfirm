/* HANDS Client Portal — v0.10c (Level 3 Payments + View-as-Client)
 * Renders the monday-backed payload from /portal/api/ledger.
 *
 * Schema (snake_case from datastore, passed through by portal-ledger.js):
 *   invoices[]: { id, po_id, project, account, billing_raw, status, amount,
 *                 invoice_amount, estimate_amount, due_date, issued_date,
 *                 completed_on, payment_url, monday_url,
 *                 payments[]?, totalPaid?, balance?, ... }
 *   payments[]: { id, po_id, paid_date, method, amount, ... }
 *   actions[]:  { po_id, message, at, author?, ... }
 *   summary:    { outstandingBalance, pendingActions, totalBilled, ... }
 *   paymentInfo: { instructions: { remit_to, remit_email, ach, check, terms } }
 *   adminPicker?: { clients: [{ clientId, name, summary }] }
 *
 * v0.10: admins can record partial payments per invoice via the
 * Record Payment modal. Posts to /portal/api/admin/record-payment which
 * appends to monday column text_mm31avnx; webhook auto-flips BILLING
 * STATUS to FUNDED when running total >= invoice amount (penny tolerance).
 */

const state = { token: null, user: null, isAdmin: false, ledger: null, clientId: null, activityFilter: 'all', activitySearch: '', viewAsClient: false };

// v0.8 — Cloudinary direct-upload constants. Both values are public
// (cloud_name appears in every CDN URL; the unsigned preset is by
// definition discoverable). Putting them here avoids a config round-trip.
const CLOUDINARY_CLOUD = 'dxkpbjicu';
const CLOUDINARY_DOC_PRESET = 'hands_documents';
const CLOUDINARY_DOC_FOLDER = 'hands-docs';

// ─── Utilities ──────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) e.setAttribute(k, v);
  });
  children.flat().forEach(c => {
    if (c == null || c === false) return;
    e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  });
  return e;
}

function root() { return document.getElementById('root'); }
function clearRoot() { root().innerHTML = ''; }

function fmtMoney(n) {
  if (n == null || n === '' || isNaN(Number(n))) return '$0.00';
  return Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getQueryParam(name) {
  const m = window.location.search.match(new RegExp('[?&]' + name + '=([^&]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function setClientIdInUrl(clientId) {
  const u = new URL(window.location.href);
  if (clientId) u.searchParams.set('clientId', clientId);
  else u.searchParams.delete('clientId');
  window.history.pushState({}, '', u.toString());
}

// Pretty-print a billing label: "NOT STARTED" → "Not Started"
function titleCase(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ─── API ────────────────────────────────────────────────────────────
async function apiGet(path) {
  const url = '/portal/api' + path;
  const resp = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + state.token },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
  return data;
}

async function apiPost(path, body) {
  const resp = await fetch('/portal/api' + path, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + state.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
  return data;
}

async function loadLedger() {
  const cid = state.clientId;
  const params = [];
  if (cid) params.push('clientId=' + encodeURIComponent(cid));
  if (state.viewAsClient) params.push('asClient=1');
  const path = '/ledger' + (params.length ? '?' + params.join('&') : '');
  state.ledger = await apiGet(path);
  // When viewing as client, the API returns isAdmin:false (so admin chrome
  // hides). Track the underlying admin status separately so we can still
  // render the toggle itself.
  state.isAdmin = !!state.ledger.isAdmin;
  if (!state.viewAsClient) {
    state.isReallyAdmin = state.isAdmin;
  }
}

// ─── Auth init (called by index.html after Clerk SDK loads) ─────────
async function initApp() {
  try {
    await window.Clerk.load();
  } catch (err) {
    return showError('Clerk failed to initialize: ' + err.message);
  }

  if (!window.Clerk.user) return renderSignIn();

  try {
    state.token = await window.Clerk.session.getToken();
  } catch (err) {
    return renderSignIn('Could not retrieve session token. Please sign in again.');
  }

  setInterval(async () => {
    try { state.token = await window.Clerk.session.getToken(); } catch (_) {}
  }, 50 * 1000);

  state.clientId = getQueryParam('clientId');
  state.viewAsClient = (window.location.hash || '').indexOf('viewAs=client') !== -1;

  try {
    await loadLedger();
  } catch (err) {
    return renderRegistryError(err.message);
  }

  routeRender();
}

window.initApp = initApp;

// ─── View-as-Client toggle (v0.10c) ──────────────────────────────────
function setViewAsHash(on) {
  // Preserve any other hash fragments. Today there are none, but be polite.
  const others = (window.location.hash || '').replace(/^#/, '').split('&').filter(s => s && !/^viewAs=/.test(s));
  if (on) others.push('viewAs=client');
  const newHash = others.length ? ('#' + others.join('&')) : '';
  if (window.location.hash !== newHash) {
    history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
  }
}

function clearViewAsHash() { setViewAsHash(false); }

function onToggleViewAsClient() {
  state.viewAsClient = !state.viewAsClient;
  setViewAsHash(state.viewAsClient);
  // Reload ledger with the new scope. UI re-renders.
  loadLedger().then(routeRender).catch(err => renderRegistryError(err.message));
}

window.addEventListener('popstate', () => {
  state.clientId = getQueryParam('clientId');
  state.viewAsClient = (window.location.hash || '').indexOf('viewAs=client') !== -1;
  loadLedger().then(routeRender).catch(err => renderRegistryError(err.message));
});

function routeRender() {
  if (state.ledger && state.ledger.adminPicker) return renderAdminPicker();
  return renderLedger();
}

// ─── Render: sign-in ─────────────────────────────────────────────────
function renderSignIn(message) {
  clearRoot();
  const card = el('div', { class: 'signin-card' },
    el('div', { class: 'brand-mark' }, 'H'),
    el('h1', {}, 'Client Portal'),
    el('p', {}, message || 'Sign in to view your activity ledger and billing.'),
    el('div', { class: 'clerk-mount', id: 'clerk-mount' }),
  );
  root().appendChild(card);

  const PORTAL_URL = window.location.origin + '/portal';
  if (window.Clerk && typeof window.Clerk.mountSignIn === 'function') {
    window.Clerk.mountSignIn(document.getElementById('clerk-mount'), {
      signInUrl: PORTAL_URL,
      signUpUrl: PORTAL_URL,
      afterSignInUrl: PORTAL_URL,
      afterSignUpUrl: PORTAL_URL,
      redirectUrl: PORTAL_URL,
      fallbackRedirectUrl: PORTAL_URL,
    });
  } else {
    const mount = document.getElementById('clerk-mount');
    mount.innerHTML = '<a href="#" class="btn-signout" style="color:#1a1a1a;border-color:#1a1a1a;text-decoration:none;display:inline-block;">Open Clerk sign-in</a>';
  }
}

// ─── Header (shared) ─────────────────────────────────────────────────
function buildHeader(opts) {
  opts = opts || {};
  const email = (window.Clerk && window.Clerk.user && window.Clerk.user.primaryEmailAddress && window.Clerk.user.primaryEmailAddress.emailAddress) || '';
  const userChipChildren = [];
  if (email) userChipChildren.push(el('span', {}, email));
  if (state.isAdmin || state.isReallyAdmin) userChipChildren.push(el('span', { class: 'admin-pill' }, 'Admin'));
  // v0.10c: View-as-Client toggle. Only renders for real admins who are
  // scoped to a specific client (no point on the picker page).
  if ((state.isReallyAdmin || state.isAdmin) && state.clientId) {
    userChipChildren.push(el('button', {
      class: 'btn-view-as' + (state.viewAsClient ? ' is-active' : ''),
      title: state.viewAsClient ? 'You are seeing what the client sees. Click to return to admin view.' : 'Switch to client view',
      onclick: () => onToggleViewAsClient(),
    }, state.viewAsClient ? '👁  Viewing as Client' : 'View as Client'));
  }
  if (opts.showBackToPicker) {
    userChipChildren.push(el('button', {
      class: 'btn-signout',
      onclick: () => { setClientIdInUrl(null); state.clientId = null; state.viewAsClient = false; clearViewAsHash(); loadLedger().then(routeRender).catch(err => renderRegistryError(err.message)); },
    }, 'All Clients'));
  }
  userChipChildren.push(el('button', {
    class: 'btn-signout',
    onclick: () => window.Clerk.signOut().then(() => location.reload()),
  }, 'Sign out'));

  return el('header', { class: 'portal-header' },
    el('div', { class: 'brand' },
      el('div', { class: 'brand-mark' }, 'H'),
      el('div', { class: 'brand-text' },
        'HANDS Logistics',
        el('small', {}, 'Client Portal'),
      ),
    ),
    el('div', { class: 'user-chip' }, userChipChildren),
  );
}

function buildFooter() {
  return el('footer', { class: 'portal-footer' },
    'HANDS Logistics · Las Vegas · Client Portal v0.10c',
  );
}

// ─── Render: admin picker ────────────────────────────────────────────
function renderAdminPicker() {
  clearRoot();
  const picker = state.ledger.adminPicker || {};
  const clients = picker.clients || [];

  const cards = clients.map(c => {
    const summary = c.summary || {};
    const cid = c.clientId || c.id;

    const handleCardOpen = () => {
      setClientIdInUrl(cid);
      state.clientId = cid;
      clearRoot();
      root().appendChild(el('div', { class: 'loading' }, 'Loading ledger…'));
      loadLedger().then(routeRender).catch(err => renderRegistryError(err.message));
    };

    return el('div', {
      class: 'client-card',
      role: 'button',
      tabindex: '0',
      onclick: handleCardOpen,
      onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handleCardOpen(); } },
    },
      el('div', { class: 'eyebrow' }, c.clientId || c.id || ''),
      el('div', { class: 'client-card-name' }, c.name || c.clientId || 'Unnamed'),
      el('div', { class: 'client-card-meta' },
        el('div', {},
          el('div', { class: 'card-label' }, 'Outstanding'),
          el('div', { class: 'client-card-num' }, fmtMoney(summary.outstandingBalance)),
        ),
        el('div', {},
          el('div', { class: 'card-label' }, 'Activity'),
          el('div', { class: 'client-card-num' }, summary.totalActivity != null ? summary.totalActivity : '0'),
        ),
      ),
      // Invite footer — only visible to admins viewing the picker. stopPropagation
      // prevents drilling into the ledger when the Invite button is clicked.
      el('div', { class: 'client-card-footer' },
        el('button', {
          class: 'btn-invite',
          onclick: (ev) => { ev.stopPropagation(); openInviteModal(c); },
        }, 'Invite'),
      ),
    );
  });

  const canvas = el('main', { class: 'canvas' },
    el('div', { class: 'eyebrow' }, 'Admin · Client Picker'),
    el('h1', { class: 'h-display' }, 'All Clients'),
    el('p', { class: 'subtitle' }, 'Select a client to view their ledger.'),
    cards.length
      ? el('div', { class: 'client-grid' }, cards)
      : el('div', { class: 'shell-notice' },
          el('div', { class: 'eyebrow' }, 'Empty'),
          el('h2', {}, 'No clients in the registry'),
          el('p', {}, 'Add clients to the Portal Registry board on monday.com (board 18411243307).'),
        ),
  );

  root().append(buildHeader(), canvas, buildFooter());
}

// ─── Render: ledger (single client) ──────────────────────────────────
function renderLedger() {
  clearRoot();

  const c = (state.ledger && state.ledger.client) || {};
  const summary = (state.ledger && state.ledger.summary) || {};
  const invoices = (state.ledger && state.ledger.invoices) || [];
  const payments = (state.ledger && state.ledger.payments) || [];
  const adjustments = (state.ledger && state.ledger.adjustments) || [];
  const actions = (state.ledger && state.ledger.actions) || [];
  const paymentInfo = (state.ledger && state.ledger.paymentInfo) || null;

  const showBack = state.isAdmin;

  const canvas = el('main', { class: 'canvas' },
    el('div', { class: 'eyebrow' }, state.isAdmin ? 'Admin · Activity Ledger' : 'Activity Ledger'),
    el('h1', { class: 'h-display' }, c.name || 'Welcome'),

    // KPI cards
    el('div', { class: 'card-grid card-grid-4' },
      kpiCard('Outstanding balance', fmtMoney(summary.outstandingBalance), 'live'),
      kpiCard('Pending actions', summary.pendingActions != null ? String(summary.pendingActions) : '0', 'live'),
      kpiCard('Total billed', fmtMoney(summary.totalBilled), 'live'),
      kpiCard('Total activity', summary.totalActivity != null ? String(summary.totalActivity) : '0', 'live'),
    ),

    // Payment instructions (NEW in v0.3)
    paymentInfoSection(paymentInfo),

    // Invoices
    invoicesSection(invoices),

    // Payments
    paymentsSection(payments),

    // Adjustments (only if any)
    adjustments.length ? adjustmentsSection(adjustments) : null,

    // Actions / comments
    actionsSection(actions, invoices),
  );

  root().append(buildHeader({ showBackToPicker: showBack }), canvas, buildFooter());
}

function kpiCard(label, value, mode) {
  return el('div', { class: 'card' },
    el('div', { class: 'card-label' }, label),
    el('div', { class: 'card-value' + (mode === 'live' ? ' card-value-live' : '') }, value),
  );
}

// ─── Section: Payment Info (v0.4 — HANDS direct AR) ──────────────────
function paymentInfoSection(info) {
  if (!info || !info.instructions) return null;
  const ix = info.instructions;
  const ach = ix.ach || {};
  const check = ix.check || {};
  const paypal = ix.paypal || {};

  // PayPal block — primary CTA, gets its own row spanning the grid
  const paypalBlock = paypal.url ? el('div', { class: 'pay-paypal' },
    el('div', {},
      el('div', { class: 'card-label' }, 'PayPal'),
      el('div', { class: 'pay-info-val' }, paypal.label || 'Pay online'),
      paypal.note ? el('div', { class: 'pay-info-sub' }, paypal.note) : null,
    ),
    el('a', {
      href: paypal.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      class: 'btn-paypal',
    }, paypal.label || 'Pay by PayPal'),
  ) : null;

  // ACH block
  const achBlock = (ach.bank || ach.details_url) ? el('div', { class: 'pay-info-row' },
    el('div', { class: 'card-label' }, 'ACH / Wire'),
    ach.bank ? el('div', { class: 'pay-info-val' }, ach.bank + (ach.account_type ? ' · ' + ach.account_type : '')) : null,
    ach.details_url ? el('a', {
      href: ach.details_url,
      target: '_blank',
      rel: 'noopener noreferrer',
      class: 'pay-info-link',
    }, '↓ ' + (ach.details_label || 'Download AR letter (PDF)')) : null,
    ach.memo ? el('div', { class: 'pay-info-sub' }, 'Memo: ' + ach.memo) : null,
  ) : null;

  // Check block
  const checkBlock = check.payable_to ? el('div', { class: 'pay-info-row' },
    el('div', { class: 'card-label' }, 'Check'),
    el('div', { class: 'pay-info-val' }, 'Payable to ' + check.payable_to),
    check.mail_to ? el('div', { class: 'pay-info-sub' }, 'Mail to: ' + check.mail_to) : null,
    check.memo ? el('div', { class: 'pay-info-sub' }, 'Memo: ' + check.memo) : null,
  ) : null;

  // Remit + terms + EIN row
  const remitBlock = el('div', { class: 'pay-info-row' },
    el('div', { class: 'card-label' }, 'Remit To'),
    el('div', { class: 'pay-info-val' }, ix.remit_to || '—'),
    ix.remit_email ? el('div', { class: 'pay-info-sub mono' }, ix.remit_email) : null,
    ix.ein ? el('div', { class: 'pay-info-sub mono' }, 'EIN: ' + ix.ein) : null,
  );

  const termsBlock = el('div', { class: 'pay-info-row' },
    el('div', { class: 'card-label' }, 'Terms'),
    el('div', { class: 'pay-info-val' }, ix.terms || '—'),
  );

  const confidentialFooter = ix.confidential ? el('div', { class: 'pay-info-confidential' }, ix.confidential) : null;

  return el('section', { class: 'ledger-section' },
    el('div', { class: 'section-head' },
      el('div', { class: 'eyebrow' }, 'Payment Instructions'),
      el('h2', { class: 'section-title' }, 'How to Pay'),
    ),
    paypalBlock,
    el('div', { class: 'pay-info' },
      remitBlock,
      termsBlock,
      achBlock,
      checkBlock,
    ),
    confidentialFooter,
  );
}

// ─── Section: Activity (v0.6 — hybrid invoice + operational rows) ────
function invoicesSection(allRows) {
  // v0.9: apply search FIRST, then chip filter. Chip counts reflect the
  // search-narrowed dataset so users see "what's actually visible right now."
  const search = (state.activitySearch || '').trim().toLowerCase();
  const searched = search
    ? allRows.filter(r => matchesSearch(r, search))
    : allRows;

  const counts = {
    all: searched.length,
    invoices: searched.filter(r => r.kind === 'invoice').length,
    operational: searched.filter(r => r.kind === 'operational').length,
  };

  // Apply current filter chip
  const filter = state.activityFilter || 'all';
  const filtered = searched.filter(r => {
    if (filter === 'all') return true;
    if (filter === 'invoices') return r.kind === 'invoice';
    if (filter === 'operational') return r.kind === 'operational';
    return true;
  });

  const emptyMessage = search
    ? 'No matches for "' + search + '".'
    : ({
        all: 'No activity yet.',
        invoices: 'No invoices in the billing pipeline.',
        operational: 'No operational items right now.',
      }[filter]);

  const rows = filtered.length
    ? filtered.map(invoiceRow)
    : [el('tr', {}, el('td', { colspan: '7', class: 'empty-row' }, emptyMessage))];

  return el('section', { class: 'ledger-section' },
    el('div', { class: 'section-head' },
      el('div', { class: 'eyebrow' }, 'Activity'),
      el('h2', { class: 'section-title' }, 'Activity & Invoices'),
    ),
    el('div', { class: 'controls-row' },
      el('div', { class: 'filter-chips' },
        filterChip('all', 'All', counts.all),
        filterChip('invoices', 'Invoices', counts.invoices),
        filterChip('operational', 'Operational', counts.operational),
      ),
      searchInput(),
    ),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'ledger-table' },
        el('thead', {},
          el('tr', {},
            el('th', {}, 'PO'),
            el('th', {}, 'Invoice #'),
            el('th', {}, 'Project'),
            el('th', {}, 'Date'),
            el('th', {}, 'Status'),
            el('th', { class: 'num' }, 'Amount'),
            el('th', {}, ''),
          ),
        ),
        el('tbody', {}, rows),
      ),
    ),
  );
}

// Match a row against a lowercase search string. Searches project + po_id + account + invoice_number.
function matchesSearch(row, q) {
  if (!q) return true;
  const haystack = [
    row.project || '',
    row.po_id || '',
    row.id || '',
    row.account || '',
    row.invoice_number || '',
  ].join(' ').toLowerCase();
  return haystack.indexOf(q) !== -1;
}

function searchInput() {
  const wrapper = el('div', { class: 'search-wrap' });
  const input = el('input', {
    type: 'text',
    class: 'search-input',
    placeholder: 'Search project, PO, account…',
    value: state.activitySearch || '',
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: (ev) => {
      state.activitySearch = ev.target.value;
      // Re-render. Preserve focus/cursor by deferring to next tick.
      const cursor = ev.target.selectionStart;
      routeRender();
      // After re-render, find the new input and restore focus + cursor
      setTimeout(() => {
        const next = document.querySelector('.search-input');
        if (next) {
          next.focus();
          if (cursor != null) next.setSelectionRange(cursor, cursor);
        }
      }, 0);
    },
  });
  wrapper.appendChild(input);

  if (state.activitySearch) {
    wrapper.appendChild(el('button', {
      class: 'search-clear',
      type: 'button',
      title: 'Clear search',
      onclick: () => {
        state.activitySearch = '';
        routeRender();
      },
    }, '×'));
  }

  return wrapper;
}

function filterChip(value, label, count) {
  const isActive = (state.activityFilter || 'all') === value;
  return el('button', {
    class: 'filter-chip' + (isActive ? ' filter-chip-active' : ''),
    onclick: () => {
      state.activityFilter = value;
      // Re-render only the activity section. Easiest: re-render the whole ledger.
      routeRender();
    },
  },
    el('span', { class: 'filter-chip-label' }, label),
    el('span', { class: 'filter-chip-count' }, String(count)),
  );
}

function invoiceRow(inv) {
  const kind = inv.kind || 'invoice';
  const billingRaw = (inv.billing_raw || '').toUpperCase();
  const logisticsRaw = (inv.logistics_status || inv.logistics || '').toUpperCase();

  const amount = inv.invoice_amount > 0
    ? inv.invoice_amount
    : (inv.amount != null ? inv.amount : inv.estimate_amount);

  // Pay button only for billing rows in payable states.
  const isPayable = kind === 'invoice' &&
    ['SUBMITTED', 'INVOICE PENDING', 'READY TO SEND', 'PARTIAL BILL SUBMITTED'].includes(billingRaw);

  const actionCell = el('td', { class: 'action-cell' });
  if (isPayable && (inv.id || inv.po_id)) {
    actionCell.appendChild(el('button', {
      class: 'btn-pay',
      onclick: (ev) => onPayInvoice(ev, inv),
    }, 'Pay Invoice'));
  }
  if (state.isAdmin) {
    if (kind === 'invoice') {
      actionCell.appendChild(el('button', {
        class: 'btn-record-payment',
        title: 'Record a payment against this invoice',
        onclick: () => openRecordPaymentModal(inv),
      }, 'Record Payment'));
    }
    actionCell.appendChild(el('button', {
      class: 'btn-edit',
      onclick: () => openInvoiceEditor(inv),
    }, 'Edit'));
  }

  // Status pill: billing label for invoice rows, logistics label for
  // operational rows. Empty logistics fallback to "OPERATIONAL".
  let statusLabel, statusKind;
  if (kind === 'invoice') {
    statusLabel = billingRaw ? titleCase(billingRaw) : 'Draft';
    statusKind = statusClass(billingRaw);
  } else {
    statusLabel = logisticsRaw ? titleCase(logisticsRaw) : 'Operational';
    statusKind = logisticsClass(logisticsRaw);
  }

  // Amount cell: invoice rows show $; operational rows show em-dash unless
  // there's an estimate or invoice amount on file.
  const amountCell = (kind === 'invoice' || amount > 0)
    ? el('td', { class: 'num mono' }, fmtMoney(amount))
    : el('td', { class: 'num mono dim' }, '—');

  // Doc badge — paperclip + count if any documents attached
  const docCount = Array.isArray(inv.documents) ? inv.documents.length : 0;
  const poCell = el('td', { class: 'mono' });
  poCell.appendChild(document.createTextNode(inv.po_id || inv.id || '—'));
  if (docCount > 0) {
    poCell.appendChild(el('span', {
      class: 'doc-badge',
      title: docCount + ' document' + (docCount === 1 ? '' : 's'),
    }, '📎 ' + docCount));
  }

  // Date column (v0.9): if the project is complete, show completed_on.
  // Otherwise show the deadline. No fallback to issued_date — encourages
  // setting real deadlines on monday rather than papering over gaps.
  const isComplete =
    (kind === 'invoice' && billingRaw === 'FUNDED') ||
    (kind === 'operational' && ['COMPLETE', 'DELIVERED', 'DONE'].includes(logisticsRaw));
  const dateValue = isComplete ? (inv.completed_on || inv.due_date) : inv.due_date;

  return el('tr', { 'data-po': inv.po_id || '', 'data-kind': kind },
    poCell,
    el('td', { class: 'mono' }, inv.invoice_number || ''),
    el('td', {}, inv.project || '—'),
    el('td', { class: 'mono' }, fmtDate(dateValue)),
    el('td', {}, el('span', { class: 'status-pill status-' + statusKind }, statusLabel)),
    amountCell,
    actionCell,
  );
}

function statusClass(billingRaw) {
  const s = (billingRaw || '').toUpperCase();
  if (s === 'FUNDED') return 'good';
  if (s === 'CANCELLED' || s === 'NOT ACCEPTED') return 'bad';
  if (s === 'SUBMITTED' || s === 'PARTIAL BILL SUBMITTED' || s === 'INVOICE PENDING' || s === 'READY TO SEND') return 'warn';
  return 'neutral';
}

// Logistics status → pill color class. Operational rows only.
function logisticsClass(logisticsRaw) {
  const s = (logisticsRaw || '').toUpperCase();
  if (s === 'COMPLETE' || s === 'DELIVERED' || s === 'DONE') return 'good';
  if (s === 'CANCELLED' || s === 'CANCEL' || s === 'STUCK') return 'bad';
  if (s === 'OUT' || s === 'OUT FOR DELIVERY' || s === 'IN PROGRESS' || s === 'PROGRESS' || s === 'WORKING') return 'warn';
  if (s === 'HOLD' || s === 'ON HOLD') return 'op-hold';
  return 'op-neutral';
}

async function onPayInvoice(ev, inv) {
  const btn = ev.currentTarget;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Opening…';

  // If the datastore already has a per-invoice payment_url, use it directly.
  if (inv.payment_url) {
    window.location.href = inv.payment_url;
    return;
  }

  // Otherwise ask the backend to mint one (PayPal hosted button or whatever).
  try {
    const resp = await apiPost('/payments/initiate', {
      invoiceId: inv.id || inv.po_id,
    });
    if (resp.paymentUrl || resp.payment_url) {
      window.location.href = resp.paymentUrl || resp.payment_url;
    } else {
      throw new Error('No payment URL returned');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    showFlash('Could not initiate payment: ' + err.message, 'error');
  }
}

// ─── Section: Payments ───────────────────────────────────────────────
function paymentsSection(payments) {
  const rows = payments.length
    ? payments.map(p => el('tr', {},
        el('td', { class: 'mono' }, p.id || p.po_id || '—'),
        el('td', { class: 'mono' }, fmtDate(p.paid_date || p.date)),
        el('td', {}, p.method || p.type || '—'),
        el('td', { class: 'mono' }, p.po_id || p.applied_to || p.invoice_id || '—'),
        el('td', { class: 'num mono' }, fmtMoney(p.amount)),
      ))
    : [el('tr', {}, el('td', { colspan: '5', class: 'empty-row' }, 'No payments recorded.'))];

  return el('section', { class: 'ledger-section' },
    el('div', { class: 'section-head' },
      el('div', { class: 'eyebrow' }, 'Payments'),
      el('h2', { class: 'section-title' }, 'Payment History'),
    ),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'ledger-table' },
        el('thead', {},
          el('tr', {},
            el('th', {}, 'ID'),
            el('th', {}, 'Date'),
            el('th', {}, 'Method'),
            el('th', {}, 'Applied To'),
            el('th', { class: 'num' }, 'Amount'),
          ),
        ),
        el('tbody', {}, rows),
      ),
    ),
  );
}

// ─── Section: Adjustments ────────────────────────────────────────────
function adjustmentsSection(adjustments) {
  const rows = adjustments.map(a => el('tr', {},
    el('td', { class: 'mono' }, fmtDate(a.dated || a.date)),
    el('td', {}, a.type || '—'),
    el('td', {}, a.note || a.description || a.reason || '—'),
    el('td', { class: 'num mono' }, fmtMoney(a.amount)),
  ));

  return el('section', { class: 'ledger-section' },
    el('div', { class: 'section-head' },
      el('div', { class: 'eyebrow' }, 'Adjustments'),
      el('h2', { class: 'section-title' }, 'Credits & Debits'),
    ),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'ledger-table' },
        el('thead', {},
          el('tr', {},
            el('th', {}, 'Date'),
            el('th', {}, 'Type'),
            el('th', {}, 'Note'),
            el('th', { class: 'num' }, 'Amount'),
          ),
        ),
        el('tbody', {}, rows),
      ),
    ),
  );
}

// ─── Section: Actions / comments ─────────────────────────────────────
function actionsSection(actions, invoices) {
  const list = actions.length
    ? actions.map(a => el('div', { class: 'action-item' },
        el('div', { class: 'action-meta' },
          el('span', { class: 'mono' }, a.po_id || a.itemId || '—'),
          el('span', { class: 'mono dim' }, ' · '),
          el('span', { class: 'mono dim' }, fmtDate(a.at || a.date || a.createdAt)),
          a.author ? el('span', { class: 'mono dim' }, ' · ' + a.author) : null,
        ),
        el('div', { class: 'action-body' }, a.message || a.body || ''),
      ))
    : [el('div', { class: 'empty-row' }, 'No comments or actions yet.')];

  // Comment composer — needs a target PO. Use invoices list for the dropdown.
  const composer = el('form', { class: 'comment-form', onsubmit: (e) => onSubmitComment(e) },
    el('div', { class: 'comment-row' },
      el('select', { name: 'poId', class: 'comment-po', required: true },
        el('option', { value: '' }, 'Select a PO…'),
        invoices.map(inv => el('option', { value: inv.po_id || inv.id }, (inv.po_id || inv.id) + ' · ' + (inv.project || ''))),
      ),
    ),
    el('textarea', { name: 'message', class: 'comment-textarea', placeholder: 'Add a comment or question…', rows: '3', required: true }),
    el('div', { class: 'comment-actions' },
      el('button', { type: 'submit', class: 'btn-primary' }, 'Post Comment'),
    ),
  );

  return el('section', { class: 'ledger-section' },
    el('div', { class: 'section-head' },
      el('div', { class: 'eyebrow' }, 'Actions'),
      el('h2', { class: 'section-title' }, 'Comments & Updates'),
    ),
    el('div', { class: 'action-list' }, list),
    invoices.length ? composer : null,
  );
}

async function onSubmitComment(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const poId = form.poId.value;
  const message = form.message.value.trim();
  if (!poId || !message) return;
  const submitBtn = form.querySelector('button[type=submit]');
  const original = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Posting…';
  try {
    await apiPost('/actions', { poId: poId, message: message });
    form.message.value = '';
    showFlash('Comment posted', 'good');
    await loadLedger();
    routeRender();
  } catch (err) {
    showFlash('Could not post comment: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = original;
  }
}

// ─── Admin invoice editor (modal) ────────────────────────────────────
function openInvoiceEditor(inv) {
  const existing = document.getElementById('invoice-editor-modal');
  if (existing) existing.remove();

  const overlay = el('div', { class: 'modal-overlay', id: 'invoice-editor-modal',
    onclick: (e) => { if (e.target === overlay) closeInvoiceEditor(); },
  });

  const currentBilling = (inv.billing_raw || '').toUpperCase();
  const currentAmount = inv.invoice_amount != null && inv.invoice_amount !== 0
    ? inv.invoice_amount
    : (inv.amount != null ? inv.amount : '');

  const form = el('form', { class: 'modal-form', onsubmit: (e) => onSubmitInvoiceEdit(e, inv) },
    el('div', { class: 'eyebrow' }, 'Admin · Edit Invoice'),
    el('h2', { class: 'section-title' }, 'PO ' + (inv.po_id || '—')),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Invoice Number'),
      el('input', { type: 'text', name: 'invoiceNumber', value: inv.invoice_number || '', placeholder: 'e.g. INV-2026-001' }),
    ),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Project Name'),
      el('input', { type: 'text', name: 'projectName', value: inv.project || '' }),
    ),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Invoice Amount ($)'),
      el('input', { type: 'number', step: '0.01', name: 'invoiceAmount', value: currentAmount }),
    ),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Billing Status'),
      el('select', { name: 'billingStatus' },
        ['', 'NOT STARTED', 'ESTIMATE READY', 'ESTIMATE APPROVED', 'INVOICE PENDING',
          'SUBMITTED', 'PARTIAL BILL SUBMITTED', 'READY TO SEND', 'FUNDED', 'CANCELLED', 'NOT ACCEPTED']
        .map(s => el('option', {
          value: s,
          selected: (currentBilling === s) ? 'selected' : null,
        }, s || '— No change —')),
      ),
    ),

    // v0.8 — Documents section
    documentsField(inv),

    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn-signout-light', onclick: () => closeInvoiceEditor() }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn-primary' }, 'Save Changes'),
    ),
  );

  overlay.appendChild(form);
  document.body.appendChild(overlay);
}

function closeInvoiceEditor() {
  const m = document.getElementById('invoice-editor-modal');
  if (m) m.remove();
}

// ─── Level 3 Payments (v0.10) ────────────────────────────────────────
// Per-invoice payment list. Source order of preference:
//   1. inv.payments[]               (if portal-ledger emits per-invoice)
//   2. ledger.payments filtered     (fallback: shared list, filter by po_id)
function paymentsForInvoice(inv) {
  if (Array.isArray(inv.payments) && inv.payments.length) return inv.payments;
  const all = (state.ledger && state.ledger.payments) || [];
  const poId = inv.po_id || inv.id;
  if (!poId) return [];
  return all.filter(p => (p.po_id || p.applied_to || p.invoice_id) == poId);
}

function totalPaidForInvoice(inv) {
  if (typeof inv.totalPaid === 'number') return inv.totalPaid;
  return paymentsForInvoice(inv).reduce((s, p) => s + (Number(p.amount) || 0), 0);
}

function openRecordPaymentModal(inv) {
  const existing = document.getElementById('record-payment-modal');
  if (existing) existing.remove();

  const invoiceAmt = Number(inv.invoice_amount || inv.amount || 0);
  const paid = totalPaidForInvoice(inv);
  const balance = Math.max(0, invoiceAmt - paid);
  const todayIso = new Date().toISOString().slice(0, 10);

  const overlay = el('div', { class: 'modal-overlay', id: 'record-payment-modal',
    onclick: (e) => { if (e.target === overlay) closeRecordPaymentModal(); },
  });

  const existingPayments = paymentsForInvoice(inv);
  const historyRows = existingPayments.length
    ? existingPayments.map(p => el('div', { class: 'pay-history-row' },
        el('span', { class: 'mono' }, fmtDate(p.date || p.paid_date)),
        el('span', {}, p.method || '—'),
        el('span', { class: 'mono dim' }, p.ref || ''),
        el('span', { class: 'num mono' }, fmtMoney(p.amount)),
        p.id ? el('button', {
          type: 'button',
          class: 'btn-doc-delete',
          title: 'Remove this payment',
          onclick: () => onRemovePayment(inv, p),
        }, '×') : null,
      ))
    : [el('div', { class: 'doc-empty' }, 'No payments recorded yet.')];

  const form = el('form', { class: 'modal-form', onsubmit: (e) => onSubmitRecordPayment(e, inv) },
    el('div', { class: 'eyebrow' }, 'Admin · Record Payment'),
    el('h2', { class: 'section-title' }, 'PO ' + (inv.po_id || '—')),

    el('div', { class: 'pay-summary' },
      el('div', {},
        el('div', { class: 'card-label' }, 'Invoice'),
        el('div', { class: 'pay-summary-num' }, fmtMoney(invoiceAmt)),
      ),
      el('div', {},
        el('div', { class: 'card-label' }, 'Paid'),
        el('div', { class: 'pay-summary-num' }, fmtMoney(paid)),
      ),
      el('div', {},
        el('div', { class: 'card-label' }, 'Balance'),
        el('div', { class: 'pay-summary-num pay-summary-balance' + (balance <= 0.01 ? ' pay-summary-paid' : '') },
          fmtMoney(balance)),
      ),
    ),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Amount ($)'),
      el('input', { type: 'number', step: '0.01', min: '0.01', name: 'amount',
        value: balance > 0 ? balance.toFixed(2) : '', required: true,
        placeholder: '0.00' }),
    ),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Method'),
      el('select', { name: 'method', required: true },
        ['PayPal', 'ACH', 'Check', 'Wire', 'Cash', 'Other']
          .map(m => el('option', { value: m }, m)),
      ),
    ),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Date'),
      el('input', { type: 'date', name: 'date', value: todayIso, required: true }),
    ),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Reference (check #, confirmation #, etc.)'),
      el('input', { type: 'text', name: 'ref', placeholder: 'optional' }),
    ),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Note'),
      el('input', { type: 'text', name: 'note', placeholder: 'optional' }),
    ),

    el('div', { class: 'field' },
      el('span', { class: 'card-label' }, 'Payment History'),
      el('div', { class: 'pay-history' }, historyRows),
    ),

    el('div', { class: 'modal-prose-dim' },
      'Recording a payment writes to the Payments column on monday. ',
      'When the running total reaches the invoice amount, BILLING STATUS auto-flips to FUNDED.',
    ),

    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn-signout-light', onclick: () => closeRecordPaymentModal() }, 'Close'),
      el('button', { type: 'submit', class: 'btn-primary' }, 'Record Payment'),
    ),
  );

  overlay.appendChild(form);
  document.body.appendChild(overlay);
}

function closeRecordPaymentModal() {
  const m = document.getElementById('record-payment-modal');
  if (m) m.remove();
}

async function onSubmitRecordPayment(ev, inv) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const amount = parseFloat(form.amount.value);
  const method = form.method.value;
  const date = form.date.value;
  const ref = form.ref.value.trim();
  const note = form.note.value.trim();

  if (!isFinite(amount) || amount <= 0) {
    showFlash('Amount must be greater than 0', 'error');
    return;
  }
  if (!date) {
    showFlash('Date is required', 'error');
    return;
  }

  const submitBtn = form.querySelector('button[type=submit]');
  const original = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  try {
    const resp = await apiPost('/admin/record-payment', {
      poId: inv.po_id || inv.id,
      amount, method, date, ref, note,
    });
    closeRecordPaymentModal();
    showFlash('Payment recorded — total paid: ' + fmtMoney(resp.totalPaid || 0), 'good');
    // Refresh ledger. The webhook will have flipped status by the time the
    // refresh hits monday (typically <1s); re-fetch picks it up.
    await loadLedger();
    routeRender();
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = original;
    showFlash('Could not record payment: ' + err.message, 'error');
  }
}

async function onRemovePayment(inv, p) {
  if (!p.id) {
    showFlash('This payment has no id and cannot be removed from the portal.', 'error');
    return;
  }
  if (!confirm('Remove ' + fmtMoney(p.amount) + ' payment from ' + fmtDate(p.date || p.paid_date) + '?')) return;
  try {
    await apiPost('/admin/record-payment', {
      poId: inv.po_id || inv.id,
      action: 'remove',
      removeId: p.id,
    });
    closeRecordPaymentModal();
    showFlash('Payment removed', 'good');
    await loadLedger();
    routeRender();
  } catch (err) {
    showFlash('Could not remove: ' + err.message, 'error');
  }
}

// ─── Documents (v0.8) ────────────────────────────────────────────────
function documentsField(inv) {
  const docs = Array.isArray(inv.documents) ? inv.documents.slice() : [];

  const list = el('div', { class: 'doc-list', id: 'doc-list-' + (inv.po_id || 'x') },
    docs.length
      ? docs.map(d => docRow(inv, d))
      : el('div', { class: 'doc-empty' }, 'No documents attached.'),
  );

  // File input (hidden) + drop zone label triggers it
  const fileInput = el('input', {
    type: 'file',
    multiple: 'multiple',
    style: 'display: none',
    id: 'doc-upload-input-' + (inv.po_id || 'x'),
    onchange: (ev) => onPickFiles(ev, inv),
  });

  const dropZone = el('label', {
    class: 'upload-zone',
    for: fileInput.id,
    ondragover: (ev) => { ev.preventDefault(); ev.currentTarget.classList.add('upload-zone-active'); },
    ondragleave: (ev) => { ev.currentTarget.classList.remove('upload-zone-active'); },
    ondrop: (ev) => {
      ev.preventDefault();
      ev.currentTarget.classList.remove('upload-zone-active');
      const files = Array.from(ev.dataTransfer && ev.dataTransfer.files || []);
      if (files.length) uploadFiles(files, inv);
    },
  },
    el('div', { class: 'upload-zone-icon' }, '↑'),
    el('div', { class: 'upload-zone-label' }, 'Drop files or click to upload'),
    el('div', { class: 'upload-zone-hint' }, 'PDF, image, or document — any type, up to 25MB each'),
  );

  // Live progress area populated during upload
  const progress = el('div', { class: 'upload-progress', id: 'upload-progress-' + (inv.po_id || 'x') });

  return el('div', { class: 'field doc-field' },
    el('span', { class: 'card-label' }, 'Documents'),
    list,
    fileInput,
    dropZone,
    progress,
  );
}

function docRow(inv, d) {
  const sizeText = d.bytes ? ' · ' + formatBytes(d.bytes) : '';
  return el('div', { class: 'doc-row', 'data-public-id': d.public_id },
    el('a', {
      href: d.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      class: 'doc-link',
    },
      el('span', { class: 'doc-icon' }, '📄'),
      el('span', { class: 'doc-name' }, d.filename || d.public_id),
    ),
    el('div', { class: 'doc-meta' },
      el('span', { class: 'doc-kind' }, d.kind || 'other'),
      el('span', { class: 'doc-bytes' }, sizeText),
    ),
    el('button', {
      type: 'button',
      class: 'btn-doc-delete',
      title: 'Remove document',
      onclick: (ev) => onDeleteDoc(ev, inv, d),
    }, '×'),
  );
}

function formatBytes(b) {
  if (!b || isNaN(b)) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

function onPickFiles(ev, inv) {
  const files = Array.from(ev.target.files || []);
  if (!files.length) return;
  uploadFiles(files, inv);
  ev.target.value = '';   // allow re-picking the same file later
}

async function uploadFiles(files, inv) {
  const progressArea = document.getElementById('upload-progress-' + (inv.po_id || 'x'));
  if (!progressArea) return;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const id = 'prog-' + Date.now() + '-' + i;
    const row = el('div', { class: 'upload-row', id: id },
      el('span', { class: 'upload-row-name' }, file.name),
      el('span', { class: 'upload-row-status' }, 'Uploading…'),
    );
    progressArea.appendChild(row);

    try {
      // 1. Direct upload to Cloudinary
      const cloudResult = await uploadToCloudinary(file);

      // 2. Tell our backend to record it on the monday item
      const meta = await apiPost('/admin/documents?action=upload-meta', {
        poId: inv.po_id || inv.id,
        document: {
          public_id: cloudResult.public_id,
          secure_url: cloudResult.secure_url,
          original_filename: cloudResult.original_filename || file.name,
          format: cloudResult.format || (file.name.split('.').pop() || ''),
          bytes: cloudResult.bytes || file.size,
          kind: 'other',
          uploaded_at: new Date().toISOString(),
        },
      });

      // 3. Update progress row to success + append to live doc list
      row.querySelector('.upload-row-status').textContent = 'Done';
      row.classList.add('upload-row-done');
      setTimeout(() => row.remove(), 2000);

      // Optimistically add to the doc list visible in the modal
      const listEl = document.getElementById('doc-list-' + (inv.po_id || 'x'));
      if (listEl) {
        const empty = listEl.querySelector('.doc-empty');
        if (empty) empty.remove();
        // Mutate the in-memory inv so the list reflects what was uploaded
        inv.documents = Array.isArray(inv.documents) ? inv.documents : [];
        inv.documents.push(meta.document);
        listEl.appendChild(docRow(inv, meta.document));
      }
    } catch (err) {
      row.querySelector('.upload-row-status').textContent = 'Failed: ' + err.message;
      row.classList.add('upload-row-error');
      // Don't auto-remove failure rows — admin should see what went wrong
    }
  }
}

async function uploadToCloudinary(file) {
  const url = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/auto/upload';
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', CLOUDINARY_DOC_PRESET);
  fd.append('folder', CLOUDINARY_DOC_FOLDER);

  const res = await fetch(url, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error((data.error && data.error.message) || ('Cloudinary HTTP ' + res.status));
  }
  return data;
}

async function onDeleteDoc(ev, inv, d) {
  ev.preventDefault();
  ev.stopPropagation();
  if (!confirm('Remove "' + (d.filename || d.public_id) + '"?')) return;

  const row = ev.currentTarget.closest('.doc-row');
  if (row) row.style.opacity = '0.5';

  try {
    await apiPost('/admin/documents?action=delete', {
      poId: inv.po_id || inv.id,
      public_id: d.public_id,
    });
    if (row) row.remove();
    // Remove from in-memory list too
    if (Array.isArray(inv.documents)) {
      inv.documents = inv.documents.filter(x => x.public_id !== d.public_id);
    }
    // If list is now empty, restore "No documents attached."
    const listEl = document.getElementById('doc-list-' + (inv.po_id || 'x'));
    if (listEl && listEl.children.length === 0) {
      listEl.appendChild(el('div', { class: 'doc-empty' }, 'No documents attached.'));
    }
    showFlash('Document removed', 'good');
  } catch (err) {
    if (row) row.style.opacity = '1';
    showFlash('Could not remove: ' + err.message, 'error');
  }
}

// ─── Admin invite modal ──────────────────────────────────────────────
function openInviteModal(c) {
  const existing = document.getElementById('invite-modal');
  if (existing) existing.remove();

  const cid = c.clientId || c.id || '';
  const displayName = c.name || cid || 'this client';

  // The picker payload only carries clientId + name + summary. The recipient
  // email lives in the Registry — the backend looks it up. We tell the admin
  // what's about to happen and confirm.
  const overlay = el('div', { class: 'modal-overlay', id: 'invite-modal',
    onclick: (e) => { if (e.target === overlay) closeInviteModal(); },
  });

  const form = el('form', { class: 'modal-form', onsubmit: (e) => onSubmitInvite(e, cid, displayName) },
    el('div', { class: 'eyebrow' }, 'Admin · Send Portal Invite'),
    el('h2', { class: 'section-title' }, displayName),

    el('p', { class: 'modal-prose' },
      'Send a portal invitation email to the address registered for ',
      el('strong', {}, displayName),
      '. The email comes from ',
      el('span', { class: 'mono' }, 'jon@handslogistics.com'),
      ' and includes the portal URL, the email address they must use to sign in, and a brief overview of what the portal does.',
    ),

    el('p', { class: 'modal-prose-dim' },
      'The recipient address comes from the Portal Registry on monday.com. To change it, edit the Registry row first, then send the invite.',
    ),

    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn-signout-light', onclick: () => closeInviteModal() }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn-primary' }, 'Send Invite'),
    ),
  );

  overlay.appendChild(form);
  document.body.appendChild(overlay);
}

function closeInviteModal() {
  const m = document.getElementById('invite-modal');
  if (m) m.remove();
}

async function onSubmitInvite(ev, clientId, displayName) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const submitBtn = form.querySelector('button[type=submit]');
  const original = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';

  try {
    const resp = await apiPost('/admin/invite', { clientId: clientId });
    closeInviteModal();
    showFlash('Invite sent to ' + (resp.sentTo || displayName), 'good');
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = original;
    showFlash('Could not send invite: ' + err.message, 'error');
  }
}

async function onSubmitInvoiceEdit(ev, inv) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const body = { poId: inv.po_id };
  const projectName = form.projectName.value.trim();
  const invoiceAmount = form.invoiceAmount.value;
  const billingStatus = form.billingStatus.value;
  const invoiceNumber = form.invoiceNumber.value.trim();

  if (projectName !== (inv.project || '')) body.projectName = projectName;
  if (invoiceNumber !== (inv.invoice_number || '')) body.invoiceNumber = invoiceNumber;
  const currentNum = Number(inv.invoice_amount || inv.amount || 0);
  if (invoiceAmount !== '' && Number(invoiceAmount) !== currentNum) {
    body.invoiceAmount = Number(invoiceAmount);
  }
  if (billingStatus) body.billingStatus = billingStatus;

  const submitBtn = form.querySelector('button[type=submit]');
  const original = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  try {
    const resp = await apiPost('/admin/invoices', body);
    closeInvoiceEditor();
    const changeCount = resp.changes
      ? (Array.isArray(resp.changes) ? resp.changes.length : Object.keys(resp.changes).length)
      : 0;
    showFlash(changeCount ? ('Saved ' + changeCount + ' change' + (changeCount === 1 ? '' : 's')) : 'No changes', 'good');
    await loadLedger();
    routeRender();
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = original;
    showFlash('Could not save: ' + err.message, 'error');
  }
}

// ─── Flash message ───────────────────────────────────────────────────
function showFlash(message, kind) {
  const existing = document.getElementById('portal-flash');
  if (existing) existing.remove();
  const flash = el('div', {
    class: 'portal-flash flash-' + (kind || 'neutral'),
    id: 'portal-flash',
  }, message);
  document.body.appendChild(flash);
  setTimeout(() => {
    flash.classList.add('flash-fade');
    setTimeout(() => flash.remove(), 400);
  }, 3000);
}

// ─── Render: registry error ──────────────────────────────────────────
function renderRegistryError(message) {
  clearRoot();
  const canvas = el('main', { class: 'canvas' },
    el('div', { class: 'error-banner' },
      el('strong', {}, 'Sign-in succeeded, but: '),
      message || 'Could not load ledger.',
      el('br'), el('br'),
      'If this is your first time signing in, contact Jon to be added to the registry. Otherwise, try refreshing — this can happen briefly during a redeploy.',
    ),
  );
  root().append(buildHeader(), canvas);
}

function showError(message) {
  clearRoot();
  root().appendChild(el('div', { class: 'error-banner' }, message));
}
