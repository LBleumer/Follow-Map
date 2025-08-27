const https = require('https');

module.exports = async function (context, req) {
  const VRM_TOKEN = process.env.VRM_TOKEN;
  const respond = (status, obj) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(obj, null, 2)
    };
  };
  if (!VRM_TOKEN) return respond(500, { ok:false, error:"CONFIG", msg:"VRM_TOKEN missing" });

  const base = "https://vrmapi.victronenergy.com/v2";

  const httpGet = (url, hdrs) => new Promise((resolve) => {
    const u = new URL(url);
    const opts = { method: 'GET', hostname: u.hostname, path: u.pathname + (u.search || ''), headers: hdrs };
    const r = https.request(opts, res => {
      let data = ''; res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    r.on('error', e => resolve({ status: 599, text: String(e) }));
    r.end();
  });

  // Try with Token first (for personal access tokens), then Bearer (for JWTs)
  const headersList = [
    { "X-Authorization": `Token ${VRM_TOKEN}`, "Accept": "application/json" },
    { "X-Authorization": `Bearer ${VRM_TOKEN}`, "Accept": "application/json" }
  ];

  try {
    let last = null, parsed = null;
    for (const H of headersList) {
      const attempt = await httpGet(`${base}/installations?extended=1`, H);
      last = attempt;
      if (attempt.status === 200) {
        try { parsed = JSON.parse(attempt.text); } catch { return respond(502, { ok:false, error:"NON_JSON", preview: attempt.text.slice(0,200) }); }
        // normalise
        const arr =
          (Array.isArray(parsed.records) && parsed.records) ||
          (Array.isArray(parsed.installations) && parsed.installations) ||
          (Array.isArray(parsed.data?.records) && parsed.data.records) ||
          (Array.isArray(parsed.data?.installations) && parsed.data.installations) ||
          [];
        const out = arr.map(it => ({
          idSite: it.idSite || it.id || it.identifier || null,
          name: it.name || it.nickname || it.siteName || `Site ${it.idSite || it.id || it.identifier}`
        })).filter(x => x.idSite && x.name);
        return respond(200, { ok:true, count: out.length, installations: out });
      }
      // 401/403 => try next header format
      if (attempt.status === 401 || attempt.status === 403) continue;
      // other error -> stop and report
      return respond(attempt.status, { ok:false, error:"VRM_HTTP", status: attempt.status, preview: attempt.text.slice(0,400) });
    }
    // both failed (likely wrong token type/typo)
    return respond(last?.status || 401, { ok:false, error:"AUTH", msg:"Token rejected as both 'Token' and 'Bearer'. Verify token type & value.", preview: last?.text?.slice(0,400) });
  } catch (e) {
    return respond(500, { ok:false, error:"FATAL", msg: String(e).slice(0,400) });
  }
};
