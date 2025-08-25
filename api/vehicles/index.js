// /api/vehicles/index.js
// Azure Static Web App Function (Node 18 runtime)

module.exports = async function (context, req) {
  const API_KEY = process.env.TT_API_KEY;
  const TT_BASE = process.env.TT_BASE_URL; // bv. https://track.bcntracer.nl/api

  if (!API_KEY || !TT_BASE) {
    return {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: "TT_API_KEY or TT_BASE_URL not configured"
    };
  }

  try {
    // 👉 Pas dit pad aan naar het juiste endpoint van TrustTrack
    // Vaak is dat /vehicles, /vehicles/positions of /objects/positions
    const url = `${TT_BASE}/vehicles/positions`;

    const r = await fetch(url, {
      headers: {
        // Meeste tenants: X-Api-Key, sommige: Authorization: Bearer
        'X-Api-Key': API_KEY,
        'Accept': 'application/json'
      }
    });

    const text = await r.text();
    if (!r.ok) {
      context.log(`TT API error ${r.status}: ${text.slice(0,300)}`);
      return {
        status: r.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: text || "Upstream error"
      };
    }

    const raw = JSON.parse(text);

    // Normaliseer naar een vast schema voor de frontend
    const vehicles = (raw.vehicles ?? raw ?? []).map(v => ({
      id: v.id || v.vehicleId || v.name,
      lat: v.lat ?? v.latitude,
      lon: v.lon ?? v.longitude,
      speed: v.speed ?? null,
      heading: v.heading ?? v.course ?? null,
      ts: v.timestamp ?? v.lastSeen ?? Date.now()
    }));

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicles })
    };
  } catch (err) {
    context.log(err);
    return {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: "Proxy error to TrustTrack API"
    };
  }
};
