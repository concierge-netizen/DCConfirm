// ============================================================
// HANDS Logistics — Delivery Confirmation Email Builder
// Shared module: fetches Monday data, renders HTML, writes back
// ============================================================

const MONDAY_API_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjYzNjEzNzc5MSwiYWFpIjoxMSwidWlkIjoxNDk4NzI0NSwiaWFkIjoiMjAyNi0wMy0yMlQxNzoyNTo1MC4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NjYxOTgxNSwicmduIjoidXNlMSJ9.RLTGytTbLaran19E20Ag8nzxdaWuwVKVZNx3fdvAIBQ';
const BOARD_ID = 4550650855;
const LOGO_URL = 'https://res.cloudinary.com/dxkpbjicu/image/upload/v1774556178/HANDS_Logo_BlackBG_HiRes_qtkac8.png';

// ── MONDAY FETCH ──
async function fetchItem(itemId) {
  const query = '{ items (ids: [' + itemId + ']) { id name column_values { id type text value } } }';
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_TOKEN,
      'API-Version': '2023-04'
    },
    body: JSON.stringify({ query })
  });
  if (!res.ok) throw new Error('Monday HTTP ' + res.status);
  const result = await res.json();
  if (result.errors) throw new Error('Monday API: ' + JSON.stringify(result.errors));
  if (!result.data || !result.data.items || result.data.items.length === 0) {
    throw new Error('Item not found: ' + itemId);
  }
  return result.data.items[0];
}

// ── EXTRACT FIELDS ──
function extractFields(item) {
  const cols = item.column_values;
  const get = id => {
    const c = cols.find(x => x.id === id);
    return c && c.text && c.text.trim() !== '' ? c.text.trim() : null;
  };
  return {
    pulseId:             item.id,
    clientName:          get('text')                || 'N/A',
    account:             get('text4')               || 'N/A',
    projectName:         get('text5')               || 'N/A',
    deliveryDate:        get('text2')               || 'TBD',
    deliveryTime:        get('text9')               || 'TBD',
    deliveryAddress:     get('long_text8')          || 'N/A',
    description:         get('long_text')           || 'See order details on file.',
    receivedBy:          get('text')                || 'Team',
    clientEmail:         get('client_email1')       || '',
    specialInstructions: get('long_text_mm1qb1hz')  || 'No special instructions provided.'
  };
}

// ── EXTRACT POD FIELDS ──
function extractPodFields(item) {
  const cols = item.column_values;
  const get = id => {
    const c = cols.find(x => x.id === id);
    return c && c.text && c.text.trim() !== '' ? c.text.trim() : null;
  };
  const getLinkUrl = id => {
    const c = cols.find(x => x.id === id);
    if (!c || !c.value) return '';
    try {
      const parsed = JSON.parse(c.value);
      return parsed.url || '';
    } catch (e) { return get(id) || ''; }
  };
  return {
    pulseId:         item.id,
    clientName:      get('text')          || 'Valued Client',
    account:         get('text4')         || '',
    projectName:     get('text5')         || '',
    deliveryDate:    get('text2')         || 'TBD',
    deliveryTime:    get('text9')         || 'TBD',
    deliveryAddress: get('long_text8')    || 'N/A',
    description:     get('long_text')     || 'See order details on file.',
    clientEmail:     get('client_email1') || '',
    receivedBy:      get('text_mm1p831b') || 'Team',
    photoUrl:        getLinkUrl('link_mm1pgr61'),
    photoUrl2:       getLinkUrl('link_mm1pay5j')
  };
}

// ── BUILD EMAIL ──
function buildEmail(f) {
  const hasProject = f.projectName && f.projectName !== 'N/A';
  const subject = hasProject
    ? 'Delivery Confirmation — ' + f.projectName + ' | PO #' + f.pulseId
    : 'Delivery Confirmation — PO #' + f.pulseId;
  return { subject, html: renderHtml(f) };
}

