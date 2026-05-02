/**
 * /portal/api/admin/documents — admin-only document management.
 *
 * Three actions, dispatched via ?action= query param:
 *
 *   POST /portal/api/admin/documents?action=upload-meta
 *     Body: { poId, document: { public_id, secure_url, original_filename,
 *                                format, bytes, kind?, uploaded_at? } }
 *     Reads existing documents JSON from monday item, appends, writes back.
 *     Browser uploads file directly to Cloudinary first; this just records it.
 *
 *   POST /portal/api/admin/documents?action=delete
 *     Body: { poId, public_id }
 *     Calls Cloudinary destroy API, then removes entry from monday JSON.
 *
 *   GET  /portal/api/admin/documents?action=ensure-column
 *     Idempotent. Creates a long_text column on the Operations 2026 board
 *     called "Documents JSON" if one doesn't exist. Returns the column ID.
 *     Run once after deploy; column ID then gets baked into datastore.
 *
 * Storage architecture:
 *   Cloudinary holds the actual files (public URLs).
 *   Monday holds metadata (a JSON array per PO in a long_text column).
 *
 * Auth: every action is admin-gated.
 */

const crypto = require('crypto');
const { requireAuth, json, handleError, handleOptions } = require('./_portal-auth');

const OPS_BOARD_ID = 4550650855;
const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2023-10';
const DOCUMENTS_COLUMN_TITLE = 'Documents JSON';

const CLOUDINARY_API = 'https://api.cloudinary.com/v1_1';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  try {
    const action = (event.queryStringParameters && event.queryStringParameters.action) || '';

    // ensure-column is GET; everything else is POST
    if (action === 'ensure-column') {
      if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
      const ctx = await requireAuth(event, { adminOnly: true });
      return await handleEnsureColumn(ctx);
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    const ctx = await requireAuth(event, { adminOnly: true });
    const body = parseBody(event.body);

    if (action === 'upload-meta') return await handleUploadMeta(ctx, body);
    if (action === 'delete')      return await handleDelete(ctx, body);

    return json(400, { error: 'Unknown action: ' + action });
  } catch (err) {
    return handleError(err);
  }
};

// ─── ensure-column: one-time setup ──────────────────────────────────
async function handleEnsureColumn(ctx) {
  // 1. List columns on the Ops board, look for our long_text column by title
  const listQuery = `
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        columns { id title type }
      }
    }
  `;
  const listed = await mondayQuery(listQuery, { boardId: String(OPS_BOARD_ID) });
  const cols = (listed.boards && listed.boards[0] && listed.boards[0].columns) || [];
  const existing = cols.find(c => c.title === DOCUMENTS_COLUMN_TITLE && c.type === 'long_text');

  if (existing) {
    return json(200, {
      ok: true,
      created: false,
      columnId: existing.id,
      title: existing.title,
      message: 'Column already exists.',
    });
  }

  // 2. Create it
  const createQuery = `
    mutation ($boardId: ID!, $title: String!) {
      create_column(
        board_id: $boardId,
        title: $title,
        column_type: long_text,
        description: "JSON array of Cloudinary documents attached to this PO. Managed by the portal."
      ) { id title type }
    }
  `;
  const created = await mondayQuery(createQuery, {
    boardId: String(OPS_BOARD_ID),
    title: DOCUMENTS_COLUMN_TITLE,
  });
  const newCol = created.create_column;

  return json(200, {
    ok: true,
    created: true,
    columnId: newCol.id,
    title: newCol.title,
    message: 'Column created. Paste columnId into _portal-datastore-monday.js as OPS_COL_DOCUMENTS.',
  });
}

