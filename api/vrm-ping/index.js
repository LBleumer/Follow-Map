module.exports = async function (context, req) {
  const TOKEN = process.env.VRM_TOKEN || null;
  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      ok: true,
      msg: "VRM ping OK",
      hasToken: !!TOKEN,
      tokenLength: TOKEN ? TOKEN.length : 0
    }, null, 2)
  };
};