function buildPodEmail(f) {
  const hasProject = f.projectName && f.projectName !== 'N/A';
  const subject = hasProject
    ? 'Proof of Delivery — ' + f.projectName + ' | PO #' + f.pulseId
    : 'Proof of Delivery — PO #' + f.pulseId;
  return { subject, html: renderPodHtml(f) };
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtml(f) {
  const e = escapeHtml;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Delivery Confirmation</title>
</head>
<body style="margin:0;padding:0;background-color:#f2f2f2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e0e0e0;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

      <!-- HEADER -->
      <tr><td style="background-color:#0a0a0a;padding:32px 40px 28px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;">
            <img src="${LOGO_URL}" alt="HANDS Logistics" width="145" style="display:block;border:0;max-width:145px;">
          </td>
          <td align="right" style="vertical-align:middle;">
            <p style="margin:0;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#555555;">Brand Activations<br>Concierge Logistics</p>
          </td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr>
          <td width="68%" height="3" style="background-color:#1a1a1a;font-size:0;line-height:0;">&nbsp;</td>
          <td width="32%" height="3" style="background-color:#a0d6b4;font-size:0;line-height:0;">&nbsp;</td>
        </tr></table>
      </td></tr>

      <!-- BANNER -->
      <tr><td style="background-color:#a0d6b4;padding:14px 40px;">
        <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#0a0a0a;text-align:center;">Delivery Confirmation</p>
      </td></tr>

      <!-- BODY -->
      <tr><td style="padding:36px 40px 0;">
        <p style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-0.5px;">Your delivery is on its way.</p>
        <p style="margin:0 0 28px 0;font-size:14px;color:#444444;line-height:1.6;">Hi ${e(f.receivedBy)}, your order has been confirmed and dispatched. Track the details below and reach out if you need anything before it arrives.</p>

        <!-- 01 ORDER INFORMATION -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td colspan="2" style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">01 &mdash; Order Information</p></td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;width:38%;text-transform:uppercase;letter-spacing:0.5px;">Client</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.clientName)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Account</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.account)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">PO Number</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.pulseId)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">Project Name</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;">${e(f.projectName)}</td></tr>
        </table>

        <!-- 02 ITEMS DISPATCHED -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">02 &mdash; Items Dispatched</p></td></tr>
          <tr><td style="padding:16px 18px;"><p style="margin:0;font-size:13px;color:#0a0a0a;line-height:1.9;white-space:pre-line;">${e(f.description)}</p></td></tr>
        </table>

        <!-- 03 DELIVERY DETAILS -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td colspan="2" style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">03 &mdash; Delivery Details</p></td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;width:38%;text-transform:uppercase;letter-spacing:0.5px;">Scheduled Date</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.deliveryDate)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Delivery Window</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.deliveryTime)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">Delivery Address</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;">${e(f.deliveryAddress)}</td></tr>
        </table>

        <!-- 04 SPECIAL INSTRUCTIONS -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">04 &mdash; Special Instructions</p></td></tr>
          <tr><td style="padding:16px 18px;"><p style="margin:0;font-size:13px;color:#0a0a0a;line-height:1.9;white-space:pre-line;">${e(f.specialInstructions)}</p></td></tr>
        </table>

        <!-- 05 WHAT TO EXPECT -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:36px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td colspan="2" style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">05 &mdash; What to Expect</p></td></tr>
          <tr><td style="padding:16px 18px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="vertical-align:top;padding-right:12px;width:20px;"><div style="width:20px;height:20px;border-radius:50%;background-color:#a0d6b4;text-align:center;line-height:20px;font-size:10px;font-weight:900;color:#0a0a0a;">1</div></td><td style="font-size:13px;color:#0a0a0a;padding-bottom:12px;line-height:1.5;">Your courier will arrive during the delivery window above. Please ensure someone is available to receive the order.</td></tr>
              <tr><td style="vertical-align:top;padding-right:12px;width:20px;"><div style="width:20px;height:20px;border-radius:50%;background-color:#a0d6b4;text-align:center;line-height:20px;font-size:10px;font-weight:900;color:#0a0a0a;">2</div></td><td style="font-size:13px;color:#0a0a0a;padding-bottom:12px;line-height:1.5;">Upon delivery, the courier will take photos as proof of delivery. A separate Proof of Delivery email will follow.</td></tr>
              <tr><td style="vertical-align:top;padding-right:12px;width:20px;"><div style="width:20px;height:20px;border-radius:50%;background-color:#a0d6b4;text-align:center;line-height:20px;font-size:10px;font-weight:900;color:#0a0a0a;">3</div></td><td style="font-size:13px;color:#0a0a0a;line-height:1.5;">If any item is missing or damaged on arrival, please contact us within 48 hours at concierge&#64;handslogistics.com.</td></tr>
            </table>
          </td></tr>
        </table>

      </td></tr>

      <!-- DISCLAIMER -->
      <tr><td style="background-color:#e8e8e8;padding:20px 40px;border-top:1px solid #d5d5d5;">
        <p style="margin:0;font-size:12px;color:#888888;line-height:1.7;text-align:center;">Questions? Contact <a href="mailto:concierge&#64;handslogistics.com" style="color:#a0d6b4;text-decoration:none;">concierge&#64;handslogistics.com</a> &mdash; please report any discrepancies within 48 hours of delivery.</p>
      </td></tr>

      <!-- CAMO FOOTER -->
      <tr><td style="padding:0;font-size:0;line-height:0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
          <td width="68%" height="3" style="background-color:#1a1a1a;font-size:0;line-height:0;">&nbsp;</td>
          <td width="32%" height="3" style="background-color:#a0d6b4;font-size:0;line-height:0;">&nbsp;</td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
          <td style="background-color:#0a0a0a;padding:0;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:rgba(5,5,5,0.90);">
              <tr><td style="padding:32px 40px 36px 40px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                  <td width="38%" style="vertical-align:top;padding-right:32px;border-right:1px solid rgba(255,255,255,0.12);">
                    <p style="margin:0 0 6px 0;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:normal;color:#ffffff;letter-spacing:0.01em;line-height:1.2;">Concierge Desk</p>
                    <p style="margin:0 0 20px 0;font-family:Arial,Helvetica,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#a0d6b4;">HANDS Logistics</p>
                    <table cellpadding="0" cellspacing="0" border="0"><tr>
                      <td style="background-color:#a0d6b4;border-radius:6px;text-align:center;">
                        <a href="https://scheduleadelivery.netlify.app/" target="_blank" style="display:inline-block;padding:13px 20px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;">Book Another Delivery</a>
                      </td>
                    </tr></table>
                  </td>
                  <td width="62%" style="vertical-align:top;padding-left:32px;">
                    <p style="margin:0 0 18px 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;font-style:italic;color:rgba(255,255,255,0.85);letter-spacing:0.02em;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,0.12);">Your logistics are in better HANDS.</p>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr><td width="22" style="vertical-align:top;padding-top:1px;padding-bottom:12px;"><span style="color:#a0d6b4;font-size:13px;">&#9993;</span></td><td style="vertical-align:middle;padding-bottom:12px;"><a href="mailto:concierge&#64;handslogistics.com" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#ffffff;text-decoration:none;">concierge&#64;handslogistics.com</a></td></tr>
                      <tr><td width="22" style="vertical-align:top;padding-top:1px;padding-bottom:12px;"><span style="color:#a0d6b4;font-size:13px;">&#9872;</span></td><td style="vertical-align:middle;padding-bottom:12px;"><a href="https://www.handslogistics.com" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#ffffff;text-decoration:none;">www.handslogistics.com</a></td></tr>
                      <tr><td width="22" style="vertical-align:top;padding-top:2px;"><span style="color:#a0d6b4;font-size:13px;">&#9679;</span></td><td style="vertical-align:top;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:rgba(255,255,255,0.75);line-height:1.5;">8540 Dean Martin Drive<br>Suite 160, Las Vegas, NV 89139</span></td></tr>
                    </table>
                  </td>
                </tr></table>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;"><tr><td height="1" style="background-color:rgba(255,255,255,0.10);font-size:0;line-height:0;"></td></tr></table>
                <p style="margin:10px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:8px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.35);">Brand Activations &nbsp;&middot;&nbsp; Events &nbsp;&middot;&nbsp; Concierge Logistics</p>
              </td></tr>
            </table>
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── WRITE BACK: mark Order Confirmation Sent + clear SEND DC ──
async function markSent(itemId) {
  const cols = {
    boolean_mm1jv595: { checked: 'true' },
    color_mm1qe2ht: { label: '' }
  };
  const mutation = 'mutation { change_multiple_column_values(item_id: ' + itemId + ', board_id: ' + BOARD_ID + ', column_values: ' + JSON.stringify(JSON.stringify(cols)) + ') { id } }';
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_TOKEN,
      'API-Version': '2023-04'
    },
    body: JSON.stringify({ query: mutation })
  });
  const result = await res.json();
  if (result.errors) throw new Error('Monday write-back: ' + JSON.stringify(result.errors));
  return result.data.change_multiple_column_values.id;
}