// ─── upload-meta: persist Cloudinary metadata to monday ─────────────
async function handleUploadMeta(ctx, body) {
  const poId = String(body.poId || '').trim();
  const doc = body.document || {};
  if (!poId) return json(400, { error: 'poId is required' });
  if (!doc.public_id) return json(400, { error: 'document.public_id is required' });
  if (!doc.secure_url) return json(400, { error: 'document.secure_url is required' });

  const columnId = process.env.OPS_COL_DOCUMENTS;
  if (!columnId) {
    return json(500, {
      error: 'OPS_COL_DOCUMENTS env var not set. Run ensure-column first, then add the returned columnId to Netlify env.',
    });
  }

  // Read current value
  const current = await readDocumentsJson(poId, columnId);
  const list = Array.isArray(current) ? current : [];

  const entry = {
    public_id: doc.public_id,
    url: doc.secure_url,
    filename: doc.original_filename || doc.public_id.split('/').pop(),
    format: doc.format || '',
    bytes: doc.bytes || 0,
    kind: doc.kind || 'other',                                    // 'estimate' | 'invoice' | 'other'
    uploaded_at: doc.uploaded_at || new Date().toISOString(),
    uploaded_by: ctx.email || '',
  };

  // De-dupe by public_id (replace if same)
  const filtered = list.filter(d => d.public_id !== entry.public_id);
  filtered.push(entry);

  await writeDocumentsJson(poId, columnId, filtered);

  // Best-effort audit comment
  let auditPosted = false;
  try {
    await postItemUpdate(poId,
      '📎 DOCUMENT ATTACHED\n' +
      'File:     ' + entry.filename + '\n' +
      'Kind:     ' + entry.kind + '\n' +
      'Size:     ' + formatBytes(entry.bytes) + '\n' +
      'By:       ' + ctx.email + '\n' +
      'At:       ' + entry.uploaded_at);
    auditPosted = true;
  } catch (e) {
    console.error('[portal-admin-documents] audit failed (non-fatal):', e.message);
  }

  return json(200, { ok: true, document: entry, totalDocs: filtered.length, auditPosted: auditPosted });
}

// ─── delete: remove from Cloudinary + monday ────────────────────────
async function handleDelete(ctx, body) {
  const poId = String(body.poId || '').trim();
  const publicId = String(body.public_id || '').trim();
  if (!poId) return json(400, { error: 'poId is required' });
  if (!publicId) return json(400, { error: 'public_id is required' });

  const columnId = process.env.OPS_COL_DOCUMENTS;
  if (!columnId) return json(500, { error: 'OPS_COL_DOCUMENTS env var not set' });

  // 1. Find the entry in monday so we know the resource_type for Cloudinary delete
  const current = await readDocumentsJson(poId, columnId);
  const list = Array.isArray(current) ? current : [];
  const target = list.find(d => d.public_id === publicId);
  if (!target) return json(404, { error: 'No document with that public_id on this PO' });

  // Determine resource_type. Cloudinary requires this for the destroy call.
  // PDFs/docs are 'image' (Cloudinary stores them that way under auto), but for raw types
  // (csv, txt, etc.) it's 'raw'. Try image first, fall back to raw on failure.
  const resourceType = guessResourceType(target.format);

  // 2. Cloudinary destroy
  let cloudinaryOk = false;
  try {
    await cloudinaryDestroy(publicId, resourceType);
    cloudinaryOk = true;
  } catch (e) {
    // Try the alternate resource type
    const alt = resourceType === 'image' ? 'raw' : 'image';
    try {
      await cloudinaryDestroy(publicId, alt);
      cloudinaryOk = true;
    } catch (e2) {
      console.error('[portal-admin-documents] Cloudinary destroy failed both modes:', e.message, '|', e2.message);
      // Continue anyway — we still want to remove the metadata so the
      // portal stops showing a broken link. Cloudinary cleanup can be manual.
    }
  }

  // 3. Remove from monday metadata
  const filtered = list.filter(d => d.public_id !== publicId);
  await writeDocumentsJson(poId, columnId, filtered);

  // Best-effort audit
  try {
    await postItemUpdate(poId,
      '🗑 DOCUMENT REMOVED\n' +
      'File:    ' + (target.filename || publicId) + '\n' +
      'By:      ' + ctx.email + '\n' +
      'At:      ' + new Date().toISOString() +
      (cloudinaryOk ? '' : '\n(Note: Cloudinary asset may still exist — clean up manually)'));
  } catch (e) {
    console.error('[portal-admin-documents] audit failed (non-fatal):', e.message);
  }

  return json(200, { ok: true, removed: target.filename || publicId, cloudinaryOk: cloudinaryOk, totalDocs: filtered.length });
}

