// netlify/functions/claude-stream.js
//
// Streaming proxy for Anthropic's /v1/messages endpoint. The browser sends
// { prompt, model?, max_tokens? } and gets the raw SSE stream piped back
// (Anthropic's text/event-stream with content_block_delta events).
//
// Used by /ceo (the CEO Dashboard / Billing Operations page) for its
// FP&A AI advisor panel. Replaces a broken browser-side direct call to
// api.anthropic.com which had no auth header and would have failed CORS.
//
// Required env vars:
//   ANTHROPIC_API_KEY   — already set on DCConfirm (also used by claude-chat.js)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL     = 'claude-opus-4-7';
const DEFAULT_MAX_TOKS  = 1000;

// Same-origin Referer guard — same idea as monday-proxy.js
const ALLOWED_HOSTS = ['ops.handslogistics.com', 'dcconfirm.netlify.app'];

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function refererAllowed(event) {
  const ref = (event.headers && (event.headers.referer || event.headers.Referer)) || '';
  if (!ref) return false;
  try { return ALLOWED_HOSTS.indexOf(new URL(ref).hostname) !== -1; }
  catch (e) { return false; }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  }
  if (!refererAllowed(event)) {
    return { statusCode: 403, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Forbidden: invalid origin' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const prompt    = body.prompt;
  const model     = body.model     || DEFAULT_MODEL;
  const maxTokens = body.maxTokens || DEFAULT_MAX_TOKS;
  if (!prompt || typeof prompt !== 'string') {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing or invalid prompt' }) };
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-api-key':          ANTHROPIC_API_KEY,
        'anthropic-version':  '2023-06-01'
      },
      body: JSON.stringify({
        model:      model,
        max_tokens: maxTokens,
        stream:     true,
        messages:   [{ role: 'user', content: prompt }]
      })
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return {
        statusCode: upstream.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Anthropic API error', status: upstream.status, detail: errText.slice(0, 500) })
      };
    }

    // Pipe the raw SSE stream back. Netlify functions don't natively support
    // streaming responses unless we use the streaming-functions runtime, so
    // we read the entire stream and return it as one body. This loses the
    // typewriter effect on the client but keeps everything else working —
    // the client's existing SSE parser still handles the data: lines fine.
    const fullBody = await upstream.text();

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'text/event-stream' },
      body: fullBody
    };
  } catch (err) {
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
