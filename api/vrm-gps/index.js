const https = require('https');

module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN;
  const respond = (s, o) => {
    context.res = {
      status: s,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(o, null, 2)
    };
  };
  if (!TOKEN) return respond(500, { ok:false, error:"CONFIG", msg:"VRM_TOKEN missing" });

  const idSite = req.query.idSite;
  if (!idSite) return respond(400, { ok:false, error:"MISSING_ID", msg:"Pass ?idSite=<number>" });

  const base = "https://vrmapi.victronenergy.com/v2";
  const H    = { "X-Authorization": `Token ${TOKEN}`, "Accept":"application/json" };

  const httpGet = (url, headers) => new Promise(resolve => {
    const u = new URL(url);
    const opts = { method:'GET', hostname:u.hostname, path:u.pathname + (u.search||''), headers };
    const r = https.request(opts, res => {
      let data=''; res.on('data', d => data += d);
      res.on('end', () => resolve({ status:res.statusCode, text:data }));
    });
    r.on('error', e => resolve({ status:599, text:String(e) }));
    r.end();
  });

  const parse = t => { try { return JSON.parse(t); } catch { return null; } };

  function extractGps(widgetJson) {
    if (!widgetJson || typeof widgetJson !== 'object') return null;
    const rec = widgetJson.data || widgetJson.records || widgetJson;

    // Direct lat/lon keys
    const lat = rec.latitude ?? rec.lat ?? rec.Latitude ?? rec.Lat;
    const lon = rec.longitude ?? rec.lon ?? rec.Longitude ?? rec.Lon;
    if (lat != null && lon != null) {
      return { lat:+lat, lon:+lon, ts:rec.timestamp ?? null };
    }
    
// VRM widget "attributes" shape
const attrs = rec?.data?.attributes ?? rec?.attributes ?? rec?.records?.data?.attributes;
    if (attrs && typeof attrs === 'object') {
      const latA = attrs['4'];   // Latitude
      const lonA = attrs['5'];   // Longitude
      const spdA = attrs['142']; // Speed
      const altA = attrs['584']; // Altitude
      const lat2 = latA?.valueFloat ?? (latA?.value != null ? Number(latA.value) : null);
      const lon2 = lonA?.valueFloat ?? (lonA?.value != null ? Number(lonA.value) : null);
      if (lat2 != null && lon2 != null) {
        return {
          lat: lat2,
          lon: lon2,
          ts: latA?.timestamp ?? lonA?.timestamp ?? null,
          speed: spdA?.valueFloat ?? null,
          alt: altA?.valueFloat ?? null
        };
      }
    }

    return null;
  }

  // Try GPS widget
  for (const W of ['GPS','Location']) {
    const r = await httpGet(`${base}/installations/${idSite}/widgets/${W}`, H);
    if (r.status === 200) {
      const j = parse(r.text);
      const coords = extractGps(j);
      if (coords) {
        return respond(200, {
          ok:true, idSite,
          lat:coords.lat, lon:coords.lon,
          ts:coords.ts ?? null,
          speed: coords.speed ?? null,
          alt: coords.alt ?? null,
          source:`widget:${W}`
        });
      }
    }
  }

  return respond(200, { ok:true, idSite, lat:null, lon:null, ts:null, note:"No GPS found" });
};
