const https = require('https');

module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN;
  const respond = (s,o)=>{ context.res={status:s,headers:{"Content-Type":"application/json"},body:JSON.stringify(o,null,2)}; };
  if (!TOKEN) return respond(500, { ok:false, error:"CONFIG", msg:"VRM_TOKEN missing" });

  const idSite = req.query.idSite;
  if (!idSite) return respond(400, { ok:false, error:"MISSING_ID", msg:"Pass ?idSite=<number>" });

  const H = { "X-Authorization": `Token ${TOKEN}`, "Accept":"application/json" };
  const url = `https://vrmapi.victronenergy.com/v2/installations/${idSite}/widgets/GPS`;

  const httpGet=(u,h)=>new Promise(r=>{
    const U=new URL(u);
    const q=https.request({method:'GET',hostname:U.hostname,path:U.pathname+(U.search||''),headers:h},res=>{
      let t=''; res.on('data',d=>t+=d); res.on('end',()=>r({status:res.statusCode,text:t}));
    });
    q.on('error',e=>r({status:599,text:String(e)})); q.end();
  });

  const resp = await httpGet(url, H);
  if (resp.status !== 200) return respond(resp.status, { ok:false, error:"VRM_HTTP_GPS", preview: resp.text.slice(0,300) });

  let j; try { j = JSON.parse(resp.text); } catch { return respond(502, { ok:false, error:"NON_JSON", preview: resp.text.slice(0,200) }); }

  // Try some common shapes
  const rec = j.data || j.records || j;
  const lat = rec.latitude ?? rec.lat ?? rec.Latitude ?? null;
  const lon = rec.longitude ?? rec.lon ?? rec.Longitude ?? null;
  const ts  = rec.timestamp ?? rec.time ?? null;

  return respond(200, { ok:true, idSite, lat, lon, ts, rawKeys: Object.keys(rec||{}) });
};
