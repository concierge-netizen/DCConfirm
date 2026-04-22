// ============================================================
// HANDS Logistics — Delivery Confirmation Email Builder
// Shared module: fetches Monday data, renders HTML, writes back
// ============================================================

const MONDAY_API_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjYzNjEzNzc5MSwiYWFpIjoxMSwidWlkIjoxNDk4NzI0NSwiaWFkIjoiMjAyNi0wMy0yMlQxNzoyNTo1MC4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6NjYxOTgxNSwicmduIjoidXNlMSJ9.RLTGytTbLaran19E20Ag8nzxdaWuwVKVZNx3fdvAIBQ';
const BOARD_ID = 4550650855;
const LOGO_URL = 'https://res.cloudinary.com/dxkpbjicu/image/upload/hands_logo.jpg';

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

// ── BUILD EMAIL ──
function buildEmail(f) {
  return {
    subject: 'Delivery Confirmation — PO #' + f.pulseId + ' | ' + f.projectName,
    html: renderHtml(f)
  };
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

module.exports = { fetchItem, extractFields, buildEmail, markSent, BOARD_ID };