// ── POD HTML RENDERER ──
function renderPodHtml(f) {
  const e = escapeHtml;
  const photoUrl  = f.photoUrl  || '';
  const photoUrl2 = f.photoUrl2 || '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Proof of Delivery</title>
</head>
<body style="margin:0;padding:0;background-color:#f2f2f2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e0e0e0;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

      <!-- HEADER -->
      <tr><td style="background-color:#0a0a0a;padding:32px 40px 28px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;">
            <img src="${LOGO_URL}" alt="HANDS Logistics" width="145" style="display:block;border:0;max-width:145px;">
          </td>
          <td align="right" style="vertical-align:middle;">
            <p style="margin:0;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#555555;">Brand Activations<br>Concierge Logistics</p>
          </td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr>
          <td width="68%" height="3" style="background-color:#1a1a1a;font-size:0;line-height:0;">&nbsp;</td>
          <td width="32%" height="3" style="background-color:#a0d6b4;font-size:0;line-height:0;">&nbsp;</td>
        </tr></table>
      </td></tr>

      <!-- BANNER -->
      <tr><td style="background-color:#a0d6b4;padding:14px 40px;">
        <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#0a0a0a;text-align:center;">Proof of Delivery</p>
      </td></tr>

      <!-- BODY -->
      <tr><td style="padding:36px 40px 0;">
        <h1 style="margin:0 0 28px 0;font-size:28px;font-weight:800;color:#0a0a0a;letter-spacing:-0.5px;text-align:center;">PO #${e(f.pulseId)}</h1>
        <p style="margin:0 0 28px 0;font-size:14px;color:#444444;line-height:1.6;">This email confirms that your delivery has been completed successfully. Please retain this document for your records.</p>

        <!-- 01 ORDER INFORMATION -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td colspan="2" style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">01 &mdash; Order Information</p></td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;width:38%;text-transform:uppercase;letter-spacing:0.5px;">Client</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.clientName)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Account</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.account)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">PO Number</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.pulseId)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Project Name</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.projectName)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">Received By</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;">${e(f.receivedBy)}</td></tr>
        </table>

        <!-- 02 ITEMS DELIVERED -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">02 &mdash; Items Delivered</p></td></tr>
          <tr><td style="padding:16px 18px;"><p style="margin:0;font-size:13px;color:#0a0a0a;line-height:1.9;white-space:pre-line;">${e(f.description)}</p></td></tr>
        </table>

        <!-- 03 DELIVERY DETAILS -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td colspan="2" style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">03 &mdash; Delivery Details</p></td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;width:38%;text-transform:uppercase;letter-spacing:0.5px;">Date Delivered</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.deliveryDate)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Delivery Time</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.deliveryTime)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">Delivery Address</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;">${e(f.deliveryAddress)}</td></tr>
        </table>

        <!-- VIEW PHOTOS BUTTONS -->
        ${(photoUrl || photoUrl2) ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:36px;"><tr><td align="center">
          <table cellpadding="0" cellspacing="0" border="0"><tr>
            ${photoUrl ? `<td style="padding-right:8px;"><table cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:#a0d6b4;border-radius:8px;text-align:center;"><a href="${e(photoUrl)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:1px;text-transform:uppercase;">View Photo 1</a></td></tr></table></td>` : ''}
            ${photoUrl2 ? `<td style="padding-left:8px;"><table cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:#a0d6b4;border-radius:8px;text-align:center;"><a href="${e(photoUrl2)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:1px;text-transform:uppercase;">View Photo 2</a></td></tr></table></td>` : ''}
          </tr></table>
        </td></tr></table>` : ''}

      </td></tr>

      <!-- DISCLAIMER -->
      <tr><td style="background-color:#e8e8e8;padding:20px 40px;border-top:1px solid #d5d5d5;">
        <p style="margin:0;font-size:12px;color:#888888;line-height:1.7;text-align:center;">Please contact <a href="mailto:concierge&#64;handslogistics.com" style="color:#a0d6b4;text-decoration:none;">concierge&#64;handslogistics.com</a> with any discrepancies within 48 hours.</p>
      </td></tr>

      <!-- CAMO FOOTER -->
      <tr><td style="padding:0;font-size:0;line-height:0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
          <td width="68%" height="3" style="background-color:#1a1a1a;font-size:0;line-height:0;">&nbsp;</td>
          <td width="32%" height="3" style="background-color:#a0d6b4;font-size:0;line-height:0;">&nbsp;</td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
          <td style="background-color:#0a0a0a;padding:0;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:rgba(5,5,5,0.90);">
              <tr><td style="padding:32px 40px 36px 40px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                  <td width="38%" style="vertical-align:top;padding-right:32px;border-right:1px solid rgba(255,255,255,0.12);">
                    <p style="margin:0 0 6px 0;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:normal;color:#ffffff;letter-spacing:0.01em;line-height:1.2;">Concierge Desk</p>
                    <p style="margin:0 0 20px 0;font-family:Arial,Helvetica,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#a0d6b4;">HANDS Logistics</p>
                    <table cellpadding="0" cellspacing="0" border="0"><tr>
                      <td style="background-color:#a0d6b4;border-radius:6px;text-align:center;">
                        <a href="https://scheduleadelivery.netlify.app/" target="_blank" style="display:inline-block;padding:13px 20px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;">Book Another Delivery</a>
                      </td>
                    </tr></table>
                  </td>
                  <td width="62%" style="vertical-align:top;padding-left:32px;">
                    <p style="margin:0 0 18px 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;font-style:italic;color:rgba(255,255,255,0.85);letter-spacing:0.02em;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,0.12);">Your logistics are in better HANDS.</p>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr><td width="22" style="vertical-align:top;padding-top:1px;padding-bottom:12px;"><span style="color:#a0d6b4;font-size:13px;">&#9993;</span></td><td style="vertical-align:middle;padding-bottom:12px;"><a href="mailto:concierge&#64;handslogistics.com" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#ffffff;text-decoration:none;">concierge&#64;handslogistics.com</a></td></tr>
                      <tr><td width="22" style="vertical-align:top;padding-top:1px;padding-bottom:12px;"><span style="color:#a0d6b4;font-size:13px;">&#9872;</span></td><td style="vertical-align:middle;padding-bottom:12px;"><a href="https://www.handslogistics.com" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#ffffff;text-decoration:none;">www.handslogistics.com</a></td></tr>
                      <tr><td width="22" style="vertical-align:top;padding-top:2px;"><span style="color:#a0d6b4;font-size:13px;">&#9679;</span></td><td style="vertical-align:top;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:rgba(255,255,255,0.75);line-height:1.5;">8540 Dean Martin Drive<br>Suite 160, Las Vegas, NV 89139</span></td></tr>
                    </table>
                  </td>
                </tr></table>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;"><tr><td height="1" style="background-color:rgba(255,255,255,0.10);font-size:0;line-height:0;"></td></tr></table>
                <p style="margin:10px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:8px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.35);">Brand Activations &nbsp;&middot;&nbsp; Events &nbsp;&middot;&nbsp; Concierge Logistics</p>
              </td></tr>
            </table>
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── WRITE BACK POD: mark POD Email Sent + clear SEND POD ──
async function markPodSent(itemId) {
  const cols = {
    boolean_mm1jr3gr: { checked: 'true' },
    color_mm1qkyf: { label: '' }
  };
  const mutation = 'mutation { change_multiple_column_values(item_id: ' + itemId + ', board_id: ' + BOARD_ID + ', column_values: ' + JSON.stringify(JSON.stringify(cols)) + ') { id } }';
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_TOKEN,
      'API-Version': '2023-04'
    },
    body: JSON.stringify({ query: mutation })
  });
  const result = await res.json();
  if (result.errors) throw new Error('Monday POD write-back: ' + JSON.stringify(result.errors));
  return result.data.change_multiple_column_values.id;
}

// Validate + dedupe + cap a list of email addresses.
// Accepts array or comma/semicolon-delimited string. Returns array of valid emails,
// with `excludeEmail` removed (to prevent CC-ing the primary recipient). Max `cap` entries.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function sanitizeEmailList(input, excludeEmail, cap) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === 'string') list = input.split(/[,;]/);
  else return [];
  const exclude = (excludeEmail || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const email = String(raw || '').trim();
    if (!email) continue;
    if (!EMAIL_REGEX.test(email)) continue;
    const lower = email.toLowerCase();
    if (lower === exclude) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(email);
    if (out.length >= (cap || 10)) break;
  }
  return out;
}

// ── I/O NOTICE HTML RENDERER ──
// Used by send-io-notice.js to render branded inbound/outbound warehouse emails.
function renderIoNoticeHtml(f) {
  const e = escapeHtml;
  const isInbound = f.direction === 'Inbound';
  const headlineMsg = isInbound
    ? 'Your inbound shipment has been received at the HANDS warehouse.'
    : 'Your outbound shipment has been processed and is on its way.';
  const bannerText = isInbound ? 'Inbound Receipt' : 'Outbound Shipment';

  // Build base64 payload for Assign Purpose form (it expects ?data=BASE64JSON
  // with itemId, po, clientName, clientEmail, account, direction, date,
  // carrier, tracking, contents — see assign-purpose.html loadParams())
  const assignPayload = {
    itemId:      f.itemId,
    po:          f.itemId,
    clientName:  f.clientName || '',
    clientEmail: f.clientEmail || '',
    account:     f.account || '',
    direction:   f.direction,
    date:        f.shipDate || '',
    carrier:     f.carrier || '',
    tracking:    f.tracking || '',
    contents:    f.contents || ''
  };
  // Plain base64 — the form decodes via atob() which expects standard base64.
  // URI-encode the result so + / = survive transit through email clients and URLSearchParams.
  const assignDataBlob = encodeURIComponent(
    Buffer.from(JSON.stringify(assignPayload)).toString('base64')
  );
  const assignPurposeUrl = 'https://dcconfirm.netlify.app/assign-purpose?data=' + assignDataBlob;

  // Build the package stats row — only show what's present
  const stats = [];
  if (f.cartons) stats.push({ label: 'Cartons', value: f.cartons });
  if (f.pallets) stats.push({ label: 'Pallets', value: f.pallets });
  if (f.weight)  stats.push({ label: 'Weight', value: f.weight + ' lbs' });
  const statsHtml = stats.length
    ? '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;"><tr>' +
        stats.map(s =>
          '<td align="center" style="background:#f4f4f4;border:1px solid #d0d0d0;border-radius:6px;padding:14px 8px;' + (stats.indexOf(s) < stats.length-1 ? 'margin-right:4px;' : '') + '">' +
            '<div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#888;margin-bottom:4px;">'+e(s.label)+'</div>' +
            '<div style="font-size:20px;font-weight:800;color:#0a0a0a;">'+e(s.value)+'</div>' +
          '</td>' +
          (stats.indexOf(s) < stats.length-1 ? '<td width="6" style="font-size:0;line-height:0;">&nbsp;</td>' : '')
        ).join('') +
      '</tr></table>'
    : '';

  // Photo buttons (only if present)
  const p1 = f.photoUrl1 || '';
  const p2 = f.photoUrl2 || '';
  const photoButtons = (p1 || p2)
    ? '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:36px;"><tr><td align="center">' +
        '<table cellpadding="0" cellspacing="0" border="0"><tr>' +
          (p1 ? '<td style="padding-right:8px;"><table cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:#a0d6b4;border-radius:8px;text-align:center;"><a href="'+e(p1)+'" target="_blank" style="display:inline-block;padding:14px 28px;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:1px;text-transform:uppercase;">View Photo 1</a></td></tr></table></td>' : '') +
          (p2 ? '<td style="padding-left:8px;"><table cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:#a0d6b4;border-radius:8px;text-align:center;"><a href="'+e(p2)+'" target="_blank" style="display:inline-block;padding:14px 28px;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:1px;text-transform:uppercase;">View Photo 2</a></td></tr></table></td>' : '') +
        '</tr></table>' +
      '</td></tr></table>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${e(bannerText)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2f2f2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e0e0e0;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

      <!-- HEADER -->
      <tr><td style="background-color:#0a0a0a;padding:32px 40px 28px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;">
            <img src="https://res.cloudinary.com/dxkpbjicu/image/upload/v1774556178/HANDS_Logo_BlackBG_HiRes_qtkac8.png" alt="HANDS Logistics" width="145" style="display:block;border:0;max-width:145px;">
          </td>
          <td align="right" style="vertical-align:middle;">
            <p style="margin:0;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#555555;">Warehouse<br>Operations</p>
          </td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr>
          <td width="68%" height="3" style="background-color:#1a1a1a;font-size:0;line-height:0;">&nbsp;</td>
          <td width="32%" height="3" style="background-color:#a0d6b4;font-size:0;line-height:0;">&nbsp;</td>
        </tr></table>
      </td></tr>

      <!-- BANNER -->
      <tr><td style="background-color:#a0d6b4;padding:14px 40px;">
        <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#0a0a0a;text-align:center;">${e(bannerText)}</p>
      </td></tr>

      <!-- BODY -->
      <tr><td style="padding:36px 40px 0;">
        <p style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-0.5px;">${e(headlineMsg)}</p>
        <p style="margin:0 0 28px 0;font-size:14px;color:#444444;line-height:1.6;">Below are the details of record. Please reply to <a href="mailto:concierge&#64;handslogistics.com" style="color:#0a0a0a;">concierge&#64;handslogistics.com</a> if anything is incorrect.</p>

        <!-- 01 SHIPMENT INFORMATION -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td colspan="2" style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">01 &mdash; Shipment Information</p></td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;width:38%;text-transform:uppercase;letter-spacing:0.5px;">Client</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.clientName)}</td></tr>
          ${f.account ? `<tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Account</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.account)}</td></tr>` : ''}
          ${f.project ? `<tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Project</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.project)}</td></tr>` : ''}
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">PO Number</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.itemId)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Direction</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;"><strong>${e(f.direction)}</strong></td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">Purpose</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;">${e(f.purpose)}</td></tr>
        </table>

        <!-- 02 CONTENTS -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">02 &mdash; Contents</p></td></tr>
          <tr><td style="padding:16px 18px;"><p style="margin:0;font-size:13px;color:#0a0a0a;line-height:1.9;white-space:pre-line;">${e(f.contents)}</p></td></tr>
        </table>

        ${statsHtml}

        <!-- 03 CARRIER & TRACKING -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td colspan="2" style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">03 &mdash; Carrier &amp; Tracking</p></td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;width:38%;text-transform:uppercase;letter-spacing:0.5px;">Carrier</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.carrier)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Tracking #</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;font-family:ui-monospace,Menlo,monospace;">${e(f.tracking)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;${f.address ? 'border-bottom:1px solid #e0e0e0;' : ''}text-transform:uppercase;letter-spacing:0.5px;">${isInbound ? 'Received On' : 'Shipped On'}</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;${f.address ? 'border-bottom:1px solid #e0e0e0;' : ''}">${e(f.shipDate)}</td></tr>
          ${f.address ? `<tr><td style="padding:11px 18px;font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">${isInbound ? 'Received At' : 'Ship To'}</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;">${e(f.address)}</td></tr>` : ''}
        </table>

        ${f.instructions ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">04 &mdash; Special Instructions</p></td></tr>
          <tr><td style="padding:16px 18px;"><p style="margin:0;font-size:13px;color:#0a0a0a;line-height:1.9;white-space:pre-line;">${e(f.instructions)}</p></td></tr>
        </table>` : ''}

        ${photoButtons}

        <!-- ASSIGN PURPOSE CTA — client-facing call to action -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 28px;">
          <tr><td align="center" style="padding:24px 0 8px;border-top:1px solid #e0e0e0;">
            <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
              <tr><td style="background-color:#a0d6b4;border-radius:8px;text-align:center;">
                <a href="${assignPurposeUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;">Assign Purpose &rarr;</a>
              </td></tr>
            </table>
            <p style="margin:10px 0 0;font-size:11px;color:#888;">Let us know how you&rsquo;d like these materials used.</p>
          </td></tr>
        </table>

      </td></tr>

      <!-- DISCLAIMER -->
      <tr><td style="background-color:#e8e8e8;padding:20px 40px;border-top:1px solid #d5d5d5;">
        <p style="margin:0;font-size:12px;color:#888888;line-height:1.7;text-align:center;">Questions or discrepancies? Reply to this email or contact <a href="mailto:concierge&#64;handslogistics.com" style="color:#a0d6b4;text-decoration:none;">concierge&#64;handslogistics.com</a>.</p>
      </td></tr>

      <!-- CAMO FOOTER -->
      <tr><td style="padding:0;font-size:0;line-height:0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
          <td width="68%" height="3" style="background-color:#1a1a1a;font-size:0;line-height:0;">&nbsp;</td>
          <td width="32%" height="3" style="background-color:#a0d6b4;font-size:0;line-height:0;">&nbsp;</td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
          <td style="background-color:#0a0a0a;padding:0;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:rgba(5,5,5,0.90);">
              <tr><td style="padding:32px 40px 36px 40px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                  <td width="38%" style="vertical-align:top;padding-right:32px;border-right:1px solid rgba(255,255,255,0.12);">
                    <p style="margin:0 0 6px 0;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:normal;color:#ffffff;letter-spacing:0.01em;line-height:1.2;">Warehouse Desk</p>
                    <p style="margin:0 0 20px 0;font-family:Arial,Helvetica,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#a0d6b4;">HANDS Logistics</p>
                    <table cellpadding="0" cellspacing="0" border="0"><tr>
                      <td style="background-color:#a0d6b4;border-radius:6px;text-align:center;">
                        <a href="${e(f.mondayUrl)}" target="_blank" style="display:inline-block;padding:13px 20px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;">Open On Monday</a>
                      </td>
                    </tr></table>
                  </td>
                  <td width="62%" style="vertical-align:top;padding-left:32px;">
                    <p style="margin:0 0 18px 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;font-style:italic;color:rgba(255,255,255,0.85);letter-spacing:0.02em;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,0.12);">Your logistics are in better HANDS.</p>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr><td width="22" style="vertical-align:top;padding-top:1px;padding-bottom:12px;"><span style="color:#a0d6b4;font-size:13px;">&#9993;</span></td><td style="vertical-align:middle;padding-bottom:12px;"><a href="mailto:concierge&#64;handslogistics.com" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#ffffff;text-decoration:none;">concierge&#64;handslogistics.com</a></td></tr>
                      <tr><td width="22" style="vertical-align:top;padding-top:1px;padding-bottom:12px;"><span style="color:#a0d6b4;font-size:13px;">&#9872;</span></td><td style="vertical-align:middle;padding-bottom:12px;"><a href="https://www.handslogistics.com" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#ffffff;text-decoration:none;">www.handslogistics.com</a></td></tr>
                      <tr><td width="22" style="vertical-align:top;padding-top:2px;"><span style="color:#a0d6b4;font-size:13px;">&#9679;</span></td><td style="vertical-align:top;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:rgba(255,255,255,0.75);line-height:1.5;">8540 Dean Martin Drive<br>Suite 160, Las Vegas, NV 89139</span></td></tr>
                    </table>
                  </td>
                </tr></table>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;"><tr><td height="1" style="background-color:rgba(255,255,255,0.10);font-size:0;line-height:0;"></td></tr></table>
                <p style="margin:10px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:8px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.35);">Inbound &nbsp;&middot;&nbsp; Outbound &nbsp;&middot;&nbsp; Warehousing</p>
              </td></tr>
            </table>
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

module.exports = { fetchItem, extractFields, extractPodFields, buildEmail, buildPodEmail, markSent, markPodSent, sanitizeEmailList, renderIoNoticeHtml, BOARD_ID };
