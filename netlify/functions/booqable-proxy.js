// HANDS Logistics — Booqable Proxy (multi-tenant)
// Server-side passthrough for Booqable v4 API across multiple client tenants.
// Routes by ?slug= param: looks up the client config to find which Booqable
// subdomain + API key to use for this request.
//
// Whitelist approach: only specific GET endpoints are allowed.
// Order creation goes through booqable-create-order.js.
// Status updates come through booqable-webhook-{slug}.js.
//
// Env vars (one per client): BOOQABLE_KEY_WGS, BOOQABLE_KEY_GHOST, ...
// Client configs: /data/clients/{slug}.json (committed to repo)

// Client configs are bundled as a JS module so Netlify includes them automatically
// in the function deploy. (Adjacent JSON files in /data/ aren't bundled by default.)
const CLIENTS = require('./_clients-config');

const ALLOWED_HOSTS = ['ops.handslogistics.com', 'dcconfirm.netlify.app'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const ALLOWED_ENDPOINTS = [
  /^products(\?.*)?$/,
  /^products\/[a-zA-Z0-9_-]+(\?.*)?$/,
  /^product_groups(\?.*)?$/,
  /^product_groups\/[a-zA-Z0-9_-]+(\?.*)?$/,
  /^availabilities(\?.*)?$/,
  /^orders\/[a-zA-Z0-9_-]+(\?.*)?$/
];

function refererAllowed(event) {
  const ref = (event.headers && (event.headers.referer || event.headers.Referer)) || '';
  if (!ref) return false;
  try { return ALLOWED_HOSTS.indexOf(new URL(ref).hostname) !== -1; }
  catch (e) { return false; }
}

function endpointAllowed(p) {
  return ALLOWED_ENDPOINTS.some(re => re.test(p));
}

// Validate slug — only lowercase letters, digits, hyphens
function slugValid(s) {
  return typeof s === 'string' && /^[a-z0-9-]+$/.test(s) && s.length > 0 && s.length < 40;
}

function loadClientConfig(slug) {
  if (!CLIENTS || typeof CLIENTS !== 'object') return null;
  return CLIENTS[slug] || null;
}

function jsonError(statusCode, msg) {
  return {
    statusCode,
    headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ error: msg })
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method not allowed' };
  }
  if (!refererAllowed(event)) {
    return jsonError(403, 'Forbidden: invalid origin');
  }

  const params = event.queryStringParameters || {};

  const slug = params.slug;
  if (!slugValid(slug)) {
    return jsonError(400, 'Missing or invalid slug param');
  }

  const config = loadClientConfig(slug);
  if (!config) {
    return jsonError(404, 'Unknown client slug: ' + slug);
  }
  if (!config.booqable_subdomain || !config.booqable_env_var) {
    return jsonError(500, 'Client config missing booqable_subdomain or booqable_env_var');
  }

  const TOKEN = process.env[config.booqable_env_var];
  if (!TOKEN) {
    return jsonError(500, 'Booqable env var not configured: ' + config.booqable_env_var);
  }

  const endpoint = params.endpoint;
  if (!endpoint) {
    return jsonError(400, 'Missing endpoint param');
  }
  if (!endpointAllowed(endpoint.split('?')[0])) {
    return jsonError(403, 'Endpoint not in whitelist');
  }

  // Reassemble query string excluding our wrapper params
  const passthroughKeys = Object.keys(params).filter(k => k !== 'endpoint' && k !== 'slug');
  const passthroughQS = passthroughKeys
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');

  const base = 'https://' + config.booqable_subdomain + '.booqable.com/api/4';
  let url = base + '/' + endpoint;
  if (passthroughQS) {
    url += (endpoint.indexOf('?') === -1 ? '?' : '&') + passthroughQS;
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'application/json' }),
      body: text
    };
  } catch (err) {
    return jsonError(500, err.message);
  }
};
