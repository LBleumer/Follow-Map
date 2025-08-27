const https = require('https');

module.exports = async function (context, req) {
  return new Promise((resolve) => {
    const token = process.env.VRM_TOKEN;
    if (!token) {
      resolve({
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { ok: false, error: "No VRM_TOKEN configured" }
      });
      return;
    }

    const options = {
      hostname: "vrmapi.victronenergy.com",
      path: "/v2/installations",
      method: "GET",
      headers: {
        "X-Authorization": "Bearer " + token,
        "Accept": "application/json"
      }
    };

    const req2 = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); }
        catch (e) {
          resolve({
            status: 502,
            headers: { "Content-Type": "application/json" },
            body: { ok: false, error: "VRM_NON_JSON", preview: data.slice(0,300) }
          });
          return;
        }

        resolve({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: { ok: true, count: parsed.records?.length || 0, installations: parsed.records || [], keysSeen: Object.keys(parsed) }
        });
      });
    });

    req2.on("error", err => {
      resolve({
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: { ok: false, error: "VRM_HTTP", msg: err.message }
      });
    });

    req2.end();
  });
};
