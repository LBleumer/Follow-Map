// Robust VRM installations lister with clear error messages
module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN; // set this in SWA env vars
  const respond = (status, obj) => {
    context.res = { status, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(obj) };
  };

  if (!TOKEN) {
    return respond(500, { ok:false, error:"CONFIG", msg:"VRM_TOKEN missing in environment variables" });
  }

  const base = "https://vrmapi.victronenergy.com/v2";
  const headers = {
    // VRM expects X-Authorization with "Token <personal access token>"
    "X-Authorization": `Token ${TOKEN}`,
    "Accept": "application/json"
  };

  async function jget(url) {
    const r = await fetch(url, { headers });
    const text = await r.text();
    if (!r.ok) {
      return { _http_error: true, status: r.status, url, body: text.slice(0, 500) };
    }
    try { return JSON.parse(text); }
    catch { return { _parse_error: true, url, preview: text.slice(0, 200) }; }
  }

  try {
    // Try common listing endpoint
    const url = `${base}/installations?extended=1`;
    const res = await jget(url);

    // Surface HTTP errors with detail so you can see 401/403 etc.
    if (res._http_error) {
      return respond(res.status, { ok:false, error:"VRM_HTTP", url: res.url, preview: res.body });
    }
    if (res._parse_error) {
      return respond(502, { ok:false, error:"VRM_NON_JSON", url: res.url, preview: res.preview });
    }

    // Normalise list shapes seen in the wild
    const arr =
      (Array.isArray(res.records) && res.records) ||
      (Array.isArray(res.installations) && res.installations) ||
      (Array.isArray(res.data?.records) && res.data.records) ||
      (Array.isArray(res.data?.installations) && res.data.installations) ||
      [];

    // If it’s still empty, tell the caller what keys we got back
    if (!arr.length) {
      return respond(200, { ok:true, count: 0, installations: [], note: "No installations in response", keys: Object.keys(res) });
    }

    // Optionally fetch GPS widget per site (skip if you just want to see something first)
    // Minimal output first; uncomment GPS block later if desired.
    const out = arr.map(it => ({
      idSite: it.idSite || it.id || it.identifier,
      name: it.name || it.nickname || it.siteName || `Site ${it.idSite || it.id || it.identifier}`,
      // lat/lon will be filled later if you enable the GPS fetch below
      lat: null,
      lon: null,
      last_seen: null,
      speed: null
    })).filter(x => x.idSite);

    return respond(200, { ok:true, count: out.length, installations: out });
  } catch (e) {
    return respond(500, { ok:false, error:"VRM_PROXY", msg: String(e).slice(0, 300) });
  }
};
