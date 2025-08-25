// /api/vehicles/index.js
module.exports = async function (context, req) {
  const API_KEY = process.env.TT_API_KEY;
  const TT_BASE = process.env.TT_BASE_URL; // bv. https://track.bcntracer.nl/api
  if (!API_KEY || !TT_BASE) {
    return { status: 500, body: "TT_API_KEY or TT_BASE_URL not configured" };
  }
  try {
    // TODO: pas dit endpoint aan naar jullie echte pad (bv. /vehicles/positions)
    const url = `${TT_BASE}/vehicles/positions`;

    const r = await fetch(url, {
      headers: {
        // Probeer eerst X-Api-Key; zo niet, wissel naar Authorization: Bearer
        'X-Api-Key': API_KEY,
        'Accept': 'application/json'
      }
    });

    const text = await r.text();
    if (!r.ok) {
      context.log(`TT API error ${r.status}: ${text.slice(0,300)}`);
      return { status: r.status, body: text || "Upstream error" };
    }

    const raw = JSON.parse(text);
    const vehicles = (raw.vehicles ?? raw ?? []).map(v => ({
      id: v.id || v.vehicleId || v.name,
      lat: v.lat ?? v.latitude,
      lon: v.lon ?? v.longitude,
      speed: v.speed ?? null,
      heading: v.heading ?? v.course ?? null,
      ts: v.timestamp ?? v.lastSeen ?? Date.now()
    }));

    return { status: 200, body: JSON.stringify({ vehicles }) };
  } catch (err) {
    context.log(err);
    return { status: 500, body: "Proxy error to TrustTrack API" };
  }
};
