const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const BOARD_ID = 4550650855;
const READY_GROUP = 'group_mm18z2ae';
const API = 'https://api.monday.com/v2';
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Content-Type':'application/json' };
const SKIP_STATUSES = ['ESTIMATE READY','ESTIMATE APPROVED','INVOICE PENDING','SUBMITTED','FUNDED','READY TO SEND'];

async function gql(query) {
  const r = await fetch(API, { method:'POST', headers:{'Content-Type':'application/json','Authorization':MONDAY_TOKEN,'API-Version':'2023-04'}, body:JSON.stringify({query}) });
  return r.json();
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:CORS, body:'' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode:400, headers:CORS, body:JSON.stringify({error:'Bad JSON'}) }; }

  // monday webhook challenge handshake
  if (body.challenge) return { statusCode:200, headers:CORS, body:JSON.stringify({challenge:body.challenge}) };

  const ev = body.event;
  if (!ev) return { statusCode:200, headers:CORS, body:JSON.stringify({skipped:'no event'}) };

  const { pulseId, columnId, value } = ev;
  if (columnId !== 'color') return { statusCode:200, headers:CORS, body:JSON.stringify({skipped:'wrong column'}) };

  const label = value?.label?.text || value?.label || '';
  if (label !== 'COMPLETE') return { statusCode:200, headers:CORS, body:JSON.stringify({skipped:`label=${label}`}) };

  // Fetch current billing status to avoid overwriting active stages
  const check = await gql(`{ items(ids:[${pulseId}]){ id name column_values(ids:["status2","text4","color_mm1wxn5k","text2"]){ id text } } }`);
  const item = check?.data?.items?.[0];
  if (!item) return { statusCode:200, headers:CORS, body:JSON.stringify({skipped:'not found'}) };

  const cols = {};
  (item.column_values||[]).forEach(c=>{ cols[c.id]=c.text||''; });

  if (SKIP_STATUSES.includes(cols.status2)) {
    return { statusCode:200, headers:CORS, body:JSON.stringify({skipped:`already at ${cols.status2}`}) };
  }

  // Run billing update + group move in parallel
  await Promise.all([
    gql(`mutation { change_multiple_column_values(item_id:${pulseId}, board_id:${BOARD_ID}, column_values:"{\\"status2\\":{\\"label\\":\\"INVOICE PENDING\\"}}") { id } }`),
    gql(`mutation { move_item_to_group(item_id:${pulseId}, group_id:"${READY_GROUP}") { id } }`)
  ]);

  // Audit comment
  await gql(`mutation { create_update(item_id:${pulseId}, body:"Billing automation: LOGISTICS STATUS → COMPLETE. BILLING STATUS auto-set to INVOICE PENDING and item moved to Ready for Billing. Open CEO Dashboard to build and export invoice.") { id } }`);

  console.log(`[billing-webhook] ${pulseId} (${item.name}) → INVOICE PENDING + Ready for Billing`);

  return {
    statusCode:200, headers:CORS,
    body: JSON.stringify({ success:true, itemId:pulseId, itemName:item.name, account:cols.text4, action:'INVOICE PENDING + group move' })
  };
};
