const https = require('https');

module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN;
  const respond = (s,o)=>{ context.res={status:s,headers:{"Content-Type":"application/json"},body:JSON.stringify(o,null,2)}; };
  if (!TOKEN) return respond(500,{ok:false,error:"CONFIG",msg:"VRM_TOKEN missing"});

  const idSite = req.query.idSite;
  const debug  = req.query.debug === '1';
  if (!idSite) return respond(400,{ok:false,error:"MISSING_ID",msg:"Pass ?idSite=<number>"});

  const H = { "X-Authorization": `Token ${TOKEN}`, "Accept":"application/json" };
  const httpGet=(u,h)=>new Promise(r=>{
    const U=new URL(u);
    const q=https.request({method:'GET',hostname:U.hostname,path:U.pathname+(U.search||''),headers:h},res=>{
      let t=''; res.on('data',d=>t+=d); res.on('end',()=>r({status:res.statusCode,text:t}));
    });
    q.on('error',e=>r({status:599,text:String(e)})); q.end();
  });
  const parse=t=>{try{return JSON.parse(t);}catch{return null;}};
  const pickCoords = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    // common variants
    const candidates = [
      ['latitude','longitude'],
      ['lat','lon'], ['Lat','Lon'], ['Latitude','Longitude'],
      ['lat_deg','lon_deg'], ['gps_latitude','gps_longitude'],
    ];
    for (const [la,lo] of candidates) {
      const lat = obj[la], lon = obj[lo];
      if (lat != null && lon != null) return { lat: Number(lat), lon: Number(lon) };
    }
    return null;
  };

  // 1) Try widgets that often carry GPS
  for (const W of ['GPS','Location']) {
    const url = `https://vrmapi.victronenergy.com/v2/installations/${idSite}/widgets/${W}`;
    const r = await httpGet(url, H);
    if (r.status === 200) {
      const j = parse(r.text);
      const rec = j?.data || j?.records || j;
      let coords = pickCoords(rec);
      if (!coords && typeof rec === 'object') {
        // also try under nested object
        for (const v of Object.values(rec)) {
          coords = pickCoords(v);
          if (coords) break;
        }
      }
      if (coords) {
        return respond(200, { ok:true, idSite, ...coords, ts: rec?.timestamp ?? null, source:`widget:${W}` });
      }
      // keep a short sample to help us map fields
      if (debug) {
        return respond(200, {
          ok:true, idSite, lat:null, lon:null, ts:null,
          source:`widget:${W}`, rawKeys:Object.keys(rec||{}),
          sample:Object.fromEntries(Object.entries(rec||{}).slice(0,8))
        });
      }
    }
  }

  // 2) Fall back to system-overview → devices scan
  const so = await httpGet(`https://vrmapi.victronenergy.com/v2/installations/${idSite}/system-overview`, H);
  if (so.status === 200) {
    const j = parse(so.text);
    const rec = j?.records || j?.data || j || {};
    const devs = Array.isArray(rec.devices) ? rec.devices : [];
    for (const d of devs) {
      // gps-looking devices sometimes have coords in their device object
      const coord = pickCoords(d);
      if (coord) return respond(200, { ok:true, idSite, ...coord, ts: d?.timestamp ?? null, source:'system-overview:device' });
    }
    if (debug) {
      return respond(200, {
        ok:true, idSite, lat:null, lon:null, ts:null,
        source:'system-overview',
        topKeys:Object.keys(rec),
        devicesCount:devs.length,
        firstDevice: devs[0] ? Object.fromEntries(Object.entries(devs[0]).slice(0,12)) : null
      });
    }
  }

  return respond(200, { ok:true, idSite, lat:null, lon:null, ts:null, note:"No GPS fields found in widgets or system-overview" });
};
