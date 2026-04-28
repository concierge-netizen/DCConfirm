// ============================================================
// HANDS Logistics — DriverPOD shared email builder
// Matches DCConfirm POD template (full camo footer, Cloudinary logo).
// Used by submit-pod.js (real send) and preview-pod.js (QA preview).
//
// Photos are uploaded to Cloudinary client-side BEFORE this runs.
// The email simply embeds the Cloudinary URLs as "View Photo" button links.
// ============================================================

const LOGO_URL = 'https://res.cloudinary.com/dxkpbjicu/image/upload/v1774556178/HANDS_Logo_BlackBG_HiRes_qtkac8.png';

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render the POD email. isPreview=true adds an orange PREVIEW banner.
function renderPodHtml(f, isPreview) {
  const e = escapeHtml;
  const photoUrl  = f.photoUrl  || '';
  const photoUrl2 = f.photoUrl2 || '';

  const previewBanner = isPreview
    ? `<tr><td style="background:#f5a623;padding:14px 40px;text-align:center;">
         <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffff;">&#128064; PREVIEW — Not sent to client yet</p>
         <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.85);">Client: <strong>${e(f.clientEmail || 'No email on file')}</strong></p>
       </td></tr>`
    : '';

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

      ${previewBanner}

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
        <p style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-0.5px;">Your delivery has been completed.</p>
        <p style="margin:0 0 28px 0;font-size:14px;color:#444444;line-height:1.6;">Below is the proof of delivery for your records, including photos taken at drop-off. Please reach out within 48 hours if anything looks off.</p>

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
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;width:38%;text-transform:uppercase;letter-spacing:0.5px;">Date Delivered</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.deliveredDate)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Time Delivered</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.deliveredTime)}</td></tr>
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
        <p style="margin:0;font-size:12px;color:#888888;line-height:1.7;text-align:center;">Please contact <a href="mailto:concierge&#64;handslogistics.com" style="color:#a0d6b4;text-decoration:none;">concierge&#64;handslogistics.com</a> with any discrepancies within 48 hours of delivery.</p>
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

// ── Monday helpers ─────────────────────────────────────────────
async function mondayQuery(token, query) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2023-04'
    },
    body: JSON.stringify({ query })
  });
  if (!res.ok) throw new Error('monday API HTTP error: ' + res.status);
  const data = await res.json();
  if (data.errors) throw new Error('monday error: ' + JSON.stringify(data.errors));
  return data;
}

function getCol(columns, id) {
  const col = columns.find(c => c.id === id);
  return (col && col.text && col.text.trim()) ? col.text.trim() : '';
}

