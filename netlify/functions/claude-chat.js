// ============================================================
// HANDS Logistics — POST /api/claude-chat
//
// Claude Opus 4.7 agent with FULL Monday read/write across both
// boards (Ops + NV I/O), generic GraphQL passthrough, and
// templated + arbitrary email send via Resend.
//
// REQUEST shape:
// {
//   secret: "<shared secret from env>",
//   messages: [{ role:"user"|"assistant", content:"..." }, ...],
//   pipelineContext: { ...optional snapshot... }
// }
//
// RESPONSE shape:
// {
//   success: true,
//   reply: "...natural language response...",
//   actions: [...tool calls executed this turn, for UI display...],
//   pendingConfirmation: {...} | null,
//   usage: {...}
// }
//
// Required env vars:
//   ANTHROPIC_API_KEY     — from console.anthropic.com
//   HUB_JWT_SECRET        — HMAC secret for verifying hub login JWTs (PRIMARY auth)
//   CLAUDE_CHAT_SECRET    — DEPRECATED legacy shared secret (kept for migration; remove after Jon confirms)
//   MONDAY_TOKEN          — Monday API token (write access)
//   RESEND_KEY            — Resend API key (for the email tools)
// ============================================================

const crypto = require('crypto');

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const HUB_JWT_SECRET     = process.env.HUB_JWT_SECRET;
const CLAUDE_CHAT_SECRET = process.env.CLAUDE_CHAT_SECRET;  // legacy fallback
const MONDAY_TOKEN       = process.env.MONDAY_TOKEN;
const RESEND_KEY         = process.env.RESEND_KEY;

// ─────────────────────────────────────────────────────────────
// JWT verification — HS256, validates issuer/expiry, constant-time signature check
// ─────────────────────────────────────────────────────────────
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function verifyHubJWT(token, secret) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'no_token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerB64, payloadB64, sigB64] = parts;

  // Verify signature with constant-time compare
  const expected = b64url(crypto.createHmac('sha256', secret).update(headerB64 + '.' + payloadB64).digest());
  const A = Buffer.from(sigB64);
  const B = Buffer.from(expected);
  if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Parse + check claims
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); }
  catch { return { ok: false, reason: 'bad_payload' }; }

  if (payload.iss !== 'hands-hub') return { ok: false, reason: 'bad_issuer' };
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

const MODEL           = 'claude-haiku-4-5';
const MAX_TOKENS      = 2000;
const MAX_HISTORY     = 30;
const MAX_AGENT_TURNS = 5;  // reduced from 8 to fit Netlify's 26s timeout (Pro plan)

const OPS_BOARD = '4550650855';   // Operations 2026
const IO_BOARD  = '18405667848';  // NV I/O 2026
const KPI_BOARD = '18406032754';  // KPI Goals 2026

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT — written to make the agent act, not refuse
// ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT_BASE = `HANDS Logistics ops agent. Embedded in ops.handslogistics.com/hub. User: Jon Williams (CEO) or his ops team. Las Vegas concierge 3PL — deliveries, warehousing, brand activation logistics.

ACT, DON'T REFUSE. You have broad write access to Monday. If no structured tool fits, USE monday_graphql — it's your universal escape hatch for any query/mutation. Saying "I can't do that" when monday_graphql can do it = failure. The user explicitly granted full power. Default to action.

HARD RULES:
- Bulk mutations >5 items → describe plan, then execute
- Destructive irreversible ops → confirm first
- Client emails (DC/POD/custom) → ALWAYS propose_* first, never send_* cold
- All other writes → just do them

BOARDS:
Operations 2026 (id ${OPS_BOARD}) — main delivery/activation board. PO# = item ID.
  text=Client, text4=Account, text5=Project, text2=Delivery Date (PLAIN TEXT "MARCH 30, 2026"),
  text9=Time, long_text8=Address, long_text=Notes, date6=Completed (ISO),
  client_email1=Client Email, color=Logistics Status, color_mm1wxn5k=Activity Type,
  status=Project Status, text_mm1p831b=Received By, link_mm1pgr61=POD1, link_mm1pay5j=POD2,
  link_mm1pg26n=Driver POD URL, boolean_mm1jv595=DC Sent flag, boolean_mm1jr3gr=POD Sent flag,
  color_mm1qe2ht=SEND DC trigger, color_mm1qkyf=SEND POD trigger, color_mm18camd=POD Status.
  Groups: Unconfirmed (id new_group84798) is the intake group; promote to Delivery/Activation/etc. by Activity Type.

NV I/O 2026 (id ${IO_BOARD}) — inbound/outbound shipments. Single group "topics".
  color_mm1t2es=Direction, color_mm1th2fd=Material Purpose, color_mm1tbfwk=Billing Status,
  color_mm1t824v=Send Inbound Notice, color_mm1t5hde=Send Outbound Notice.

KPI Goals (id ${KPI_BOARD}) — monthly+annual targets, one row per activity per month.

GOTCHAS:
- Status labels EXACT match (case/spacing). On mismatch, error returns valid_labels — retry with one.
- text2 is PLAIN TEXT uppercase format ("MARCH 30, 2026"), not ISO.
- Link columns need DOUBLE-stringified JSON via monday_graphql.
- Personnel rows have null Activity Type — filter out of pipeline analysis.
- pipeline_snapshot in user msg has most data; only call query_board_items / get_item if insufficient.

INTAKE PROTOCOL: pull Unconfirmed group → enrich → propose to Jon → on approval, update items + move to correct group by Activity Type. Calendar/reminders happen downstream.

