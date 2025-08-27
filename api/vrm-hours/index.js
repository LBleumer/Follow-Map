const https = require('https');

module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN;
  const respond = (status, obj) => {
    context.res = { status, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(obj, null, 2) };
  };
  if (!TOKEN) return respond(500, { ok:false, error:"CONFIG", msg:"VRM_TOKEN missing" });

  const base = "https://vrmapi.victronenergy.com/v2";
  const httpGet = (url, headers) => new Promise((resolve) => {
    const u = new URL(url);
    const opts = { method:'GET', hostname:u.hostname, path:u.pathname + (u.search||''), headers };
    const r = https.request(opts, res => { let data=''; res.on('data',d=>data+=d); res.on('end',()=>resolve({status:res.statusCode,text:data})); });
    r.on('error', e => resolve({ status: 599, text: String(e) }));
    r.end();
  });
  const headerOptions = [
    { "X-Authorization": `Token ${TOKEN}`, "Accept": "application/json" },
    { "X-Authorization": `Bearer ${TOKEN}`, "Accept": "application/json" },
  ];
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const extractHours = (rec) => {
    if (!rec || typeof rec !== 'object') return { hours:null, ts:null, key:null };
    const candidates = [
      "genset/0/Ac/RunningHours","genset/0/Ac/Runtime",
      "Generator/0/Ac/RunningHours","Generator/0/RunningHours"
    ];
    for (const k of candidates) if (rec[k]) {
      const v = rec[k]; const hours = v.value ?? v.last ?? v.current ?? v;
      const ts = v.timestamp ?? v.time ?? null;
      if (hours != null) return { hours:String(hours), ts, key:k };
    }
    for (const [k,v] of Object.entries(rec)) if (/(RunningHours|Runtime)$/i.test(k) && v) {
      const hours = v.value ?? v.last ?? v.current ?? v;
      const ts = v.timestamp ?? v.time ?? null;
      if (hours != null) return { hours:String(hours), ts, key:k };
    }
    return { hours:null, ts:null, key:null };
  };

  try {
    // 1) Who am I?
    let idUser = null, Hgood = null, last = null;
    for (const H of headerOptions) {
      const me = await httpGet(`${base}/users/me`, H);
      last = me;
      if (me.status === 200) {
        const j = parse(me.text); idUser = j?.idUser || j?.data?.idUser || j?.user?.idUser;
        if (idUser) { Hgood = H; break; }
      } else if (me.status === 401 || me.status === 403) {
        continue;
      } else {
        return respond(me.status, { ok:false, error:"VRM_HTTP_ME", preview: me.text.slice(0,400) });
      }
    }
    if (!idUser || !Hgood) return respond(last?.status||401, { ok:false, error:"AUTH", msg:"Token not accepted for /users/me." });

    // 2) List my installations
    const li = await httpGet(`${base}/users/${idUser}/installations?extended=1`, Hgood);
    if (li.status !== 200) return respond(li.status, { ok:false, error:"VRM_HTTP_INSTALLATIONS", preview: li.text.slice(0,400) });
    const pList = parse(li.text);
    const list = Array.isArray(pList?.records) ? pList.records :
                 Array.isArray(pList?.installations) ? pList.installations :
                 Array.isArray(pList?.data?.records) ? pList.data.records :
                 Array.isArray(pList?.data?.installations) ? pList.data.installations : [];

    // 3) Hours per site
    const items = [];
    const batch = 4;
    for (let i=0; i<list.length; i+=batch) {
      const part = list.slice(i,i+batch);
      const results = await Promise.all(part.map(async inst => {
        const idSite = inst.idSite || inst.id || inst.identifier;
        const name = inst.name || inst.siteName || `Site ${idSite}`;
        if (!idSite) return { idSite:null, name, hours:null, ts:null, note:"missing idSite" };
        const ov = await httpGet(`${base}/installations/${idSite}/system-overview`, Hgood);
        if (ov.status !== 200) return { idSite, name, hours:null, ts:null, note:`HTTP ${ov.status}` };
        const p = parse(ov.text); const rec = p?.records || p?.data || p;
        const ex = extractHours(rec);
        return { idSite, name, hours: ex.hours, ts: ex.ts, key: ex.key || null };
      }));
      items.push(...results);
    }

    return respond(200, { ok:true, idUser, count: items.length, items });
  } catch (e) {
    return respond(500, { ok:false, error:"FATAL", msg:String(e).slice(0,400) });
  }
};
