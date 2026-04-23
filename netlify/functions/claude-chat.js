// ============================================================
// HANDS Logistics — POST /api/claude-chat
//
// Claude Opus 4.7 agent with Monday read/write + email send tools.
// Holds API key + Monday token + Resend key server-side.
//
// REQUEST shape:
// {
//   secret: "<shared secret from env>",
//   messages: [{ role:"user"|"assistant", content:"..." }, ...],
//   pipelineContext: { ...optional snapshot... },
//   pendingConfirmation: { ...optional, see below... }
// }
//
// pendingConfirmation: when the previous turn proposed an email send, the
// frontend echoes it back so Claude can act on user approval. Shape:
//   { type:'email_send', kind:'dc'|'pod', items:[{po, clientEmail}], approved: bool }
//
// RESPONSE shape:
// {
//   success: true,
//   reply: "...natural language response...",
//   actions: [...tool calls executed this turn, for UI display...],
//   pendingConfirmation: {...} | null,  // if Claude is asking for approval
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

const MODEL          = 'claude-opus-4-7';
const MAX_TOKENS     = 2000;
const MAX_HISTORY    = 16;
const MAX_AGENT_TURNS = 20;   // hard cap on tool-call iterations per request
const BOARD_ID       = '4550650855';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const SYSTEM_PROMPT = `You are the HANDS Logistics operations assistant — an autonomous agent embedded in the internal tools hub at handstools.netlify.app.

HANDS Logistics is a Las Vegas concierge 3PL serving premium brands (Bacardi, GHOST, etc.) with deliveries, warehousing, brand activation logistics, and event ops. The user is Jon Williams (Founder & CEO) or his ops team.

You have agentic access to the Monday.com Operations Board (id 4550650855) via tools. You can read items, change statuses, create new deliveries, post updates, and send Delivery Confirmation (DC) and Proof of Delivery (POD) emails to clients.

The hub's pipelines:
- Delivery: Intake → Scheduled → In Motion → Delivered → Billed
- Activation: Proposal → Approved → Procurement → Setup → Live → Strike → Wrapped

Pipeline snapshot may be included in the user message inside <pipeline_snapshot> tags.

OPERATING PRINCIPLES:
1. Be decisive but verify. When the user gives a clear command, do it. When ambiguous, ask one focused question.
2. Always show your work. Before doing something destructive (status changes, multi-item updates), briefly say what you're about to do.
3. Email sends require user confirmation. When the user asks you to send DC or POD emails, use propose_email_send first — never send_dc_email or send_pod_email without user approval. After confirmation, fire the actual sends.
4. Use the snapshot first. The pipeline_snapshot has most of what you need. Only call query_board_items or get_item when the snapshot is insufficient.
5. Concise tone. Real PO numbers, brief explanations, no filler.
6. Never invent data. If a PO/client/email isn't visible, say so and ask.
7. Audit trail. After meaningful changes (status updates, item creation), you can call add_monday_update to leave a note on the affected item — recommended for accountability.

EMAIL SEND PROTOCOL:
- User says "send DC for X" or "send PODs for everything delivered yesterday"
- You call propose_email_send with the list of {po, kind} pairs you intend to send
- The system pauses and shows the user the list with a confirm prompt
- User responds "yes" / "no" / "skip 1234567893"
- If approved (possibly with skips), THEN you call send_dc_email or send_pod_email for each one
- If user says no or skips all, just acknowledge

Never call send_dc_email or send_pod_email in the same turn as propose_email_send. They're two separate steps.`;

