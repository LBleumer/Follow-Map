// /api/vehicles/index.js  (Node 18+ Functions in SWA)
export default async function (context, req) {
  const API_KEY = process.env.TT_API_KEY;
  const TT_BASE = process.env.TT_BASE_URL; // bv. https://<jouw-trusttrack-host>/api

  if (!API_KEY || !TT_BASE) {
    return { status: 500, body: "TT_API_KEY or TT_BASE_URL not configured" };
  }

  try {
    // TODO: vervang het pad hieronder door het échte TrustTrack endpoint voor actuele posities
    // Voorbeeldpad:
    const url = `${TT_BASE}/vehicles/positions`;

    const r = await fetch(url, {
      headers: {
        // Sommige tenants gebruiken 'Authorization: Bearer ...', anderen 'X-Api-Key: ...'
        // Pas aan op basis van jouw documentatie:
        "Authorization": `Bearer ${API_KEY}`,
        "Accept": "application/json"
      }
    });

    if (!r.ok) {
      const text = await r.text();
      return { status: r.status, body: text || "Upstream error" };
    }

    const raw = await r.json();

    // Normaliseer velden naar een vast schema voor je frontend
    const vehicles = (raw.vehicles ?? raw ?? []).map(v => ({
      id: v.id || v.vehicleId || v.name,
      lat: v.lat ?? v.latitude,
      lon: v.lon ?? v.longitude,
      speed: v.speed ?? null,
      heading: v.heading ?? v.course ?? null,
      ts: v.timestamp ?? v.lastSeen ?? Date.now()
    }));

    return { status: 200, jsonBody: { vehicles } };
  } catch (err) {
    context.log(err);
    return { status: 500, body: "Proxy error to TrustTrack API" };
  }
}