GMAIL: Three accounts available — jon (jon@), concierge (concierge@), inbound (inbound@handslogistics.com). DEFAULT to "concierge" unless context obviously points elsewhere (personal/exec → jon; receiving-dock email → inbound). Toolset:
- gmail_search_threads / gmail_list_threads / gmail_get_thread to read
- gmail_list_labels / gmail_modify_labels for labels
- gmail_create_draft (DEFAULT for "draft an email" / "write a reply") — sits in Drafts, no risk
- gmail_send_message (ONLY when Jon explicitly says "send it now" or after he reviews a draft) — sends immediately, no propose/send split, no review
LABEL PROCESSING: When Jon says "process my labeled emails" / "process inbound" / similar, the pattern is:
  1. gmail_list_labels (account=jon AND account=inbound — emails with the trigger label live in either) to find the "HANDS → Claude" label ID
  2. gmail_search_threads with q='label:"HANDS → Claude"' (or list_threads with that label ID)
  3. For each thread: gmail_get_thread → parse → take action (log to NV I/O Board ${IO_BOARD} for inbound receipts, or Ops Board ${OPS_BOARD} for activity-bound items)
  4. gmail_modify_labels to REMOVE the "HANDS → Claude" label so it doesn't reprocess
NEVER auto-send a Gmail message without explicit instruction. Drafts are free; sends are not.

EMAIL: propose_email_send (DC/POD) or propose_custom_email → wait for approval → THEN send_*.

TONE: concise, real PO numbers, brief explanations, no filler. Show your work before destructive ops. Don't apologize for being capable.`;

// Build the full system prompt with current date prepended.
// Called fresh on each request so the date is always accurate.
function buildSystemPrompt() {
  const now = new Date();
  const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' };
  const todayStr = now.toLocaleDateString('en-US', opts);
  // Format Monday's text2 column ("MARCH 30, 2026" — uppercase, comma-separated)
  const t2opts = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' };
  const todayText2 = now.toLocaleDateString('en-US', t2opts).toUpperCase();
  // ISO date in PT
  const ptDateParts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Los_Angeles' }).formatToParts(now);
  const isoPT = ptDateParts.filter(p => p.type !== 'literal').map(p => p.value).join('-');

  const dateBlock = `CURRENT DATE: ${todayStr} (Pacific Time, Las Vegas).
- Today's date in Monday text2 format: ${todayText2}
- Today's ISO date: ${isoPT}
- When the user says "today", "tomorrow", "this week", "this Wednesday", etc., resolve relative to this date.
- Never claim you don't know today's date — it's right here.

`;
  return dateBlock + SYSTEM_PROMPT_BASE;
}

