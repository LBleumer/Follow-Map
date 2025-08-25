// /api/vehicles/index.js — DIAG
module.exports = async function (context, req) {
  const API_KEY = process.env.TT_API_KEY || '';
  const TT_BASE = (process.env.TT_BASE_URL || '').replace(/\/$/, ''); // bv. https://track.bcntracer.nl/api
  const DEBUG = req && req.query && ('debug' in req.query);

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

  // Meest gangbare paden in TrustTrack/Ruptela tenants:
  const endpoints = [
    "/vehicles/positions",
    "/vehicles",
    "/objects/positions",
    "/objects",
    "/units"
  ];

  const headerOptions = [
    { name: "X-Api-Key", headers: { "X-Api-Key": API_KEY, "Accept": "application/json" } },
    { name: "Bearer",   headers: { "Authorization": `Bearer ${API_KEY}`, "Accept": "application/json" } }
  ];

  const attempts = [];

  for (const ep of endpoints) {
    const url = `${TT_BASE}${ep.startsWith('/') ? '' : '/'}${ep}`;
    for (const opt of headerOptions) {
      try {
        const r = await fetch(url, { headers: opt.headers, redirect: "follow" });
        const text = await r.text();
        const info = {
          url, auth: opt.name, status: r.status,
          ok: r.ok, contentType: r.headers.get('content-type') || null,
          length: text.length
        };
        if (DEBUG) info.preview = text.slice(0, 300);

        // ✓ Succes: 200 + JSON
        if (r.ok) {
          // probeer JSON te parsen
          try {
            const raw = JSON.parse(text);
            const arr = Array.isArray(raw) ? raw : (raw.vehicles ?? raw ?? []);
            const vehicles = (arr || []).map(v => ({
              id: v.id || v.vehicleId || v.name || v.unitId || 'unknown',
              lat: v.lat ?? v.latitude,
              lon: v.lon ?? v.longitude,
              speed: v.speed ?? null,
              heading: v.heading ?? v.course ?? null,
              ts: v.timestamp ?? v.lastSeen ?? Date.now()
            })).filter(v => typeof v.lat === 'number' && typeof v.lon === 'number');

            return respond(200, { ok:true, used: info, count: vehicles.length, vehicles, attempts: DEBUG ? attempts : undefined });
          } catch {
            // 200 maar geen JSON -> login HTML of andere pagina
            attempts.push({ ...info, note: "non-JSON at 200" });
            continue;
          }
        } else {
          // Niet ok: 401/403 -> waarschijnlijk verkeerde authstijl
          attempts.push(info);
          continue;
        }
      } catch (e) {
        attempts.push({ url, auth: opt.name, exception: String(e).slice(0,200) });
        continue;
      }
    }
  }

  // Niets gelukt:
  return respond(502, {
    ok:false,
    error:"NO_MATCH",
    msg:"Geen endpoint/header-combinatie gaf JSON terug.",
    attempts // bevat per poging: url, auth, status, contentType (+preview bij ?debug=1)
  });
};
