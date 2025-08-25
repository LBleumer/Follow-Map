// Good: CommonJS
module.exports = async function (context, req) {
  context.log("Function hit!");

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, msg: "CommonJS works 🚀" })
  };
};
