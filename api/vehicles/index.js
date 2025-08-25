// /api/vehicles/index.js — TrustTrack proxy (CommonJS)
module.exports = async function (context, req) {
  const API_KEY = process.env.TT_API_KEY;
  const TT_BASE = process.env.TT_BASE_URL; // bv. https://track.bcntracer.nl/api
  const ENDPOINT = "/vehicles/positions";  // ← pas aan als nodig (bv. /vehicles of /objects/positions)

  // helper: vaste JSON-responses
  const respond = (status, obj) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(obj)
    };
  };

  if (!API_KEY || !TT_BASE) {
    return respond(500, { ok:false, error:"CONFIG", msg:"TT_API_KEY or TT_BASE_URL not configured" });
  }

  const url = `${TT_BASE.replace(/\/$/,'')}${ENDPOINT.startsWith('/') ? '' : '/'}${ENDPOINT}`;

  // Probeer beide auth-varianten; veel tenants gebruiken X-Api-Key, sommigen Bearer
  const headerOptions = [
    { 'X-Api-Key': API_KEY, 'Accept': 'application/json' },
    { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
  ];

  for (const hdr of headerOptions) {
    try {
      const r = await fetch(url, { headers: hdr, redirect: 'follow' });
      const text = await r.text();

      if (!r.ok) {
        // 401/403 → waarschijnlijk verkeerde headerstijl; probeer volgende
        if (r.status === 401 || r.status === 403) continue;
        return respond(r.status, { ok:false, error:"UPSTREAM", status:r.status, bodyPreview:text.slice(0,300) });
      }

      // Probeer JSON te parsen; HTML = waarschijnlijk loginpagina
      let raw;
      try { raw = JSON.parse(text); }
      catch { return respond(502, { ok:false, error:"NON_JSON", msg:"Upstream returned non-JSON (maybe login HTML)" }); }

      const arr = Array.isArray(raw) ? raw : (raw.vehicles ?? raw ?? []);
      const vehicles = (arr || []).map(v => ({
        id: v.id || v.vehicleId || v.name || v.unitId || 'unknown',
        lat: v.lat ?? v.latitude,
        lon: v.lon ?? v.longitude,
        speed: v.speed ?? null,
        heading: v.heading ?? v.course ?? null,
        ts: v.timestamp ?? v.lastSeen ?? Date.now()
      })).filter(v => typeof v.lat === 'number' && typeof v.lon === 'number');

      return respond(200, { ok:true, count: vehicles.length, vehicles });
    } catch (e) {
      // netwerk/exception → probeer eventueel volgende headerstijl
      context.log('Fetch error with headers', Object.keys(hdr), e.toString());
    }
  }

  return respond(502, { ok:false, error:"AUTH", msg:"Tried X-Api-Key and Bearer; both failed (401/403?). Check key/header or endpoint path." });
};
