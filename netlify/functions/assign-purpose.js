// ============================================================
// HANDS Logistics — POST /api/assign-purpose
//
// Receives submissions from the client-facing assignpurpose.netlify.app
// portal. Replaces dead Zapier hook that was firing at placeholder URL.
//
// What it does:
//   1. Fetches the original NV I/O item (board 18405667848)
//   2. Updates Material Purpose + Event/Project Name on that item
//   3. Appends client's name/email/notes to Client Notes / Reply column
//   4. If purpose = "Market Distribution" AND scheduling fields supplied →
//      creates a new item on Ops Board (4550650855) in the Unconfirmed group
//      linked back to the NV I/O item via the Description field
//   5. Sends ops-team notification email to concierge@ + inbound@
//   6. Optionally sends client a confirmation email
//   7. Posts an audit update on the NV I/O item
//
// Request body:
//   {
//     itemId:       "<NV I/O monday item id>",
//     po:           "<display po number>",
//     clientName:   string,
//     clientEmail:  string,
//     account:      string,
//     purpose:      "Event / Activation" | "Market Distribution" | "Storage / Hold" | "Return / Recall",
//     eventName:    string,     // when purpose = Event/Activation
//     eventDate:    string,     // when purpose = Event/Activation (YYYY-MM-DD)
//     shipTo:       string,     // when purpose = Market Distribution (full address)
//     // --- Delivery scheduler fields (only when purpose=Market Distribution AND scheduleDelivery=true) ---
//     scheduleDelivery:   boolean,
//     deliveryDate:       string,   // YYYY-MM-DD
//     deliveryTime:       string,   // HH:MM (24h)
//     deliveryContact:    string,
//     deliveryPhone:      string,
//     deliveryInstructions: string,
//     // ---
//     request:      string,     // free-text
//     urgency:      "Standard" | "Priority" | "Urgent"
//   }
//
// Response:
//   { success:true, nvIoItemId, opsItemId?, messages: [...] }
//
// Required env vars:
//   MONDAY_TOKEN
//   RESEND_KEY
// ============================================================

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const RESEND_KEY   = process.env.RESEND_KEY;

const NVIO_BOARD_ID = '18405667848';
const OPS_BOARD_ID  = '4550650855';
const OPS_UNCONFIRMED_GROUP = 'new_group84798';

const FROM        = 'HANDS Logistics <concierge@handslogistics.com>';
const OPS_TEAM    = ['concierge@handslogistics.com', 'inbound@handslogistics.com'];
const LOGO_URL    = 'https://res.cloudinary.com/dxkpbjicu/image/upload/v1774556178/HANDS_Logo_BlackBG_HiRes_qtkac8.png';

// NV I/O board columns
const NVIO = {
  purpose:        'color_mm1th2fd',       // Material Purpose (status)
  project:        'text_mm1t684g',        // Event / Project Name
  clientNotes:    'long_text_mm1t2fc',    // Client Notes / Reply
  noticeSent:     'boolean_mm1trns6'      // Notice Sent checkbox (re-used as "client replied" flag)
};

// Ops board columns (for the new delivery item, when scheduling)
const OPS = {
  clientName:     'text',
  account:        'text4',
  projectName:    'text5',
  deliveryDate:   'text2',                // plain text, uppercase month format
  deliveryTime:   'text9',                // plain text
  deliveryAddress:'long_text8',
  description:    'long_text',
  specialInst:    'long_text_mm1qb1hz',
  clientEmail:    'client_email1',
  clientPhone:    'phone',
  logisticsStatus:'color',                // default to Unconfirmed
  activityType:   'color_mm1wxn5k'        // default to Delivery
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

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

// Convert YYYY-MM-DD to "MONTH D, YYYY" (matches Ops board text2 convention)
function toUppercaseMonthDate(iso) {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  return MONTHS[parseInt(m[2],10)-1] + ' ' + parseInt(m[3],10) + ', ' + m[1];
}

// Convert HH:MM 24h → "H:MM AM/PM"
function to12h(hhmm) {
  if (!hhmm) return '';
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return hhmm;
  let h = parseInt(m[1],10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m[2] + ' ' + ampm;
}

function validEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()); }