// ─────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'monday_graphql',
    description: 'Universal Monday GraphQL passthrough. Run ANY query or mutation against any board. Use this whenever a structured tool below doesn\'t fit your need — updating a non-status column, querying NV I/O Board, custom filtering, posting subitems, archiving, etc. You are responsible for proper escaping (link columns need double-stringified JSON) and for checking the result for errors. Returns the raw Monday response as JSON string. PREFER STRUCTURED TOOLS when they fit; use this when they don\'t.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Full GraphQL query or mutation string. Do NOT wrap in extra braces.' }
      },
      required: ['query']
    }
  },
  {
    name: 'query_board_items',
    description: 'Query items from a Monday board with optional filters. Defaults to the Operations Board. Use boardId to target NV I/O instead.',
    input_schema: {
      type: 'object',
      properties: {
        boardId:           { type: 'string', description: 'Board ID. Defaults to Ops Board (4550650855). Use 18405667848 for NV I/O.', default: '4550650855' },
        statusEquals:      { type: 'string', description: 'Filter by Logistics Status label exact match (case-sensitive). Optional.' },
        activityEquals:    { type: 'string', description: 'Filter by Activity Type label. Optional.' },
        clientContains:    { type: 'string', description: 'Filter by Client Name containing this text (case-insensitive). Optional.' },
        groupId:           { type: 'string', description: 'Filter to a specific group on the board. Optional.' },
        limit:             { type: 'integer', description: 'Max items to return (default 50, max 200).', default: 50 }
      }
    }
  },
  {
    name: 'get_item',
    description: 'Get full column details + recent updates for one Monday item by ID (PO number).',
    input_schema: {
      type: 'object',
      properties: {
        po: { type: 'string', description: 'The Monday item ID / PO number' }
      },
      required: ['po']
    }
  },
  {
    name: 'update_item_columns',
    description: 'Update one or more columns on a Monday item. Pass values as a JSON object keyed by column ID. For status columns use {label: "EXACT TEXT"}. For text use a string. For dates use {date: "YYYY-MM-DD"}. For email use {email, text}. For links use {url, text}. Throws hard if Monday returns errors — it will show you the available labels if a label mismatch.',
    input_schema: {
      type: 'object',
      properties: {
        po:      { type: 'string', description: 'PO number / Monday item ID' },
        boardId: { type: 'string', description: 'Board ID. Defaults to Ops Board.', default: '4550650855' },
        columns: { type: 'object', description: 'Object keyed by column ID. e.g. {color: {label: "DELIVERY SCHEDULED"}, text2: "MARCH 30, 2026"}' }
      },
      required: ['po','columns']
    }
  },
  {
    name: 'create_delivery',
    description: 'Create a new delivery item in the Unconfirmed group on the Operations Board. Use this for the standard intake flow. For non-delivery items, use monday_graphql with create_item.',
    input_schema: {
      type: 'object',
      properties: {
        clientName:      { type: 'string' },
        projectName:     { type: 'string' },
        deliveryAddress: { type: 'string' },
        deliveryDate:    { type: 'string', description: 'Format: "MARCH 30, 2026" (uppercase month, day, year)' },
        deliveryTime:    { type: 'string', description: 'Format: "10:00 AM" or "2:30 PM"' },
        clientEmail:     { type: 'string' },
        activityType:    { type: 'string', description: 'One of: Delivery, Activation, I/O Shipping, Production, Sourcing. Defaults to Delivery.', default: 'Delivery' }
      },
      required: ['clientName','projectName','deliveryAddress','deliveryDate','deliveryTime','clientEmail']
    }
  },
  {
    name: 'add_monday_update',
    description: 'Post an internal update (comment) on a Monday item. Use for audit-trail notes after changes, or to log decisions. Does not require approval — these are internal only.',
    input_schema: {
      type: 'object',
      properties: {
        po:   { type: 'string', description: 'Monday item ID' },
        body: { type: 'string', description: 'Update text' }
      },
      required: ['po','body']
    }
  },
  {
    name: 'propose_email_send',
    description: 'Propose sending one or more templated DC or POD emails. User MUST confirm before emails fire. Always call this BEFORE send_dc_email or send_pod_email. After this call, your turn ENDS — wait for user approval next turn.',
    input_schema: {
      type: 'object',
      properties: {
        kind:  { type: 'string', enum: ['dc','pod'], description: 'dc = Delivery Confirmation, pod = Proof of Delivery' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              po:       { type: 'string' },
              ccEmails: { type: 'array', items: { type: 'string' } }
            },
            required: ['po']
          }
        }
      },
      required: ['kind','items']
    }
  },
  {
    name: 'send_dc_email',
    description: 'Send a Delivery Confirmation email for one PO. ONLY call after the user approved a propose_email_send.',
    input_schema: {
      type: 'object',
      properties: {
        po:       { type: 'string' },
        ccEmails: { type: 'array', items: { type: 'string' } }
      },
      required: ['po']
    }
  },
  {
    name: 'send_pod_email',
    description: 'Send a Proof of Delivery email for one PO. ONLY call after the user approved a propose_email_send.',
    input_schema: {
      type: 'object',
      properties: {
        po:       { type: 'string' },
        ccEmails: { type: 'array', items: { type: 'string' } }
      },
      required: ['po']
    }
  },
  {
    name: 'propose_custom_email',
    description: 'Propose sending an arbitrary (non-template) email via Resend. User MUST confirm. Always call this BEFORE send_custom_email. After this call, your turn ENDS.',
    input_schema: {
      type: 'object',
      properties: {
        to:       { type: 'string', description: 'Primary recipient email' },
        cc:       { type: 'array', items: { type: 'string' }, description: 'Optional CC recipients' },
        subject:  { type: 'string' },
        body:     { type: 'string', description: 'Plain-text or simple HTML body' },
        from:     { type: 'string', description: 'From address. Defaults to concierge@handslogistics.com', default: 'concierge@handslogistics.com' },
        relatedPo: { type: 'string', description: 'Optional Monday PO this email relates to (for the audit log)' }
      },
      required: ['to','subject','body']
    }
  },
  {
    name: 'send_custom_email',
    description: 'Send an arbitrary email via Resend. ONLY call after user approved a propose_custom_email.',
    input_schema: {
      type: 'object',
      properties: {
        to:        { type: 'string' },
        cc:        { type: 'array', items: { type: 'string' } },
        subject:   { type: 'string' },
        body:      { type: 'string' },
        from:      { type: 'string', default: 'concierge@handslogistics.com' },
        relatedPo: { type: 'string' }
      },
      required: ['to','subject','body']
    }
  },

  // ─── GMAIL TOOLS ─────────────────────────────────────────────
  // Three accounts: jon | concierge | inbound. If unspecified, default to "concierge".
  // All operations go through the matching GMAIL_TOKEN_* refresh token.
  {
    name: 'gmail_search_threads',
    description: 'Search Gmail threads using Gmail\'s native query syntax. Returns thread list with summaries (subject, from, snippet, date). Use Gmail operators like from:bacardi.com, after:2026/04/01, label:HANDS-Claude, has:attachment, is:unread, subject:"PO ". Default account is "concierge" — pick "jon" for personal/exec inbox or "inbound" for receiving-dock email.',
    input_schema: {
      type: 'object',
      properties: {
        account:    { type: 'string', enum: ['jon','concierge','inbound'], description: 'Which inbox. Defaults to concierge.', default: 'concierge' },
        query:      { type: 'string', description: 'Gmail search query (uses native Gmail operators). Empty string = all threads.' },
        maxResults: { type: 'integer', description: 'Max threads to return (default 20, max 50).', default: 20 }
      },
      required: ['query']
    }
  },
  {
    name: 'gmail_get_thread',
    description: 'Get a full Gmail thread by threadId — all messages in the thread with headers, sender, recipient, date, and decoded body text. Use this to read what an email actually says before deciding what to do.',
    input_schema: {
      type: 'object',
      properties: {
        account:  { type: 'string', enum: ['jon','concierge','inbound'], default: 'concierge' },
        threadId: { type: 'string', description: 'Thread ID from gmail_search_threads or gmail_list_threads.' }
      },
      required: ['threadId']
    }
  },
  {
    name: 'gmail_list_threads',
    description: 'List Gmail threads filtered by label. Convenience wrapper around gmail_search_threads — useful when you have label IDs from gmail_list_labels. Common pattern: list threads labeled "HANDS → Claude" to process inbound automation requests.',
    input_schema: {
      type: 'object',
      properties: {
        account:    { type: 'string', enum: ['jon','concierge','inbound'], default: 'concierge' },
        labelIds:   { type: 'array', items: { type: 'string' }, description: 'Label IDs to filter by (any-of). Get IDs via gmail_list_labels.' },
        maxResults: { type: 'integer', default: 20 }
      }
    }
  },
  {
    name: 'gmail_create_draft',
    description: 'Create a Gmail draft. The draft sits in the account\'s Drafts folder until manually sent. Use this whenever Jon asks to "draft a reply" or "compose an email" — DO NOT send unless Jon explicitly says "send it" or approves a draft. Pass threadId to draft inside an existing thread (becomes a reply).',
    input_schema: {
      type: 'object',
      properties: {
        account:  { type: 'string', enum: ['jon','concierge','inbound'], default: 'concierge' },
        to:       { type: 'string', description: 'Primary recipient email. Multiple = comma-separated.' },
        cc:       { type: 'array', items: { type: 'string' } },
        bcc:      { type: 'array', items: { type: 'string' } },
        subject:  { type: 'string' },
        body:     { type: 'string', description: 'Plain-text body. New paragraphs separated by blank lines.' },
        threadId: { type: 'string', description: 'Optional. Pass to attach the draft as a reply to an existing thread.' }
      },
      required: ['to','subject','body']
    }
  },
  {
    name: 'gmail_send_message',
    description: 'Send a Gmail message immediately. Use sparingly — prefer gmail_create_draft unless Jon explicitly says "send" or "send it now". This bypasses any review. There is no propose_/send_ split here — calling this IS the send.',
    input_schema: {
      type: 'object',
      properties: {
        account:  { type: 'string', enum: ['jon','concierge','inbound'], default: 'concierge' },
        to:       { type: 'string' },
        cc:       { type: 'array', items: { type: 'string' } },
        bcc:      { type: 'array', items: { type: 'string' } },
        subject:  { type: 'string' },
        body:     { type: 'string' },
        threadId: { type: 'string', description: 'Optional. Send as reply within an existing thread.' }
      },
      required: ['to','subject','body']
    }
  },
  {
    name: 'gmail_list_labels',
    description: 'List all labels in a Gmail account (system + user-created), with their IDs. Needed when you want to add/remove a label by ID — use the returned id, not the human-readable name.',
    input_schema: {
      type: 'object',
      properties: {
        account: { type: 'string', enum: ['jon','concierge','inbound'], default: 'concierge' }
      }
    }
  },
  {
    name: 'gmail_modify_labels',
    description: 'Add or remove labels on a Gmail thread by ID. Common pattern: after processing a "HANDS → Claude" labeled thread, remove that label so it doesn\'t reprocess. Get label IDs via gmail_list_labels first.',
    input_schema: {
      type: 'object',
      properties: {
        account:        { type: 'string', enum: ['jon','concierge','inbound'], default: 'concierge' },
        threadId:       { type: 'string' },
        addLabelIds:    { type: 'array', items: { type: 'string' }, description: 'Label IDs to add. Empty array OK.' },
        removeLabelIds: { type: 'array', items: { type: 'string' }, description: 'Label IDs to remove. Empty array OK.' }
      },
      required: ['threadId']
    }
  }
];

