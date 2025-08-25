// /api/vehicles/index.js  — DEBUG VARIANT
// Werkt in Azure Static Web Apps (Node 18). Altijd JSON terug.

module.exports = async function (context, req) {
  // Debugflag: voeg ?debug=1 toe aan de URL om extra info te zien
  const DEBUG = (req && req.query && ('debug' in req.query));

  const API_KEY = process.env.TT_API_KEY || '';
  const TT_BASE = process.env.TT_BASE_URL || ''; // bv. https://track.bcntracer.nl/api
  const endpoint = (process.env.TT_POS_ENDPOINT || '/vehicles/positions').replace(/^\s*$/, '/vehicles/positions');

  // Helper voor consistente JSON-responses
  const respond = (status, obj) => ({
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj)
  });

  // Environment check
  if (!API_KEY || !TT_BASE) {
    return respond(500, {
      ok: false,
      error: 'CONFIG_MISSING',
      message: 'TT_API_KEY or TT_BASE_URL not configured',
      have: { TT_API_KEY: !!API_KEY, TT_BASE_URL: !!TT_BASE }
    });
  }

  const url = `${TT_BASE.replace(/\/$/, '')}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  const headersCandidates = [
    { 'X-Api-Key': API_KEY, 'Accept': 'application/json' },            // veel tenants
    { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' } // alternatief
  ];

  // Probeer 2 header-varianten – we geven debug terug wat er gebeurde
  const attempts = [];
  for (const hdr of headersCandidates) {
    try {
      const r = await fetch(url, { headers: hdr, redirect: 'follow' });
      const text = await r.text();
      const info = {
        attemptHeaders: Object.keys(hdr),
        status: r.status,
        ok: r.ok,
        contentType: r.headers.get('content-type'),
        length: text.length
      };
      // Bewaar wat we zagen (ingekort), maar laat geen gevoelige data zien
      if (DEBUG) info.preview = text.slice(0, 300);

      attempts.push(info);

      if (!r.ok) continue; // probeer volgende headerstijl

      // Probeer JSON te parsen; als het HTML is, melden we dat netjes
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        return respond(502, {
          ok: false,
          error: 'NON_JSON_RESPONSE',
          message: 'Upstream returned non-JSON (mogelijk loginpagina/HTML).',
          url,
          attempts
        });
      }

      // Normaliseer voertuigen
      const arr = Array.isArray(raw) ? raw : (raw.vehicles ?? raw ?? []);
      const vehicles = (arr || []).map(v => ({
        id: v.id || v.vehicleId || v.name || v.unitId || 'unknown',
        lat: v.lat ?? v.latitude,
        lon: v.lon ?? v.longitude,
        speed: v.speed ?? null,
        heading: v.heading ?? v.course ?? null,
        ts: v.timestamp ?? v.lastSeen ?? Date.now()
      })).filter(v => typeof v.lat === 'number' && typeof v.lon === 'number');

      return respond(200, { ok: true, url, vehicles, count: vehicles.length, attempts: DEBUG ? attempts : undefined });
    } catch (e) {
      attempts.push({ attemptHeaders: Object.keys(hdr), exception: ('' + e).slice(0, 200) });
      // probeer volgende headerstijl
    }
  }

  // Als geen enkele poging lukte:
  return respond(502, {
    ok: false,
    error: 'UPSTREAM_FAILED',
    message: 'Geen succesvolle response van TrustTrack endpoint.',
    url,
    attempts
  });
};
