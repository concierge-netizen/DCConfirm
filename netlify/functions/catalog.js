const OWNER='concierge-netizen',REPO='DCConfirm',PATH='data/catalog.json';
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
const GH_API=`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
async function ghH(){const t=process.env.GITHUB_TOKEN;if(!t)throw new Error('GITHUB_TOKEN not set');return{'Authorization':`token ${t}`,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'};}
exports.handler=async function(event){
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:CORS,body:''};
  if(event.httpMethod==='GET'){
    try{const h=await ghH();const r=await fetch(GH_API,{headers:h});
      if(r.status===404)return{statusCode:200,headers:{...CORS,'Content-Type':'application/json'},body:JSON.stringify({items:[],categories:[]})};
      if(!r.ok)throw new Error(`GitHub ${r.status}`);
      const f=await r.json();const c=JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
      return{statusCode:200,headers:{...CORS,'Content-Type':'application/json'},body:JSON.stringify(c)};
    }catch(e){return{statusCode:500,headers:CORS,body:JSON.stringify({error:e.message})};}}
  if(event.httpMethod==='POST'){
    try{const catalog=JSON.parse(event.body);const h=await ghH();
      let sha=null;const ch=await fetch(GH_API,{headers:h});if(ch.ok){const f=await ch.json();sha=f.sha;}
      const content=Buffer.from(JSON.stringify(catalog,null,2)).toString('base64');
      const body={message:'Update supplies catalog',content};if(sha)body.sha=sha;
      const put=await fetch(GH_API,{method:'PUT',headers:h,body:JSON.stringify(body)});
      if(!put.ok){const r=await put.json();throw new Error(r.message||`GitHub ${put.status}`);}
      return{statusCode:200,headers:{...CORS,'Content-Type':'application/json'},body:JSON.stringify({ok:true})};
    }catch(e){return{statusCode:500,headers:CORS,body:JSON.stringify({error:e.message})};}}
  return{statusCode:405,headers:CORS,body:'Method not allowed'};
};
