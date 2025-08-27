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

  // try PAT first, then JWT
  const headerOptions = [
    { "X-Authorization": `Token ${TOKEN}`, "Accept": "application/json" },
    { "X-Authorization": `Bearer ${TOKEN}`, "Accept": "application/json" },
  ];

  try {
    let userId = null, Hgood = null, last = null;

    // 1) Who am I?
    for (const H of headerOptions) {
      const me = await httpGet(`${base}/users/me`, H);
      last = me;
      if (me.status === 200) {
        try {
          const j = JSON.parse(me.text);
          // VRM returns { success:true, user:{ id, ... } }
          userId = j?.user?.id ?? j?.idUser ?? j?.data?.idUser ?? null;
          if (userId) { Hgood = H; break; }
        } catch {}
      } else if (me.status === 401 || me.status === 403) {
        continue; // try next header style
      } else {
        return respond(me.status, { ok:false, error:"VRM_HTTP_ME", preview: me.text.slice(0,400) });
      }
    }

    if (!userId || !Hgood) {
      return respond(last?.status || 401, { ok:false, error:"AUTH", msg:"Token accepted but no user id found in /users/me response.", preview:last?.text?.slice(0,400) });
    }

    // 2) List installations for this user
    const li = await httpGet(`${base}/users/${userId}/installations?extended=1`, Hgood);
    if (li.status !== 200) return respond(li.status, { ok:false, error:"VRM_HTTP_INSTALLATIONS", preview: li.text.slice(0,400) });

    let parsed; try { parsed = JSON.parse(li.text); } catch {
      return respond(502, { ok:false, error:"VRM_NON_JSON_INSTALLATIONS", preview: li.text.slice(0,200) });
    }

    const arr =
      (Array.isArray(parsed.records) && parsed.records) ||
      (Array.isArray(parsed.installations) && parsed.installations) ||
      (Array.isArray(parsed.data?.records) && parsed.data.records) ||
      (Array.isArray(parsed.data?.installations) && parsed.data.installations) ||
      [];

    const out = arr.map(it => ({
      idSite: it.idSite || it.id || it.identifier || null,
      name: it.name || it.siteName || it.nickname || `Site ${it.idSite || it.id || it.identifier}`
    })).filter(x => x.idSite && x.name);

    return respond(200, { ok:true, userId, count: out.length, installations: out });
  } catch (e) {
    return respond(500, { ok:false, error:"FATAL", msg:String(e).slice(0,400) });
  }
};