// ─── monday helpers ─────────────────────────────────────────────────
async function readDocumentsJson(itemId, columnId) {
  const q = `
    query ($itemId: ID!, $columnIds: [String!]!) {
      items(ids: [$itemId]) {
        column_values(ids: $columnIds) { id text value }
      }
    }
  `;
  const data = await mondayQuery(q, { itemId: String(itemId), columnIds: [columnId] });
  const cv = data.items && data.items[0] && data.items[0].column_values && data.items[0].column_values[0];
  if (!cv) return [];
  // long_text column stores its content in `text` (and `value` is a JSON-stringified object)
  // Cloudinary metadata is plain JSON. Try to parse `text` first, then `value`.
  const raw = cv.text || '';
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function writeDocumentsJson(itemId, columnId, list) {
  const text = JSON.stringify(list);
  const q = `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
      change_simple_column_value(
        board_id: $boardId,
        item_id: $itemId,
        column_id: $columnId,
        value: $value
      ) { id }
    }
  `;
  return await mondayQuery(q, {
    boardId: String(OPS_BOARD_ID),
    itemId: String(itemId),
    columnId: columnId,
    value: text,
  });
}

async function postItemUpdate(itemId, body) {
  const q = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
  `;
  return await mondayQuery(q, { itemId: String(itemId), body: body });
}

async function mondayQuery(query, variables) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) throw new Error('MONDAY_TOKEN env var not set');
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
      'API-Version': MONDAY_API_VERSION,
    },
    body: JSON.stringify({ query: query, variables: variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('monday HTTP ' + res.status + ': ' + text.slice(0, 300));
  }
  const data = await res.json();
  if (data.errors) {
    throw new Error('monday GraphQL: ' + JSON.stringify(data.errors).slice(0, 300));
  }
  return data.data;
}

// ─── Cloudinary helpers ─────────────────────────────────────────────
async function cloudinaryDestroy(publicId, resourceType) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName) throw new Error('CLOUDINARY_CLOUD_NAME env var not set');
  if (!apiKey || !apiSecret) throw new Error('CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET env vars not set');

  const timestamp = Math.floor(Date.now() / 1000);
  // Signature: SHA-1 of "public_id=X&timestamp=Y" + apiSecret, no params query-string-encoded
  const toSign = 'public_id=' + publicId + '&timestamp=' + timestamp;
  const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');

  const url = CLOUDINARY_API + '/' + cloudName + '/' + resourceType + '/destroy';
  const formBody = new URLSearchParams();
  formBody.append('public_id', publicId);
  formBody.append('timestamp', String(timestamp));
  formBody.append('api_key', apiKey);
  formBody.append('signature', signature);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result !== 'ok') {
    throw new Error('Cloudinary destroy ' + res.status + ': ' + JSON.stringify(data).slice(0, 300));
  }
  return data;
}

function guessResourceType(format) {
  const f = String(format || '').toLowerCase();
  // PDFs are stored as 'image' in Cloudinary. Most office docs are 'image' too.
  // Plain text-like types fall under 'raw'.
  if (['csv', 'txt', 'json', 'xml', 'log', 'md'].includes(f)) return 'raw';
  return 'image';
}

// ─── helpers ────────────────────────────────────────────────────────
function parseBody(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function formatBytes(b) {
  if (!b || isNaN(b)) return '?';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}