// ── OPS-TEAM EMAIL TEMPLATE ──
function renderOpsTeamEmail(p, opsItemId) {
  const e = escapeHtml;
  const urgencyColor = p.urgency === 'Urgent' ? '#df2f4a' : (p.urgency === 'Priority' ? '#f0c040' : '#a0d6b4');
  const scheduledBlock = p.scheduleDelivery
    ? `<tr><td style="padding:16px 18px;background:rgba(160,214,180,0.08);border-top:1px solid #d0d0d0;">
         <p style="margin:0 0 6px;font-size:11px;font-weight:900;letter-spacing:2px;text-transform:uppercase;color:#a0d6b4;">Delivery requested</p>
         <p style="margin:0;font-size:13px;color:#0a0a0a;line-height:1.7;">
           ${e(p._deliveryDateFmt)} · ${e(p._deliveryTimeFmt)}<br>
           ${e(p.shipTo || '(no address)')}<br>
           Contact: ${e(p.deliveryContact || p.clientName)}${p.deliveryPhone ? ' · ' + e(p.deliveryPhone) : ''}<br>
           ${opsItemId ? '<strong>Ops Board item created: PO #' + e(opsItemId) + '</strong>' : '<em style="color:#df2f4a;">Ops Board item NOT created — check logs</em>'}
         </p>
       </td></tr>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Purpose Assigned</title></head>
<body style="margin:0;padding:0;background:#f2f2f2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#e0e0e0;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.1);">
  <tr><td style="background:#0a0a0a;padding:28px 40px;">
    <img src="${LOGO_URL}" alt="HANDS" width="145" style="display:block;">
    <table width="100%" style="margin-top:20px;"><tr>
      <td width="68%" height="3" style="background:#1a1a1a;font-size:0;line-height:0;">&nbsp;</td>
      <td width="32%" height="3" style="background:#a0d6b4;font-size:0;line-height:0;">&nbsp;</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#a0d6b4;padding:14px 40px;text-align:center;">
    <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#0a0a0a;">Client Purpose Assigned</p>
  </td></tr>
  <tr><td style="padding:30px 40px 10px;">
    <p style="margin:0 0 20px;font-size:15px;color:#444;line-height:1.5;">The client has assigned a purpose for PO #<strong>${e(p.po)}</strong>. Details below — review and take action if needed.</p>

    <table width="100%" style="margin-bottom:18px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
      <tr><td colspan="2" style="background:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;">
        <p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">01 &mdash; Submission</p>
      </td></tr>
      <tr><td style="padding:10px 18px;font-size:12px;color:#888;border-bottom:1px solid #e0e0e0;width:36%;text-transform:uppercase;letter-spacing:0.5px;">PO</td><td style="padding:10px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(p.po)}</td></tr>
      <tr><td style="padding:10px 18px;font-size:12px;color:#888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Account</td><td style="padding:10px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(p.account || '—')}</td></tr>
      <tr><td style="padding:10px 18px;font-size:12px;color:#888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Purpose</td><td style="padding:10px 18px;font-size:14px;color:#0a0a0a;font-weight:700;border-bottom:1px solid #e0e0e0;">${e(p.purpose)}</td></tr>
      ${p.eventName ? `<tr><td style="padding:10px 18px;font-size:12px;color:#888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Event</td><td style="padding:10px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(p.eventName)}${p.eventDate ? ' — '+e(p.eventDate) : ''}</td></tr>` : ''}
      ${p.shipTo && !p.scheduleDelivery ? `<tr><td style="padding:10px 18px;font-size:12px;color:#888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Ship-To</td><td style="padding:10px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(p.shipTo)}</td></tr>` : ''}
      <tr><td style="padding:10px 18px;font-size:12px;color:#888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Urgency</td><td style="padding:10px 18px;font-size:13px;border-bottom:1px solid #e0e0e0;"><span style="display:inline-block;padding:3px 10px;background:${urgencyColor};color:#0a0a0a;border-radius:3px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">${e(p.urgency)}</span></td></tr>
      <tr><td style="padding:10px 18px;font-size:12px;color:#888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Submitted By</td><td style="padding:10px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(p.clientName)} &lt;${e(p.clientEmail)}&gt;</td></tr>
      ${p.request ? `<tr><td style="padding:10px 18px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;vertical-align:top;">Notes</td><td style="padding:10px 18px;font-size:13px;color:#0a0a0a;line-height:1.5;white-space:pre-line;">${e(p.request)}</td></tr>` : ''}
      ${scheduledBlock}
    </table>

    <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;"><tr>
      <td style="background:#0a0a0a;border-radius:6px;">
        <a href="https://handslogistics.monday.com/boards/${NVIO_BOARD_ID}/pulses/${e(p.itemId)}" style="display:inline-block;padding:10px 18px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:#fff;text-decoration:none;letter-spacing:1px;text-transform:uppercase;">View NV I/O Item</a>
      </td>
      ${opsItemId ? `<td width="8">&nbsp;</td><td style="background:#a0d6b4;border-radius:6px;">
        <a href="https://handslogistics.monday.com/boards/${OPS_BOARD_ID}/pulses/${e(opsItemId)}" style="display:inline-block;padding:10px 18px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:1px;text-transform:uppercase;">View Ops Item</a>
      </td>` : ''}
    </tr></table>
  </td></tr>
  <tr><td style="background:#0a0a0a;padding:18px 40px;text-align:center;">
    <p style="margin:0;font-size:10px;color:rgba(255,255,255,0.55);letter-spacing:2px;text-transform:uppercase;">HANDS Logistics &middot; Concierge Desk</p>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

// ── CLIENT CONFIRMATION EMAIL TEMPLATE ──
function renderClientEmail(p, opsItemId) {
  const e = escapeHtml;
  const deliveryLine = p.scheduleDelivery
    ? `<p style="margin:0 0 14px;font-size:14px;color:#444;line-height:1.6;">We've scheduled your delivery for <strong>${e(p._deliveryDateFmt)} at ${e(p._deliveryTimeFmt)}</strong>. You'll receive a Delivery Confirmation from our concierge team shortly with final details.</p>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Received</title></head>