// ─────────────────────────────────────────────────────────────
// MONDAY HELPERS
// ─────────────────────────────────────────────────────────────
async function mondayQuery(query) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version':'2023-04' },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  // Hard error check — Monday returns 200 with errors[] populated when mutations fail
  if (!res.ok) {
    throw new Error('Monday HTTP ' + res.status + ': ' + JSON.stringify(data).slice(0, 500));
  }
  if (data.errors && data.errors.length) {
    throw new Error('Monday GraphQL error: ' + data.errors.map(e => e.message).join(' | '));
  }
  if (data.error_message) {
    throw new Error('Monday error: ' + data.error_message);
  }
  return data;
}

function getCol(cols, id) {
  const c = (cols || []).find(x => x.id === id);
  return (c && c.text && c.text.trim()) ? c.text.trim() : '';
}

// ─────────────────────────────────────────────────────────────
// GMAIL HELPERS
// ─────────────────────────────────────────────────────────────
const GMAIL_ACCOUNTS = {
  jon:       { email: 'jon@handslogistics.com',       envVar: 'GMAIL_TOKEN_JON' },
  concierge: { email: 'concierge@handslogistics.com', envVar: 'GMAIL_TOKEN_CONCIERGE' },
  inbound:   { email: 'inbound@handslogistics.com',   envVar: 'GMAIL_TOKEN_INBOUND' }
};

// Module-scope access-token cache. Netlify keeps warm Lambda containers
// alive for ~5-15 min between invocations, so this avoids hitting Google's
// token endpoint on every single tool call within a chat session.
// Each entry: { token: string, expiresAt: number (epoch seconds) }
const GMAIL_TOKEN_CACHE = {};

async function getGmailAccessToken(account) {
  const cfg = GMAIL_ACCOUNTS[account];
  if (!cfg) throw new Error(`Unknown Gmail account "${account}". Valid: jon, concierge, inbound.`);

  const refreshToken = process.env[cfg.envVar];
  if (!refreshToken) throw new Error(`${cfg.envVar} env var not set — run /api/gmail-auth to capture refresh token for ${cfg.email}.`);

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set.');

  // Return cached token if still good (with 60s safety margin)
  const now = Math.floor(Date.now() / 1000);
  const cached = GMAIL_TOKEN_CACHE[account];
  if (cached && cached.expiresAt > now + 60) return cached.token;

  // Refresh
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(`Google token refresh failed for ${account} (HTTP ${r.status}): ${data.error_description || data.error || JSON.stringify(data)}`);
  }
  if (!data.access_token) {
    throw new Error(`No access_token in Google refresh response for ${account}.`);
  }

  GMAIL_TOKEN_CACHE[account] = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600)
  };
  return data.access_token;
}

// Convenience wrapper: GET / POST to Gmail API with auto-refreshed access token.
async function gmailFetch(account, path, opts = {}) {
  const token = await getGmailAccessToken(account);
  const url = path.startsWith('http') ? path : 'https://gmail.googleapis.com' + path;
  const headers = Object.assign({
    'Authorization': 'Bearer ' + token,
    'Content-Type':  'application/json'
  }, opts.headers || {});
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data.error && data.error.message) || data.message || text || ('HTTP ' + res.status);
    throw new Error(`Gmail API ${res.status} (${account}): ${msg}`);
  }
  return data;
}

// Decode a Gmail message body. Gmail returns body data in URL-safe base64.
// A message can have multiple MIME parts; we walk and pick the first text/plain
// (falling back to text/html stripped of tags) so the agent gets readable text.
function decodeGmailBody(payload) {
  if (!payload) return '';
  function decode(b64url) {
    if (!b64url) return '';
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8');
  }
  function walk(part, results) {
    if (!part) return;
    const mime = part.mimeType || '';
    if (mime.startsWith('text/') && part.body && part.body.data) {
      results.push({ mime, text: decode(part.body.data) });
    }
    (part.parts || []).forEach(p => walk(p, results));
  }
  const all = [];
  walk(payload, all);
  // Prefer text/plain
  const plain = all.find(p => p.mime === 'text/plain');
  if (plain) return plain.text;
  const html = all.find(p => p.mime === 'text/html');
  if (html) return html.text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // Fallback: top-level body
  if (payload.body && payload.body.data) return decode(payload.body.data);
  return '';
}

