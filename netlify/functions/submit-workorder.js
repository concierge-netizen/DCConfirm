const MONDAY_TOKEN=process.env.MONDAY_TOKEN;
const BOARD_ID=4550650855;
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
exports.handler=async function(event){
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:CORS,body:''};
  if(event.httpMethod!=='POST')return{statusCode:405,headers:CORS,body:'Method not allowed'};
  try{
    const{itemId,phase,installerName,actualStart,actualEnd,photos,notes}=JSON.parse(event.body);
    if(!itemId)return{statusCode:400,headers:CORS,body:JSON.stringify({error:'Missing itemId'})};
    const cols={};
    if(installerName)cols['text_mm1p831b']=installerName;
    if(actualStart)cols['text_mm1wxn5z']=actualStart;
    if(actualEnd)cols['text_mm1wxn60']=actualEnd;
    if(phase==='install')cols['color']={label:'Install Complete'};
    else if(phase==='retrieval')cols['color']={label:'Done'};
    if(photos&&photos[0])cols['link_mm1pgr61']={url:photos[0],text:'Photo 1'};
    if(photos&&photos[1])cols['link_mm1pay5j']={url:photos[1],text:'Photo 2'};
    if(notes)cols['long_text']=notes;
    const mutation=`mutation{change_multiple_column_values(item_id:${itemId},board_id:${BOARD_ID},column_values:${JSON.stringify(JSON.stringify(cols))}){id}}`;
    const res=await fetch('https://api.monday.com/v2',{method:'POST',headers:{'Content-Type':'application/json','Authorization':MONDAY_TOKEN,'API-Version':'2023-04'},body:JSON.stringify({query:mutation})});
    const result=await res.json();if(result.errors)throw new Error(JSON.stringify(result.errors));
    return{statusCode:200,headers:CORS,body:JSON.stringify({success:true})};
  }catch(e){return{statusCode:500,headers:CORS,body:JSON.stringify({error:e.message})};}
};