<body style="margin:0;padding:0;background:#f2f2f2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#e0e0e0;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.1);">
  <tr><td style="background:#0a0a0a;padding:28px 40px;">
    <img src="${LOGO_URL}" alt="HANDS" width="145" style="display:block;">
    <table width="100%" style="margin-top:20px;"><tr>
      <td width="68%" height="3" style="background:#1a1a1a;font-size:0;line-height:0;">&nbsp;</td>
      <td width="32%" height="3" style="background:#a0d6b4;font-size:0;line-height:0;">&nbsp;</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#a0d6b4;padding:14px 40px;text-align:center;">
    <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#0a0a0a;">Request Received</p>
  </td></tr>
  <tr><td style="padding:36px 40px 10px;">
    <p style="margin:0 0 6px;font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-0.5px;">Thanks, ${e(p.clientName.split(' ')[0] || 'there')}.</p>
    <p style="margin:0 0 18px;font-size:14px;color:#444;line-height:1.6;">We've received your purpose assignment for PO #<strong>${e(p.po)}</strong>. Our concierge team has been notified and will act on your instructions.</p>
    ${deliveryLine}

    <table width="100%" style="margin:18px 0;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
      <tr><td style="padding:10px 18px;font-size:12px;color:#888;background:#e2e2e2;letter-spacing:0.5px;text-transform:uppercase;">Summary</td></tr>
      <tr><td style="padding:14px 18px;font-size:13px;color:#0a0a0a;line-height:1.8;">
        <strong>Purpose:</strong> ${e(p.purpose)}<br>
        ${p.eventName ? '<strong>Event:</strong> ' + e(p.eventName) + (p.eventDate ? ' — '+e(p.eventDate) : '') + '<br>' : ''}
        ${p.shipTo ? '<strong>Ship-To:</strong> ' + e(p.shipTo) + '<br>' : ''}
        ${p.scheduleDelivery ? '<strong>Delivery:</strong> ' + e(p._deliveryDateFmt) + ' at ' + e(p._deliveryTimeFmt) + '<br>' : ''}
        <strong>Urgency:</strong> ${e(p.urgency)}
      </td></tr>
    </table>

    <p style="margin:18px 0 8px;font-size:13px;color:#666;line-height:1.6;">Questions or changes? Reply to this email or reach <a href="mailto:concierge&#64;handslogistics.com" style="color:#0a0a0a;">concierge&#64;handslogistics.com</a>.</p>
  </td></tr>
  <tr><td style="background:#0a0a0a;padding:22px 40px;text-align:center;">
    <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:13px;font-style:italic;color:rgba(255,255,255,0.8);">Your logistics are in better HANDS.</p>
    <p style="margin:0;font-size:10px;color:rgba(255,255,255,0.45);letter-spacing:2px;text-transform:uppercase;">Concierge Desk &middot; Las Vegas</p>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