// Pick a header value out of payload.headers[]
function getHeader(headers, name) {
  if (!Array.isArray(headers)) return '';
  const want = name.toLowerCase();
  const h = headers.find(h => h.name && h.name.toLowerCase() === want);
  return h ? (h.value || '') : '';
}

// Build an RFC 2822 message and base64url-encode for gmail.send / drafts.create
function buildRfc822({ from, to, cc, bcc, subject, body }) {
  const lines = [];
  lines.push('From: ' + from);
  lines.push('To: ' + (Array.isArray(to) ? to.join(', ') : to));
  if (cc && cc.length)  lines.push('Cc: '  + (Array.isArray(cc)  ? cc.join(', ')  : cc));
  if (bcc && bcc.length) lines.push('Bcc: ' + (Array.isArray(bcc) ? bcc.join(', ') : bcc));
  lines.push('Subject: ' + subject);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 7bit');
  lines.push('');
  lines.push(body || '');
  const raw = lines.join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// ─────────────────────────────────────────────────────────────
// TOOL EXECUTORS
// ─────────────────────────────────────────────────────────────
async function tool_monday_graphql(args) {
  if (!args.query || typeof args.query !== 'string') {
    return JSON.stringify({ error: 'query required' });
  }
  // Block the most catastrophic mutations as a backstop
  const danger = /\bdelete_board\s*\(/i;
  if (danger.test(args.query)) {
    return JSON.stringify({ error: 'delete_board is blocked at the proxy level. If you really need this, ask Jon to do it manually.' });
  }
  const data = await mondayQuery(args.query);
  // Strip noise — return data + meta only
  return JSON.stringify({ success: true, data: data.data, account_id: data.account_id });
}

async function tool_query_board_items(args) {
  const boardId = args.boardId || OPS_BOARD;
  const limit   = Math.min(args.limit || 50, 200);
  const groupClause = args.groupId ? `, query_params:{rules:[{column_id:"group", compare_value:["${args.groupId}"]}]}` : '';
  const colIds = boardId === OPS_BOARD
    ? ['text','text4','text5','text2','text9','color','color_mm1wxn5k','client_email1','date6','status','long_text8']
    : ['color_mm1t2es','color_mm1th2fd','color_mm1tbfwk','color_mm1t824v','color_mm1t5hde'];
  const q = `{ boards(ids:[${boardId}]) { items_page(limit:${limit}${groupClause}) { items { id name group { id title } column_values(ids:[${colIds.map(c=>`"${c}"`).join(',')}]) { id text } } } } }`;
  const data = await mondayQuery(q);
  let items = (data.data.boards[0].items_page && data.data.boards[0].items_page.items) || [];

  if (args.statusEquals)   items = items.filter(i => getCol(i.column_values,'color') === args.statusEquals);
  if (args.activityEquals) items = items.filter(i => getCol(i.column_values,'color_mm1wxn5k') === args.activityEquals);
  if (args.clientContains) {
    const needle = args.clientContains.toLowerCase();
    items = items.filter(i => getCol(i.column_values,'text').toLowerCase().includes(needle));
  }

  const summary = items.slice(0, limit).map(i => {
    const base = { po: i.id, name: i.name, group: i.group && i.group.title };
    i.column_values.forEach(c => { if (c.text) base[c.id] = c.text; });
    return base;
  });
  return JSON.stringify({ board_id: boardId, count: summary.length, items: summary });
}

async function tool_get_item(args) {
  const q = `{ items(ids:[${args.po}]) { id name board { id name } group { id title } column_values { id text type value } updates(limit:5){ id body created_at } } }`;
  const data = await mondayQuery(q);
  const it = data.data.items && data.data.items[0];
  if (!it) return JSON.stringify({ error: 'Item not found', po: args.po });
  const cols = {};
  it.column_values.forEach(c => { if (c.text) cols[c.id] = c.text; });
  return JSON.stringify({
    po: it.id,
    name: it.name,
    board: it.board && it.board.name,
    group: it.group && it.group.title,
    columns: cols,
    recent_updates: (it.updates || []).slice(0,3).map(u => ({
      created: u.created_at,
      body: u.body && u.body.replace(/<[^>]+>/g,'').slice(0,300)
    }))
  });
}

async function tool_update_item_columns(args) {
  const boardId = args.boardId || OPS_BOARD;
  if (!args.columns || typeof args.columns !== 'object') {
    return JSON.stringify({ error: 'columns object required' });
  }
  const colsJson = JSON.stringify(args.columns);
  const mutation = `mutation { change_multiple_column_values(item_id:${args.po}, board_id:${boardId}, column_values:${JSON.stringify(colsJson)}) { id name } }`;
  try {
    await mondayQuery(mutation);
    return JSON.stringify({ success: true, po: args.po, board_id: boardId, updated: Object.keys(args.columns) });
  } catch (e) {
    // If the error is a label mismatch, fetch valid labels for the affected column(s) so the agent can self-correct
    const msg = e.message || String(e);
    if (/label.*not found|invalid.*label|status.*label/i.test(msg)) {
      // Best-effort: pull settings for the columns the agent tried to update
      try {
        const colIds = Object.keys(args.columns);
        const settingsQ = `{ boards(ids:[${boardId}]) { columns(ids:[${colIds.map(c=>`"${c}"`).join(',')}]) { id title settings_str } } }`;
        const s = await mondayQuery(settingsQ);
        const labelHelp = (s.data.boards[0].columns || []).map(c => {
          let labels = [];
          try { const parsed = JSON.parse(c.settings_str || '{}'); labels = Object.values(parsed.labels || {}); } catch (_) {}
          return { column: c.id, title: c.title, valid_labels: labels };
        });
        return JSON.stringify({ error: msg, hint: 'Label mismatch. Retry with one of the valid labels below.', valid_labels: labelHelp });
      } catch (_) {}
    }
    return JSON.stringify({ error: msg });
  }
}

async function tool_create_delivery(args) {
  const cols = {
    text:           args.clientName,
    text5:          args.projectName,
    long_text8:     { text: args.deliveryAddress },
    text2:          args.deliveryDate,
    text9:          args.deliveryTime,
    client_email1:  { email: args.clientEmail, text: args.clientEmail },
    color:          { label: 'Unconfirmed' },
    color_mm1wxn5k: { label: args.activityType || 'Delivery' }
  };
  const mutation = `mutation { create_item(board_id:${OPS_BOARD}, group_id:"new_group84798", item_name:${JSON.stringify(args.projectName)}, column_values:${JSON.stringify(JSON.stringify(cols))}) { id } }`;
  const data = await mondayQuery(mutation);
  return JSON.stringify({ success: true, new_po: data.data.create_item.id, group: 'Unconfirmed', activity: args.activityType || 'Delivery' });
}

async function tool_add_monday_update(args) {
  const body = '🤖 (HANDS Assistant) ' + args.body;
  const mutation = `mutation { create_update(item_id:${args.po}, body:${JSON.stringify(body)}) { id } }`;
  await mondayQuery(mutation);
  return JSON.stringify({ success: true, po: args.po });
}

async function tool_propose_email_send(args) {
  const enriched = [];
  for (const it of args.items) {
    try {
      const q = `{ items(ids:[${it.po}]) { id name column_values(ids:["text","text5","client_email1"]){id text} } }`;
      const data = await mondayQuery(q);
      const item = data.data.items[0];
      if (!item) { enriched.push({ po: it.po, error: 'not_found' }); continue; }
      enriched.push({
        po: item.id,
        client_email: getCol(item.column_values, 'client_email1'),
        client_name:  getCol(item.column_values, 'text'),
        project_name: getCol(item.column_values, 'text5') || item.name,
        ccEmails: it.ccEmails || []
      });
    } catch (e) {
      enriched.push({ po: it.po, error: e.message });
    }
  }
  return JSON.stringify({ awaiting_user_confirmation: true, kind: args.kind, proposed: enriched });
}

async function tool_send_dc_email(args) {
  const res = await fetch('https://dcconfirm.netlify.app/api/send-confirmation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: args.po, ccEmails: args.ccEmails || [] })
  });
  const data = await res.json();
  return JSON.stringify(res.ok ? { success: true, ...data } : { success: false, status: res.status, ...data });
}

async function tool_send_pod_email(args) {
  const res = await fetch('https://dcconfirm.netlify.app/api/send-pod', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: args.po, ccEmails: args.ccEmails || [] })
  });
  const data = await res.json();
  return JSON.stringify(res.ok ? { success: true, ...data } : { success: false, status: res.status, ...data });
}

