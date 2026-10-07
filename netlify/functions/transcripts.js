// The records, read back out.
//   GET /api/transcripts?seat=jason          -> JSON list of that seat's record files
//   GET /api/transcripts?seat=jason&file=..  -> text/markdown, the file itself
//   GET /api/transcripts?adam=1&file=..      -> text/markdown, the Adam record
//   GET /api/transcripts?list=adam           -> JSON list of the Adam record files
const { getStore, initBlobs, SEAT_STORE, ADAM_STORE } = require("./_record.js");
const seats = require("./seats.json");

exports.handler = async (event) => {
  initBlobs(event);
  const q = event.queryStringParameters || {};

  // ---- Adam's record ----
  if (q.list === "adam" || q.adam) {
    const store = getStore({ name: ADAM_STORE, consistency: "strong" });
    if (q.file) {
      const body = await readText(store, q.file);
      if (body === null) return json(404, { error: "not_found" });
      return {
        statusCode: 200,
        headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
        body,
      };
    }
    const { blobs } = await store.list();
    return json(200, { record: "adam", files: blobs.map((b) => b.key).sort() });
  }

  // ---- a seat's record ----
  const seatId = q.seat;
  if (!seatId || !seats[seatId]) return json(400, { error: "unknown_seat" });
  const store = getStore({ name: SEAT_STORE, consistency: "strong" });

  if (q.file) {
    const body = await readText(store, `${seatId}/${q.file}`);
    if (body === null) return json(404, { error: "not_found" });
    return {
      statusCode: 200,
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
      body,
    };
  }

  const { blobs } = await store.list({ prefix: `${seatId}/` });
  return json(200, {
    record: seatId,
    seat: seats[seatId].name,
    files: blobs.map((b) => b.key.replace(`${seatId}/`, "")).sort(),
  });
};

async function readText(store, key) {
  try {
    const got = await store.get(key);
    if (!got) return null;
    return typeof got === "string" ? got : await got.text();
  } catch { return null; }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}