// ── HANDLER ──
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!MONDAY_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'MONDAY_TOKEN not set' }) };
  if (!RESEND_KEY)   return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'RESEND_KEY not set' }) };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Required fields
  if (!p.itemId)                   return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing itemId' }) };
  if (!p.clientName)               return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing clientName' }) };
  if (!p.clientEmail || !validEmail(p.clientEmail)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid clientEmail' }) };
  if (!p.purpose)                  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing purpose' }) };

  // Normalize scheduling fields
  p._deliveryDateFmt = toUppercaseMonthDate(p.deliveryDate);
  p._deliveryTimeFmt = to12h(p.deliveryTime);
  const willSchedule = !!(p.scheduleDelivery && p.deliveryDate && p.deliveryTime && (p.shipTo || '').trim());

  const messages = [];
  let opsItemId = null;
  let nvWriteError = null;
  let opsWriteError = null;
  let opsTeamEmailError = null;
  let clientEmailError = null;

  // ── Step 1: Update the NV I/O item ──
  try {
    // Fetch existing Client Notes to append rather than overwrite
    const qLookup = '{ items(ids:['+p.itemId+']) { id name column_values(ids:["'+NVIO.clientNotes+'","text1","text_mm1thc9z"]){id text} } }';
    const lookup = await mondayQuery(qLookup);
    const item = lookup.data.items && lookup.data.items[0];
    if (!item) throw new Error('NV I/O item not found: ' + p.itemId);

    const existingNotes = getCol(item.column_values, NVIO.clientNotes);
    const ts = new Date().toISOString().slice(0,16).replace('T',' ');
    const newNoteBlock = [
      '[' + ts + ' UTC — ' + p.clientName + ' <' + p.clientEmail + '>]',
      'Purpose: ' + p.purpose,
      p.eventName ? 'Event: ' + p.eventName + (p.eventDate ? ' (' + p.eventDate + ')' : '') : '',
      p.shipTo ? 'Ship-To: ' + p.shipTo : '',
      willSchedule ? 'Delivery requested: ' + p._deliveryDateFmt + ' @ ' + p._deliveryTimeFmt : '',
      willSchedule && p.deliveryContact ? 'Delivery contact: ' + p.deliveryContact + (p.deliveryPhone ? ' ('+p.deliveryPhone+')' : '') : '',
      willSchedule && p.deliveryInstructions ? 'Delivery instructions: ' + p.deliveryInstructions : '',
      'Urgency: ' + (p.urgency || 'Standard'),
      p.request ? 'Notes: ' + p.request : ''
    ].filter(Boolean).join('\n');
    const combinedNotes = (existingNotes ? existingNotes + '\n\n' : '') + newNoteBlock;

    const nvCols = {};
    nvCols[NVIO.purpose] = { label: p.purpose };
    if (p.eventName) nvCols[NVIO.project] = p.eventName;
    nvCols[NVIO.clientNotes] = combinedNotes;
    nvCols[NVIO.noticeSent] = { checked: 'true' }; // flag client replied

    const mut = 'mutation { change_multiple_column_values(item_id:'+p.itemId+', board_id:'+NVIO_BOARD_ID+', column_values:'+JSON.stringify(JSON.stringify(nvCols))+') { id } }';
    await mondayQuery(mut);
    messages.push('NV I/O item updated');
  } catch (e) {
    nvWriteError = e.message;
    console.error('NV I/O update failed:', e);
  }

  // ── Step 2: Create Ops Board item IF delivery requested ──
  if (willSchedule) {
    try {
      const opsCols = {};
      opsCols[OPS.clientName]      = p.clientName;
      if (p.account)     opsCols[OPS.account] = p.account;
      const projectLabel = p.eventName || (p.purpose + ' — PO #' + p.po);
      opsCols[OPS.projectName]     = projectLabel;
      opsCols[OPS.deliveryDate]    = p._deliveryDateFmt;
      opsCols[OPS.deliveryTime]    = p._deliveryTimeFmt;
      opsCols[OPS.deliveryAddress] = { text: p.shipTo };
      opsCols[OPS.description]     = 'Requested via Assign Purpose portal from NV I/O PO #' + p.po +
        (p.deliveryContact ? '\nOn-site contact: ' + p.deliveryContact + (p.deliveryPhone ? ' ('+p.deliveryPhone+')' : '') : '') +
        (p.request ? '\nClient notes: ' + p.request : '');
      if (p.deliveryInstructions) opsCols[OPS.specialInst] = { text: p.deliveryInstructions };
      opsCols[OPS.clientEmail]     = { email: p.clientEmail, text: p.clientEmail };
      if (p.deliveryPhone)         opsCols[OPS.clientPhone] = { phone: p.deliveryPhone, countryShortName: 'US' };
      opsCols[OPS.logisticsStatus] = { label: 'Unconfirmed' };
      opsCols[OPS.activityType]    = { label: 'Delivery' };

      const mut = 'mutation { create_item(board_id:'+OPS_BOARD_ID+', group_id:"'+OPS_UNCONFIRMED_GROUP+'", item_name:'+JSON.stringify(projectLabel)+', column_values:'+JSON.stringify(JSON.stringify(opsCols))+') { id } }';
      const data = await mondayQuery(mut);
      opsItemId = data.data.create_item.id;
      messages.push('Ops Board item created: PO #' + opsItemId);
    } catch (e) {
      opsWriteError = e.message;
      console.error('Ops create failed:', e);
    }
  }

  // ── Step 3: Monday audit update on NV I/O item ──
  try {
    const noteBody = '📬 Client ' + p.clientName + ' assigned purpose: ' + p.purpose +
      (willSchedule ? ' · Delivery scheduled ' + p._deliveryDateFmt + ' @ ' + p._deliveryTimeFmt : '') +
      (opsItemId ? ' · Ops PO #' + opsItemId + ' created' : '');
    const mut = 'mutation { create_update(item_id:'+p.itemId+', body:'+JSON.stringify(noteBody)+') { id } }';
    await mondayQuery(mut).catch(() => {}); // non-fatal
  } catch (e) { /* non-fatal */ }

  // ── Step 4: Ops-team email (always) ──
  try {
    const subject = '[Purpose Assigned] PO #' + p.po + ' · ' + p.purpose + (p.urgency && p.urgency !== 'Standard' ? ' · ' + p.urgency.toUpperCase() : '');
    const emailRes = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ 'Authorization':'Bearer '+RESEND_KEY, 'Content-Type':'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: OPS_TEAM,
        reply_to: p.clientEmail,
        subject,
        html: renderOpsTeamEmail(p, opsItemId)
      })
    });
    const data = await emailRes.json();
    if (!emailRes.ok) throw new Error('Resend ops: ' + JSON.stringify(data));
    messages.push('Ops team notified');
  } catch (e) {
    opsTeamEmailError = e.message;
    console.error('Ops team email failed:', e);
  }

  // ── Step 5: Client confirmation email (always, unless client email invalid) ──
  try {
    const subject = 'We received your request — PO #' + p.po;
    const emailRes = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ 'Authorization':'Bearer '+RESEND_KEY, 'Content-Type':'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [p.clientEmail],
        bcc: ['concierge@handslogistics.com'],
        subject,
        html: renderClientEmail(p, opsItemId)
      })
    });
    const data = await emailRes.json();
    if (!emailRes.ok) throw new Error('Resend client: ' + JSON.stringify(data));
    messages.push('Client confirmation sent');
  } catch (e) {
    clientEmailError = e.message;
    console.error('Client email failed:', e);
  }

  const allOk = !nvWriteError && !opsTeamEmailError;
  return {
    statusCode: allOk ? 200 : 207, // 207 = partial success
    headers: CORS,
    body: JSON.stringify({
      success: allOk,
      nvIoItemId: p.itemId,
      opsItemId,
      scheduled: willSchedule,
      messages,
      errors: {
        nvWriteError,
        opsWriteError,
        opsTeamEmailError,
        clientEmailError
      }
    })
  };
};
