// ── activation-proposals.js ─────────────────────────────────────
// Single fan-out function for the Activations system.
//
// Actions:
//   - save             → upsert a proposal record (returns slug)
//   - load             → return one proposal by slug
//   - list             → return all proposals (most recent first)
//   - saveRecap        → write/update the .recap field on an existing proposal
//   - unpublishRecap   → set recap.published = false (data preserved)
//   - accept           → client-side accept (sets status=accepted)
//   - request_changes  → client-side change-request (sets status=changes_requested)
//
// Storage: GitHub Contents API → concierge-netizen/DCConfirm
// Files:
//   data/activations/index.json       — list of all slugs + metadata
//   data/activations/<slug>.json      — full proposal record
//
// Same pattern as save-workorder / catalog / inventory from Phase 7 wave 1.
// ─────────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'concierge-netizen';
const REPO  = 'DCConfirm';
const BRANCH = 'main';
const DATA_DIR = 'data/activations';
const INDEX_PATH = `${DATA_DIR}/index.json`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ── GitHub helpers ────────────────────────────────────────────
async function ghGet(path) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'hands-activations'
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GH GET ${path}: HTTP ${res.status}`);
  const meta = await res.json();
  // content is base64 with newlines; decode
  const content = Buffer.from(meta.content || '', 'base64').toString('utf8');
  return { sha: meta.sha, content };
}

async function ghPut(path, content, message, sha) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const body = {
    message,
    branch: BRANCH,
    content: Buffer.from(content, 'utf8').toString('base64')
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'hands-activations'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GH PUT ${path}: HTTP ${res.status} — ${txt.substring(0, 200)}`);
  }
  return res.json();
}

// ── Slug helpers ──────────────────────────────────────────────
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60) || 'activation';
}