async function tool_propose_custom_email(args) {
  return JSON.stringify({
    awaiting_user_confirmation: true,
    kind: 'custom',
    proposed: [{
      to: args.to,
      cc: args.cc || [],
      subject: args.subject,
      body_preview: args.body.slice(0, 240),
      from: args.from || 'concierge@handslogistics.com',
      relatedPo: args.relatedPo || null
    }]
  });
}

async function tool_send_custom_email(args) {
  if (!RESEND_KEY) return JSON.stringify({ success: false, error: 'RESEND_KEY not configured' });
  const fromAddr = args.from || 'concierge@handslogistics.com';
  // Wrap plain text in a minimal HTML shell if no HTML tags detected
  const html = /<[a-z]/i.test(args.body)
    ? args.body
    : '<div style="font-family:-apple-system,sans-serif;font-size:14px;line-height:1.6;color:#222;">'
      + args.body.split('\n\n').map(p => '<p style="margin:0 0 12px;">' + p.replace(/\n/g,'<br>') + '</p>').join('')
      + '</div>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'HANDS Logistics <' + fromAddr + '>',
      to:   [args.to],
      cc:   args.cc && args.cc.length ? args.cc : undefined,
      subject: args.subject,
      html: html
    })
  });
  const data = await res.json();
  if (!res.ok) return JSON.stringify({ success: false, status: res.status, error: data.message || JSON.stringify(data) });
  // If related PO, log internally
  if (args.relatedPo) {
    try {
      const note = `📧 Custom email sent to ${args.to} — Subject: "${args.subject}"`;
      await mondayQuery(`mutation { create_update(item_id:${args.relatedPo}, body:${JSON.stringify(note)}) { id } }`);
    } catch (_) {}
  }
  return JSON.stringify({ success: true, message_id: data.id, to: args.to, subject: args.subject });
}

// ─── GMAIL TOOL EXECUTORS ────────────────────────────────────

