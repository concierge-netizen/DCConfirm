/**
 * GET /portal/api/admin/actions — admin-only feed of every client action
 * across all clients (subitem comments + estimate-approved events).
 */
const ds = require('./_portal-datastore-monday');
const { requireAuth, json, handleError, handleOptions } = require('./_portal-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  try {
    await requireAuth(event, { adminOnly: true });
    const actions = await ds.getAllClientActions();
    return json(200, { shellMode: false, actions: actions });
  } catch (err) { return handleError(err); }
};