// ─────────────────────────────────────────────────────────────
// TOOL DEFINITIONS (Anthropic tool-use schema)
// ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'query_board_items',
    description: 'Query items from the Monday Operations Board with optional filters. Use this when the pipeline snapshot does not contain enough detail (e.g. you need items from a specific group, or items not in active pipelines like Completed).',
    input_schema: {
      type: 'object',
      properties: {
        statusEquals:      { type: 'string', description: 'Filter by Logistics Status label (e.g. "DELIVERY SCHEDULED", "COMPLETE", "OUT FOR DELIVERY"). Optional.' },
        activityEquals:    { type: 'string', description: 'Filter by Activity Type label (Delivery, Activation, Production, Sourcing, I/O Shipping). Optional.' },
        clientContains:    { type: 'string', description: 'Filter by Client Name containing this text (case-insensitive). Optional.' },
        deliveryDateAfter: { type: 'string', description: 'YYYY-MM-DD — items with delivery date on or after. Best-effort text comparison. Optional.' },
        limit:             { type: 'integer', description: 'Max items to return (default 25, max 100).', default: 25 }
      }
    }
  },
  {
    name: 'get_item',
    description: 'Get full column details of a specific Monday item by PO number.',
    input_schema: {
      type: 'object',
      properties: {
        po: { type: 'string', description: 'The Monday item ID / PO number' }
      },
      required: ['po']
    }
  },
  {
    name: 'update_item_status',
    description: 'Change a Monday item\'s Logistics Status (column "color"), Activity Type (column "color_mm1wxn5k"), or Project Status (column "status"). Pass the human-readable label exactly as it appears on the board.',
    input_schema: {
      type: 'object',
      properties: {
        po:           { type: 'string', description: 'PO number / Monday item ID' },
        column:       { type: 'string', enum: ['color','color_mm1wxn5k','status'], description: 'Which status column to change. "color"=Logistics Status, "color_mm1wxn5k"=Activity Type, "status"=Project Status' },
        labelText:    { type: 'string', description: 'The exact label text (e.g. "DELIVERY SCHEDULED", "Delivery", "COMPLETE")' }
      },
      required: ['po','column','labelText']
    }
  },
  {
    name: 'create_delivery',
    description: 'Create a new delivery item in the Unconfirmed group on the Operations Board.',
    input_schema: {
      type: 'object',
      properties: {
        clientName:      { type: 'string' },
        projectName:     { type: 'string' },
        deliveryAddress: { type: 'string' },
        deliveryDate:    { type: 'string', description: 'Format: "MARCH 30, 2026" (uppercase month name, day, year)' },
        deliveryTime:    { type: 'string', description: 'Format: "10:00 AM" or "2:30 PM"' },
        clientEmail:     { type: 'string' }
      },
      required: ['clientName','projectName','deliveryAddress','deliveryDate','deliveryTime','clientEmail']
    }
  },
  {
    name: 'add_monday_update',
    description: 'Post an update (comment) on a Monday item. Use this for audit-trail notes after making changes, or to log decisions for the team.',
    input_schema: {
      type: 'object',
      properties: {
        po:   { type: 'string', description: 'PO number / Monday item ID' },
        body: { type: 'string', description: 'The update text body' }
      },
      required: ['po','body']
    }
  },
  {
    name: 'propose_email_send',
    description: 'Propose sending one or more DC or POD emails. The user MUST confirm before the emails actually fire. Always use this BEFORE send_dc_email or send_pod_email. After this call, your turn ends — wait for user approval next turn.',
    input_schema: {
      type: 'object',
      properties: {
        kind:  { type: 'string', enum: ['dc','pod'], description: 'dc = Delivery Confirmation, pod = Proof of Delivery' },
        items: {
          type: 'array',
          description: 'List of items to send to. The system will look up client emails and present to the user for approval.',
          items: {
            type: 'object',
            properties: {
              po: { type: 'string' },
              ccEmails: { type: 'array', items: { type: 'string' }, description: 'Optional CC recipients per item' }
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
    description: 'Send a Delivery Confirmation email for one PO. Only call this AFTER the user has approved a propose_email_send. Returns immediately if Resend succeeds.',
    input_schema: {
      type: 'object',
      properties: {
        po:       { type: 'string' },
        ccEmails: { type: 'array', items: { type: 'string' }, description: 'Optional CC recipients' }
      },
      required: ['po']
    }
  },
  {
    name: 'send_pod_email',
    description: 'Send a Proof of Delivery email for one PO. Only call this AFTER the user has approved a propose_email_send.',
    input_schema: {
      type: 'object',
      properties: {
        po:       { type: 'string' },
        ccEmails: { type: 'array', items: { type: 'string' }, description: 'Optional CC recipients' }
      },
      required: ['po']
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
  if (!res.ok || data.errors) throw new Error('Monday error: ' + JSON.stringify(data.errors || data));
  return data;
}

function getCol(cols, id) {
  const c = (cols || []).find(x => x.id === id);
  return (c && c.text && c.text.trim()) ? c.text.trim() : '';
}

// ─────────────────────────────────────────────────────────────
// TOOL EXECUTORS — return strings (sent back to Claude as tool_result content)
// ─────────────────────────────────────────────────────────────
async function tool_query_board_items(args) {
  const limit = Math.min(args.limit || 25, 100);
  let q = `{ boards(ids:[${BOARD_ID}]) { items_page(limit:${limit}) { items { id name column_values(ids:["text","text4","text5","text2","text9","color","color_mm1wxn5k","client_email1","date6"]) { id text } } } } }`;
  const data = await mondayQuery(q);
  let items = (data.data.boards[0].items_page && data.data.boards[0].items_page.items) || [];

  // Client-side filtering (Monday GraphQL filtering is finicky — easier to filter in JS)
  if (args.statusEquals)   items = items.filter(i => getCol(i.column_values,'color') === args.statusEquals);
  if (args.activityEquals) items = items.filter(i => getCol(i.column_values,'color_mm1wxn5k') === args.activityEquals);
  if (args.clientContains) {
    const needle = args.clientContains.toLowerCase();
    items = items.filter(i => getCol(i.column_values,'text').toLowerCase().includes(needle));
  }

  const summary = items.slice(0, limit).map(i => ({
    po: i.id,
    name: i.name,
    client: getCol(i.column_values,'text'),
    account: getCol(i.column_values,'text4'),
    project: getCol(i.column_values,'text5'),
    delivery_date: getCol(i.column_values,'text2'),
    delivery_time: getCol(i.column_values,'text9'),
    status: getCol(i.column_values,'color'),
    activity: getCol(i.column_values,'color_mm1wxn5k'),
    client_email: getCol(i.column_values,'client_email1'),
    completed_on: getCol(i.column_values,'date6')
  }));
  return JSON.stringify({ count: summary.length, items: summary });
}

async function tool_get_item(args) {
  const q = `{ items(ids:[${args.po}]) { id name column_values { id text type } updates(limit:5){ id body created_at } } }`;
  const data = await mondayQuery(q);
  const it = data.data.items && data.data.items[0];
  if (!it) return JSON.stringify({ error: 'Item not found', po: args.po });
  const cols = {};
  it.column_values.forEach(c => { if (c.text) cols[c.id] = c.text; });
  return JSON.stringify({
    po: it.id, name: it.name, columns: cols,
    recent_updates: (it.updates || []).slice(0,3).map(u => ({ created: u.created_at, body: u.body && u.body.replace(/<[^>]+>/g,'').slice(0,200) }))
  });
}

async function tool_update_item_status(args) {
  const cols = {};
  cols[args.column] = { label: args.labelText };
  const mutation = `mutation { change_multiple_column_values(item_id:${args.po}, board_id:${BOARD_ID}, column_values:${JSON.stringify(JSON.stringify(cols))}) { id } }`;
  await mondayQuery(mutation);
  return JSON.stringify({ success: true, po: args.po, column: args.column, label: args.labelText });
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
    color_mm1wxn5k: { label: 'Delivery' }
  };
  const mutation = `mutation { create_item(board_id:${BOARD_ID}, group_id:"new_group84798", item_name:${JSON.stringify(args.projectName)}, column_values:${JSON.stringify(JSON.stringify(cols))}) { id } }`;
  const data = await mondayQuery(mutation);
  return JSON.stringify({ success: true, new_po: data.data.create_item.id, group: 'Unconfirmed' });
}

async function tool_add_monday_update(args) {
  const body = '🤖 (HANDS Assistant) ' + args.body;
  const mutation = `mutation { create_update(item_id:${args.po}, body:${JSON.stringify(body)}) { id } }`;
  await mondayQuery(mutation);
  return JSON.stringify({ success: true, po: args.po });
}

async function tool_propose_email_send(args) {
  // Look up each PO to enrich with client email + project for the confirmation prompt.
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
  // Mark this as a pending-confirmation envelope. The agent loop will detect the
  // tool name and surface this in the response so the frontend can pause for approval.
  return JSON.stringify({
    awaiting_user_confirmation: true,
    kind: args.kind,
    proposed: enriched
  });
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

const EXECUTORS = {
  query_board_items:   tool_query_board_items,
  get_item:            tool_get_item,
  update_item_status:  tool_update_item_status,
  create_delivery:     tool_create_delivery,
  add_monday_update:   tool_add_monday_update,
  propose_email_send:  tool_propose_email_send,
  send_dc_email:       tool_send_dc_email,
  send_pod_email:      tool_send_pod_email
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
  if (!res.ok) throw new Error('Anthropic API: ' + (data.error && data.error.message ? data.error.message : JSON.stringify(data)));
  return data;
}

// Sanitize message content blocks — Anthropic requires content to be string or array of blocks
function normalizeMessages(msgs) {
  return msgs.map(m => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    return { role: m.role, content: m.content }; // already array
  });
}

// ─────────────────────────────────────────────────────────────
// AGENT LOOP
// ─────────────────────────────────────────────────────────────
async function runAgent(initialMessages, ctx) {
  // Inject pipeline context into the most recent user message, if present
  let messages = normalizeMessages(initialMessages);
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

    // Append the assistant's full content (text + tool_use blocks) to the message history
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      // Done — extract text and return
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

    // Execute every tool_use block in this assistant turn
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
        } catch (e) {
          resultText = JSON.stringify({ error: e.message });
          success = false;
        }
      }
      actionsLog.push({
        tool: tu.name,
        input: tu.input,
        success,
        // Truncate for UI display; full result is fed back to Claude
        summary: resultText.length > 240 ? resultText.slice(0, 240) + '…' : resultText
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultText
      });

      // Special: propose_email_send terminates this agent turn so the user can confirm.
      if (tu.name === 'propose_email_send' && success) {
        try {
          const parsed = JSON.parse(resultText);
          if (parsed.awaiting_user_confirmation) {
            pendingConfirmation = { type: 'email_send', kind: parsed.kind, items: parsed.proposed };
          }
        } catch (e) { /* fall through */ }
      }
    }

    messages.push({ role: 'user', content: toolResults });

    // If we just queued a confirmation, terminate the loop and ask Claude to summarize once more.
    // We do one more call so Claude can write the natural-language confirmation prompt.
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

  // Hit the cap
  return {
    reply: 'I hit the max number of tool calls for this turn. Stopping here for safety. Ask me to continue if needed.',
    actions: actionsLog,
    pendingConfirmation,
    usage: totalUsage,
    model: MODEL
  };
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
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

  const messages = Array.isArray(body.messages) ? body.messages.slice(-MAX_HISTORY) : [];
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
