// api/vrm-hours/index.js
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
  const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

  // Try Personal Access Token ("Token") first, then "Bearer"
  const headerOptions = [
    { "X-Authorization": `Token ${TOKEN}`, "Accept": "application/json" },
    { "X-Authorization": `Bearer ${TOKEN}`, "Accept": "application/json" },
  ];

  const extractHours = (rec) => {
    if (!rec || typeof rec !== 'object') return { hours:null, ts:null, key:null };
    const candidates = [
      "genset/0/Ac/RunningHours","genset/0/Ac/Runtime",
      "Generator/0/Ac/RunningHours","Generator/0/RunningHours",
      "Genset/0/Ac/RunningHours","Genset/0/Ac/Runtime",
    ];
    for (const k of candidates) if (rec[k]) {
      const v = rec[k]; const hours = v.value ?? v.last ?? v.current ?? v;
      const ts = v.timestamp ?? v.time ?? null;
      if (hours != null) return { hours:String(hours), ts, key:k };
    }
    // generic scan
    for (const [k,v] of Object.entries(rec)) if (/(RunningHours|Runtime)$/i.test(k) && v && typeof v === 'object') {
      const hours = v.value ?? v.last ?? v.current ?? v;
      const ts = v.timestamp ?? v.time ?? null;
      if (hours != null) return { hours:String(hours), ts, key:k };
    }
    return { hours:null, ts:null, key:null };
  };

  // Step 1: /users/me to get userId and the working header style
  let userId=null, Hgood=null, last=null;
  for (const H of headerOptions) {
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
  if (!userId || !Hgood) return respond(last?.status||401, { ok:false, error:"AUTH", msg:"Token accepted but no user id found in /users/me.", preview:last?.text?.slice(0,400) });

  // helper: fetch hours for a single site (with detailed notes)
  async function getHoursForSite(idSite, name) {
    const url = `${base}/installations/${idSite}/system-overview`;
    const r = await httpGet(url, Hgood);
    if (r.status !== 200) return { idSite, name, hours:null, ts:null, key:null, note:`HTTP ${r.status}` };
    const p = parse(r.text);
    if (!p) return { idSite, name, hours:null, ts:null, key:null, note:"NON_JSON" };
    const rec = p.records || p.data || p;
    const ex = extractHours(rec);
    if (!ex.hours) return { idSite, name, hours:null, ts:null, key:null, note:"NO_RUNNING_HOURS_KEY" };
    return { idSite, name, hours: ex.hours, ts: ex.ts, key: ex.key || null };
  }

  try {
    // If caller provides idSite, just fetch that one (easier to debug)
    const qsId = req?.query?.idSite ? String(req.query.idSite) : null;
    if (qsId) {
      const one = await getHoursForSite(qsId, `Site ${qsId}`);
      return respond(200, { ok:true, userId, count: 1, items: [one] });
    }

    // Otherwise: list all user installations
    const li = await httpGet(`${base}/users/${userId}/installations?extended=1`, Hgood);
    if (li.status !== 200) return respond(li.status, { ok:false, error:"VRM_HTTP_INSTALLATIONS", preview: li.text.slice(0,400) });
    const pList = parse(li.text);
    const list = Array.isArray(pList?.records) ? pList.records :
                 Array.isArray(pList?.installations) ? pList.installations :
                 Array.isArray(pList?.data?.records) ? pList.data.records :
                 Array.isArray(pList?.data?.installations) ? pList.data.installations : [];

    // Fetch in small batches to avoid rate limits
    const items = [];
    const batch = 4;
    const delay = (ms)=>new Promise(r=>setTimeout(r,ms));
    for (let i=0;i<list.length;i+=batch) {
      const part = list.slice(i,i+batch);
      const results = await Promise.all(part.map(inst=>{
        const idSite = inst.idSite || inst.id || inst.identifier;
        const name = inst.name || inst.siteName || `Site ${idSite}`;
        if (!idSite) return Promise.resolve({ idSite:null, name, hours:null, ts:null, key:null, note:"MISSING_ID" });
        return getHoursForSite(idSite, name);
      }));
      items.push(...results);
      await delay(150); // polite breathing room
    }

    return respond(200, { ok:true, userId, count: items.length, items });
  } catch (e) {
    return respond(500, { ok:false, error:"FATAL", msg:String(e).slice(0,400) });
  }
};
