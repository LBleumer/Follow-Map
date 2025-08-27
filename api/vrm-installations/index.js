// api/vrm-installations/index.js
const https = require('https');

module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN;
  const respond = (status, obj) => {
    context.res = { status, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(obj, null, 2) };
  };
  if (!TOKEN) return respond(500, { ok:false, error:"CONFIG", msg:"VRM_TOKEN missing" });

  const wantGps = String(req.query.gps || '0') === '1';
  const limit   = req.query.limit ? Math.max(1, Math.min(1000, +req.query.limit)) : null;

  const base = "https://vrmapi.victronenergy.com/v2";
  const httpGet = (url, headers) => new Promise((resolve) => {
    const u = new URL(url);
    const opts = { method:'GET', hostname:u.hostname, path:u.pathname + (u.search||''), headers };
    const r = https.request(opts, res => { let data=''; res.on('data',d=>data+=d); res.on('end',()=>resolve({status:res.statusCode,text:data})); });
    r.on('error', e => resolve({ status: 599, text: String(e) }));
    r.end();
  });

  const headersList = [
    { "X-Authorization": `Token ${TOKEN}`,  "Accept":"application/json" },
    { "X-Authorization": `Bearer ${TOKEN}`, "Accept":"application/json" }
  ];
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

  // 1) /users/me to get user id + working header style
  let userId=null, Hgood=null, last=null;
  for (const H of headersList) {
    const me = await httpGet(`${base}/users/me`, H);
    last = me;
    if (me.status === 200) {
      const j = parse(me.text);
      userId = j?.user?.id ?? j?.idUser ?? j?.data?.idUser ?? null;
      if (userId) { Hgood = H; break; }
    } else if (me.status === 401 || me.status === 403) {
      continue;
    } else {
      return respond(me.status, { ok:false, error:"VRM_HTTP_ME", preview: me.text.slice(0,400) });
    }
  }
  if (!userId || !Hgood) return respond(last?.status||401, { ok:false, error:"AUTH", msg:"Token accepted but no user id from /users/me.", preview:last?.text?.slice(0,400) });

  // 2) get installations
  const li = await httpGet(`${base}/users/${userId}/installations?extended=1`, Hgood);
  if (li.status !== 200) return respond(li.status, { ok:false, error:"VRM_HTTP_INSTALLATIONS", preview: li.text.slice(0,400) });
  const jList = parse(li.text);
  const arr =
    (Array.isArray(jList?.records) && jList.records) ||
    (Array.isArray(jList?.installations) && jList.installations) ||
    (Array.isArray(jList?.data?.records) && jList.data.records) ||
    (Array.isArray(jList?.data?.installations) && jList.data.installations) || [];

  let sites = arr.map(it => ({
    idSite: it.idSite || it.id || it.identifier || null,
    name: it.name || it.siteName || it.nickname || `Site ${it.idSite || it.id || it.identifier}`
  })).filter(x => x.idSite && x.name);

  if (limit && sites.length > limit) sites = sites.slice(0, limit);

  if (!wantGps) {
    return respond(200, { ok:true, userId, count: sites.length, installations: sites });
  }

  // 3) optional GPS fetch (batched)
  const pickCoords = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const cand = [
      ['latitude','longitude'], ['lat','lon'], ['Lat','Lon'], ['Latitude','Longitude']
    ];
    for (const [la,lo] of cand) {
      const lat = obj[la], lon = obj[lo];
      if (lat != null && lon != null) return { lat:Number(lat), lon:Number(lon) };
    }
    return null;
  };
  async function fetchGPS(idSite) {
    // Try widgets first
    for (const W of ['GPS','Location']) {
      const r = await httpGet(`${base}/installations/${idSite}/widgets/${W}`, Hgood);
      if (r.status === 200) {
        const j = parse(r.text);
        const rec = j?.data || j?.records || j;
        if (rec) {
          let coords = pickCoords(rec);
          if (!coords && typeof rec === 'object') {
            for (const v of Object.values(rec)) { coords = pickCoords(v); if (coords) break; }
          }
          if (coords) return { lat:coords.lat, lon:coords.lon, ts: rec?.timestamp ?? null, src:`widget:${W}` };
        }
      }
    }
    // Fallback: scan system-overview devices
    const so = await httpGet(`${base}/installations/${idSite}/system-overview`, Hgood);
    if (so.status === 200) {
      const j = parse(so.text);
      const rec = j?.records || j?.data || j || {};
      const devs = Array.isArray(rec.devices) ? rec.devices : [];
      for (const d of devs) {
        const c = pickCoords(d);
        if (c) return { lat:c.lat, lon:c.lon, ts: d?.timestamp ?? null, src:'system-overview:device' };
      }
    }
    return { lat:null, lon:null, ts:null, src:null };
  }

  const out = [];
  const batchSize = 4;
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  for (let i=0; i<sites.length; i+=batchSize) {
    const batch = sites.slice(i,i+batchSize);
    const results = await Promise.all(batch.map(async s => {
      const gps = await fetchGPS(s.idSite);
      return { ...s, ...gps };
    }));
    out.push(...results);
    await sleep(150); // be polite to VRM
  }

  return respond(200, { ok:true, userId, count: out.length, installations: out });
};
