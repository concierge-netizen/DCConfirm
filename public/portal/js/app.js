/* HANDS Client Portal — v0.2 (live data)
 * Renders the monday-backed payload from /portal/api/ledger.
 * Branches:
 *   - Admin user, no ?clientId= in URL  → adminPicker grid
 *   - clientId set (or non-admin user)  → real ledger view
 * Wires:
 *   - Pay Invoice         → POST /portal/api/payments/initiate
 *   - Admin invoice edit  → POST /portal/api/admin/invoices
 *   - Client comment      → POST /portal/api/actions
 */

const state = { token: null, user: null, isAdmin: false, ledger: null, clientId: null };

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
  const path = cid ? ('/ledger?clientId=' + encodeURIComponent(cid)) : '/ledger';
  state.ledger = await apiGet(path);
  state.isAdmin = !!state.ledger.isAdmin;
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

  // Refresh token periodically
  setInterval(async () => {
    try { state.token = await window.Clerk.session.getToken(); } catch (_) {}
  }, 50 * 1000);

  state.clientId = getQueryParam('clientId');

  try {
    await loadLedger();
  } catch (err) {
    return renderRegistryError(err.message);
  }

  routeRender();
}

window.initApp = initApp;

// Re-render on back/forward
window.addEventListener('popstate', () => {
  state.clientId = getQueryParam('clientId');
  loadLedger().then(routeRender).catch(err => renderRegistryError(err.message));
});