async function tool_gmail_search_threads(args) {
  const account = args.account || 'concierge';
  const max = Math.min(args.maxResults || 20, 50);
  const params = new URLSearchParams();
  params.set('maxResults', String(max));
  if (args.query) params.set('q', args.query);
  const list = await gmailFetch(account, `/gmail/v1/users/me/threads?${params.toString()}`);
  const threads = list.threads || [];
  if (!threads.length) return JSON.stringify({ account, query: args.query, count: 0, threads: [] });

  // Hydrate each thread with first-message metadata (subject, from, snippet, date)
  const summaries = await Promise.all(threads.slice(0, max).map(async t => {
    try {
      const detail = await gmailFetch(account, `/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
      const firstMsg = detail.messages && detail.messages[0];
      const lastMsg  = detail.messages && detail.messages[detail.messages.length - 1];
      const headers  = (firstMsg && firstMsg.payload && firstMsg.payload.headers) || [];
      return {
        threadId: t.id,
        subject:  getHeader(headers, 'Subject'),
        from:     getHeader(headers, 'From'),
        date:     getHeader(headers, 'Date'),
        message_count: (detail.messages || []).length,
        last_snippet: (lastMsg && lastMsg.snippet) || '',
        labels: (lastMsg && lastMsg.labelIds) || []
      };
    } catch (e) {
      return { threadId: t.id, error: e.message };
    }
  }));
  return JSON.stringify({ account, query: args.query, count: summaries.length, threads: summaries });
}

async function tool_gmail_get_thread(args) {
  const account = args.account || 'concierge';
  const detail = await gmailFetch(account, `/gmail/v1/users/me/threads/${args.threadId}?format=full`);
  const messages = (detail.messages || []).map(m => {
    const headers = (m.payload && m.payload.headers) || [];
    return {
      messageId: m.id,
      labels: m.labelIds || [],
      from:    getHeader(headers, 'From'),
      to:      getHeader(headers, 'To'),
      cc:      getHeader(headers, 'Cc'),
      subject: getHeader(headers, 'Subject'),
      date:    getHeader(headers, 'Date'),
      snippet: m.snippet || '',
      body:    (decodeGmailBody(m.payload) || '').slice(0, 8000) // cap at 8k chars to keep response tight
    };
  });
  return JSON.stringify({ account, threadId: args.threadId, messages });
}

async function tool_gmail_list_threads(args) {
  const account = args.account || 'concierge';
  const max = Math.min(args.maxResults || 20, 50);
  const params = new URLSearchParams();
  params.set('maxResults', String(max));
  (args.labelIds || []).forEach(id => params.append('labelIds', id));
  const list = await gmailFetch(account, `/gmail/v1/users/me/threads?${params.toString()}`);
  const threads = list.threads || [];
  if (!threads.length) return JSON.stringify({ account, count: 0, threads: [] });

  const summaries = await Promise.all(threads.slice(0, max).map(async t => {
    try {
      const detail = await gmailFetch(account, `/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
      const firstMsg = detail.messages && detail.messages[0];
      const lastMsg  = detail.messages && detail.messages[detail.messages.length - 1];
      const headers  = (firstMsg && firstMsg.payload && firstMsg.payload.headers) || [];
      return {
        threadId: t.id,
        subject:  getHeader(headers, 'Subject'),
        from:     getHeader(headers, 'From'),
        date:     getHeader(headers, 'Date'),
        message_count: (detail.messages || []).length,
        last_snippet: (lastMsg && lastMsg.snippet) || '',
        labels: (lastMsg && lastMsg.labelIds) || []
      };
    } catch (e) {
      return { threadId: t.id, error: e.message };
    }
  }));
  return JSON.stringify({ account, count: summaries.length, threads: summaries });
}

async function tool_gmail_create_draft(args) {
  const account = args.account || 'concierge';
  const fromEmail = GMAIL_ACCOUNTS[account].email;
  const raw = buildRfc822({
    from: fromEmail, to: args.to, cc: args.cc, bcc: args.bcc,
    subject: args.subject, body: args.body
  });
  const message = { raw };
  if (args.threadId) message.threadId = args.threadId;
  const data = await gmailFetch(account, '/gmail/v1/users/me/drafts', {
    method: 'POST',
    body: JSON.stringify({ message })
  });
  return JSON.stringify({
    success: true,
    account,
    draftId:  data.id,
    messageId: data.message && data.message.id,
    threadId:  data.message && data.message.threadId,
    note: 'Draft created — sits in Drafts folder until manually sent or until you call gmail_send_message.'
  });
}

async function tool_gmail_send_message(args) {
  const account = args.account || 'concierge';
  const fromEmail = GMAIL_ACCOUNTS[account].email;
  const raw = buildRfc822({
    from: fromEmail, to: args.to, cc: args.cc, bcc: args.bcc,
    subject: args.subject, body: args.body
  });
  const payload = { raw };
  if (args.threadId) payload.threadId = args.threadId;
  const data = await gmailFetch(account, '/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return JSON.stringify({
    success: true,
    account,
    from: fromEmail,
    to: args.to,
    subject: args.subject,
    messageId: data.id,
    threadId:  data.threadId
  });
}

async function tool_gmail_list_labels(args) {
  const account = args.account || 'concierge';
  const data = await gmailFetch(account, '/gmail/v1/users/me/labels');
  const labels = (data.labels || []).map(l => ({
    id: l.id,
    name: l.name,
    type: l.type,
    visible: l.labelListVisibility !== 'labelHide'
  }));
  return JSON.stringify({ account, count: labels.length, labels });
}

async function tool_gmail_modify_labels(args) {
  const account = args.account || 'concierge';
  const body = {
    addLabelIds:    args.addLabelIds    || [],
    removeLabelIds: args.removeLabelIds || []
  };
  if (!body.addLabelIds.length && !body.removeLabelIds.length) {
    return JSON.stringify({ error: 'addLabelIds or removeLabelIds must be non-empty.' });
  }
  await gmailFetch(account, `/gmail/v1/users/me/threads/${args.threadId}/modify`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return JSON.stringify({
    success: true,
    account,
    threadId: args.threadId,
    added:    body.addLabelIds,
    removed:  body.removeLabelIds
  });
}

const EXECUTORS = {
  monday_graphql:       tool_monday_graphql,
  query_board_items:    tool_query_board_items,
  get_item:             tool_get_item,
  update_item_columns:  tool_update_item_columns,
  create_delivery:      tool_create_delivery,
  add_monday_update:    tool_add_monday_update,
  propose_email_send:   tool_propose_email_send,
  send_dc_email:        tool_send_dc_email,
  send_pod_email:       tool_send_pod_email,
  propose_custom_email: tool_propose_custom_email,
  send_custom_email:    tool_send_custom_email,
  // Gmail
  gmail_search_threads: tool_gmail_search_threads,
  gmail_get_thread:     tool_gmail_get_thread,
  gmail_list_threads:   tool_gmail_list_threads,
  gmail_create_draft:   tool_gmail_create_draft,
  gmail_send_message:   tool_gmail_send_message,
  gmail_list_labels:    tool_gmail_list_labels,
  gmail_modify_labels:  tool_gmail_modify_labels
};

// ─────────────────────────────────────────────────────────────
// ANTHROPIC API CALL
// ─────────────────────────────────────────────────────────────
async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages: messages
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Anthropic API: ' + (data.error && data.error.message ? data.error.message : JSON.stringify(data).slice(0,500)));
  return data;
}

