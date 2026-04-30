// ── recover-activations.js ─────────────────────────────────────
// One-shot migration function: reads every proposal from the
// Netlify Blobs store ("activation-proposals") and writes each
// one as data/activations/<slug>.json in the DCConfirm repo via
// the GitHub Contents API. Rebuilds data/activations/index.json.
//
// Hit once via:
//   curl -X POST https://ops.handslogistics.com/api/recover-activations
//
// Returns JSON: { migrated: N, skipped: N, errors: [...] }
// Idempotent — safe to run multiple times.
// ─────────────────────────────────────────────────────────────────

const { connectLambda, getStore } = require('@netlify/blobs');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'concierge-netizen';
const REPO  = 'DCConfirm';
const BRANCH = 'main';
const DATA_DIR = 'data/activations';
const INDEX_PATH = `${DATA_DIR}/index.json`;
const BLOB_STORE = 'activation-proposals';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

async function ghGet(path) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'hands-recover'
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GH GET ${path}: HTTP ${res.status}`);
  const meta = await res.json();
  const content = Buffer.from(meta.content || '', 'base64').toString('utf8');
  return { sha: meta.sha, content };
}

async function ghPut(path, content, message, sha) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const body = {
    message, branch: BRANCH,
    content: Buffer.from(content, 'utf8').toString('base64')
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'hands-recover'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GH PUT ${path}: HTTP ${res.status} — ${txt.substring(0, 300)}`);
  }
  return res.json();
}

function summarize(p) {
  return {
    slug: p.slug,
    client: p.client || '',
    projectName: p.projectName || '',
    contact: p.contact || '',
    email: p.email || '',
    proposalDate: p.proposalDate || '',
    status: p.status || 'sent',
    recapPublished: !!(p.recap && p.recap.published),
    recapExists: !!p.recap,
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: p.updatedAt || new Date().toISOString()
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };

  try { connectLambda(event); } catch (e) { console.error('connectLambda failed:', e); }

  if (!GITHUB_TOKEN) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'GITHUB_TOKEN env var not set' }) };
  }

  const result = { migrated: 0, skipped: 0, errors: [], slugs: [] };

  try {
    const s = getStore({ name: BLOB_STORE });

    // List all blobs (paginated)
    let cursor;
    const allKeys = [];
    do {
      const page = await s.list({ paginate: true, cursor });
      (page.blobs || []).forEach(b => allKeys.push(b.key));
      cursor = page.cursor;
    } while (cursor);

    result.totalKeys = allKeys.length;

    // Migrate each
    for (const key of allKeys) {
      try {
        const raw = await s.get(key, { type: 'text' });
        if (!raw) {
          result.skipped++;
          result.errors.push(`${key}: empty blob`);
          continue;
        }
        let proposal;
        try { proposal = JSON.parse(raw); }
        catch (e) {
          result.skipped++;
          result.errors.push(`${key}: invalid JSON`);
          continue;
        }

        // Ensure slug is set
        if (!proposal.slug) proposal.slug = key;

        // Set createdAt/updatedAt if missing
        const now = new Date().toISOString();
        if (!proposal.createdAt) proposal.createdAt = now;
        if (!proposal.updatedAt) proposal.updatedAt = now;

        // Write to GH (upsert via SHA lookup)
        const path = `${DATA_DIR}/${proposal.slug}.json`;
        const existing = await ghGet(path);
        await ghPut(
          path,
          JSON.stringify(proposal, null, 2),
          `Recover: ${proposal.slug}`,
          existing ? existing.sha : null
        );

        result.migrated++;
        result.slugs.push(proposal.slug);
      } catch (err) {
        result.errors.push(`${key}: ${err.message}`);
      }
    }

    // Rebuild index from all migrated proposals
    const entries = [];
    for (const slug of result.slugs) {
      const file = await ghGet(`${DATA_DIR}/${slug}.json`);
      if (file) {
        try { entries.push(summarize(JSON.parse(file.content))); }
        catch {}
      }
    }
    entries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const indexExisting = await ghGet(INDEX_PATH);
    await ghPut(
      INDEX_PATH,
      JSON.stringify({ entries, updatedAt: new Date().toISOString() }, null, 2),
      `Rebuild activations index after recovery (${entries.length} entries)`,
      indexExisting ? indexExisting.sha : null
    );

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result, null, 2)
    };
  } catch (err) {
    console.error('Recovery error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message, partial: result })
    };
  }
};