// ─── Top-level router ────────────────────────────────────────────────
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
  if (state.isAdmin) userChipChildren.push(el('span', { class: 'admin-pill' }, 'Admin'));
  if (opts.showBackToPicker) {
    userChipChildren.push(el('button', {
      class: 'btn-signout',
      onclick: () => { setClientIdInUrl(null); state.clientId = null; loadLedger().then(routeRender).catch(err => renderRegistryError(err.message)); },
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
    'HANDS Logistics · Las Vegas · Client Portal v0.2',
  );
}

// ─── Render: admin picker ────────────────────────────────────────────
function renderAdminPicker() {
  clearRoot();
  const picker = state.ledger.adminPicker || {};
  const clients = picker.clients || [];

  const cards = clients.map(c => {
    const summary = c.summary || {};
    return el('button', {
      class: 'client-card',
      onclick: () => {
        const cid = c.clientId || c.id;
        setClientIdInUrl(cid);
        state.clientId = cid;
        clearRoot();
        root().appendChild(el('div', { class: 'loading' }, 'Loading ledger…'));
        loadLedger().then(routeRender).catch(err => renderRegistryError(err.message));
      },
    },
      el('div', { class: 'eyebrow' }, c.clientId || c.id || ''),
      el('div', { class: 'client-card-name' }, c.name || c.clientId || 'Unnamed'),
      el('div', { class: 'client-card-meta' },
        el('div', {},
          el('div', { class: 'card-label' }, 'Outstanding'),
          el('div', { class: 'client-card-num' }, fmtMoney(summary.outstandingBalance)),
        ),
        el('div', {},
          el('div', { class: 'card-label' }, 'Pending'),
          el('div', { class: 'client-card-num' }, summary.pendingActions != null ? summary.pendingActions : '0'),
        ),
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

  const showBack = state.isAdmin;

  const canvas = el('main', { class: 'canvas' },
    el('div', { class: 'eyebrow' }, state.isAdmin ? 'Admin · Activity Ledger' : 'Activity Ledger'),
    el('h1', { class: 'h-display' }, c.name || 'Welcome'),

    // KPI cards
    el('div', { class: 'card-grid' },
      kpiCard('Outstanding balance', fmtMoney(summary.outstandingBalance), 'live'),
      kpiCard('Pending actions', summary.pendingActions != null ? String(summary.pendingActions) : '0', 'live'),
      kpiCard('Total billed', fmtMoney(summary.totalBilled), 'live'),
    ),

    // Invoices
    invoicesSection(invoices),

    // Payments
    paymentsSection(payments),

    // Adjustments (only render if any)
    adjustments.length ? adjustmentsSection(adjustments) : null,

    // Actions / comments
    actionsSection(actions),
  );

  root().append(buildHeader({ showBackToPicker: showBack }), canvas, buildFooter());
}

function kpiCard(label, value, mode) {
  return el('div', { class: 'card' },
    el('div', { class: 'card-label' }, label),
    el('div', { class: 'card-value' + (mode === 'live' ? ' card-value-live' : '') }, value),
  );
}

// ─── Section: Invoices ───────────────────────────────────────────────
function invoicesSection(invoices) {
  const rows = invoices.length
    ? invoices.map(invoiceRow)
    : [el('tr', {}, el('td', { colspan: '6', class: 'empty-row' }, 'No invoices yet.'))];

  return el('section', { class: 'ledger-section' },
    el('div', { class: 'section-head' },
      el('div', { class: 'eyebrow' }, 'Invoices'),
      el('h2', { class: 'section-title' }, 'Billing Activity'),
    ),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'ledger-table' },
        el('thead', {},
          el('tr', {},
            el('th', {}, 'PO'),
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

function invoiceRow(inv) {
  const status = (inv.billingStatus || inv.status || '').toUpperCase();
  const amount = inv.invoiceAmount != null ? inv.invoiceAmount : inv.amount;
  const isPayable = ['SUBMITTED', 'INVOICE PENDING', 'READY TO SEND', 'PARTIAL BILL SUBMITTED'].includes(status);

  const actionCell = el('td', { class: 'action-cell' });
  if (isPayable && (inv.invoiceId || inv.poId)) {
    actionCell.appendChild(el('button', {
      class: 'btn-pay',
      onclick: (ev) => onPayInvoice(ev, inv),
    }, 'Pay Invoice'));
  }
  if (state.isAdmin) {
    actionCell.appendChild(el('button', {
      class: 'btn-edit',
      onclick: () => openInvoiceEditor(inv),
    }, 'Edit'));
  }

  return el('tr', { 'data-po': inv.poId || '' },
    el('td', { class: 'mono' }, inv.poId || inv.invoiceId || '—'),
    el('td', {}, inv.projectName || inv.project || '—'),
    el('td', { class: 'mono' }, fmtDate(inv.date || inv.invoiceDate || inv.serviceDate)),
    el('td', {}, el('span', { class: 'status-pill status-' + statusClass(status) }, status || '—')),
    el('td', { class: 'num mono' }, fmtMoney(amount)),
    actionCell,
  );
}

function statusClass(status) {
  const s = (status || '').toUpperCase();
  if (s === 'FUNDED' || s === 'PAID') return 'good';
  if (s === 'CANCELLED' || s === 'NOT ACCEPTED') return 'bad';
  if (s === 'SUBMITTED' || s === 'PARTIAL BILL SUBMITTED' || s === 'INVOICE PENDING' || s === 'READY TO SEND') return 'warn';
  return 'neutral';
}

async function onPayInvoice(ev, inv) {
  const btn = ev.currentTarget;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Opening…';
  try {
    const resp = await apiPost('/payments/initiate', {
      invoiceId: inv.invoiceId || inv.poId,
    });
    if (resp.paymentUrl) {
      window.location.href = resp.paymentUrl;
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
        el('td', { class: 'mono' }, p.paymentId || p.id || '—'),
        el('td', { class: 'mono' }, fmtDate(p.date || p.paymentDate)),
        el('td', {}, p.method || p.type || '—'),
        el('td', {}, p.appliedTo || p.invoiceId || '—'),
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
    el('td', { class: 'mono' }, fmtDate(a.date)),
    el('td', {}, a.type || '—'),
    el('td', {}, a.note || a.description || '—'),
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
function actionsSection(actions) {
  const list = actions.length
    ? actions.map(a => el('div', { class: 'action-item' },
        el('div', { class: 'action-meta' },
          el('span', { class: 'mono' }, a.poId || a.itemId || '—'),
          el('span', { class: 'mono dim' }, ' · '),
          el('span', { class: 'mono dim' }, fmtDate(a.date || a.createdAt)),
          a.author ? el('span', { class: 'mono dim' }, ' · ' + a.author) : null,
        ),
        el('div', { class: 'action-body' }, a.message || a.body || ''),
      ))
    : [el('div', { class: 'empty-row' }, 'No comments or actions yet.')];

  // Comment composer — needs a target PO. Use current selection or first invoice.
  const invoices = (state.ledger && state.ledger.invoices) || [];
  const composer = el('form', { class: 'comment-form', onsubmit: (e) => onSubmitComment(e) },
    el('div', { class: 'comment-row' },
      el('select', { name: 'poId', class: 'comment-po', required: true },
        el('option', { value: '' }, 'Select a PO…'),
        invoices.map(inv => el('option', { value: inv.poId || inv.invoiceId }, (inv.poId || inv.invoiceId) + ' · ' + (inv.projectName || ''))),
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
    // Reload ledger to show the new action
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
  // Remove any existing modal
  const existing = document.getElementById('invoice-editor-modal');
  if (existing) existing.remove();

  const overlay = el('div', { class: 'modal-overlay', id: 'invoice-editor-modal',
    onclick: (e) => { if (e.target === overlay) closeInvoiceEditor(); },
  });

  const form = el('form', { class: 'modal-form', onsubmit: (e) => onSubmitInvoiceEdit(e, inv) },
    el('div', { class: 'eyebrow' }, 'Admin · Edit Invoice'),
    el('h2', { class: 'section-title' }, 'PO ' + (inv.poId || '—')),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Project Name'),
      el('input', { type: 'text', name: 'projectName', value: inv.projectName || '' }),
    ),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Invoice Amount ($)'),
      el('input', { type: 'number', step: '0.01', name: 'invoiceAmount',
        value: inv.invoiceAmount != null ? inv.invoiceAmount : (inv.amount != null ? inv.amount : '') }),
    ),

    el('label', { class: 'field' },
      el('span', { class: 'card-label' }, 'Billing Status'),
      el('select', { name: 'billingStatus' },
        ['', 'NOT STARTED', 'ESTIMATE READY', 'ESTIMATE APPROVED', 'INVOICE PENDING',
          'SUBMITTED', 'PARTIAL BILL SUBMITTED', 'READY TO SEND', 'FUNDED', 'CANCELLED', 'NOT ACCEPTED']
        .map(s => el('option', {
          value: s,
          selected: ((inv.billingStatus || '').toUpperCase() === s) ? 'selected' : null,
        }, s || '— No change —')),
      ),
    ),

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

async function onSubmitInvoiceEdit(ev, inv) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const body = { poId: inv.poId };
  const projectName = form.projectName.value.trim();
  const invoiceAmount = form.invoiceAmount.value;
  const billingStatus = form.billingStatus.value;

  if (projectName !== (inv.projectName || '')) body.projectName = projectName;
  if (invoiceAmount !== '' && Number(invoiceAmount) !== Number(inv.invoiceAmount || inv.amount || 0)) {
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
    const changeCount = resp.changes ? Object.keys(resp.changes).length : 0;
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
