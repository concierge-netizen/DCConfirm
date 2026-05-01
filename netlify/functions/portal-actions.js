const { requireAuth, json, handleError, handleOptions } = require('./_portal-auth');
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  try {
    await requireAuth(event);
    return json(200, { shellMode: true, ok: true, message: 'Action received (shell mode — not persisted).' });
  } catch (err) { return handleError(err); }
};
