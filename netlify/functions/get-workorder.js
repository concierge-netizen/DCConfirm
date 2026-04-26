const MONDAY_TOKEN=process.env.MONDAY_TOKEN;
const CORS={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
exports.handler=async function(event){
  const id=event.queryStringParameters&&event.queryStringParameters.id;
  if(!id)return{statusCode:400,headers:CORS,body:JSON.stringify({error:'Missing ?id='})};
  const query=`{items(ids:[${id}]){id name column_values{id text value}subitems{id name column_values{id text}}}}`;
  try{
    const res=await fetch('https://api.monday.com/v2',{method:'POST',headers:{'Content-Type':'application/json','Authorization':MONDAY_TOKEN,'API-Version':'2023-04'},body:JSON.stringify({query})});
    const json=await res.json();const item=json.data&&json.data.items&&json.data.items[0];
    if(!item)return{statusCode:404,headers:CORS,body:JSON.stringify({error:'Not found'})};
    const cols={};(item.column_values||[]).forEach(c=>{cols[c.id]={text:c.text||'',value:c.value};});
    return{statusCode:200,headers:CORS,body:JSON.stringify({id:item.id,name:item.name,account:cols['text4']?.text||'',activityType:cols['color_mm1wxn5k']?.text||'',logisticsStatus:cols['color']?.text||'',startDate:cols['date4']?.text||'',startTime:cols['hour']?.text||'',endTime:cols['text8']?.text||'',venue:cols['text5']?.text||'',address:cols['text6']?.text||'',contactName:cols['text']?.text||'',contactPhone:cols['phone']?.text||'',notes:cols['long_text']?.text||'',setupNotes:cols['text_mm1wxn5x']?.text||'',teardownNotes:cols['text_mm1wxn5y']?.text||'',supplies:(item.subitems||[]).map(s=>{const sc={};(s.column_values||[]).forEach(c=>{sc[c.id]=c.text||'';});return{id:s.id,name:s.name,qty:sc['numbers']||sc['numeric']||'1',unit:sc['text']||'',status:sc['status']||''};})})};
  }catch(e){return{statusCode:500,headers:CORS,body:JSON.stringify({error:e.message})};}
};