function getLinkUrl(columns, id) {
  const col = columns.find(c => c.id === id);
  if (!col || !col.value) return '';
  try { return JSON.parse(col.value).url || ''; } catch (e) { return getCol(columns, id); }
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

// ============================================================
// DELIVERY CONFIRMATION email builder (sent BEFORE delivery)
// Used by send-confirmation.js — confirms a scheduled delivery to client.
// Distinct from renderPodHtml which is the POST-delivery proof of delivery.
// ============================================================

// Read Monday token from env. Tries common variable names.
function getMondayToken() {
  const t = process.env.MONDAY_API_KEY
         || process.env.MONDAY_TOKEN
         || process.env.MONDAY_API_TOKEN;
  if (!t) throw new Error('Monday token not set in env (MONDAY_API_KEY or MONDAY_TOKEN)');
  return t;
}

// Fetch a Monday item by ID with all column values needed for the DC email.
async function fetchItem(itemId) {
  const token = getMondayToken();
  const query = `query {
    items(ids: [${itemId}]) {
      id
      name
      column_values {
        id
        text
        value
      }
    }
  }`;
  const data = await mondayQuery(token, query);
  const items = data && data.data && data.data.items;
  if (!items || items.length === 0) {
    throw new Error('Monday item not found: ' + itemId);
  }
  return items[0];
}

// Extract the fields we use in the delivery confirmation email from a Monday item.
function extractFields(item) {
  const cols = item.column_values || [];
  return {
    pulseId:         item.id,
    itemName:        item.name || '',
    clientName:      getCol(cols, 'text'),
    clientEmail:     getCol(cols, 'client_email1'),
    account:         getCol(cols, 'text4'),
    projectName:     getCol(cols, 'text5'),
    deliveryDate:    getCol(cols, 'text2'),
    deliveryTime:    getCol(cols, 'text9'),
    deliveryAddress: getCol(cols, 'long_text8'),
    description:     getCol(cols, 'long_text'),
    specialInstructions: getCol(cols, 'long_text_mm1qb1hz')
  };
}

// Render the Delivery Confirmation email HTML.
// Uses the same brand template as POD but with confirmation copy.
function buildEmail(f) {
  const e = escapeHtml;
  const subject = 'Delivery Confirmation: ' + (f.account || f.clientName || 'Your Delivery')
                + (f.projectName ? ' — ' + f.projectName : '');

  const html = `<!DOCTYPE html>
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
        <p style="margin:0 0 8px 0;font-size:22px;font-weight:800;color:#0a0a0a;letter-spacing:-0.5px;">Your delivery has been scheduled.</p>
        <p style="margin:0 0 28px 0;font-size:14px;color:#444444;line-height:1.6;">Please confirm the details below. If anything looks off, reply to this email or contact us at concierge&#64;handslogistics.com and we'll make it right.</p>

        <!-- 01 ORDER INFORMATION -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td colspan="2" style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">01 &mdash; Order Information</p></td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;width:38%;text-transform:uppercase;letter-spacing:0.5px;">Client</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.clientName)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Account</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.account)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">PO Number</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.pulseId)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">Project Name</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;">${e(f.projectName)}</td></tr>
        </table>

        ${f.description ? `<!-- 02 ITEMS -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">02 &mdash; Items For Delivery</p></td></tr>
          <tr><td style="padding:16px 18px;"><p style="margin:0;font-size:13px;color:#0a0a0a;line-height:1.9;white-space:pre-line;">${e(f.description)}</p></td></tr>
        </table>` : ''}

        <!-- 03 DELIVERY DETAILS -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td colspan="2" style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">03 &mdash; Delivery Details</p></td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;width:38%;text-transform:uppercase;letter-spacing:0.5px;">Date</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.deliveryDate)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;border-bottom:1px solid #e0e0e0;text-transform:uppercase;letter-spacing:0.5px;">Time</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;border-bottom:1px solid #e0e0e0;">${e(f.deliveryTime)}</td></tr>
          <tr><td style="padding:11px 18px;font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">Address</td><td style="padding:11px 18px;font-size:13px;color:#0a0a0a;">${e(f.deliveryAddress)}</td></tr>
        </table>

        ${f.specialInstructions ? `<!-- 04 SPECIAL INSTRUCTIONS -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:36px;border:1px solid #d0d0d0;border-radius:6px;overflow:hidden;">
          <tr><td style="background-color:#e2e2e2;padding:10px 18px;border-bottom:1px solid #d0d0d0;"><p style="margin:0;font-size:9.5px;font-weight:900;letter-spacing:3px;text-transform:uppercase;color:#a0d6b4;">04 &mdash; Special Instructions</p></td></tr>
          <tr><td style="padding:16px 18px;"><p style="margin:0;font-size:13px;color:#0a0a0a;line-height:1.9;white-space:pre-line;">${e(f.specialInstructions)}</p></td></tr>
        </table>` : '<div style="height:12px;">&nbsp;</div>'}

      </td></tr>

      <!-- DISCLAIMER -->
      <tr><td style="background-color:#e8e8e8;padding:20px 40px;border-top:1px solid #d5d5d5;">
        <p style="margin:0;font-size:12px;color:#888888;line-height:1.7;text-align:center;">Please contact <a href="mailto:concierge&#64;handslogistics.com" style="color:#a0d6b4;text-decoration:none;">concierge&#64;handslogistics.com</a> if you need to adjust the delivery details. We confirm receipt of all replies within one business hour.</p>
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

  return { subject, html };
}

// Mark Order Confirmation Sent (boolean_mm1jv595) on a Monday item.
// Non-fatal if it fails — the email already went out.
async function markSent(itemId) {
  const token = getMondayToken();
  const boardId = process.env.MONDAY_BOARD_ID || '4550650855';
  // Monday checkbox column requires JSON value: {"checked":"true"}
  // The column_values arg must be double-stringified for the GraphQL string.
  const colValues = JSON.stringify({ boolean_mm1jv595: { checked: 'true' } });
  const query = `mutation {
    change_multiple_column_values(
      item_id: ${itemId},
      board_id: ${boardId},
      column_values: ${JSON.stringify(colValues)}
    ) { id }
  }`;
  return mondayQuery(token, query);
}

// Extract POD-specific fields from a Monday item.
// Includes the photo URLs (link columns), received-by name, and delivered date/time.
function extractPodFields(item) {
  const cols = item.column_values || [];
  return {
    pulseId:         item.id,
    itemName:        item.name || '',
    clientName:      getCol(cols, 'text'),
    clientEmail:     getCol(cols, 'client_email1'),
    account:         getCol(cols, 'text4'),
    projectName:     getCol(cols, 'text5'),
    deliveryAddress: getCol(cols, 'long_text8'),
    description:     getCol(cols, 'long_text'),
    // POD-specific
    receivedBy:      getCol(cols, 'text_mm1p831b'),
    deliveredDate:   getCol(cols, 'text0')  || getCol(cols, 'text2'),  // fallback to scheduled date
    deliveredTime:   getCol(cols, 'text00') || getCol(cols, 'text9'),  // fallback to scheduled time
    photoUrl:        getLinkUrl(cols, 'link_mm1pgr61'),
    photoUrl2:       getLinkUrl(cols, 'link_mm1pay5j')
  };
}

// Render the POD email with subject + HTML.
// Uses the existing renderPodHtml template (full POD email with photos, camo footer, etc.).
function buildPodEmail(f) {
  const subject = 'Proof of Delivery: ' + (f.account || f.clientName || 'Your Delivery')
                + (f.projectName ? ' — ' + f.projectName : '');
  const html = renderPodHtml(f, false);  // false = not preview mode
  return { subject, html };
}

// Mark POD Email Sent (boolean_mm1jr3gr) on a Monday item.
// Distinct from markSent which flips Order Confirmation Sent (boolean_mm1jv595).
async function markPodSent(itemId) {
  const token = getMondayToken();
  const boardId = process.env.MONDAY_BOARD_ID || '4550650855';
  const colValues = JSON.stringify({ boolean_mm1jr3gr: { checked: 'true' } });
  const query = `mutation {
    change_multiple_column_values(
      item_id: ${itemId},
      board_id: ${boardId},
      column_values: ${JSON.stringify(colValues)}
    ) { id }
  }`;
  return mondayQuery(token, query);
}

module.exports = {
  // POD email
  renderPodHtml,
  extractPodFields,
  buildPodEmail,
  markPodSent,
  // Delivery Confirmation email
  fetchItem,
  extractFields,
  buildEmail,
  markSent,
  // Shared helpers
  mondayQuery,
  getCol,
  getLinkUrl,
  escapeHtml,
  sanitizeEmailList,
  LOGO_URL
};
