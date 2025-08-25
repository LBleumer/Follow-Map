// /api/vehicles/index.js — TEST
module.exports = async function (context, req) {
  context.log("vehicles test function hit");
  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      ok: true,
      msg: "Hello from Azure Functions 🎉",
      now: new Date().toISOString()
    })
  };
  return;
};
