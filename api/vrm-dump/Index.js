const https = require('https');

module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN;
  const respond = (s,o)=>{ context.res={status:s,headers:{"Content-Type":"application/json"},body:JSON.stringify(o,null,2)}; };
  if(!TOKEN) return respond(500,{ok:false,error:"CONFIG",msg:"VRM_TOKEN missing"});

  const base="https://vrmapi.victronenergy.com/v2";
  const httpGet=(url,headers)=>new Promise(r=>{
    const u=new URL(url);
    const opts={method:'GET',hostname:u.hostname,path:u.pathname+(u.search||''),headers};
    const q=https.request(opts,res=>{let t='';res.on('data',d=>t+=d);res.on('end',()=>r({status:res.statusCode,text:t}));});
    q.on('error',e=>r({status:599,text:String(e)}));q.end();
  });
  const parse=t=>{try{return JSON.parse(t);}catch{return null;}};

  const H={"X-Authorization":`Token ${TOKEN}`,"Accept":"application/json"};
  const idSite = req.query.idSite;
  if(!idSite) return respond(400,{ok:false,error:"MISSING_ID",msg:"Pass ?idSite=<number>"});

  const so = await httpGet(`${base}/installations/${idSite}/system-overview`, H);
  const soJson = parse(so.text);
  const rec = soJson?.records || soJson?.data || soJson || {};
  const soKeys = Object.keys(rec);

  const widgets = {};
  for (const W of ["Generator","Genset"]) {
    const r = await httpGet(`${base}/installations/${idSite}/widgets/${W}`, H);
    widgets[W] = { status: r.status, preview: r.text.slice(0,400) };
  }

  return respond(200,{
    ok:true,idSite,
    system_overview_status:so.status,
    system_overview_keys:soKeys,
    sample:Object.fromEntries(Object.entries(rec).slice(0,10)),
    widgets
  });
};
