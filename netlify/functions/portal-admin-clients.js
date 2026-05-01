const { requireAuth, json, handleError, handleOptions } = require('./_portal-auth');
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  try {
    await requireAuth(event, { adminOnly: true });
    return json(200, { shellMode: true, clients: [], notice: 'Connecting to data sources — coming soon.' });
  } catch (err) { return handleError(err); }
};
