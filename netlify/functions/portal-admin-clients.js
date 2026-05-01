/**
 * GET /portal/api/admin/clients — admin-only list of all clients.
 */
const ds = require('./_portal-datastore-monday');
const { requireAuth, json, handleError, handleOptions } = require('./_portal-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  try {
    await requireAuth(event, { adminOnly: true });
    const clients = await ds.listClients();
    return json(200, {
      shellMode: false,
      clients: clients.map(c => ({
        clientId:    c.client_id,
        name:        c.display_name,
        contactName: c.contact_name,
        loginEmail:  c.email,
        status:      c.status,
        terms:       c.terms
      }))
    });
  } catch (err) { return handleError(err); }
};
