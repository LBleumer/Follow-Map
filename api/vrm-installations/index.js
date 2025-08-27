const https = require('https');

module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN;

  const respond = (status, obj) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(obj, null, 2)
    };
  };

  // helper that never throws; always resolves {status, text}
  const httpGet = (url, headers = {}) => new Promise((resolve) => {
    const u = new URL(url);
    const opts = {
      method: 'GET',
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      headers
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', (e) => resolve({ status: 599, text: String(e) }));
    req.end();
  });

  try {
    if (!TOKEN) return respond(500, { ok:false, error:"CONFIG", msg:"VRM_TOKEN missing" });

    const base = 'https://vrmapi.victronenergy.com/v2';
    const headers = {
      'X-Authorization': `Token ${TOKEN}`,
      'Accept': 'application/json'
    };

    // 1) call installations listing
    const url = `${base}/installations?extended=1`;
    const { status, text } = await httpGet(url, headers);

    if (status !== 200) {
      return respond(status, { ok:false, error:"VRM_HTTP", status, url, preview: text.slice(0, 400) });
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return respond(502, { ok:false, error:"VRM_NON_JSON", preview: text.slice(0, 200) }); }

    // normalise shapes
    const arr =
      (Array.isArray(parsed.records) && parsed.records) ||
      (Array.isArray(parsed.installations) && parsed.installations) ||
      (Array.isArray(parsed.data?.records) && parsed.data.records) ||
      (Array.isArray(parsed.data?.installations) && parsed.data.installations) ||
      [];

    // return minimal info first (we can add GPS later)
    const out = arr.map(it => ({
      idSite: it.idSite || it.id || it.identifier || null,
      name: it.name || it.nickname || it.siteName || null
    })).filter(x => x.idSite && x.name);

    return respond(200, { ok:true, count: out.length, installations: out, keysSeen: Object.keys(parsed) });

  } catch (e) {
    return respond(500, { ok:false, error:"FATAL", msg: String(e).slice(0, 300) });
  }
};
