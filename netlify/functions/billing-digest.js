const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const BOARD_ID = 4550650855;
const ZAPIER_WEBHOOK = 'PASTE_YOUR_ZAPIER_CATCH_HOOK_URL_HERE';
const API = 'https://api.monday.com/v2';
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Content-Type':'application/json' };

async function getReadyItems() {
  const query = `{ boards(ids:[${BOARD_ID}]){ items_page(limit:100){ items{ id name url column_values(ids:["text4","text2","color_mm1wxn5k","status2","numeric_mm1wq77t"]){ id text } } } } }`;
  const r = await fetch(API, { method:'POST', headers:{'Content-Type':'application/json','Authorization':MONDAY_TOKEN,'API-Version':'2023-04'}, body:JSON.stringify({query}) });
  const json = await r.json();
  const items = json?.data?.boards?.[0]?.items_page?.items || [];
  const gc = (it,id) => (it.column_values||[]).find(c=>c.id===id)?.text||'';
  return items.filter(it=>gc(it,'status2')==='INVOICE PENDING').map(it=>({
    id:it.id, name:it.name, url:it.url,
    account:gc(it,'text4')||'—', type:gc(it,'color_mm1wxn5k')||'—',
    date:gc(it,'text2')||'—', estimate:parseFloat(gc(it,'numeric_mm1wq77t'))||0
  }));
}

function buildEmail(items) {
  const today = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  const total = items.reduce((s,it)=>s+it.estimate,0);
  const rows = items.map(it=>`<tr style="border-bottom:1px solid #eee">
    <td style="padding:10px 12px;font-size:13px"><a href="${it.url}" style="color:#0a0a0a;font-weight:500;text-decoration:none">${it.name}</a></td>
    <td style="padding:10px 12px;font-size:13px;color:#555">${it.account}</td>
    <td style="padding:10px 12px;font-size:12px;color:#555">${it.type}</td>
    <td style="padding:10px 12px;font-size:12px;color:#555">${it.date}</td>
    <td style="padding:10px 12px;font-size:13px;font-weight:500;color:${it.estimate?'#1b5e20':'#ba7517'}">${it.estimate?'$'+it.estimate.toLocaleString():'Rate needed'}</td>
  </tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table width="100%" style="max-width:680px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0">
<tr><td style="background:#0a0a0a;padding:20px 28px"><span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:.08em">H<span style="color:#a0d6b4">∧</span>NDS</span><span style="font-size:13px;color:#888;margin-left:12px">Logistics · Billing Digest</span></td></tr>
<tr><td style="padding:24px 28px 8px"><p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#0a0a0a">${items.length} job${items.length!==1?'s':''} ready to invoice</p><p style="margin:0;font-size:13px;color:#888">${today}</p></td></tr>
${total>0?`<tr><td style="padding:8px 28px"><div style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:6px;padding:12px 16px;display:inline-block"><span style="font-size:11px;color:#2e7d32;text-transform:uppercase;letter-spacing:.06em">Total estimated pipeline</span><br><span style="font-size:24px;font-weight:700;color:#1b5e20">$${total.toLocaleString()}</span></div></td></tr>`:''}
<tr><td style="padding:16px 28px 4px"><table width="100%" style="border-collapse:collapse">
<thead><tr style="background:#f9f9f9;border-bottom:2px solid #e0e0e0">
<th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em">Job</th>
<th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em">Account</th>
<th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em">Type</th>
<th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em">Date</th>
<th style="padding:10px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em">Amount</th>
</tr></thead><tbody>${rows}</tbody></table></td></tr>
<tr><td style="padding:20px 28px">
<a href="https://ops.handslogistics.com/ceo" style="display:inline-block;background:#a0d6b4;color:#0a0a0a;font-weight:700;font-size:13px;padding:12px 24px;border-radius:6px;text-decoration:none;margin-right:10px">Open CEO Dashboard →</a>
<a href="https://handslogistics.monday.com/boards/4550650855" style="display:inline-block;background:#f5f5f5;color:#0a0a0a;font-size:13px;padding:12px 24px;border-radius:6px;text-decoration:none;border:1px solid #e0e0e0">View in monday →</a>
</td></tr>
<tr><td style="background:#f9f9f9;padding:14px 28px;border-top:1px solid #e0e0e0"><p style="margin:0;font-size:11px;color:#aaa">HANDS Logistics · 8540 Dean Martin Drive Suite 160 · Las Vegas NV 89139</p></td></tr>
</table></body></html>`;
}

exports.handler = async function(event) {
  if (event.httpMethod==='OPTIONS') return {statusCode:200,headers:CORS,body:''};

  let triggeredBy = 'Manual';
  if (event.httpMethod==='POST') {
    try { triggeredBy = JSON.parse(event.body||'{}').triggeredBy||'Zapier'; } catch {}
  }

  try {
    const items = await getReadyItems();
    if (items.length===0) return {statusCode:200,headers:CORS,body:JSON.stringify({success:true,message:'Nothing in Invoice Pending',count:0})};

    const total = items.reduce((s,it)=>s+it.estimate,0);
    const subject = `[HANDS] ${items.length} job${items.length!==1?'s':''} ready to invoice — ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'})}`;
    const htmlBody = buildEmail(items);

    if (ZAPIER_WEBHOOK && !ZAPIER_WEBHOOK.startsWith('PASTE')) {
      await fetch(ZAPIER_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject,to:'jon@handslogistics.com',htmlBody,itemCount:items.length,totalEstimate:total})});
    }

    return {statusCode:200,headers:CORS,body:JSON.stringify({success:true,count:items.length,totalEstimate:total,subject,items:items.map(it=>({id:it.id,name:it.name,account:it.account,estimate:it.estimate}))})};
  } catch(err) {
    return {statusCode:500,headers:CORS,body:JSON.stringify({error:err.message})};
  }
};
