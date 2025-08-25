// /api/vehicles/index.js — FMS "objects-last-coordinate v2" proxy (CommonJS)
module.exports = async function (context, req) {
  const API_KEY = process.env.TT_API_KEY;
  const BASE = (process.env.TT_BASE_URL || "https://api.fm-track.com").replace(/\/$/, "");
  const VERSION = "2"; // v2 is vereist voor last-coordinate

  const respond = (status, obj) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(obj)
    };
  };

  if (!API_KEY || !BASE) {
    return respond(500, { ok:false, error:"CONFIG", msg:"TT_API_KEY or TT_BASE_URL not configured" });
  }

  // Helper: haal 1 pagina op (optionele continuation_token)
  const fetchPage = async (continuationToken) => {
    const params = new URLSearchParams({
      version: VERSION,
      api_key: API_KEY
    });
    if (continuationToken) params.set("continuation_token", continuationToken);

    const url = `${BASE}/objects-last-coordinate?${params.toString()}`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await r.text();
    if (!r.ok) throw new Error(`Upstream ${r.status}: ${text.slice(0,300)}`);
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error("NON_JSON from FMS"); }
    return json;
  };

  try {
    // Pagineren totdat er geen continuation_token meer is
    const all = [];
    let ct = undefined;
    do {
      const page = await fetchPage(ct);
      const arr = Array.isArray(page) ? page : (page.results || []);
      all.push(...arr);
      ct = page.continuation_token || null;
    } while (ct);

    // Normaliseren naar "vehicles"
    const vehicles = all.map(o => {
      const lc = o.last_coordinate || {};
      return {
        id: o.id || o.objectId || o.name || "unknown",
        name: o.name || null,
        lat: lc.latitude,
        lon: lc.longitude,
        speed: lc.speed ?? null,
        heading: lc.direction ?? null,
        ts: lc.datetime || lc.server_datetime || null
      };
    }).filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lon));

    return respond(200, { ok:true, count: vehicles.length, vehicles });
  } catch (e) {
    context.log(e);
    return respond(502, { ok:false, error:"PROXY", msg: e.message });
  }
};
