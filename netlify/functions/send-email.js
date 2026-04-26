// netlify/functions/send-email.js
// Sends emails via Resend API — installer work orders and client supply quotes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'RESEND_KEY not set' }) };

  let payload;
  try { payload = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { type, recipients, subject, workOrder, quoteData, siteUrl } = payload;
  if (!recipients || !recipients.length)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No recipients' }) };

  let html = '';
  let emailSubject = subject || 'HANDS Logistics';

  // ── INSTALLER EMAIL ────────────────────────────────────────────────────────
  if (type === 'installer') {
    const wo = workOrder || {};
    const installLink   = (siteUrl||'') + '/?id=' + wo.id + '&phase=install';
    const retrievalLink = (siteUrl||'') + '/?id=' + wo.id + '&phase=retrieval';
    emailSubject = subject || ('Work Order: ' + (wo.name||'Activation') + ' — HANDS Logistics');

    const toolRows = (wo.tools||[]).map(t =>
      '<li style="font-size:14px;padding:3px 0;color:#444;">' + t.name + (t.qty ? ' <span style="color:#999;font-size:12px;">— '+t.qty+'</span>' : '') + '</li>'
    ).join('');

    const supplyRows = (wo.supplies||[]).map(s =>
      '<tr><td style="padding:7px 0;font-size:14px;color:#444;border-bottom:1px solid #f0f0f0;">'+(s.name||s.catalogId)+'</td>'
      +'<td style="padding:7px 0;text-align:right;font-family:monospace;font-size:11px;color:#999;border-bottom:1px solid #f0f0f0;">Qty: '+(s.qty||1)+'</td></tr>'
    ).join('');

    html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f7f7f5;">'
      +'<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f5;padding:32px 16px;"><tr><td align="center">'
      +'<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">'

      // header
      +'<tr><td style="background:#1a1a1a;border-bottom:3px solid #a0d6b4;padding:24px 32px;border-radius:8px 8px 0 0;">'
      +'<div style="font-family:Georgia,serif;font-size:22px;font-weight:300;letter-spacing:4px;text-transform:uppercase;color:#fff;">HANDS</div>'
      +'<div style="font-family:monospace;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#666;margin-top:3px;">Work Order</div>'
      +'</td></tr>'

      // hero
      +'<tr><td style="background:#222;padding:24px 32px;">'
      +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#666;margin-bottom:4px;">'+(wo.account||'')+'</div>'
      +'<div style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:#fff;margin-bottom:16px;">'+(wo.name||'Work Order')+'</div>'
      +'<table width="100%"><tr>'
      +'<td width="33%" style="padding-right:16px;"><div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#555;margin-bottom:4px;">Date</div><div style="font-family:Georgia,serif;font-size:16px;color:#fff;">'+(wo.eventDate||'—')+'</div></td>'
      +'<td width="33%" style="padding-right:16px;"><div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#555;margin-bottom:4px;">Start</div><div style="font-family:Georgia,serif;font-size:16px;color:#a0d6b4;">'+(wo.startTime||'—')+'</div></td>'
      +'<td width="33%"><div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#555;margin-bottom:4px;">Strike</div><div style="font-family:Georgia,serif;font-size:16px;color:#fff;">'+(wo.endTime||'—')+'</div></td>'
      +'</tr></table></td></tr>'

      // body
      +'<tr><td style="background:#fff;padding:28px 32px;">'

      // venue
      +(wo.venue ? '<div style="margin-bottom:20px;"><div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:6px;">Venue</div>'
        +'<div style="font-size:16px;font-weight:600;color:#1a1a1a;">'+wo.venue+'</div>'
        +(wo.address ? '<div style="font-size:13px;color:#777;margin-top:2px;">'+wo.address+'</div>' : '')
        +'</div>' : '')

      // contact
      +(wo.contactName ? '<div style="margin-bottom:20px;padding:14px;background:#f9f9f7;border-radius:6px;">'
        +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:4px;">On-Site Contact</div>'
        +'<div style="font-size:15px;font-weight:600;color:#1a1a1a;">'+wo.contactName+'</div>'
        +(wo.contactPhone ? '<div style="font-family:monospace;font-size:12px;color:#7bbf9a;">'+wo.contactPhone+'</div>' : '')
        +'</div>' : '')

      // setup notes
      +(wo.setupNotes ? '<div style="margin-bottom:20px;">'
        +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#2980b9;margin-bottom:6px;">Install / Setup</div>'
        +'<div style="font-size:14px;color:#444;line-height:1.7;white-space:pre-wrap;background:#f5f9ff;padding:14px;border-radius:6px;border-left:3px solid #2980b9;">'+wo.setupNotes+'</div>'
        +'</div>' : '')

      // teardown notes
      +(wo.teardownNotes ? '<div style="margin-bottom:20px;">'
        +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#8e44ad;margin-bottom:6px;">Retrieval / Teardown</div>'
        +'<div style="font-size:14px;color:#444;line-height:1.7;white-space:pre-wrap;background:#fdf5ff;padding:14px;border-radius:6px;border-left:3px solid #8e44ad;">'+wo.teardownNotes+'</div>'
        +'</div>' : '')

      // general notes
      +(wo.notes ? '<div style="margin-bottom:20px;">'
        +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:6px;">General Notes</div>'
        +'<div style="font-size:14px;color:#444;line-height:1.7;white-space:pre-wrap;">'+wo.notes+'</div>'
        +'</div>' : '')

      // tools
      +'<div style="margin-bottom:20px;">'
      +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:6px;">Tools Needed</div>'
      +(toolRows ? '<ul style="margin:0;padding-left:18px;">'+toolRows+'</ul>'
        : '<div style="font-size:13px;color:#bbb;">No tools listed.</div>')
      +'</div>'

      // supplies
      +'<div style="margin-bottom:28px;">'
      +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:6px;">Supplies &amp; Equipment</div>'
      +(supplyRows ? '<table width="100%" cellpadding="0" cellspacing="0">'+supplyRows+'</table>'
        : '<div style="font-size:13px;color:#bbb;">No supplies listed.</div>')
      +'</div>'

      // CTA
      +'<div style="text-align:center;padding:24px 0;border-top:1px solid #f0f0f0;">'
      +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:14px;">Open Your Work Order Portal</div>'
      +'<a href="'+installLink+'" style="display:inline-block;background:#1a1a1a;color:#a0d6b4;font-family:monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;padding:14px 24px;border-radius:6px;margin:4px 6px;">Install Portal</a>'
      +'<a href="'+retrievalLink+'" style="display:inline-block;background:#f0f0f0;color:#1a1a1a;font-family:monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;padding:14px 24px;border-radius:6px;margin:4px 6px;">Retrieval Portal</a>'
      +'</div>'
      +'</td></tr>'

      // footer
      +'<tr><td style="background:#1a1a1a;padding:16px 32px;border-radius:0 0 8px 8px;text-align:center;">'
      +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#555;">HANDS Logistics LLC &middot; Las Vegas, NV</div>'
      +'</td></tr>'
      +'</table></td></tr></table></body></html>';

  // ── CLIENT QUOTE EMAIL ─────────────────────────────────────────────────────
  } else if (type === 'client') {
    const q = quoteData || {};
    const markup = q.markup || 0;
    const lines  = q.items  || [];
    const base   = lines.reduce(function(s,l){ return s + (l.cost||0) * (l.qty||1); }, 0);
    const total  = base * (1 + markup/100);
    emailSubject = subject || ('Supplies Estimate — ' + (q.ref || 'HANDS Logistics'));

    const lineRows = lines.map(function(l) {
      var unitPrice = (l.cost||0) * (1 + markup/100);
      var lineTotal = unitPrice * (l.qty||1);
      return '<tr>'
        +'<td style="padding:10px 0;font-size:14px;color:#1a1a1a;border-bottom:1px solid #f0f0f0;">'+(l.name||'')+'</td>'
        +'<td style="padding:10px 0;text-align:center;font-family:monospace;font-size:12px;color:#777;border-bottom:1px solid #f0f0f0;">'+(l.qty||1)+' '+(l.unit||'ea')+'</td>'
        +'<td style="padding:10px 0;text-align:right;font-family:monospace;font-size:13px;font-weight:600;color:#1a1a1a;border-bottom:1px solid #f0f0f0;">$'+lineTotal.toFixed(2)+'</td>'
        +'</tr>';
    }).join('');

    html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f7f7f5;">'
      +'<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f5;padding:32px 16px;"><tr><td align="center">'
      +'<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">'
      +'<tr><td style="background:#1a1a1a;border-bottom:3px solid #a0d6b4;padding:24px 32px;border-radius:8px 8px 0 0;">'
      +'<div style="font-family:Georgia,serif;font-size:22px;font-weight:300;letter-spacing:4px;text-transform:uppercase;color:#fff;">HANDS</div>'
      +'<div style="font-family:monospace;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#666;margin-top:3px;">Supplies Estimate</div>'
      +'</td></tr>'
      +'<tr><td style="background:#fff;padding:32px;">'
      +'<div style="margin-bottom:24px;">'
      +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:4px;">Prepared for</div>'
      +'<div style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#1a1a1a;">'+(q.client||'Client')+'</div>'
      +(q.ref ? '<div style="font-family:monospace;font-size:11px;color:#999;margin-top:2px;">'+q.ref+'</div>' : '')
      +'<div style="font-family:monospace;font-size:10px;color:#bbb;margin-top:4px;">'+new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})+'</div>'
      +'</div>'
      +'<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">'
      +'<tr>'
      +'<th style="text-align:left;font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#999;padding-bottom:8px;border-bottom:2px solid #1a1a1a;">Item</th>'
      +'<th style="text-align:center;font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#999;padding-bottom:8px;border-bottom:2px solid #1a1a1a;">Qty</th>'
      +'<th style="text-align:right;font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#999;padding-bottom:8px;border-bottom:2px solid #1a1a1a;">Total</th>'
      +'</tr>'
      +lineRows
      +'</table>'
      +'<table width="100%" cellpadding="0" cellspacing="0">'
      +'<tr><td style="background:#1a1a1a;padding:20px 24px;border-radius:8px;">'
      +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.35);margin-bottom:4px;">Client Total (agency fee included)</div>'
      +'<div style="font-family:Georgia,serif;font-size:36px;font-weight:600;color:#a0d6b4;">$'+total.toFixed(2)+'</div>'
      +'<div style="font-family:monospace;font-size:9px;color:rgba(255,255,255,0.25);margin-top:6px;">This estimate is valid for 7 days. Contact HANDS to confirm.</div>'
      +'</td></tr></table>'
      +'</td></tr>'
      +'<tr><td style="background:#1a1a1a;padding:16px 32px;border-radius:0 0 8px 8px;text-align:center;">'
      +'<div style="font-family:monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#555;">HANDS Logistics LLC &middot; Las Vegas, NV</div>'
      +'</td></tr>'
      +'</table></td></tr></table></body></html>';
  }

  // ── Send via Resend ────────────────────────────────────────────────────────
  try {
    var results = [];
    for (var i = 0; i < recipients.length; i++) {
      var to = (recipients[i] || '').trim();
      if (!to) continue;
      var res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_KEY },
        body: JSON.stringify({ from: 'HANDS Logistics <jon@handslogistics.com>', to: [to], subject: emailSubject, html: html })
      });
      var result = await res.json();
      if (!res.ok) throw new Error(result.message || ('Resend error ' + res.status + ' for ' + to));
      results.push({ to: to, id: result.id });
    }
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, sent: results.length, results: results }) };
  } catch(err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
