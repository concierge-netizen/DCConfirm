/**
 * GET /portal/api/config (and /api/portal-config) — dual mode:
 *
 *   • Unauthenticated  → public Clerk publishable key + portal status.
 *                        Cached for 5 min. Used by Clerk bootloaders.
 *   • With Bearer token → verify Clerk JWT + Portal Registry membership and
 *                        return { email, isAdmin, user }. NOT cached.
 *                        Used by admin tools (e.g. /workorders.html) that
 *                        need to gate UI on adminOnly registry status.
 */

const { requireAuth } = require('./_portal-auth');

const PUBLIC_BODY = {
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || '',
  shellMode: false,
  version: 'monday-1',
};

function publicConfig() {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(PUBLIC_BODY),
  };
}

function authedJson(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
      body: '',
    };
  }

  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  if (!auth) return publicConfig();

  try {
    const ctx = await requireAuth(event);
    return authedJson(200, {
      email: ctx.email,
      isAdmin: ctx.isAdmin,
      user: {
        email: ctx.email,
        role: ctx.user.role || null,
        name: ctx.user.name || null,
        status: ctx.user.status || null,
        clientId: ctx.user.clientId || null,
      },
    });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return authedJson(status, { error: (err && err.message) || 'Auth failed' });
  }
};
