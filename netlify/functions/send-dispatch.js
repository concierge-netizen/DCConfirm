// netlify/functions/send-dispatch.js
// Receives dispatch data, sends branded email to driver + internal team via Resend

const RESEND_KEY = process.env.RESEND_KEY;
const FROM       = 'HANDS Logistics <concierge@handslogistics.com>';
const INTERNAL   = ['jon@handslogistics.com', 'charles@handslogistics.com'];
const GREEN      = '#a0d6b4';
const BLACK      = '#0a0a0a';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

async function resend(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], subject, html })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Resend: ' + JSON.stringify(data));
  return data;
}

function row(label, value, last) {
  if (!value) return '';
  const border = last ? '' : 'border-bottom:1px solid #eee;';
  return '<tr>' +
    '<td style="width:30%;padding:7px 14px;font-size:10px;color:#999;font-family:monospace;text-transform:uppercase;' + border + 'vertical-align:top;">' + label + '</td>' +
    '<td style="padding:7px 14px;font-size:13px;color:#111;' + border + '">' + String(value).replace(/\n/g, '<br>') + '</td>' +
  '</tr>';
}

function stopBlock(stop, idx) {
  // Only show PO if it's an actual PO number — not a billing status
  const billingWords = ['INVOICE PENDING','INVOICE DIRECT','ESTIMATE READY','NOT STARTED','DIRECT','PENDING'];
  const showPO = stop.po && !billingWords.includes((stop.po || '').toUpperCase().trim());
  const poLabel = showPO ? '<span style="font-size:10px;color:#888;font-family:monospace;margin-left:12px;">PO# ' + stop.po + '</span>' : '';

  // POD link — ensure full https:// URL
  let podUrl = '';
  if (stop.podLink) {
    podUrl = /^https?:\/\//.test(stop.podLink) ? stop.podLink : 'https://' + stop.podLink;
  }
  const podButton = podUrl
    ? '<div style="padding:14px;background:#f0faf4;border-top:2px solid ' + GREEN + ';text-align:center;">' +
        '<a href="' + podUrl + '" style="display:inline-block;background:' + GREEN + ';color:#000;text-decoration:none;border-radius:6px;padding:10px 24px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">&#128247; Upload POD Photos</a>' +
      '</div>'
    : '';

  return '<div style="margin-bottom:16px;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">' +
    '<div style="background:' + BLACK + ';padding:10px 14px;display:flex;align-items:center;gap:8px;">' +
      '<span style="background:' + GREEN + ';color:#000;font-weight:700;font-size:10px;border-radius:4px;padding:3px 10px;letter-spacing:1px;font-family:monospace;">STOP ' + (idx + 1) + '</span>' +
      '<span style="color:#fff;font-size:13px;font-weight:600;">' + (stop.account || stop.project || 'Stop ' + (idx + 1)) + '</span>' +
      poLabel +
    '</div>' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' +
      row('Account',  stop.account) +
      row('PO / Ref', showPO ? stop.po : '') +
      row('Project',  stop.project) +
      row('Address',  stop.address) +
      row('Time',     stop.time) +
      row('Contact',  stop.contact) +
      row('Items',    stop.desc || stop.items) +
      row('Notes',    stop.notes, true) +
    '</table>' +
    podButton +
  '</div>';
}

function buildDriverEmail(d) {
  const stops = (d.stops || []).map((s, i) => stopBlock(s, i)).join('');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
  '<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,sans-serif;">' +
  '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px;">' +
  '<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);max-width:600px;">' +

  // Header
  '<tr><td style="background:' + BLACK + ';padding:28px 32px;">' +
    '<img src="https://res.cloudinary.com/dxkpbjicu/image/upload/v1774556178/HANDS_Logo_BlackBG_HiRes_qtkac8.png" width="140" style="display:block;margin-bottom:20px;">' +
    '<div style="height:3px;background:linear-gradient(90deg,' + BLACK + ' 68%,' + GREEN + ' 68%);"></div>' +
  '</td></tr>' +

  // Green banner
  '<tr><td style="background:' + GREEN + ';padding:12px 32px;text-align:center;">' +
    '<p style="margin:0;font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#000;">Driver Dispatch</p>' +
  '</td></tr>' +

  // Body
  '<tr><td style="padding:28px 32px;">' +
    '<h2 style="margin:0 0 6px;font-size:22px;color:' + BLACK + ';">Your Delivery Route</h2>' +
    '<p style="margin:0 0 24px;font-size:13px;color:#888;">Hello ' + (d.driverName || 'Driver') + ', here are your stops for today. Please review all stops and contact us with any questions.</p>' +

    // Info table
    '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">' +
      (d.driverName ? '<tr><td style="padding:8px 14px;font-size:11px;color:#888;border-bottom:1px solid #eee;width:30%;">Driver</td><td style="padding:8px 14px;font-size:12px;font-weight:600;color:#111;border-bottom:1px solid #eee;">' + d.driverName + '</td></tr>' : '') +
      (d.vehicle    ? '<tr><td style="padding:8px 14px;font-size:11px;color:#888;border-bottom:1px solid #eee;">Vehicle</td><td style="padding:8px 14px;font-size:12px;color:#111;border-bottom:1px solid #eee;">' + d.vehicle + '</td></tr>' : '') +
      (d.date       ? '<tr><td style="padding:8px 14px;font-size:11px;color:#888;border-bottom:1px solid #eee;">Date</td><td style="padding:8px 14px;font-size:12px;color:#111;border-bottom:1px solid #eee;">' + d.date + '</td></tr>' : '') +
      (d.dispatcher ? '<tr><td style="padding:8px 14px;font-size:11px;color:#888;">Dispatcher</td><td style="padding:8px 14px;font-size:12px;color:#111;">' + d.dispatcher + '</td></tr>' : '') +
    '</table>' +

    // Stop count
    '<div style="font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#888;margin-bottom:14px;">' + (d.stops ? d.stops.length : 0) + ' Stop' + ((d.stops && d.stops.length !== 1) ? 's' : '') + '</div>' +
    stops +
  '</td></tr>' +

  // Footer
  '<tr><td style="background:#f0f0f0;padding:18px 32px;border-top:1px solid #e0e0e0;font-size:11px;color:#888;text-align:center;">' +
    'HANDS Logistics &middot; concierge@handslogistics.com &middot; Las Vegas, NV 89139' +
  '</td></tr>' +

  '</table></td></tr></table></body></html>';
}

