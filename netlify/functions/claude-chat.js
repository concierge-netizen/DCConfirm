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
//   CLAUDE_CHAT_SECRET    — shared secret the hub must send
//   MONDAY_TOKEN          — Monday API token (write access)
//   RESEND_KEY            — Resend API key (for the email tools)
// ============================================================

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const CLAUDE_CHAT_SECRET = process.env.CLAUDE_CHAT_SECRET;
const MONDAY_TOKEN       = process.env.MONDAY_TOKEN;
const RESEND_KEY         = process.env.RESEND_KEY;

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
const SYSTEM_PROMPT = `HANDS Logistics ops agent. Embedded in ops.handslogistics.com/hub. User: Jon Williams (CEO) or his ops team. Las Vegas concierge 3PL — deliveries, warehousing, brand activation logistics.

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

EMAIL: propose_email_send (DC/POD) or propose_custom_email → wait for approval → THEN send_*.

TONE: concise, real PO numbers, brief explanations, no filler. Show your work before destructive ops. Don't apologize for being capable.`;

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
  send_custom_email:    tool_send_custom_email
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
      system: SYSTEM_PROMPT,
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
  if (!CLAUDE_CHAT_SECRET) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'CLAUDE_CHAT_SECRET not set' }) };
  if (!MONDAY_TOKEN)       return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'MONDAY_TOKEN not set' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (body.secret !== CLAUDE_CHAT_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
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
