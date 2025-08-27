// api/vrm-hours/index.js
const fetch = require("node-fetch");

module.exports = async function (context, req) {
  const VRM_TOKEN = process.env.VRM_TOKEN;
  if (!VRM_TOKEN) {
    context.res = { status: 500, body: { ok: false, error: "CONFIG", msg: "VRM_TOKEN missing" } };
    return;
  }

  try {
    // Step 1: get all installations
    const listRes = await fetch("https://vrmapi.victronenergy.com/v2/installations", {
      headers: { "X-Authorization": `Bearer ${VRM_TOKEN}` }
    });
    const list = await listRes.json();
    if (!list.success) throw new Error("Failed to fetch installations");

    const items = [];
    // Step 2: loop over installations
    for (const inst of list.records || []) {
      const idSite = inst.idSite;
      const name = inst.name;

      try {
        const sysRes = await fetch(`https://vrmapi.victronenergy.com/v2/installations/${idSite}/system-overview`, {
          headers: { "X-Authorization": `Bearer ${VRM_TOKEN}` }
        });
        const sys = await sysRes.json();

        let hours = null;
        let ts = null;

        if (sys.success && sys.records) {
          const rec = sys.records;
          if (rec["genset/0/Ac/RunningHours"]) {
            hours = rec["genset/0/Ac/RunningHours"].value;
            ts = rec["genset/0/Ac/RunningHours"].timestamp;
          } else if (rec["genset/0/Ac/Runtime"]) {
            hours = rec["genset/0/Ac/Runtime"].value;
            ts = rec["genset/0/Ac/Runtime"].timestamp;
          }
        }

        items.push({ idSite, name, hours, ts });
      } catch (err2) {
        items.push({ idSite: inst.idSite, name: inst.name, hours: null, ts: null, error: err2.message });
      }
    }

    context.res = { status: 200, body: { ok: true, count: items.length, items } };
  } catch (err) {
    context.res = { status: 500, body: { ok: false, error: "VRM_HOURS", msg: err.message } };
  }
};
