// /api/vehicles/index.js — fm-track proxy (CommonJS, Azure SWA)
module.exports = async function (context, req) {
  const API_KEY = process.env.TT_API_KEY;
  const BASE = (process.env.TT_BASE_URL || "").replace(/\/$/, "");
  const VERSION = process.env.TT_API_VERSION || "1";

  const respond = (status, obj, contentType = "application/json; charset=utf-8") => {
    context.res = { status, headers: { "Content-Type": contentType }, body: JSON.stringify(obj) };
  };

  if (!API_KEY || !BASE) {
    return respond(500, { ok: false, error: "CONFIG", msg: "TT_API_KEY or TT_BASE_URL not configured" });
  }

  // Primary endpoint you confirmed works:
  //   GET https://api.fm-track.com/objects?version=1&api_key=API_KEY
  const url = `${BASE}/objects?version=${encodeURIComponent(VERSION)}&api_key=${encodeURIComponent(API_KEY)}`;

  try {
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    const text = await r.text();

    if (!r.ok) {
      return respond(r.status, { ok: false, error: "UPSTREAM", status: r.status, bodyPreview: text.slice(0, 300) }, "application/json; charset=utf-8");
    }

    let raw;
    try { raw = JSON.parse(text); }
    catch { return respond(502, { ok: false, error: "NON_JSON", msg: "fm-track returned non-JSON" }); }

    // Normalize to a simple vehicles array.
    // fm-track commonly returns an array of "objects" with last position nested.
    // This mapper handles a few likely shapes:
    const list = Array.isArray(raw) ? raw : (raw.objects || raw.data || []);
    const vehicles = (list || []).map(o => {
      // try multiple field shapes
      const id = o.id || o.objectId || o.name || o.unitId || o.uniqueId || "unknown";
      const pos = o.lastPosition || o.position || o.last_pos || {};
      const lat = Number(o.lat ?? o.latitude ?? pos.lat ?? pos.latitude);
      const lon = Number(o.lon ?? o.longitude ?? pos.lon ?? pos.longitude);
      const speed = o.speed ?? pos.speed ?? null;
      const heading = o.heading ?? o.course ?? pos.heading ?? pos.course ?? null;
      const ts = o.timestamp ?? o.lastSeen ?? pos.timestamp ?? pos.time ?? Date.now();
      return { id, lat, lon, speed, heading, ts };
    }).filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lon));

    return respond(200, { ok: true, count: vehicles.length, vehicles });
  } catch (e) {
    context.log(e);
    return respond(500, { ok: false, error: "PROXY", msg: "Error calling fm-track API" });
  }
};