function randomSuffix(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function ensureUniqueSlug(base) {
  // Try base, then base-<3rand>, then base-<5rand>.
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomSuffix(attempt === 1 ? 3 : 5)}`;
    const existing = await ghGet(`${DATA_DIR}/${candidate}.json`);
    if (!existing) return candidate;
  }
  // Last resort
  return `${base}-${randomSuffix(8)}`;
}

// ── Index file (a single JSON list of summaries) ─────────────
async function readIndex() {
  const file = await ghGet(INDEX_PATH);
  if (!file) return { sha: null, entries: [] };
  try {
    const parsed = JSON.parse(file.content);
    return { sha: file.sha, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { sha: file.sha, entries: [] };
  }
}

async function writeIndex(entries, sha) {
  const content = JSON.stringify({ entries, updatedAt: new Date().toISOString() }, null, 2);
  return ghPut(INDEX_PATH, content, 'Update activations index', sha);
}

function summarize(proposal) {
  return {
    slug: proposal.slug,
    client: proposal.client || '',
    projectName: proposal.projectName || '',
    contact: proposal.contact || '',
    email: proposal.email || '',
    proposalDate: proposal.proposalDate || '',
    status: proposal.status || 'sent',
    recapPublished: !!(proposal.recap && proposal.recap.published),
    recapExists: !!proposal.recap,
    createdAt: proposal.createdAt || new Date().toISOString(),
    updatedAt: proposal.updatedAt || new Date().toISOString()
  };
}

async function upsertIndexEntry(proposal) {
  const idx = await readIndex();
  const entries = idx.entries.filter(e => e.slug !== proposal.slug);
  entries.unshift(summarize(proposal));
  // Sort by updatedAt desc
  entries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  await writeIndex(entries, idx.sha);
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method not allowed' };

  if (!GITHUB_TOKEN) {
    return jsonResponse(500, { error: 'GITHUB_TOKEN env var not configured on Netlify' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }

  const action = body.action;

  try {
    switch (action) {
      case 'save':            return await handleSave(body);
      case 'load':            return await handleLoad(body);
      case 'list':            return await handleList(body);
      case 'saveRecap':       return await handleSaveRecap(body);
      case 'unpublishRecap':  return await handleUnpublishRecap(body);
      case 'accept':          return await handleStatusUpdate(body, 'accepted');
      case 'request_changes': return await handleStatusUpdate(body, 'changes_requested');
      default:
        return jsonResponse(400, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('activation-proposals error:', err);
    return jsonResponse(500, { error: err.message });
  }
};

// ── Handlers ─────────────────────────────────────────────────
async function handleSave(body) {
  const incoming = body.proposal;
  if (!incoming) return jsonResponse(400, { error: 'Missing proposal' });
  if (!incoming.client) return jsonResponse(400, { error: 'client required' });
  if (!incoming.projectName) return jsonResponse(400, { error: 'projectName required' });

  const now = new Date().toISOString();
  let slug = incoming.slug || null;
  let existing = null;

  if (slug) {
    existing = await ghGet(`${DATA_DIR}/${slug}.json`);
  }

  if (!slug) {
    const base = slugify(`${incoming.client}-${incoming.projectName}`);
    slug = await ensureUniqueSlug(base);
  }

  // Merge — preserve recap, status, createdAt if updating
  const prev = existing ? safeParse(existing.content) : {};
  const merged = {
    ...incoming,
    slug,
    status: prev.status || incoming.status || 'sent',
    recap: prev.recap || incoming.recap || null,
    createdAt: prev.createdAt || now,
    updatedAt: now
  };

  const content = JSON.stringify(merged, null, 2);
  await ghPut(
    `${DATA_DIR}/${slug}.json`,
    content,
    `${existing ? 'Update' : 'Create'} activation proposal: ${slug}`,
    existing ? existing.sha : null
  );

  await upsertIndexEntry(merged);

  return jsonResponse(200, { slug, proposal: merged });
}

async function handleLoad(body) {
  const slug = body.slug;
  if (!slug) return jsonResponse(400, { error: 'slug required' });

  const file = await ghGet(`${DATA_DIR}/${slug}.json`);
  if (!file) return jsonResponse(404, { error: 'Proposal not found' });

  const proposal = safeParse(file.content);
  if (!proposal) return jsonResponse(500, { error: 'Corrupt proposal file' });

  return jsonResponse(200, { proposal });
}

async function handleList(body) {
  const idx = await readIndex();
  return jsonResponse(200, { proposals: idx.entries });
}

async function handleSaveRecap(body) {
  const slug = body.slug;
  const recap = body.recap;
  if (!slug) return jsonResponse(400, { error: 'slug required' });
  if (!recap || typeof recap !== 'object') return jsonResponse(400, { error: 'recap object required' });

  const file = await ghGet(`${DATA_DIR}/${slug}.json`);
  if (!file) return jsonResponse(404, { error: 'Proposal not found' });

  const proposal = safeParse(file.content);
  if (!proposal) return jsonResponse(500, { error: 'Corrupt proposal file' });

  const now = new Date().toISOString();
  proposal.recap = {
    ...recap,
    updatedAt: now,
    publishedAt: recap.published ? (proposal.recap?.publishedAt || now) : (proposal.recap?.publishedAt || null)
  };
  proposal.updatedAt = now;

  await ghPut(
    `${DATA_DIR}/${slug}.json`,
    JSON.stringify(proposal, null, 2),
    `Update recap: ${slug} (${recap.published ? 'published' : 'draft'})`,
    file.sha
  );

  await upsertIndexEntry(proposal);

  return jsonResponse(200, { slug, recap: proposal.recap });
}

async function handleUnpublishRecap(body) {
  const slug = body.slug;
  if (!slug) return jsonResponse(400, { error: 'slug required' });

  const file = await ghGet(`${DATA_DIR}/${slug}.json`);
  if (!file) return jsonResponse(404, { error: 'Proposal not found' });

  const proposal = safeParse(file.content);
  if (!proposal) return jsonResponse(500, { error: 'Corrupt proposal file' });
  if (!proposal.recap) return jsonResponse(400, { error: 'No recap to unpublish' });

  proposal.recap.published = false;
  proposal.recap.updatedAt = new Date().toISOString();
  proposal.updatedAt = proposal.recap.updatedAt;

  await ghPut(
    `${DATA_DIR}/${slug}.json`,
    JSON.stringify(proposal, null, 2),
    `Unpublish recap: ${slug}`,
    file.sha
  );

  await upsertIndexEntry(proposal);

  return jsonResponse(200, { slug, recap: proposal.recap });
}

async function handleStatusUpdate(body, newStatus) {
  const slug = body.slug;
  if (!slug) return jsonResponse(400, { error: 'slug required' });

  const file = await ghGet(`${DATA_DIR}/${slug}.json`);
  if (!file) return jsonResponse(404, { error: 'Proposal not found' });

  const proposal = safeParse(file.content);
  if (!proposal) return jsonResponse(500, { error: 'Corrupt proposal file' });

  const now = new Date().toISOString();
  proposal.status = newStatus;
  if (newStatus === 'accepted') proposal.acceptedAt = now;
  if (newStatus === 'changes_requested') {
    proposal.changeRequestedAt = now;
    proposal.changeNotes = body.notes || '';
  }
  proposal.updatedAt = now;

  await ghPut(
    `${DATA_DIR}/${slug}.json`,
    JSON.stringify(proposal, null, 2),
    `Status update: ${slug} → ${newStatus}`,
    file.sha
  );

  await upsertIndexEntry(proposal);

  return jsonResponse(200, { slug, status: newStatus });
}

// ── Utils ────────────────────────────────────────────────────
function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  };
}
