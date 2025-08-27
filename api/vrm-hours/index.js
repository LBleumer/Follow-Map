const https = require('https');

module.exports = async function (context, req) {
  const VRM_TOKEN = process.env.VRM_TOKEN;
  const respond = (status, obj) => {
    context.res = { status, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(obj, null, 2) };
  };
  if (!VRM_TOKEN) return respond(500, { ok:false, error:"CONFIG", msg:"VRM_TOKEN missing" });

  const base = "https://vrmapi.victronenergy.com/v2";
  const httpGet = (url, hdrs) => new Promise((resolve) => {
    const u = new URL(url);
    const opts = { method: 'GET', hostname: u.hostname, path: u.pathname + (u.search || ''), headers: hdrs };
    const r = https.request(opts, res => { let data=''; res.on('data', d => data+=d); res.on('end', ()=>resolve({ status: res.statusCode, text: data })); });
    r.on('error', e => resolve({ status: 599, text: String(e) }));
    r.end();
  });
  const headersList = [
    { "X-Authorization": `Token ${VRM_TOKEN}`, "Accept": "application/json" },
    { "X-Authorization": `Bearer ${VRM_TOKEN}`, "Accept": "application/json" }
  ];
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const extractHours = (rec) => {
    if (!rec || typeof rec !== 'object') return { hours:null, ts:null, key:null };
    const keys = [
      "genset/0/Ac/RunningHours","genset/0/Ac/Runtime",
      "Generator/0/Ac/RunningHours","Generator/0/RunningHours"
    ];
    for (const k of keys) if (rec[k]) {
      const v = rec[k]; const hours = v.value ?? v.last ?? v.current ?? v;
      const ts    = v.timestamp ?? v.time ?? null;
      if (hours!=null) return { hours:String(hours), ts, key:k };
    }
    for (const [k,v] of Object.entries(rec)) if (/(RunningHours|Runtime)$/i.test(k) && v) {
      const hours = v.value ?? v.last ?? v.current ?? v; const ts = v.timestamp ?? v.time ?? null;
      if (hours!=null) return { hours:String(hours), ts, key:k };
    }
    return { hours:null, ts:null, key:null };
  };

  try {
    // 1) list installations, trying both header formats
    let list = null, last = null;
    for (const H of headersList) {
      const resp = await httpGet(`${base}/installations?extended=1`, H);
      last = resp;
      if (resp.status !== 200) { if (resp.status === 401 || resp.status === 403) continue; else return respond(resp.status, { ok:false, error:"VRM_HTTP_LIST", preview: resp.text.slice(0,400) }); }
      const p = parse(resp.text); if (!p) return respond(502, { ok:false, error:"VRM_NON_JSON_LIST", preview: resp.text.slice(0,200) });
      list = Array.isArray(p.records) ? p.records :
             Array.isArray(p.installations) ? p.installations :
             Array.isArray(p.data?.records) ? p.data.records :
             Array.isArray(p.data?.installations) ? p.data.installations : [];
      break;
    }
    if (!list) return respond(last?.status||401, { ok:false, error:"AUTH", msg:"Token rejected as both 'Token' and 'Bearer'." });

    // 2) Hours per site
    const items = [];
    const Hgood = last.status===200 && last.text ? headersList[0] : headersList[1]; // pick the header that succeeded above
    const batchSize = 4;
    for (let i=0; i<list.length; i+=batchSize) {
      const batch = list.slice(i,i+batchSize);
      const results = await Promise.all(batch.map(async (inst)=>{
        const idSite = inst.idSite || inst.id || inst.identifier;
        const name = inst.name || inst.siteName || `Site ${idSite}`;
        if (!idSite) return { idSite:null, name, hours:null, ts:null, note:"missing idSite" };
        const r = await httpGet(`${base}/installations/${idSite}/system-overview`, Hgood);
        if (r.status !== 200) return { idSite, name, hours:null, ts:null, note:`HTTP ${r.status}` };
        const p = parse(r.text); if (!p) return { idSite, name, hours:null, ts:null, note:"NON_JSON" };
        const rec = p.records || p.data || p;
        const ex = extractHours(rec);
        return { idSite, name, hours: ex.hours, ts: ex.ts, key: ex.key || null };
      }));
      items.push(...results);
    }
    return respond(200, { ok:true, count: items.length, items });
  } catch (e) {
    return respond(500, { ok:false, error:"FATAL", msg:String(e).slice(0,400) });
  }
};
