// One gate for the console routes.
//
// Every function that can spend the model key or write a record calls guard(event) as its
// FIRST statement and returns the result if it gets one. Placed before initBlobs() on
// purpose: a rejected call must not touch the Blobs context, the store, or the model.
//
// CONSOLE_KEY lives in the host's environment variables and nowhere else. Never in a file,
// never in the repository, never in the page bundle. The console sends it as the
// x-console-key header from browser storage, where the operator typed it once.
//
// This file sits beside _record.js, which is the same arrangement the repo already uses for
// a shared module. Netlify deploys every .js in this directory as a route, so this one is
// reachable at /.netlify/functions/_auth. It exports no handler, so that route returns
// HandlerNotFound and nothing else. No data, no behaviour. Verified on the live host, not
// assumed.
const crypto = require("crypto");

function digest(v) {
  return crypto.createHash("sha256").update(String(v), "utf8").digest();
}

function sentKey(event) {
  const h = (event && event.headers) || {};
  for (const name of Object.keys(h)) {
    if (name.toLowerCase() === "x-console-key") return h[name] || "";
  }
  return "";
}

// null means pass. Anything else is the response to return, unchanged.
function guard(event) {
  const expected = process.env.CONSOLE_KEY;

  // Fail closed, and say which piece is missing so it can be fixed without reading logs.
  if (!expected) {
    return {
      statusCode: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({
        error: "no_console_key",
        message: "No CONSOLE_KEY set on the host. The console is closed until it is.",
      }),
    };
  }

  const got = sentKey(event);
  // Both sides hashed to a fixed length, then compared in constant time.
  const ok = got && crypto.timingSafeEqual(digest(got), digest(expected));

  if (!ok) {
    return {
      statusCode: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ error: "unauthorized" }),
    };
  }

  return null;
}

module.exports = { guard };