function buildInternalEmail(d) {
  const stops = (d.stops || []).map((s, i) => stopBlock(s, i)).join('');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
  '<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">' +
  '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px;">' +
  '<table width="620" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);max-width:620px;">' +

  '<tr><td style="background:' + BLACK + ';padding:22px 32px;">' +
    '<img src="https://res.cloudinary.com/dxkpbjicu/image/upload/v1774556178/HANDS_Logo_BlackBG_HiRes_qtkac8.png" width="130" style="display:block;margin-bottom:16px;">' +
    '<div style="height:3px;background:linear-gradient(90deg,' + BLACK + ' 68%,' + GREEN + ' 68%);"></div>' +
  '</td></tr>' +

  '<tr><td style="background:' + GREEN + ';padding:10px 32px;text-align:center;">' +
    '<p style="margin:0;font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#000;">Dispatch Sent — Internal Copy</p>' +
  '</td></tr>' +

  '<tr><td style="padding:24px 32px;">' +
    '<h3 style="margin:0 0 16px;font-size:16px;color:' + BLACK + ';">Dispatch Summary</h3>' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">' +
      '<tr><td style="padding:8px 14px;font-size:11px;color:#888;border-bottom:1px solid #eee;width:30%;">Driver</td><td style="padding:8px 14px;font-size:12px;font-weight:600;color:#111;border-bottom:1px solid #eee;">' + (d.driverName || '—') + '</td></tr>' +
      '<tr><td style="padding:8px 14px;font-size:11px;color:#888;border-bottom:1px solid #eee;">Email</td><td style="padding:8px 14px;font-size:12px;color:#111;border-bottom:1px solid #eee;"><a href="mailto:' + (d.driverEmail || '') + '" style="color:' + GREEN + ';text-decoration:none;">' + (d.driverEmail || '—') + '</a></td></tr>' +
      '<tr><td style="padding:8px 14px;font-size:11px;color:#888;border-bottom:1px solid #eee;">Vehicle</td><td style="padding:8px 14px;font-size:12px;color:#111;border-bottom:1px solid #eee;">' + (d.vehicle || '—') + '</td></tr>' +
      '<tr><td style="padding:8px 14px;font-size:11px;color:#888;border-bottom:1px solid #eee;">Date</td><td style="padding:8px 14px;font-size:12px;color:#111;border-bottom:1px solid #eee;">' + (d.date || '—') + '</td></tr>' +
      '<tr><td style="padding:8px 14px;font-size:11px;color:#888;">Dispatcher</td><td style="padding:8px 14px;font-size:12px;color:#111;">' + (d.dispatcher || '—') + '</td></tr>' +
    '</table>' +
    '<div style="font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#888;margin-bottom:14px;">' + (d.stops ? d.stops.length : 0) + ' Stop' + ((d.stops && d.stops.length !== 1) ? 's' : '') + '</div>' +
    stops +
  '</td></tr>' +

  '<tr><td style="background:#f0f0f0;padding:16px 32px;border-top:1px solid #e0e0e0;font-size:11px;color:#888;text-align:center;">' +
    'HANDS Logistics &middot; concierge@handslogistics.com &middot; Las Vegas, NV 89139' +
  '</td></tr>' +

  '</table></td></tr></table></body></html>';
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const d = JSON.parse(event.body);
    const { driverName, driverEmail, date, vehicle, dispatcher, stops = [] } = d;

    if (!driverEmail) throw new Error('Driver email is required');

    const driverSubject   = 'Your Dispatch — ' + (date || 'Today') + ' · ' + stops.length + ' Stop' + (stops.length !== 1 ? 's' : '');
    const internalSubject = '[DISPATCH] ' + (driverName || 'Driver') + ' · ' + (date || 'Today') + ' · ' + stops.length + ' stop' + (stops.length !== 1 ? 's' : '');

    await Promise.all([
      resend(driverEmail,  driverSubject,   buildDriverEmail(d)),
      resend(INTERNAL,     internalSubject, buildInternalEmail(d))
    ]);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error('send-dispatch error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
