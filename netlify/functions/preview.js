// ============================================================
// HANDS Logistics — GET /api/preview?po=12345
// Returns the rendered email HTML for visual inspection.
// Does NOT send. Useful for QA.
// ============================================================

const { fetchItem, extractFields, buildEmail } = require('./_email-builder');

exports.handler = async function(event) {
  const itemId = event.queryStringParameters && event.queryStringParameters.po;
  if (!itemId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Missing ?po= parameter'
    };
  }
  try {
    const item = await fetchItem(itemId);
    const fields = extractFields(item);
    const { html } = buildEmail(fields);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Error: ' + err.message
    };
  }
};