// Smart history truncation that preserves tool_use/tool_result pairs
function truncateHistory(msgs, max) {
  if (msgs.length <= max) return msgs;
  // Keep the most recent N, but never start the slice on a tool_result message
  // (that would orphan it from its tool_use parent and Anthropic will error).
  let start = msgs.length - max;
  while (start < msgs.length) {
    const m = msgs[start];
    if (Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')) {
      start++; // skip — the matching tool_use is being dropped
    } else {
      break;
    }
  }
  return msgs.slice(start);
}

function normalizeMessages(msgs) {
  return msgs.map(m => ({ role: m.role, content: m.content }));
}

// ─────────────────────────────────────────────────────────────
// AGENT LOOP
// ─────────────────────────────────────────────────────────────
async function runAgent(initialMessages, ctx) {
  let messages = truncateHistory(normalizeMessages(initialMessages), MAX_HISTORY);

  if (ctx) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && typeof messages[i].content === 'string') {
        messages[i] = {
          role: 'user',
          content: '<pipeline_snapshot>\n' + JSON.stringify(ctx, null, 2) + '\n</pipeline_snapshot>\n\n' + messages[i].content
        };
        break;
      }
    }
  }

  const actionsLog = [];
  let pendingConfirmation = null;
  let totalUsage = { input_tokens: 0, output_tokens: 0 };

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const response = await callClaude(messages);
    if (response.usage) {
      totalUsage.input_tokens  += response.usage.input_tokens  || 0;
      totalUsage.output_tokens += response.usage.output_tokens || 0;
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const text = (response.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text).join('\n').trim();
      return {
        reply: text || '(no text in response)',
        actions: actionsLog,
        pendingConfirmation,
        usage: totalUsage,
        model: response.model
      };
    }

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const tu of toolUses) {
      const exec = EXECUTORS[tu.name];
      let resultText;
      let success = true;
      if (!exec) {
        resultText = JSON.stringify({ error: 'Unknown tool: ' + tu.name });
        success = false;
      } else {
        try {
          resultText = await exec(tu.input || {});
          // If the tool returned an error envelope, mark failed for the UI
          try { const parsed = JSON.parse(resultText); if (parsed && parsed.error) success = false; } catch (_) {}
        } catch (e) {
          resultText = JSON.stringify({ error: e.message });
          success = false;
        }
      }
      actionsLog.push({
        tool: tu.name,
        input: tu.input,
        success,
        summary: resultText.length > 280 ? resultText.slice(0, 280) + '…' : resultText
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultText,
        is_error: !success
      });

      // propose_* tools terminate the turn for user confirmation
      if ((tu.name === 'propose_email_send' || tu.name === 'propose_custom_email') && success) {
        try {
          const parsed = JSON.parse(resultText);
          if (parsed.awaiting_user_confirmation) {
            pendingConfirmation = {
              type: tu.name === 'propose_custom_email' ? 'custom_email_send' : 'email_send',
              kind: parsed.kind,
              items: parsed.proposed
            };
          }
        } catch (e) { /* fall through */ }
      }
    }

    messages.push({ role: 'user', content: toolResults });

    if (pendingConfirmation) {
      const finalResponse = await callClaude(messages);
      if (finalResponse.usage) {
        totalUsage.input_tokens  += finalResponse.usage.input_tokens  || 0;
        totalUsage.output_tokens += finalResponse.usage.output_tokens || 0;
      }
      const text = (finalResponse.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text).join('\n').trim();
      return {
        reply: text || '(no text in response)',
        actions: actionsLog,
        pendingConfirmation,
        usage: totalUsage,
        model: finalResponse.model
      };
    }
  }

  return {
    reply: 'Hit the max number of tool calls for this turn. Stopping for safety — ask me to continue if needed.',
    actions: actionsLog,
    pendingConfirmation,
    usage: totalUsage,
    model: MODEL
  };
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
// Netlify Pro plan: extend function timeout from default 10s to 26s
// Required because the agent loop (up to MAX_AGENT_TURNS Claude API calls
// + Monday API calls per turn) can exceed 10s and return HTTP 502.
exports.config = { maxDuration: 26 };

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!ANTHROPIC_API_KEY)  return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  if (!MONDAY_TOKEN)       return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'MONDAY_TOKEN not set' }) };
  if (!HUB_JWT_SECRET && !CLAUDE_CHAT_SECRET) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Auth not configured (need HUB_JWT_SECRET or CLAUDE_CHAT_SECRET)' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // ── Auth: prefer JWT (Authorization: Bearer …), fall back to legacy body.secret ──
  let authed = false;
  const authHeader = event.headers && (event.headers.authorization || event.headers.Authorization);
  if (HUB_JWT_SECRET && authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const v = verifyHubJWT(token, HUB_JWT_SECRET);
    if (v.ok) authed = true;
    else {
      // Distinguishable error so the hub can prompt re-login
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Auth failed: ' + v.reason, code: v.reason }) };
    }
  } else if (CLAUDE_CHAT_SECRET && body.secret === CLAUDE_CHAT_SECRET) {
    // Legacy path — kept temporarily so the deploy doesn't break the hub before the new client ships.
    authed = true;
  }

  if (!authed) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized', code: 'no_token' }) };
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No messages provided' }) };
  }

  try {
    const result = await runAgent(messages, body.pipelineContext);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        reply: result.reply,
        actions: result.actions,
        pendingConfirmation: result.pendingConfirmation,
        usage: result.usage,
        model: result.model
      })
    };
  } catch (err) {
    console.error('agent error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
