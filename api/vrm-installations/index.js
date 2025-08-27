module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN;
  const respond = (status, obj) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(obj, null, 2)
    };
  };

  try {
    if (!TOKEN) {
      return respond(500, { ok:false, error:"CONFIG", msg:"VRM_TOKEN missing" });
    }

    const base = "https://vrmapi.victronenergy.com/v2";
    const headers = {
      "X-Authorization": `Token ${TOKEN}`,
      "Accept": "application/json"
    };

    // 1) Fetch installations list
    const url = `${base}/installations?extended=1`;
    let res;
    try {
      const r = await fetch(url, { headers });
      const text = await r.text();
      if (!r.ok) {
        return respond(r.status, { ok:false, error:"HTTP_FAIL", url, status:r.status, body:text.slice(0,400) });
      }
      res = JSON.parse(text);
    } catch (e) {
      return respond(500, { ok:false, error:"FETCH_FAIL", msg:String(e) });
    }

    // 2) Normalize
    const arr =
      (Array.isArray(res.records) && res.records) ||
      (Array.isArray(res.installations) && res.installations) ||
      (Array.isArray(res.data?.records) && res.data.records) ||
      (Array.isArray(res.data?.installations) && res.data.installations) ||
      [];

    return respond(200, {
      ok:true,
      count: arr.length,
      note: "Keys seen: " + Object.keys(res),
      sample: arr[0] || null
    });

  } catch (e) {
    return respond(500, { ok:false, error:"FATAL", msg:String(e) });
  }
};
