// Lists all installations + current GPS from VRM
// Docs: https://vrm-api-docs.victronenergy.com/ (Auth via X-Authorization)
// Community examples show "Token <personal access token>" in X-Authorization.

module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN;
  const respond = (status, obj) => {
    context.res = { status, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(obj) };
  };
  if (!TOKEN) return respond(500, { ok:false, error:"CONFIG", msg:"VRM_TOKEN missing" });

  const H = { "X-Authorization": "Token " + TOKEN, "Accept": "application/json" };

  // Helper: VRM fetch
  const jget = async (url) => {
    const r = await fetch(url, { headers: H });
    const text = await r.text();
    if (!r.ok) throw new Error(`VRM ${r.status} ${url}: ${text.slice(0,300)}`);
    try { return JSON.parse(text); } catch { throw new Error("NON_JSON"); }
  };

  try {
    // 1) Discover installations accessible to the token.
    // The v2 API exposes an installations listing for the current user/token context.
    // Typical endpoint: /v2/installations?extended=1  (commonly referenced in examples)
    const base = "https://vrmapi.victronenergy.com/v2";
    const list = await jget(`${base}/installations?extended=1`);

    const arr = (list?.records || list?.installations || list?.data || []);
    if (!Array.isArray(arr)) {
      return respond(502, { ok:false, error:"UNEXPECTED_LIST", preview: list });
    }

    // 2) For each installation, fetch GPS widget (current position).
    // Endpoint used in community examples: /v2/installations/{idSite}/widgets/GPS
    const out = [];
    // Rate-limit a bit to be friendly
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    for (const it of arr) {
      const idSite = it.idSite || it.id || it.identifier;
      const name = it.name || it.nickname || it.siteName || `Site ${idSite}`;
      if (!idSite) continue;

      let gps = null;
      try {
        gps = await jget(`${base}/installations/${idSite}/widgets/GPS`);
      } catch (e) {
        // GPS might be disabled or not present; skip silently
        gps = null;
      }

      const rec = {
        idSite,
        name,
        lat: gps?.records?.[0]?.value?.lat ?? gps?.records?.[0]?.lat ?? null,
        lon: gps?.records?.[0]?.value?.lon ?? gps?.records?.[0]?.lon ?? null,
        last_seen: gps?.records?.[0]?.timestamp ?? gps?.start ?? null,
        speed: gps?.records?.[0]?.value?.speed ?? gps?.records?.[0]?.speed ?? null
      };
      out.push(rec);

      // small delay to avoid rate limits
      await delay(120);
    }

    return respond(200, { ok:true, count: out.length, installations: out });
  } catch (e) {
    return respond(500, { ok:false, error:"VRM_PROXY", msg: String(e).slice(0,300) });
  }
};
