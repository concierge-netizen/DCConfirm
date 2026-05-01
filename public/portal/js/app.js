/* HANDS Client Portal — Hollow shell frontend
 * Handles Clerk auth, renders sign-in or signed-in shell.
 * Calls /portal/api/* endpoints which return shellMode placeholders.
 */

const state = { token: null, user: null, isAdmin: false, ledger: null, error: null };

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
    if (c == null) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}

function root() { return document.getElementById('root'); }

function clearRoot() { root().innerHTML = ''; }

// ─── API ────────────────────────────────────────────────────────────
async function api(path) {
  const resp = await fetch(`/portal/api${path}`, {
    headers: { 'Authorization': `Bearer ${state.token}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

// ─── Auth init (called by index.html after Clerk SDK loads) ─────────
async function initApp() {
  try {
    await window.Clerk.load();
  } catch (err) {
    return showError(`Clerk failed to initialize: ${err.message}`);
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

  // Try to load ledger; surface registry errors gracefully
  try {
    state.ledger = await api('/ledger');
    state.isAdmin = !!state.ledger.isAdmin;
  } catch (err) {
    return renderRegistryError(err.message);
  }

  renderShell();
}

window.initApp = initApp;

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

  // Mount Clerk's hosted sign-in component, telling it to redirect back to /portal
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
    // Fallback if SDK didn't expose mountSignIn (older versions)
    const mount = document.getElementById('clerk-mount');
    mount.innerHTML = '<a href="' + (window.Clerk?.frontendApi || '#') + '" class="btn-signout" style="color:#1a1a1a;border-color:#1a1a1a;text-decoration:none;display:inline-block;">Open Clerk sign-in</a>';
  }
}

// ─── Render: signed-in shell ─────────────────────────────────────────
function renderShell() {
  clearRoot();

  const header = el('header', { class: 'portal-header' },
    el('div', { class: 'brand' },
      el('div', { class: 'brand-mark' }, 'H'),
      el('div', { class: 'brand-text' },
        'HANDS Logistics',
        el('small', {}, 'Client Portal'),
      ),
    ),
    el('div', { class: 'user-chip' },
      el('span', {}, (window.Clerk?.user?.primaryEmailAddress?.emailAddress) || ''),
      el('button', { class: 'btn-signout', onclick: () => window.Clerk.signOut().then(() => location.reload()) }, 'Sign out'),
    ),
  );

  const c = state.ledger?.client || {};
  const summary = state.ledger?.summary || {};

  const canvas = el('main', { class: 'canvas' },
    el('div', { class: 'eyebrow' }, state.isAdmin ? 'Admin · Activity Ledger' : 'Activity Ledger'),
    el('h1', { class: 'h-display' }, c.name || 'Welcome'),

    el('div', { class: 'shell-notice' },
      el('div', { class: 'eyebrow' }, 'Shell mode'),
      el('h2', {}, 'Connecting to data sources'),
      el('p', {}, 'Your portal is live and authenticated. Activity, invoices, payments, and dispute tools will appear here once the data layer is connected. No action needed on your end — we\'ll notify you when it\'s ready.'),
    ),

    el('div', { class: 'card-grid' },
      placeholderCard('Outstanding'),
      placeholderCard('Past due'),
      placeholderCard('Open requests'),
      placeholderCard('Last activity'),
    ),
  );

  const footer = el('footer', { class: 'portal-footer' },
    'HANDS Logistics · Las Vegas · Client Portal v0.1 (shell)',
  );

  root().append(header, canvas, footer);
}

function placeholderCard(label) {
  return el('div', { class: 'card' },
    el('div', { class: 'card-label' }, label),
    el('div', { class: 'card-value' }, '—'),
  );
}

// ─── Render: registry error ──────────────────────────────────────────
function renderRegistryError(message) {
  clearRoot();

  const header = el('header', { class: 'portal-header' },
    el('div', { class: 'brand' },
      el('div', { class: 'brand-mark' }, 'H'),
      el('div', { class: 'brand-text' }, 'HANDS Logistics', el('small', {}, 'Client Portal')),
    ),
    el('div', { class: 'user-chip' },
      el('button', { class: 'btn-signout', onclick: () => window.Clerk.signOut().then(() => location.reload()) }, 'Sign out'),
    ),
  );

  const canvas = el('main', { class: 'canvas' },
    el('div', { class: 'error-banner' },
      el('strong', {}, 'Sign-in succeeded, but: '),
      message || 'Your account is not in the registry yet.',
      el('br'),
      el('br'),
      'During shell mode, only allowlisted admin emails can access the portal. Contact Jon to be added.',
    ),
  );

  root().append(header, canvas);
}

function showError(message) {
  clearRoot();
  root().appendChild(
    el('div', { class: 'error-banner' }, message),
  );
}
