/**
 * _portal-auth.js — Clerk JWT verification + user resolution for the portal.
 * Stub-datastore version (Path 4 hollow shell).
 */

const { createRemoteJWKSet, jwtVerify } = require('jose');
const datastore = require('./_portal-datastore-stub');

const CLERK_ISSUER = process.env.CLERK_ISSUER;
let JWKS;
function getJWKS() {
  if (!CLERK_ISSUER) return null;
  if (!JWKS) JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));
  return JWKS;
}

async function verifyClerkToken(token) {
  if (!CLERK_ISSUER) throw new Error('CLERK_ISSUER env var not set');
  const { payload } = await jwtVerify(token, getJWKS(), { issuer: CLERK_ISSUER });
  return payload;
}

class AuthError extends Error {
  constructor(message, status = 401) { super(message); this.status = status; }
}

function extractBearer(event) {
  const h = event.headers.authorization || event.headers.Authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function requireAuth(event, { adminOnly = false } = {}) {
  const token = extractBearer(event);
  if (!token) throw new AuthError('Missing bearer token', 401);

  let payload;
  try { payload = await verifyClerkToken(token); }
  catch (err) { throw new AuthError('Invalid token: ' + err.message, 401); }

  const email = (payload.email || payload.primary_email || '').toLowerCase();
  if (!email) throw new AuthError('Token has no email claim', 401);

  const user = await datastore.getUserByEmail(email);
  if (!user) throw new AuthError('User not in registry', 403);
  if (user.status !== 'Active') throw new AuthError('User account not active', 403);

  const isAdmin = user.role === 'admin';
  if (adminOnly && !isAdmin) throw new AuthError('Admin access required', 403);

  let client = null;
  if (!isAdmin) {
    client = await datastore.getClientById(user.clientId);
    if (!client) throw new AuthError('Client record missing', 403);
    if (client.status !== 'Active') throw new AuthError('Client account not active', 403);
  }

  return { user, client, isAdmin, email };
}

async function resolveTargetClient(ctx, requestedClientId) {
  if (ctx.isAdmin) {
    if (!requestedClientId) {
      // For hollow shell, admins land on a default placeholder client
      return { clientId: 'PLACEHOLDER', name: 'No clients yet', status: 'Active', terms: 'NET 30' };
    }
    return await datastore.getClientById(requestedClientId);
  }
  if (requestedClientId && requestedClientId !== ctx.client.clientId) {
    throw new AuthError('Cannot access other clients', 403);
  }
  return ctx.client;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

function handleError(err) {
  if (err instanceof AuthError) return json(err.status, { error: err.message });
  console.error('Portal error:', err);
  return json(500, { error: 'Internal server error', detail: String(err.message || err) });
}

function handleOptions() {
  return {
    statusCode: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    },
    body: '',
  };
}

module.exports = { requireAuth, resolveTargetClient, AuthError, json, handleError, handleOptions };
