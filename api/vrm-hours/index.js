// Robust VRM hours endpoint (no external libs; always returns JSON)
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

  if (!TOKEN) {
    return respond(500, { ok: false, error: "CONFIG", msg: "VRM_TOKEN missing in environment variables" });
  }

  const base = "https://vrmapi.victronenergy.com/v2";
  const headers = {
    "X-Authorization": `Bearer ${TOKEN}`,
    "Accept": "application/json"
  };

  // Safe GET helper that never throws
  const httpGet = (url) => new Promise((resolve) => {
    const u = new URL(url);
    const opts = { method: 'GET', hostname: u.hostname, path: u.pathname + (u.search || ''), headers };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", (e) => resolve({ status: 599, text: String(e) }));
    req.end();
  });

  // parse JSON or return error
  const parseJson = (status, text) => {
    try { return { ok: true, json: JSON.parse(text) }; }
    catch { return { ok: false, err: { status, preview: text.slice(0, 300) } }; }
  };

  // Try to pull hours from various likely keys
  function extractHours(rec) {
    if (!rec || typeof rec !== "object") return { hours: null, ts: null, key: null };

    const tryKeys = [
      "genset/0/Ac/RunningHours",
      "genset/0/Ac/Runtime",
      "Generator/0/Ac/RunningHours",
      "Generator/0/RunningHours"
    ];

    for (const k of tryKeys) {
      if (rec[k] && typeof rec[k] === "object") {
        const v = rec[k];
        const val = v.value ?? v.last ?? v.current ?? v; // different shapes
        const ts  = v.timestamp ?? v.time ?? null;
        if (val !== undefined && val !== null) return { hours: String(val), ts, key: k };
      }
    }

    // fallback: scan for anything ending with RunningHours/Runtime
    for (const [k, v] of Object.entries(rec)) {
      if (/(RunningHours|Runtime)$/i.test(k) && v && typeof v === "object") {
        const val = v.value ?? v.last ?? v.current ?? v;
        const ts  = v.timestamp ?? v.time ?? null;
        if (val !== undefined && val !== null) return { hours: String(val), ts, key: k };
      }
    }

    return { hours: null, ts: null, key: null };
  }

  try {
    // 1) List installations
    const listUrl = `${base}/installations?extended=1`;
    const { status: s1, text: t1 } = await httpGet(listUrl);
    if (s1 !== 200) return respond(s1, { ok: false, error: "VRM_HTTP_LIST", status: s1, url: listUrl, preview: t1.slice(0, 400) });

    const p1 = parseJson(s1, t1);
    if (!p1.ok) return respond(502, { ok: false, error: "VRM_NON_JSON_LIST", ...p1.err });

    // normalise array
    const list = Array.isArray(p1.json.records) ? p1.json.records
               : Array.isArray(p1.json.installations) ? p1.json.installations
               : Array.isArray(p1.json.data?.records) ? p1.json.data.records
               : Array.isArray(p1.json.data?.installations) ? p1.json.data.installations
               : [];

    // 2) For each installation: system overview
    const items = [];
    // Limit concurrency to be polite
    const batchSize = 4;
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      const promises = batch.map(async (inst) => {
        const idSite = inst.idSite || inst.id || inst.identifier;
        const name = inst.name || inst.siteName || `Site ${idSite}`;
        if (!idSite) return { idSite: null, name, hours: null, ts: null, note: "missing idSite" };

        const url = `${base}/installations/${idSite}/system-overview`;
        const { status: s2, text: t2 } = await httpGet(url);
        if (s2 !== 200) return { idSite, name, hours: null, ts: null, note: `HTTP ${s2}` };

        const p2 = parseJson(s2, t2);
        if (!p2.ok) return { idSite, name, hours: null, ts: null, note: "NON_JSON" };

        const rec = p2.json.records || p2.json.data || p2.json;
        const ex = extractHours(rec);
        return { idSite, name, hours: ex.hours, ts: ex.ts, key: ex.key || null };
      });

      const results = await Promise.all(promises);
      items.push(...results);
    }

    return respond(200, { ok: true, count: items.length, items });

  } catch (e) {
    return respond(500, { ok: false, error: "FATAL", msg: String(e).slice(0, 400) });
  }
};
