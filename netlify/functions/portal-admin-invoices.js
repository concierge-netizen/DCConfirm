const { requireAuth, json, handleError, handleOptions } = require('./_portal-auth');
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  try {
    await requireAuth(event, { adminOnly: true });
    return json(200, { shellMode: true, ok: true, message: 'Invoice publishing will be available once data sources are connected.' });
  } catch (err) { return handleError(err); }
};
