// /api/vehicles/index.js — fm-track: objects + positions merge
module.exports = async function (context, req) {
  const API_KEY = process.env.TT_API_KEY;
  const BASE = (process.env.TT_BASE_URL || "").replace(/\/$/, "");
  const VERSION = process.env.TT_API_VERSION || "1";

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

  const q = `version=${encodeURIComponent(VERSION)}&api_key=${encodeURIComponent(API_KEY)}`;
  const urlObjects   = `${BASE}/objects?${q}`;
  const urlPositions = `${BASE}/positions?${q}`; // ← als jullie echte endpoint anders is, pas dit aan

  try {
    // 1) Haal objecten (id + naam)
    const [ro, rp] = await Promise.all([
      fetch(urlObjects,   { headers: { "Accept":"application/json" } }),
      fetch(urlPositions, { headers: { "Accept":"application/json" } })
    ]);

    const textO = await ro.text();
    const textP = await rp.text();

    if (!ro.ok) return respond(ro.status, { ok:false, error:"UPSTREAM_OBJECTS", status:ro.status, bodyPreview:textO.slice(0,300) });
    if (!rp.ok) return respond(rp.status, { ok:false, error:"UPSTREAM_POSITIONS", status:rp.status, bodyPreview:textP.slice(0,300) });

    let objects, positions;
    try { objects = JSON.parse(textO); } catch { return respond(502, { ok:false, error:"NON_JSON_OBJECTS" }); }
    try { positions = JSON.parse(textP); } catch { return respond(502, { ok:false, error:"NON_JSON_POSITIONS" }); }

    // Normaliseer: sommige API's geven {objects:[...]} of direct [...]
    const objList = Array.isArray(objects) ? objects : (objects.objects || objects.data || []);
    const posList = Array.isArray(positions) ? positions : (positions.positions || positions.data || []);

    // Maak snelle lookup op mogelijke id-velden in positions
    // We proberen verschillende veldnamen omdat we je exacte schema nog niet weten.
    const idxBy = (arr, keys) => {
      const maps = {};
      for (const key of keys) maps[key] = new Map();
      for (const p of arr) {
        for (const key of keys) {
          if (p && p[key] != null) maps[key].set(String(p[key]), p);
        }
      }
      return maps;
    };
    const posKeys = ["object_id","objectId","id","unitId","unit_id","vehicle_id","vehicleId"];
    const posIndex = idxBy(posList, posKeys);

    // Merge: kies de eerste index-key die matcht met het object
    const vehicles = [];
    for (const o of objList) {
      const oidCandidates = [
        String(o.id),
        o.objectId != null ? String(o.objectId) : null,
        o.unitId != null ? String(o.unitId) : null,
        o.uniqueId != null ? String(o.uniqueId) : null
      ].filter(Boolean);

      let pos = null;
      for (const oid of oidCandidates) {
        for (const key of posKeys) {
          if (posIndex[key].has(oid)) { pos = posIndex[key].get(oid); break; }
        }
        if (pos) break;
      }

      // Zoek lat/lon in object EN/OF position record
      const lat = Number(
        o.lat ?? o.latitude ??
        (pos ? (pos.lat ?? pos.latitude) : undefined)
      );
      const lon = Number(
        o.lon ?? o.longitude ??
        (pos ? (pos.lon ?? pos.longitude) : undefined)
      );

      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const vehicle = {
          id: o.id || o.objectId || o.name || o.unitId || o.uniqueId || "unknown",
          name: o.name || null,
          lat, lon,
          speed: (pos ? (pos.speed ?? pos.velocity) : (o.speed ?? null)) ?? null,
          heading: (pos ? (pos.heading ?? pos.course) : (o.heading ?? o.course)) ?? null,
          ts: (pos ? (pos.timestamp ?? pos.time) : (o.timestamp ?? o.lastSeen)) ?? Date.now()
        };
        vehicles.push(vehicle);
      }
    }

    return respond(200, { ok:true, count: vehicles.length, vehicles });
  } catch (e) {
    context.log(e);
    return respond(500, { ok:false, error:"PROXY", msg:"Error calling fm-track endpoints" });
  }
};
