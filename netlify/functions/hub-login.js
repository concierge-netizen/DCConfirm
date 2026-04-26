// Re-pushed 2026-04-26 to force Netlify function bundle refresh
// HANDS Logistics — POST /api/hub-login
// Validates a numeric PIN against env var HUB_PIN, returns a signed JWT.
// JWT is HS256 with HMAC-SHA256, signed with HUB_JWT_SECRET. 30-day expiry.
// No external dependencies — pure Node crypto.

const crypto = require('crypto');

const HUB_PIN          = process.env.HUB_PIN;
const HUB_JWT_SECRET   = process.env.HUB_JWT_SECRET;
const JWT_TTL_DAYS     = 30;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

// Base64url helpers (JWT uses URL-safe base64 without padding)
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
function b64urlJSON(obj) { return b64url(JSON.stringify(obj)); }

function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = b64urlJSON(header);
  const payloadB64 = b64urlJSON(payload);
  const data = headerB64 + '.' + payloadB64;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return data + '.' + b64url(sig);
}

// Constant-time string compare to resist timing attacks
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!HUB_PIN || !HUB_JWT_SECRET) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'HUB_PIN or HUB_JWT_SECRET not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const submittedPin = String(body.pin || '').trim();
  if (!submittedPin) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'PIN required' }) };
  }

  // Light rate limit hint — no actual rate limiting since serverless is stateless,
  // but pause on bad PIN to slow brute force a bit.
  if (!safeEqual(submittedPin, HUB_PIN)) {
    await new Promise(r => setTimeout(r, 800));
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Incorrect PIN' }) };
  }

  // Sign JWT
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (JWT_TTL_DAYS * 86400);
  const token = signJWT({
    iss: 'hands-hub',
    sub: 'jon-or-team',
    iat: now,
    exp: exp,
    scope: 'hub-chat'
  }, HUB_JWT_SECRET);

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      token: token,
      expiresAt: exp,
      ttlDays: JWT_TTL_DAYS
    })
  };
};
